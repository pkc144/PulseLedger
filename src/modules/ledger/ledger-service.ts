import { randomUUID } from 'node:crypto';
import {
  LedgerError,
  Money,
  validatePosting,
  type FundAccountInput,
  type FundingResult,
  type LedgerApplication,
  type LedgerStore,
  type PostedTransaction,
  type PostingInput,
} from './ledger-domain.js';

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
}
