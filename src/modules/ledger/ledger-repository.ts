import { randomUUID } from 'node:crypto';
import type { Database } from '../../ports/database.js';
import type {
  LedgerAccount,
  LedgerStore,
  PostedTransaction,
  PostingInput,
} from './ledger-domain.js';

interface AccountRow extends Record<string, unknown> {
  currency: string;
  id: string;
  is_treasury: boolean;
  status: LedgerAccount['status'];
}

interface TransactionRow extends Record<string, unknown> {
  created_at: Date;
  currency: string;
  id: string;
  reference: string;
  type: PostedTransaction['type'];
}

function toAccount(row: AccountRow): LedgerAccount {
  return {
    currency: row.currency,
    id: row.id,
    isTreasury: row.is_treasury,
    status: row.status,
  };
}

export class PostgresLedgerStore implements LedgerStore {
  public constructor(private readonly database: Database) {}

  public async findAccount(id: string): Promise<LedgerAccount | null> {
    const result = await this.database.query<AccountRow>(
      `SELECT id, currency, status, is_treasury
       FROM accounts
       WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row ? toAccount(row) : null;
  }

  public async findTreasury(currency: string): Promise<LedgerAccount | null> {
    const result = await this.database.query<AccountRow>(
      `SELECT id, currency, status, is_treasury
       FROM accounts
       WHERE currency = $1 AND is_treasury = true`,
      [currency],
    );
    const row = result.rows[0];
    return row ? toAccount(row) : null;
  }

  public async post(input: PostingInput): Promise<PostedTransaction> {
    const result = await this.database.query<TransactionRow>(
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
}
