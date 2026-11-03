import { randomUUID } from 'node:crypto';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createPool } from '../../src/infrastructure/database/pool.js';
import { runMigrations } from '../../src/infrastructure/database/migrate.js';
import { PostgresIdempotencyStore } from '../../src/modules/idempotency/idempotency-repository.js';
import {
  computeCanonicalFingerprint,
  IdempotencyService,
} from '../../src/modules/idempotency/idempotency-service.js';
import { PostgresTransferStore } from '../../src/modules/transfers/transfer-repository.js';
import { TransferService } from '../../src/modules/transfers/transfer-service.js';
import { createTestPrincipal, type TestPrincipal } from '../helpers/auth.js';

const testAdminApiKey = 'test-admin-api-key-0123456789';

let container: StartedPostgreSqlContainer | undefined;
let pool: pg.Pool;
let app: Awaited<ReturnType<typeof buildApp>>;
let principal: TestPrincipal;

beforeAll(async () => {
  let databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) {
    container = await new PostgreSqlContainer('postgres:17-alpine')
      .withDatabase('pulseledger_idempotency_test')
      .withUsername('pulseledger')
      .withPassword('pulseledger')
      .start();
    databaseUrl = container.getConnectionUri();
  }

  pool = createPool(databaseUrl);
  await runMigrations(pool);
  app = await buildApp({ adminApiKey: testAdminApiKey, database: pool });
  principal = await createTestPrincipal(pool, 'integration');
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  await pool.query('TRUNCATE transfers, journal_entries, ledger_transactions, idempotency_records');
  await pool.query(
    'UPDATE accounts SET balance_minor = 0, updated_at = now() WHERE NOT is_treasury',
  );
  await pool.query(
    `UPDATE accounts SET balance_minor = 0, updated_at = now()
     WHERE is_treasury AND currency IN ('INR', 'USD')`,
  );
});

async function createAccount(currency: 'INR' | 'USD' = 'INR'): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/accounts',
    headers: { ...principal.authHeaders },
    payload: { currency },
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ id: string }>().id;
}

async function fund(accountId: string, amountMinor: string): Promise<void> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/admin/fund',
    headers: { 'x-admin-api-key': testAdminApiKey },
    payload: { accountId, amountMinor },
  });
  expect(response.statusCode).toBe(201);
}

async function transfer(
  sourceAccountId: string,
  destinationAccountId: string,
  amountMinor: string,
  idempotencyKey?: string,
) {
  const headers: Record<string, string> = {};
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;

  return await app.inject({
    method: 'POST',
    url: '/v1/transfers',
    headers: { ...principal.authHeaders, ...headers },
    payload: { sourceAccountId, destinationAccountId, amountMinor },
  });
}

async function countTransfers(): Promise<number> {
  const result = await pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM transfers',
  );
  return Number(result.rows[0]!.count);
}

