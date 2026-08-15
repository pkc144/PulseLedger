import { randomUUID } from 'node:crypto';
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
      .withDatabase('pulseledger_idempotency_test')
      .withUsername('pulseledger')
      .withPassword('pulseledger')
      .start();
    databaseUrl = container.getConnectionUri();
  }

  pool = createPool(databaseUrl);
  await runMigrations(pool);
  app = await buildApp({ adminApiKey: testAdminApiKey, database: pool });
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
    headers,
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
