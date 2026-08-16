import { randomUUID } from 'node:crypto';
import type { Database } from '../../ports/database.js';
import type {
  Account,
  AccountStore,
  CreateAccountInput,
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
}