describe('request idempotency with PostgreSQL', () => {
  it('replays a completed response for the same key and body', async () => {
    const sourceId = await createAccount();
    const destinationId = await createAccount();
    await fund(sourceId, '100');
    const key = `test-key-${randomUUID()}`;

    const first = await transfer(sourceId, destinationId, '30', key);
    expect(first.statusCode).toBe(201);
    const firstBody = first.json<Record<string, unknown>>();

    const second = await transfer(sourceId, destinationId, '30', key);
    expect(second.statusCode).toBe(201);
    expect(second.json()).toEqual(firstBody);

    expect(await countTransfers()).toBe(1);
  });

  it('returns conflict for same key with different request body', async () => {
    const sourceId = await createAccount();
    const dest1Id = await createAccount();
    const dest2Id = await createAccount();
    await fund(sourceId, '100');
    const key = `test-key-${randomUUID()}`;

    await transfer(sourceId, dest1Id, '10', key);

    const conflict = await transfer(sourceId, dest2Id, '20', key);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } });
  });

  it('does not create a second transfer when idempotency key is reused', async () => {
    const sourceId = await createAccount();
    const destinationId = await createAccount();
    await fund(sourceId, '200');
    const key = `test-key-${randomUUID()}`;

    await transfer(sourceId, destinationId, '50', key);
    expect(await countTransfers()).toBe(1);

    const replay = await transfer(sourceId, destinationId, '50', key);
    expect(replay.statusCode).toBe(201);
    expect(await countTransfers()).toBe(1);
  });

  it('stores the idempotency record atomically with the transfer', async () => {
    const sourceId = await createAccount();
    const destinationId = await createAccount();
    await fund(sourceId, '100');
    const key = `test-key-${randomUUID()}`;

    await transfer(sourceId, destinationId, '25', key);

    const record = await pool.query<{ status: string; response_status_code: number }>(
      `SELECT status, response_status_code
       FROM idempotency_records
       WHERE key = $1 AND operation = 'transfer'`,
      [key],
    );
    expect(record.rows[0]).toEqual({ status: 'completed', response_status_code: 201 });
  });

  it('allows key reuse across different operations', async () => {
    const sourceId = await createAccount();
    const destinationId = await createAccount();
    await fund(sourceId, '100');
    const key = `test-key-${randomUUID()}`;

    const transfer1 = await transfer(sourceId, destinationId, '10', key);
    expect(transfer1.statusCode).toBe(201);

    const operations = await pool.query<{ operation: string }>(
      'SELECT operation FROM idempotency_records WHERE key = $1',
      [key],
    );
    expect(operations.rows.map(({ operation }) => operation)).toEqual(['transfer']);
  });

  it('handles 50 concurrent identical requests creating exactly one transfer', async () => {
    const sourceId = await createAccount();
    const destinationId = await createAccount();
    await fund(sourceId, '500');
    const key = `concurrent-key-${randomUUID()}`;

    const before = await countTransfers();

    const responses = await Promise.all(
      Array.from({ length: 50 }, async () => await transfer(sourceId, destinationId, '10', key)),
    );

    const successfulBodies = responses
      .filter(({ statusCode }) => statusCode === 201)
      .map((response) => response.json<{ id: string }>().id);

    expect(new Set(successfulBodies).size).toBe(1);

    const after = await countTransfers();
    expect(after - before).toBe(1);
  });

  it('simulates lost-response retry safely', async () => {
    const sourceId = await createAccount();
    const destinationId = await createAccount();
    await fund(sourceId, '100');
    const key = `lost-response-${randomUUID()}`;

    const first = await transfer(sourceId, destinationId, '40', key);
    expect(first.statusCode).toBe(201);
    const firstResponse = first.json<Record<string, unknown>>();

    const retry = await transfer(sourceId, destinationId, '40', key);
    expect(retry.statusCode).toBe(201);
    expect(retry.json()).toEqual(firstResponse);

    expect(await countTransfers()).toBe(1);
  });

  it('transfers without idempotency key still work normally', async () => {
    const sourceId = await createAccount();
    const destinationId = await createAccount();
    await fund(sourceId, '100');

    const response = await transfer(sourceId, destinationId, '15');
    expect(response.statusCode).toBe(201);

    const second = await transfer(sourceId, destinationId, '15');
    expect(second.statusCode).toBe(201);
    expect(second.json<{ id: string }>().id).not.toBe(response.json<{ id: string }>().id);

    expect(await countTransfers()).toBe(2);
  });
});

/** Plants an `in_progress` claim that is already past the stale window, as a crash would leave. */
async function plantStaleClaim(key: string, body: unknown, owner = principal.principalId) {
  await pool.query(
    `INSERT INTO idempotency_records
       (principal_id, key, operation, request_fingerprint, status, created_at)
     VALUES ($1, $2, 'transfer', $3, 'in_progress', now() - interval '1 hour')`,
    [owner, key, computeCanonicalFingerprint(body)],
  );
}

