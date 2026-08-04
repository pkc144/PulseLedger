export const ledgerDirections = ['debit', 'credit'] as const;
export type LedgerDirection = (typeof ledgerDirections)[number];

export const maximumMoneyMinor = 9_223_372_036_854_775_807n;

export type LedgerErrorCode =
  | 'ACCOUNT_NOT_ACTIVE'
  | 'ACCOUNT_NOT_FOUND'
  | 'INVALID_AMOUNT'
  | 'INVALID_POSTING'
  | 'MIXED_CURRENCY_POSTING'
  | 'TREASURY_NOT_FOUND'
  | 'UNBALANCED_POSTING';

export class LedgerError extends Error {
  public constructor(
    public readonly code: LedgerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LedgerError';
  }
}

export class Money {
  private constructor(public readonly minor: bigint) {}

  public static fromMinor(value: unknown): Money {
    if (typeof value !== 'string' && typeof value !== 'bigint') {
      throw new LedgerError('INVALID_AMOUNT', 'Amount must be a positive integer string');
    }
    if (typeof value === 'string' && !/^[1-9][0-9]*$/.test(value)) {
      throw new LedgerError('INVALID_AMOUNT', 'Amount must be a positive integer string');
    }

    const minor = typeof value === 'bigint' ? value : BigInt(value);
    if (minor <= 0n || minor > maximumMoneyMinor) {
      throw new LedgerError('INVALID_AMOUNT', 'Amount is outside the supported range');
    }
    return new Money(minor);
  }

  public toString(): string {
    return this.minor.toString();
  }
}

export interface LedgerAccount {
  currency: string;
  id: string;
  isTreasury: boolean;
  status: 'active' | 'frozen' | 'closed';
}

export interface PostingEntryInput {
  accountId: string;
  amount: Money;
  currency: string;
  direction: LedgerDirection;
}

export interface PostingInput {
  entries: readonly PostingEntryInput[];
  id: string;
  reference: string;
  type: 'funding';
}

export interface PostedTransaction {
  createdAt: string;
  currency: string;
  id: string;
  reference: string;
  type: PostingInput['type'];
}

export interface LedgerStore {
  findAccount(id: string): Promise<LedgerAccount | null>;
  findTreasury(currency: string): Promise<LedgerAccount | null>;
  post(input: PostingInput): Promise<PostedTransaction>;
}

export interface FundAccountInput {
  accountId: string;
  amountMinor: string;
}

export interface FundingResult extends PostedTransaction {
  amountMinor: string;
  fundedAccountId: string;
}

export interface LedgerApplication {
  fundAccount(input: FundAccountInput): Promise<FundingResult>;
}

export function validatePosting(input: PostingInput): void {
  if (input.entries.length < 2) {
    throw new LedgerError('INVALID_POSTING', 'A posting requires at least two entries');
  }

  const currencies = new Set(input.entries.map(({ currency }) => currency));
  if (currencies.size !== 1) {
    throw new LedgerError('MIXED_CURRENCY_POSTING', 'All entries must use one currency');
  }

  let debits = 0n;
  let credits = 0n;
  for (const entry of input.entries) {
    if (entry.direction === 'debit') debits += entry.amount.minor;
    else credits += entry.amount.minor;
  }

  if (debits !== credits) {
    throw new LedgerError('UNBALANCED_POSTING', 'Total debits must equal total credits');
  }
}
