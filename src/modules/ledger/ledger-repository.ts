import { randomUUID } from 'node:crypto';
import type { Database, TransactionalDatabase } from '../../ports/database.js';
import { IdempotencyError } from '../idempotency/idempotency-domain.js';
import { outboxCurrentEventVersion, type OutboxStore } from '../outbox/outbox-domain.js';
import {
  encodeJournalEntryCursor,
  type JournalEntry,
  type LedgerAccount,
  type LedgerStore,
  type ListJournalEntriesInput,
  type ListJournalEntriesResult,
  type PostedTransaction,
  type PostingInput,
  type PostOptions,
} from './ledger-domain.js';

interface AccountRow extends Record<string, unknown> {
  currency: string;
  id: string;
  is_treasury: boolean;
  owner_principal_id: string | null;
  status: LedgerAccount['status'];
}

interface TransactionRow extends Record<string, unknown> {
  created_at: Date;
  currency: string;
  id: string;
  reference: string;
  type: PostedTransaction['type'];
}

interface JournalEntryRow extends Record<string, unknown> {
  account_id: string;
  amount_minor: string;
  created_at: Date;
  // Microsecond-precision text form of created_at, used only for cursor construction. A JS
  // `Date` (and therefore `.toISOString()`) only carries millisecond precision, so building the
  // cursor from it would silently drop sub-millisecond ordering information and could cause a
  // boundary row to be re-included on the next page whenever two entries share a millisecond.
  created_at_cursor: string;
  currency: string;
  direction: JournalEntry['direction'];
  id: string;
  transaction_id: string;
}

function toAccount(row: AccountRow): LedgerAccount {
  return {
    currency: row.currency,
    id: row.id,
    isTreasury: row.is_treasury,
    ownerPrincipalId: row.owner_principal_id,
    status: row.status,
  };
}

function toJournalEntry(row: JournalEntryRow): JournalEntry {
  return {
    accountId: row.account_id,
    amountMinor: row.amount_minor,
    createdAt: row.created_at.toISOString(),
    currency: row.currency,
    direction: row.direction,
    id: row.id,
    transactionId: row.transaction_id,
  };
}

export class PostgresLedgerStore implements LedgerStore {
  public constructor(
    private readonly database: TransactionalDatabase,
    private readonly outboxStore?: OutboxStore,
  ) {}

  public async findAccount(id: string): Promise<LedgerAccount | null> {
    const result = await this.database.query<AccountRow>(
      `SELECT id, currency, status, is_treasury, owner_principal_id
       FROM accounts
       WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row ? toAccount(row) : null;
  }

  public async findTreasury(currency: string): Promise<LedgerAccount | null> {
    const result = await this.database.query<AccountRow>(
      `SELECT id, currency, status, is_treasury, owner_principal_id
       FROM accounts
       WHERE currency = $1 AND is_treasury = true`,
      [currency],
    );
    const row = result.rows[0];
    return row ? toAccount(row) : null;
  }

  public async listJournalEntries(
    input: ListJournalEntriesInput,
  ): Promise<ListJournalEntriesResult> {
    // Fetch one extra row to detect whether a next page exists without a separate COUNT query.
    const fetchLimit = input.limit + 1;
    // `to_char` on a timestamptz renders it in the *session* time zone, so the literal "Z" is only
    // true when that zone happens to be UTC. Converting explicitly keeps the cursor correct on a
    // server configured for any other zone (otherwise page two starts hours away from page one).
    const selectColumns = `id, transaction_id, account_id, currency, direction,
           amount_minor::text AS amount_minor, created_at,
           to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
             AS created_at_cursor`;
    const result = input.cursor
      ? await this.database.query<JournalEntryRow>(
          `SELECT ${selectColumns}
           FROM journal_entries
           WHERE account_id = $1 AND (created_at, id) > ($2::timestamptz, $3::uuid)
           ORDER BY created_at, id
           LIMIT $4`,
          [input.accountId, input.cursor.createdAt, input.cursor.id, fetchLimit],
        )
      : await this.database.query<JournalEntryRow>(
          `SELECT ${selectColumns}
           FROM journal_entries
           WHERE account_id = $1
           ORDER BY created_at, id
           LIMIT $2`,
          [input.accountId, fetchLimit],
        );

    const hasMore = result.rows.length > input.limit;
    const page = hasMore ? result.rows.slice(0, input.limit) : result.rows;
    const lastRow = page.at(-1);
    const nextCursor =
      hasMore && lastRow
        ? encodeJournalEntryCursor({ createdAt: lastRow.created_at_cursor, id: lastRow.id })
        : null;

    return { entries: page.map(toJournalEntry), nextCursor };
  }

  public async post(input: PostingInput, options: PostOptions = {}): Promise<PostedTransaction> {
    const idempotency = options.idempotency;
    // A bare posting is one statement and therefore already atomic. Anything written alongside
    // it -- the outbox event, the idempotency completion -- must commit in the same transaction,
    // or a crash between the two could move money without its event or its stored response.
    if (!this.outboxStore && !idempotency) return await postWith(this.database, input);

    const connection = await this.database.connect();
    try {
      await connection.query('BEGIN');
      const posted = await postWith(connection, input);

      if (this.outboxStore) {
        await this.outboxStore.insert(connection, {
          aggregateId: posted.id,
          aggregateType: input.type,
          eventType: `${input.type}.created`,
          eventVersion: outboxCurrentEventVersion,
          payload: {
            ...posted,
            entries: input.entries.map((entry) => ({
              accountId: entry.accountId,
              amountMinor: entry.amount.toString(),
              direction: entry.direction,
            })),
          },
        });
      }

      if (idempotency) {
        const completed = await connection.query(
          `UPDATE idempotency_records
           SET status = 'completed',
               response_status_code = $1,
               response_body = $2,
               completed_at = now()
           WHERE key = $3 AND operation = $4 AND principal_id = $5 AND status = 'in_progress'`,
          [
            idempotency.responseStatus,
            idempotency.responseBody(posted),
            idempotency.key,
            idempotency.operation,
            idempotency.principalId,
          ],
        );
        // Same backstop as transfers: only the request that completes the claim may post.
        if (completed.rowCount !== 1) {
          throw new IdempotencyError(
            'IDEMPOTENCY_IN_PROGRESS',
            'A request with this idempotency key is already in progress',
          );
        }
      }

      await connection.query('COMMIT');
      return posted;
    } catch (error) {
      try {
        await connection.query('ROLLBACK');
      } catch {
        // Preserve the original failure.
      }
      throw error;
    } finally {
      connection.release();
    }
  }
}

async function postWith(database: Database, input: PostingInput): Promise<PostedTransaction> {
  const result = await database.query<TransactionRow>(
    `SELECT id, type, reference, currency, created_at
     FROM post_ledger_transaction($1, $2, $3, $4, $5, $6, $7)`,
    [
      input.id,
      input.type,
      input.reference,
      input.entries.map(() => randomUUID()),
      input.entries.map(({ accountId }) => accountId),
      input.entries.map(({ direction }) => direction),
      input.entries.map(({ amount }) => amount.toString()),
    ],
  );
  const row = result.rows[0]!;
  return {
    createdAt: row.created_at.toISOString(),
    currency: row.currency,
    id: row.id,
    reference: row.reference,
    type: row.type,
  };
}
