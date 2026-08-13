import { randomUUID } from 'node:crypto';
import type { Database, DatabaseConnection, TransactionalDatabase } from '../../ports/database.js';
import type { OutboxStore } from '../outbox/outbox-domain.js';
import type {
  LockedTransferAccount,
  Transfer,
  TransferStore,
  TransferTransaction,
} from './transfer-domain.js';

interface AccountRow extends Record<string, unknown> {
  balance_minor: string;
  currency: string;
  id: string;
  is_treasury: boolean;
  status: LockedTransferAccount['status'];
}

interface TransferRow extends Record<string, unknown> {
  amount_minor: string;
  created_at: Date;
  currency: string;
  destination_account_id: string;
  id: string;
  reference: string;
  source_account_id: string;
  status: Transfer['status'];
}

function toTransfer(row: TransferRow): Transfer {
  return {
    amountMinor: row.amount_minor,
    createdAt: row.created_at.toISOString(),
    currency: row.currency,
    destinationAccountId: row.destination_account_id,
    id: row.id,
    reference: row.reference,
    sourceAccountId: row.source_account_id,
    status: row.status,
  };
}

class PostgresTransferTransaction implements TransferTransaction {
  public constructor(
    private readonly database: Database,
    private readonly outboxStore?: OutboxStore,
  ) {}

  public async lockAccounts(
    accountIds: readonly [string, string],
  ): Promise<readonly LockedTransferAccount[]> {
    const result = await this.database.query<AccountRow>(
      `SELECT id, currency, status, balance_minor::text, is_treasury
       FROM accounts
       WHERE id = ANY($1::uuid[])
       ORDER BY id
       FOR UPDATE`,
      [accountIds],
    );
    return result.rows.map((row) => ({
      balanceMinor: row.balance_minor,
      currency: row.currency,
      id: row.id,
      isTreasury: row.is_treasury,
      status: row.status,
    }));
  }

  public async postTransfer(input: {
    amountMinor: string;
    currency: string;
    destinationAccountId: string;
    id: string;
    reference: string;
    sourceAccountId: string;
    idempotency?: { key: string; operation: string };
  }): Promise<Transfer> {
    const transaction = await this.database.query<{ created_at: Date }>(
      `SELECT created_at
       FROM post_ledger_transaction($1, 'transfer', $2, $3, $4, $5, $6)`,
      [
        input.id,
        input.reference,
        [randomUUID(), randomUUID()],
        [input.sourceAccountId, input.destinationAccountId],
        ['credit', 'debit'],
        [input.amountMinor, input.amountMinor],
      ],
    );
    const createdAt = transaction.rows[0]!.created_at;

    await this.database.query(
      `INSERT INTO transfers (
         id, source_account_id, destination_account_id, amount_minor, currency, status
       )
       VALUES ($1, $2, $3, $4, $5, 'completed')`,
      [
        input.id,
        input.sourceAccountId,
        input.destinationAccountId,
        input.amountMinor,
        input.currency,
      ],
    );

    const transfer: Transfer = {
      amountMinor: input.amountMinor,
      createdAt: createdAt.toISOString(),
      currency: input.currency,
      destinationAccountId: input.destinationAccountId,
      id: input.id,
      reference: input.reference,
      sourceAccountId: input.sourceAccountId,
      status: 'completed',
    };

    if (this.outboxStore) {
      await this.outboxStore.insert(this.database, {
        aggregateId: input.id,
        aggregateType: 'transfer',
        eventType: 'transfer.created',
        payload: transfer,
      });
    }

    if (input.idempotency) {
      await this.database.query(
        `UPDATE idempotency_records
         SET status = 'completed',
             response_status_code = $1,
             response_body = $2,
             completed_at = now()
         WHERE key = $3 AND operation = $4 AND status = 'in_progress'`,
        [201, transfer, input.idempotency.key, input.idempotency.operation],
      );
    }

    return transfer;
  }
}

export class PostgresTransferStore implements TransferStore {
  public constructor(
    private readonly database: TransactionalDatabase,
    private readonly outboxStore?: OutboxStore,
  ) {}

  public async findById(id: string): Promise<Transfer | null> {
    const result = await this.database.query<TransferRow>(
      `SELECT transfer.id, transfer.source_account_id, transfer.destination_account_id,
              transfer.amount_minor::text, transfer.currency, transfer.status,
              ledger_transaction.created_at, ledger_transaction.reference
       FROM transfers AS transfer
       JOIN ledger_transactions AS ledger_transaction ON ledger_transaction.id = transfer.id
       WHERE transfer.id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row ? toTransfer(row) : null;
  }

  public async runSerializable<T>(
    work: (transaction: TransferTransaction) => Promise<T>,
  ): Promise<T> {
    const connection: DatabaseConnection = await this.database.connect();
    try {
      await connection.query('BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE');
      const result = await work(new PostgresTransferTransaction(connection, this.outboxStore));
      await connection.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await connection.query('ROLLBACK');
      } catch {
        // Preserve the original transaction failure.
      }
      throw error;
    } finally {
      connection.release();
    }
  }
}
