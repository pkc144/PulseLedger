import { randomUUID } from 'node:crypto';
import type { Database } from '../../ports/database.js';
import type {
  Account,
  AccountStore,
  CreateAccountInput,
  OwnedAccountsCursor,
  SupportedCurrency,
} from './account-domain.js';

interface AccountRow extends Record<string, unknown> {
  balance_minor: string;
  created_at: Date;
  currency: SupportedCurrency;
  id: string;
  status: Account['status'];
}

function toAccount(row: AccountRow): Account {
  return {
    balanceMinor: row.balance_minor,
    createdAt: row.created_at.toISOString(),
    currency: row.currency,
    id: row.id,
    status: row.status,
  };
}

export class PostgresAccountStore implements AccountStore {
  public constructor(private readonly database: Database) {}

  public async create(input: CreateAccountInput, ownerPrincipalId: string): Promise<Account> {
    const result = await this.database.query<AccountRow>(
      `INSERT INTO accounts (id, currency, owner_principal_id)
       VALUES ($1, $2, $3)
       RETURNING id, currency, status, balance_minor::text, created_at`,
      [randomUUID(), input.currency, ownerPrincipalId],
    );
    return toAccount(result.rows[0]!);
  }

  public async findOwnedById(id: string, ownerPrincipalId: string): Promise<Account | null> {
    // Ownership is part of the WHERE clause, not a check on the result: an account owned by
    // someone else is indistinguishable from one that does not exist, so the 404 this produces
    // leaks nothing about other principals' accounts.
    const result = await this.database.query<AccountRow>(
      `SELECT id, currency, status, balance_minor::text, created_at
       FROM accounts
       WHERE id = $1 AND is_treasury = false AND owner_principal_id = $2`,
      [id, ownerPrincipalId],
    );
    const row = result.rows[0];
    return row ? toAccount(row) : null;
  }

  public async listOwned(
    ownerPrincipalId: string,
    page: { cursor?: OwnedAccountsCursor | undefined; limit: number },
  ): Promise<{ accounts: Account[]; nextCursor: OwnedAccountsCursor | null }> {
    // Same ownership filter as findOwnedById, served by accounts_owner_idx. Oldest first, so a
    // principal's first account stays first in every listing. Keyset-paginated on
    // (created_at, id), fetching one extra row to learn whether another page exists. The cursor
    // timestamp is rendered in UTC explicitly -- see the journal-entries cursor for why.
    const result = await this.database.query<AccountRow & { created_at_cursor: string }>(
      `SELECT id, currency, status, balance_minor::text, created_at,
              to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                AS created_at_cursor
       FROM accounts
       WHERE owner_principal_id = $1 AND is_treasury = false
         AND ($3::timestamptz IS NULL OR (created_at, id) > ($3::timestamptz, $4::uuid))
       ORDER BY created_at, id
       LIMIT $2`,
      [ownerPrincipalId, page.limit + 1, page.cursor?.createdAt ?? null, page.cursor?.id ?? null],
    );
    const hasMore = result.rows.length > page.limit;
    const rows = hasMore ? result.rows.slice(0, page.limit) : result.rows;
    const last = rows.at(-1);
    return {
      accounts: rows.map(toAccount),
      nextCursor: hasMore && last ? { createdAt: last.created_at_cursor, id: last.id } : null,
    };
  }
}
