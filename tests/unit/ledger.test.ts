import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  maximumMoneyMinor,
  Money,
  validatePosting,
  type LedgerAccount,
  type LedgerStore,
  type PostedTransaction,
  type PostingInput,
} from '../../src/modules/ledger/ledger-domain.js';
import { LedgerPostingService } from '../../src/modules/ledger/ledger-service.js';

class MemoryLedgerStore implements LedgerStore {
  public posted: PostingInput[] = [];
  public readonly customer: LedgerAccount = {
    id: randomUUID(),
    currency: 'INR',
    isTreasury: false,
    status: 'active',
  };
  public readonly treasury: LedgerAccount = {
    id: randomUUID(),
    currency: 'INR',
    isTreasury: true,
    status: 'active',
  };

  public async findAccount(id: string): Promise<LedgerAccount | null> {
    return id === this.customer.id ? this.customer : null;
  }

  public async findTreasury(currency: string): Promise<LedgerAccount | null> {
    return currency === this.treasury.currency ? this.treasury : null;
  }

  public async post(input: PostingInput): Promise<PostedTransaction> {
    this.posted.push(input);
    return {
      id: input.id,
      type: input.type,
      reference: input.reference,
      currency: input.entries[0]!.currency,
      createdAt: '2026-08-03T00:00:00.000Z',
    };
  }
}

function posting(entries: PostingInput['entries']): PostingInput {
  return { id: randomUUID(), reference: `test:${randomUUID()}`, type: 'funding', entries };
}

function expectLedgerError(action: () => unknown, code: string): void {
  try {
    action();
  } catch (error) {
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected ${code}`);
}

describe('Money', () => {
  it.each(['0', '-1', '1.5', '01', '', (maximumMoneyMinor + 1n).toString()])(
    'rejects invalid amount %s',
    (amount) => {
      expectLedgerError(() => Money.fromMinor(amount), 'INVALID_AMOUNT');
    },
  );

  it('rejects JavaScript numbers, including unsafe integers', () => {
    expectLedgerError(() => Money.fromMinor(10), 'INVALID_AMOUNT');
    expectLedgerError(() => Money.fromMinor(Number.MAX_SAFE_INTEGER + 1), 'INVALID_AMOUNT');
  });

  it('round-trips the largest PostgreSQL bigint', () => {
    expect(Money.fromMinor(maximumMoneyMinor.toString()).toString()).toBe(
      maximumMoneyMinor.toString(),
    );
  });
});

describe('posting validation', () => {
  it('rejects unbalanced entries', () => {
    expectLedgerError(
      () =>
        validatePosting(
          posting([
            {
              accountId: randomUUID(),
              amount: Money.fromMinor('10'),
              currency: 'INR',
              direction: 'debit',
            },
            {
              accountId: randomUUID(),
              amount: Money.fromMinor('9'),
              currency: 'INR',
              direction: 'credit',
            },
          ]),
        ),
      'UNBALANCED_POSTING',
    );
  });

  it('rejects mixed currencies', () => {
    expectLedgerError(
      () =>
        validatePosting(
          posting([
            {
              accountId: randomUUID(),
              amount: Money.fromMinor('10'),
              currency: 'INR',
              direction: 'debit',
            },
            {
              accountId: randomUUID(),
              amount: Money.fromMinor('10'),
              currency: 'USD',
              direction: 'credit',
            },
          ]),
        ),
      'MIXED_CURRENCY_POSTING',
    );
  });

  it('funds through an equal customer debit and treasury credit', async () => {
    const store = new MemoryLedgerStore();
    const service = new LedgerPostingService(store);

    const result = await service.fundAccount({ accountId: store.customer.id, amountMinor: '2500' });

    expect(result).toMatchObject({ amountMinor: '2500', fundedAccountId: store.customer.id });
    expect(store.posted[0]!.entries).toMatchObject([
      { accountId: store.customer.id, direction: 'debit', currency: 'INR' },
      { accountId: store.treasury.id, direction: 'credit', currency: 'INR' },
    ]);
    expect(store.posted[0]!.entries.map(({ amount }) => amount.toString())).toEqual([
      '2500',
      '2500',
    ]);
  });
});
