import { describe, expect, it } from 'vitest';
import {
  canonicalSerialize,
  IdempotencyError,
  type ClaimResult,
  type IdempotencyRecord,
  type IdempotencyStore,
} from '../../src/modules/idempotency/idempotency-domain.js';
import {
  computeCanonicalFingerprint,
  IdempotencyService,
} from '../../src/modules/idempotency/idempotency-service.js';

class FakeIdempotencyStore implements IdempotencyStore {
  private records = new Map<string, IdempotencyRecord>();

  public async claim(params: {
    fingerprint: string;
    key: string;
    operation: string;
    staleTimeoutMs: number;
  }): Promise<ClaimResult> {
    const compoundKey = `${params.key}:${params.operation}`;
    const existing = this.records.get(compoundKey);

    if (!existing) {
      const record: IdempotencyRecord = {
        completedAt: null,
        createdAt: new Date().toISOString(),
        key: params.key,
        operation: params.operation,
        requestFingerprint: params.fingerprint,
        responseBody: null,
        responseStatus: null,
        status: 'in_progress',
      };
      this.records.set(compoundKey, record);
      return { action: 'proceed', record };
    }

    if (existing.status === 'completed') {
      return {
        action: 'replay',
        record: existing,
        response: { body: existing.responseBody, status: existing.responseStatus! },
      };
    }

    if (existing.requestFingerprint !== params.fingerprint) {
      throw new IdempotencyError(
        'IDEMPOTENCY_CONFLICT',
        'Duplicate idempotency key with a different request body',
      );
    }

    const staleThreshold = new Date(Date.now() - params.staleTimeoutMs);
    if (new Date(existing.createdAt) < staleThreshold) {
      existing.createdAt = new Date().toISOString();
      existing.completedAt = null;
      return { action: 'proceed', record: existing };
    }

    throw new IdempotencyError(
      'IDEMPOTENCY_IN_PROGRESS',
      'A request with this idempotency key is already in progress',
    );
  }

  public async complete(params: {
    key: string;
    operation: string;
    responseBody: unknown;
    responseStatus: number;
  }): Promise<void> {
    const compoundKey = `${params.key}:${params.operation}`;
    const record = this.records.get(compoundKey);
    if (record) {
      record.status = 'completed';
      record.responseBody = params.responseBody;
      record.responseStatus = params.responseStatus;
      record.completedAt = new Date().toISOString();
    }
  }

  public getRecord(key: string, operation: string): IdempotencyRecord | undefined {
    return this.records.get(`${key}:${operation}`);
  }
}

const requestBody = { sourceAccountId: 'src', destinationAccountId: 'dst', amountMinor: '100' };

describe('canonical fingerprint', () => {
  it('produces the same fingerprint for identical bodies', () => {
    const first = computeCanonicalFingerprint(requestBody);
    const second = computeCanonicalFingerprint({ ...requestBody });
    expect(first).toBe(second);
  });

  it('produces the same fingerprint regardless of key ordering', () => {
    const first = computeCanonicalFingerprint({ a: 1, b: 2 });
    const second = computeCanonicalFingerprint({ b: 2, a: 1 });
    expect(first).toBe(second);
  });

  it('produces different fingerprints for different bodies', () => {
    const first = computeCanonicalFingerprint(requestBody);
    const second = computeCanonicalFingerprint({
      sourceAccountId: 'src',
      destinationAccountId: 'dst',
      amountMinor: '200',
    });
    expect(first).not.toBe(second);
  });

  it('serializes nested objects deterministically', () => {
    const nested = { outer: { inner: 1, other: 2 } };
    const first = canonicalSerialize(nested);
    const second = canonicalSerialize({ outer: { other: 2, inner: 1 } });
    expect(first).toBe(second);
  });
});

describe('idempotency service', () => {
  it('returns null on first request (claim succeeds)', async () => {
    const store = new FakeIdempotencyStore();
    const service = new IdempotencyService(store);
    const result = await service.claimOrReplay('key-1', 'transfer', requestBody);
    expect(result).toBeNull();

    const record = store.getRecord('key-1', 'transfer');
    expect(record?.status).toBe('in_progress');
  });

  it('replays the stored response for a completed key with matching body', async () => {
    const store = new FakeIdempotencyStore();
    const service = new IdempotencyService(store);

    await service.claimOrReplay('key-1', 'transfer', requestBody);
    await store.complete({
      key: 'key-1',
      operation: 'transfer',
      responseBody: { id: 'transfer-1' },
      responseStatus: 201,
    });

    const result = await service.claimOrReplay('key-1', 'transfer', requestBody);
    expect(result).toEqual({ body: { id: 'transfer-1' }, status: 201 });
  });

  it('throws IDEMPOTENCY_CONFLICT for same key with different body', async () => {
    const store = new FakeIdempotencyStore();
    const service = new IdempotencyService(store);

    await service.claimOrReplay('key-1', 'transfer', requestBody);

    await expect(
      service.claimOrReplay('key-1', 'transfer', {
        sourceAccountId: 'src',
        destinationAccountId: 'dst',
        amountMinor: '200',
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('throws IDEMPOTENCY_IN_PROGRESS for concurrent identical request (not stale)', async () => {
    const store = new FakeIdempotencyStore();
    const service = new IdempotencyService(store);

    await service.claimOrReplay('key-1', 'transfer', requestBody);

    await expect(service.claimOrReplay('key-1', 'transfer', requestBody)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_IN_PROGRESS',
    });
  });

  it('reclaims a stale in_progress record', async () => {
    const store = new FakeIdempotencyStore();
    const service = new IdempotencyService(store, { staleTimeoutMs: 10 });

    await service.claimOrReplay('key-1', 'transfer', requestBody);

    const record = store.getRecord('key-1', 'transfer')!;
    record.createdAt = new Date(Date.now() - 20).toISOString();

    const result = await service.claimOrReplay('key-1', 'transfer', requestBody);
    expect(result).toBeNull();
  });

  it('allows same key for different operations', async () => {
    const store = new FakeIdempotencyStore();
    const service = new IdempotencyService(store);

    const transfer = await service.claimOrReplay('key-1', 'transfer', requestBody);
    expect(transfer).toBeNull();

    const funding = await service.claimOrReplay('key-1', 'fund', { amount: '100' });
    expect(funding).toBeNull();

    expect(store.getRecord('key-1', 'transfer')?.operation).toBe('transfer');
    expect(store.getRecord('key-1', 'fund')?.operation).toBe('fund');
  });
});
