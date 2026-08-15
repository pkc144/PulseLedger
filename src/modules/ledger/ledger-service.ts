import { randomUUID } from 'node:crypto';
import {
  decodeJournalEntryCursor,
  journalEntriesDefaultLimit,
  journalEntriesMaxLimit,
  LedgerError,
  Money,
  validatePosting,
  type FundAccountInput,
  type FundingResult,
  type LedgerApplication,
  type LedgerStore,
  type ListJournalEntriesOptions,
  type ListJournalEntriesResult,
  type PostedTransaction,
  type PostingInput,
} from './ledger-domain.js';

// The HTTP schema is the primary gate for `limit` (integer, 1..journalEntriesMaxLimit); this is a
// defense-in-depth clamp for any caller that reaches the service directly.
function resolveLimit(requested: number | undefined): number {
  if (requested === undefined || !Number.isInteger(requested) || requested < 1) {
    return journalEntriesDefaultLimit;
  }
  return Math.min(requested, journalEntriesMaxLimit);
}

export class LedgerPostingService implements LedgerApplication {
  public constructor(private readonly store: LedgerStore) {}

  public async post(input: PostingInput): Promise<PostedTransaction> {
    validatePosting(input);
    return await this.store.post(input);
  }

  public async fundAccount(input: FundAccountInput): Promise<FundingResult> {
    const amount = Money.fromMinor(input.amountMinor);
    const account = await this.store.findAccount(input.accountId);
    if (!account || account.isTreasury) {
      throw new LedgerError('ACCOUNT_NOT_FOUND', 'Account not found');
    }
    if (account.status !== 'active') {
      throw new LedgerError('ACCOUNT_NOT_ACTIVE', 'Account is not active');
    }

    const treasury = await this.store.findTreasury(account.currency);
    if (!treasury) {
      throw new LedgerError('TREASURY_NOT_FOUND', 'Treasury account is unavailable');
    }

    const id = randomUUID();
    const posted = await this.post({
      id,
      reference: `funding:${id}`,
      type: 'funding',
      entries: [
        { accountId: account.id, amount, currency: account.currency, direction: 'debit' },
        { accountId: treasury.id, amount, currency: account.currency, direction: 'credit' },
      ],
    });

    return { ...posted, amountMinor: amount.toString(), fundedAccountId: account.id };
  }

  public async listJournalEntries(
    accountId: string,
    options: ListJournalEntriesOptions = {},
  ): Promise<ListJournalEntriesResult> {
    const account = await this.store.findAccount(accountId);
    if (!account) {
      throw new LedgerError('ACCOUNT_NOT_FOUND', 'Account not found');
    }

    const limit = resolveLimit(options.limit);
    return await this.store.listJournalEntries({
      accountId,
      limit,
      ...(options.cursor ? { cursor: decodeJournalEntryCursor(options.cursor) } : {}),
    });
  }
}