describe('stale-claim reclaim', () => {
  it('hands a stale claim to exactly one of many concurrent reclaimers', async () => {
    const store = new PostgresIdempotencyStore(pool);
    const body = { amountMinor: '10', destinationAccountId: 'd', sourceAccountId: 's' };
    const key = `stale-${randomUUID()}`;
    await plantStaleClaim(key, body);

    const outcomes = await Promise.allSettled(
      Array.from({ length: 10 }, async () =>
        store.claim({
          fingerprint: computeCanonicalFingerprint(body),
          key,
          operation: 'transfer',
          principalId: principal.principalId,
          staleTimeoutMs: 30_000,
        }),
      ),
    );

    const proceeded = outcomes.filter(
      (outcome) => outcome.status === 'fulfilled' && outcome.value.action === 'proceed',
    );
    expect(proceeded).toHaveLength(1);
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') {
        expect(outcome.reason).toMatchObject({ code: 'IDEMPOTENCY_IN_PROGRESS' });
      }
    }
  });

  it('posts exactly one transfer when concurrent retries race to reclaim a stale key', async () => {
    const sourceId = await createAccount();
    const destinationId = await createAccount();
    await fund(sourceId, '1000');
    const key = `stale-race-${randomUUID()}`;
    await plantStaleClaim(key, {
      amountMinor: '10',
      destinationAccountId: destinationId,
      sourceAccountId: sourceId,
    });

    const responses = await Promise.all(
      Array.from({ length: 20 }, async () => await transfer(sourceId, destinationId, '10', key)),
    );

    expect(await countTransfers()).toBe(1);
    const ids = responses
      .filter(({ statusCode }) => statusCode === 201)
      .map((response) => response.json<{ id: string }>().id);
    expect(new Set(ids).size).toBe(1);
    expect(responses.every(({ statusCode }) => statusCode === 201 || statusCode === 409)).toBe(
      true,
    );
  });

  it('refuses to post a transfer whose claim it does not hold, and rolls the money back', async () => {
    const sourceId = await createAccount();
    const destinationId = await createAccount();
    await fund(sourceId, '100');
    const key = `already-completed-${randomUUID()}`;
    // The key was completed by some other request; this transfer never claimed it.
    await pool.query(
      `INSERT INTO idempotency_records
         (principal_id, key, operation, request_fingerprint, status, response_status_code,
          response_body, completed_at)
       VALUES ($1, $2, 'transfer', 'x', 'completed', 201, '{}', now())`,
      [principal.principalId, key],
    );

    const service = new TransferService(new PostgresTransferStore(pool));
    await expect(
      service.create(
        { amountMinor: '10', destinationAccountId: destinationId, sourceAccountId: sourceId },
        principal.principalId,
        { idempotencyKey: key },
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_IN_PROGRESS' });

    expect(await countTransfers()).toBe(0);
    const balance = await pool.query<{ balance_minor: string }>(
      'SELECT balance_minor::text FROM accounts WHERE id = $1',
      [sourceId],
    );
    expect(balance.rows[0]!.balance_minor).toBe('100');
  });
});

