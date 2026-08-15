import type { Database } from '../../ports/database.js';
import type {
  ReconciliationIssue,
  ReconciliationReport,
  ReconciliationStore,
} from './reconciliation-domain.js';

interface ReconciliationRow extends Record<string, unknown> {
  account_id: string;
  cached_balance: string | null;
  computed_balance: string;
  currency: string | null;
  no_journal_support: boolean;
  unexpected: boolean;
}

/**
 * Independently recomputes each account's balance from the immutable journal and compares it to
 * the cached `accounts.balance_minor`. This store never writes: reconciliation reports drift, it
 * does not silently repair it.
 */
export class PostgresReconciliationStore implements ReconciliationStore {
  public constructor(private readonly database: Database) {}

  public async run(): Promise<ReconciliationReport> {
    const countResult = await this.database.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM accounts',
    );
    const accountsChecked = Number(countResult.rows[0]?.count ?? '0');

    const result = await this.database.query<ReconciliationRow>(
      `WITH computed AS (
         SELECT
           account_id,
           currency,
           sum(CASE WHEN direction = 'debit' THEN amount_minor ELSE -amount_minor END) AS computed_balance
         FROM journal_entries
         GROUP BY account_id, currency
       )
       SELECT
         COALESCE(a.id, c.account_id) AS account_id,
         COALESCE(a.currency, c.currency) AS currency,
         a.balance_minor::text AS cached_balance,
         COALESCE(c.computed_balance, 0)::text AS computed_balance,
         (a.id IS NULL) AS unexpected,
         (c.account_id IS NULL) AS no_journal_support
       FROM accounts a
       FULL OUTER JOIN computed c ON c.account_id = a.id
       ORDER BY COALESCE(a.id, c.account_id)`,
    );

    const issues: ReconciliationIssue[] = [];
    for (const row of result.rows) {
      if (row.unexpected) {
        // A computed balance exists for an account id with no accounts row. The composite
        // (account_id, currency) foreign key on journal_entries prevents this today; it is
        // still checked independently rather than trusted, matching the project's principle
        // that reconciliation verifies the journal on its own terms.
        issues.push({
          accountId: row.account_id,
          cachedBalanceMinor: null,
          computedBalanceMinor: row.computed_balance,
          currency: row.currency,
          type: 'unexpected',
        });
        continue;
      }

      if (row.no_journal_support && row.cached_balance !== '0') {
        // A non-zero cached balance with zero journal entries behind it: the cache was set
        // (or corrupted) without ever being posted through the ledger.
        issues.push({
          accountId: row.account_id,
          cachedBalanceMinor: row.cached_balance,
          computedBalanceMinor: '0',
          currency: row.currency,
          type: 'missing',
        });
        continue;
      }

      if (row.cached_balance !== row.computed_balance) {
        issues.push({
          accountId: row.account_id,
          cachedBalanceMinor: row.cached_balance,
          computedBalanceMinor: row.computed_balance,
          currency: row.currency,
          type: 'mismatched',
        });
      }
    }

    return {
      accountsChecked,
      generatedAt: new Date().toISOString(),
      issues,
      ok: issues.length === 0,
    };
  }
}
