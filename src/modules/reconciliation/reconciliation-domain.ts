export const reconciliationIssueTypes = ['mismatched', 'missing', 'unexpected'] as const;
export type ReconciliationIssueType = (typeof reconciliationIssueTypes)[number];

export interface ReconciliationIssue {
  /** Account id from whichever side of the comparison has it. */
  accountId: string;
  /** Cached `accounts.balance_minor`. Null only for 'unexpected' (no accounts row exists). */
  cachedBalanceMinor: string | null;
  /** Balance recomputed by summing debits minus credits from journal_entries. */
  computedBalanceMinor: string;
  currency: string | null;
  type: ReconciliationIssueType;
}

export interface ReconciliationReport {
  accountsChecked: number;
  generatedAt: string;
  issues: readonly ReconciliationIssue[];
  ok: boolean;
}

export interface ReconciliationStore {
  /** Read-only: reports drift between cached balances and the journal, never repairs it. */
  run(): Promise<ReconciliationReport>;
}

export interface ReconciliationApplication {
  run(): Promise<ReconciliationReport>;
}