describe('failed requests under an idempotency key', () => {
  it('stores a business rejection and replays it, even after the cause is fixed', async () => {
    const sourceId = await createAccount();
    const destinationId = await createAccount();
    await fund(sourceId, '10');
    const key = `rejected-${randomUUID()}`;

    const first = await transfer(sourceId, destinationId, '50', key);
    expect(first.statusCode).toBe(409);
    expect(first.json()).toMatchObject({ error: { code: 'INSUFFICIENT_FUNDS' } });

    // Before: the claim stayed `in_progress`, so this retry got IDEMPOTENCY_IN_PROGRESS for 30 s
    // and then silently re-executed. Now the key's answer is the original rejection.
    await fund(sourceId, '100');
    const retry = await transfer(sourceId, destinationId, '50', key);
    expect(retry.statusCode).toBe(409);
    expect(retry.json()).toEqual(first.json());
    expect(await countTransfers()).toBe(0);

    const record = await pool.query<{ response_status_code: number; status: string }>(
      'SELECT status, response_status_code FROM idempotency_records WHERE key = $1',
      [key],
    );
    expect(record.rows[0]).toEqual({ status: 'completed', response_status_code: 409 });
  });

  it('releases an unfinished claim so the key can be retried at once', async () => {
    const store = new PostgresIdempotencyStore(pool);
    const service = new IdempotencyService(store);
    const body = { amountMinor: '10' };
    const key = `released-${randomUUID()}`;

    expect(await service.claimOrReplay(key, 'transfer', principal.principalId, body)).toBeNull();
    await service.settleFailure(key, 'transfer', principal.principalId, null);
    // Without the release this would be IDEMPOTENCY_IN_PROGRESS for the next 30 seconds.
    expect(await service.claimOrReplay(key, 'transfer', principal.principalId, body)).toBeNull();
  });

  it('never releases a completed record', async () => {
    const sourceId = await createAccount();
    const destinationId = await createAccount();
    await fund(sourceId, '100');
    const key = `kept-${randomUUID()}`;
    const first = await transfer(sourceId, destinationId, '10', key);
    expect(first.statusCode).toBe(201);

    await new PostgresIdempotencyStore(pool).release({
      key,
      operation: 'transfer',
      principalId: principal.principalId,
    });

    const replay = await transfer(sourceId, destinationId, '10', key);
    expect(replay.json()).toEqual(first.json());
    expect(await countTransfers()).toBe(1);
  });

  it('rejects an over-long key as a client error instead of a 500', async () => {
    const sourceId = await createAccount();
    const destinationId = await createAccount();
    await fund(sourceId, '100');

    const response = await transfer(sourceId, destinationId, '10', 'k'.repeat(257));
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    expect(await countTransfers()).toBe(0);
  });
});

describe('idempotent admin funding', () => {
  async function fundWithKey(accountId: string, amountMinor: string, key: string) {
    return await app.inject({
      method: 'POST',
      url: '/v1/admin/fund',
      headers: { 'x-admin-api-key': testAdminApiKey, 'idempotency-key': key },
      payload: { accountId, amountMinor },
    });
  }

  async function balanceOf(accountId: string): Promise<string> {
    const result = await pool.query<{ balance_minor: string }>(
      'SELECT balance_minor::text FROM accounts WHERE id = $1',
      [accountId],
    );
    return result.rows[0]!.balance_minor;
  }

  it('replays a retried funding instead of crediting the account twice', async () => {
    const accountId = await createAccount();
    const key = `fund-${randomUUID()}`;

    const first = await fundWithKey(accountId, '500', key);
    expect(first.statusCode).toBe(201);
    const second = await fundWithKey(accountId, '500', key);
    expect(second.statusCode).toBe(201);
    expect(second.json()).toEqual(first.json());

    expect(await balanceOf(accountId)).toBe('500');
  });

  it('credits exactly once under 20 concurrent identical fundings', async () => {
    const accountId = await createAccount();
    const key = `fund-concurrent-${randomUUID()}`;

    const responses = await Promise.all(
      Array.from({ length: 20 }, async () => await fundWithKey(accountId, '700', key)),
    );

    expect(await balanceOf(accountId)).toBe('700');
    const ids = responses
      .filter(({ statusCode }) => statusCode === 201)
      .map((response) => response.json<{ id: string }>().id);
    expect(new Set(ids).size).toBe(1);
  });

  it('conflicts when a funding key is reused with a different amount', async () => {
    const accountId = await createAccount();
    const key = `fund-conflict-${randomUUID()}`;

    expect((await fundWithKey(accountId, '100', key)).statusCode).toBe(201);
    const conflict = await fundWithKey(accountId, '200', key);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } });
    expect(await balanceOf(accountId)).toBe('100');
  });

  it('keeps funding keys apart from a customer using the same string for a transfer', async () => {
    const sourceId = await createAccount();
    const destinationId = await createAccount();
    const key = `shared-${randomUUID()}`;

    expect((await fundWithKey(sourceId, '100', key)).statusCode).toBe(201);
    const customerTransfer = await transfer(sourceId, destinationId, '40', key);
    expect(customerTransfer.statusCode).toBe(201);
    expect(await balanceOf(sourceId)).toBe('60');
  });
});
