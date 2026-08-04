import { randomUUID } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  Money,
  validatePosting,
  type PostingInput,
} from '../../src/modules/ledger/ledger-domain.js';

function posting(entries: PostingInput['entries']): PostingInput {
  return { id: randomUUID(), reference: `property:${randomUUID()}`, type: 'funding', entries };
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

describe('double-entry properties', () => {
  it('accepts generated balanced postings', () => {
    fc.assert(
      fc.property(
        fc.array(fc.bigInt({ min: 1n, max: 1_000_000_000n }), { minLength: 1, maxLength: 20 }),
        (values) => {
          const total = values.reduce((sum, value) => sum + value, 0n);
          const entries: PostingInput['entries'] = [
            ...values.map((value) => ({
              accountId: randomUUID(),
              amount: Money.fromMinor(value),
              currency: 'INR',
              direction: 'debit' as const,
            })),
            {
              accountId: randomUUID(),
              amount: Money.fromMinor(total),
              currency: 'INR',
              direction: 'credit' as const,
            },
          ];
          expect(() => validatePosting(posting(entries))).not.toThrow();
        },
      ),
    );
  });

  it('rejects generated unequal postings', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 1_000_000_000n }),
        fc.bigInt({ min: 1n, max: 1_000_000_000n }),
        (amount, difference) => {
          expectLedgerError(
            () =>
              validatePosting(
                posting([
                  {
                    accountId: randomUUID(),
                    amount: Money.fromMinor(amount),
                    currency: 'USD',
                    direction: 'debit',
                  },
                  {
                    accountId: randomUUID(),
                    amount: Money.fromMinor(amount + difference),
                    currency: 'USD',
                    direction: 'credit',
                  },
                ]),
              ),
            'UNBALANCED_POSTING',
          );
        },
      ),
    );
  });
});
