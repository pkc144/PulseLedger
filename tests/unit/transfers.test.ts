import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  deterministicAccountOrder,
  type LockedTransferAccount,
  type Transfer,
  type TransferStore,
  type TransferTransaction,
} from '../../src/modules/transfers/transfer-domain.js';
import { TransferService } from '../../src/modules/transfers/transfer-service.js';
import { TransferMetrics } from '../../src/modules/transfers/transfer-service.js';

const sourceId = '00000000-0000-4000-8000-000000000020';
const destinationId = '00000000-0000-4000-8000-000000000010';
const principalId = '00000000-0000-4000-8000-0000000000a1';
const otherPrincipalId = '00000000-0000-4000-8000-0000000000a2';

function account(
  id: string,
  overrides: Partial<LockedTransferAccount> = {},
): LockedTransferAccount {
  return {
    balanceMinor: '100',
    currency: 'INR',
    id,
    isTreasury: false,
    ownerPrincipalId: principalId,
    status: 'active',
    ...overrides,
  };
}

function completedTransfer(): Transfer {
  const id = randomUUID();
  return {
    amountMinor: '10',
    createdAt: '2026-08-03T00:00:00.000Z',
    currency: 'INR',
    destinationAccountId: destinationId,
    id,
    reference: `transfer:${id}`,
    sourceAccountId: sourceId,
    status: 'completed',
  };
}

class FakeTransferStore implements TransferStore, TransferTransaction {
  public accounts: readonly LockedTransferAccount[] = [account(sourceId), account(destinationId)];
  public attempts = 0;
  public failures: Error[] = [];
  public lockOrders: (readonly [string, string])[] = [];
  public posts = 0;

  public async findVisibleById(): Promise<Transfer | null> {
    return null;
  }

  public async lockAccounts(
    accountIds: readonly [string, string],
  ): Promise<readonly LockedTransferAccount[]> {
    this.lockOrders.push(accountIds);
    return this.accounts;
  }

  public async postTransfer(): Promise<Transfer> {
    this.posts += 1;
    return completedTransfer();
  }

  public async runSerializable<T>(
    work: (transaction: TransferTransaction) => Promise<T>,
  ): Promise<T> {
    this.attempts += 1;
    const failure = this.failures.shift();
    if (failure) throw failure;
    return await work(this);
  }
}

const input = {
  amountMinor: '10',
  destinationAccountId: destinationId,
  sourceAccountId: sourceId,
};

function databaseFailure(code: string): Error & { code: string } {
  return Object.assign(new Error('database conflict'), { code });
}

async function expectTransferError(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

describe('transfer validation', () => {
  it('orders account locks deterministically', () => {
    expect(deterministicAccountOrder(sourceId, destinationId)).toEqual([destinationId, sourceId]);
    expect(deterministicAccountOrder(destinationId, sourceId)).toEqual([destinationId, sourceId]);
  });

  it('rejects self-transfers before opening a transaction', async () => {
    const store = new FakeTransferStore();
    const service = new TransferService(store);
    await expectTransferError(
      service.create({ ...input, destinationAccountId: sourceId }, principalId),
      'SELF_TRANSFER',
    );
    expect(store.attempts).toBe(0);
  });

  it('refuses to spend from an account the caller does not own, and posts nothing', async () => {
    const store = new FakeTransferStore();
    store.accounts = [
      account(sourceId, { ownerPrincipalId: otherPrincipalId }),
      account(destinationId),
    ];
    // Reported as ACCOUNT_NOT_FOUND, not a distinct authorization code: a caller must not be able
    // to tell "someone else's account" apart from "no such account".
    await expectTransferError(
      new TransferService(store).create(input, principalId),
      'ACCOUNT_NOT_FOUND',
    );
    expect(store.posts).toBe(0);
  });

  it('allows paying an account owned by someone else', async () => {
    const store = new FakeTransferStore();
    store.accounts = [
      account(sourceId),
      account(destinationId, { ownerPrincipalId: otherPrincipalId }),
    ];
    await expect(new TransferService(store).create(input, principalId)).resolves.toMatchObject({
      status: 'completed',
    });
    expect(store.posts).toBe(1);
  });

  it('rejects inactive, cross-currency, and underfunded sources without posting', async () => {
    const cases: Array<{ accounts: LockedTransferAccount[]; code: string }> = [
      {
        accounts: [account(sourceId, { status: 'frozen' }), account(destinationId)],
        code: 'ACCOUNT_NOT_ACTIVE',
      },
      {
        accounts: [account(sourceId), account(destinationId, { currency: 'USD' })],
        code: 'CURRENCY_MISMATCH',
      },
      {
        accounts: [account(sourceId, { balanceMinor: '9' }), account(destinationId)],
        code: 'INSUFFICIENT_FUNDS',
      },
    ];

    for (const testCase of cases) {
      const store = new FakeTransferStore();
      store.accounts = testCase.accounts;
      await expectTransferError(
        new TransferService(store).create(input, principalId),
        testCase.code,
      );
      expect(store.posts).toBe(0);
    }
  });
});

describe('serialization retries', () => {
  it('retries recognized database conflicts with bounded backoff and records metrics', async () => {
    const store = new FakeTransferStore();
    store.failures = [databaseFailure('40001'), databaseFailure('40P01')];
    const delays: number[] = [];
    const retryEvents: number[] = [];
    const metrics = new TransferMetrics();
    const service = new TransferService(store, {
      baseRetryDelayMs: 10,
      jitter: () => 1,
      maxAttempts: 4,
      metrics,
      sleep: async (delay) => {
        delays.push(delay);
      },
      telemetry: {
        completed: () => undefined,
        retrying: ({ retryAttempt }) => retryEvents.push(retryAttempt),
      },
    });

    await expect(service.create(input, principalId)).resolves.toMatchObject({
      status: 'completed',
    });
    expect(store.attempts).toBe(3);
    expect(delays).toEqual([10, 20]);
    expect(retryEvents).toEqual([1, 2]);
    expect(metrics.snapshot()).toEqual({ completed: 1, exhausted: 0, retries: 2 });
  });

  it('stops at the retry bound', async () => {
    const store = new FakeTransferStore();
    store.failures = Array.from({ length: 4 }, () => databaseFailure('40001'));
    const delays: number[] = [];
    const metrics = new TransferMetrics();
    const service = new TransferService(store, {
      baseRetryDelayMs: 10,
      jitter: () => 1,
      maxAttempts: 4,
      metrics,
      sleep: async (delay) => {
        delays.push(delay);
      },
    });

    await expectTransferError(service.create(input, principalId), 'TRANSFER_RETRY_EXHAUSTED');
    expect(store.attempts).toBe(4);
    expect(delays).toEqual([10, 20, 40]);
    expect(delays.reduce((total, delay) => total + delay, 0)).toBe(70);
    expect(metrics.snapshot()).toEqual({ completed: 0, exhausted: 1, retries: 3 });
  });
});
