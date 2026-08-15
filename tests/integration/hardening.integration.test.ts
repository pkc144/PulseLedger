import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createPool } from '../../src/infrastructure/database/pool.js';
import { runMigrations } from '../../src/infrastructure/database/migrate.js';

const testAdminApiKey = 'test-admin-api-key-0123456789';

let container: StartedPostgreSqlContainer | undefined;
let pool: pg.Pool;
let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  let databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) {
    container = await new PostgreSqlContainer('postgres:17-alpine')
      .withDatabase('pulseledger_hardening_test')
      .withUsername('pulseledger')
      .withPassword('pulseledger')
      .start();
    databaseUrl = container.getConnectionUri();
  }

  pool = createPool(databaseUrl);
  await runMigrations(pool);
  app = await buildApp({
    adminApiKey: testAdminApiKey,
    database: pool,
    requestLimits: {
      bodyLimitBytes: 256,
      connectionTimeoutMs: 10_000,
      keepAliveTimeoutMs: 5_000,
      requestTimeoutMs: 30_000,
    },
  });
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  await pool.query(
    'UPDATE accounts SET balance_minor = 0, updated_at = now() WHERE NOT is_treasury',
  );
  await pool.query(
    `UPDATE accounts SET balance_minor = 0, updated_at = now()
     WHERE is_treasury AND currency IN ('INR', 'USD')`,
  );
});

async function createAccount(): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/accounts',
    payload: { currency: 'INR' },
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ id: string }>().id;
}

describe('admin API key protection', () => {
  it('rejects /v1/admin/fund with no key', async () => {
    const accountId = await createAccount();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/admin/fund',
      payload: { accountId, amountMinor: '100' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
  });

  it('rejects /v1/admin/fund with the wrong key', async () => {
    const accountId = await createAccount();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/admin/fund',
      headers: { 'x-admin-api-key': 'definitely-wrong' },
      payload: { accountId, amountMinor: '100' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('accepts /v1/admin/fund with the correct key', async () => {
    const accountId = await createAccount();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/admin/fund',
      headers: { 'x-admin-api-key': testAdminApiKey },
      payload: { accountId, amountMinor: '100' },
    });
    expect(response.statusCode).toBe(201);
  });

  it('never protects customer-facing or health routes', async () => {
    const account = await app.inject({
      method: 'POST',
      url: '/v1/accounts',
      payload: { currency: 'INR' },
    });
    expect(account.statusCode).toBe(201);

    const live = await app.inject({ method: 'GET', url: '/health/live' });
    expect(live.statusCode).toBe(200);
  });
});

describe('admin metrics', () => {
  it('rejects without the admin key', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/admin/metrics' });
    expect(response.statusCode).toBe(401);
  });

  it('reports the in-process transfer counters', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/admin/metrics',
      headers: { 'x-admin-api-key': testAdminApiKey },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      transfers: { completed: number; exhausted: number; retries: number };
    }>();
    expect(Number.isInteger(body.transfers.completed)).toBe(true);
    expect(Number.isInteger(body.transfers.retries)).toBe(true);
    expect(Number.isInteger(body.transfers.exhausted)).toBe(true);
  });

  it('increments completed after a real transfer', async () => {
    const before = await app.inject({
      method: 'GET',
      url: '/v1/admin/metrics',
      headers: { 'x-admin-api-key': testAdminApiKey },
    });
    const beforeCompleted = before.json<{ transfers: { completed: number } }>().transfers.completed;

    const source = await createAccount();
    const destination = await createAccount();
    await app.inject({
      method: 'POST',
      url: '/v1/admin/fund',
      headers: { 'x-admin-api-key': testAdminApiKey },
      payload: { accountId: source, amountMinor: '500' },
    });
    const transferResponse = await app.inject({
      method: 'POST',
      url: '/v1/transfers',
      headers: { 'idempotency-key': `metrics-test-${source}` },
      payload: { sourceAccountId: source, destinationAccountId: destination, amountMinor: '100' },
    });
    expect(transferResponse.statusCode).toBe(201);

    const after = await app.inject({
      method: 'GET',
      url: '/v1/admin/metrics',
      headers: { 'x-admin-api-key': testAdminApiKey },
    });
    const afterCompleted = after.json<{ transfers: { completed: number } }>().transfers.completed;
    expect(afterCompleted).toBe(beforeCompleted + 1);
  });
});

describe('request body limit', () => {
  it('rejects an oversized body with 413 REQUEST_REJECTED', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/accounts',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ currency: 'INR', padding: 'x'.repeat(1024) }),
    });
    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ error: { code: 'REQUEST_REJECTED' } });
  });
});

describe('graceful shutdown', () => {
  it('serves a real request over a real socket, then stops accepting connections after close', async () => {
    const draining = await buildApp({ adminApiKey: testAdminApiKey, database: pool });
    await draining.listen({ host: '127.0.0.1', port: 0 });
    const address = draining.server.address();
    if (typeof address !== 'object' || address === null) {
      throw new Error('expected a real listening address');
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const response = await fetch(`${baseUrl}/health/live`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });

    await draining.close();

    await expect(fetch(`${baseUrl}/health/live`)).rejects.toThrow();
  });
});
