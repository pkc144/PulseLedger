import { randomUUID } from 'node:crypto';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createPool } from '../../src/infrastructure/database/pool.js';
import { runMigrations } from '../../src/infrastructure/database/migrate.js';

let container: StartedPostgreSqlContainer | undefined;
let pool: pg.Pool;
let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  let databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) {
    container = await new PostgreSqlContainer('postgres:17-alpine')
      .withDatabase('pulseledger_test')
      .withUsername('pulseledger')
      .withPassword('pulseledger')
      .start();
    databaseUrl = container.getConnectionUri();
  }

  pool = createPool(databaseUrl);
  await runMigrations(pool);
  app = await buildApp({ database: pool });
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

describe('accounts with PostgreSQL', () => {
  it('seeds one treasury for each supported currency', async () => {
    const result = await pool.query<{ currency: string }>(
      'SELECT currency FROM accounts WHERE is_treasury ORDER BY currency',
    );
    expect(result.rows.map(({ currency }) => currency)).toEqual(['INR', 'USD']);
  });

  it('creates and retrieves a customer account', async () => {
    const createdResponse = await app.inject({
      method: 'POST',
      url: '/v1/accounts',
      payload: { currency: 'USD' },
    });
    expect(createdResponse.statusCode).toBe(201);
    const created = createdResponse.json<{ id: string }>();

    const fetchedResponse = await app.inject({ method: 'GET', url: `/v1/accounts/${created.id}` });
    expect(fetchedResponse.statusCode).toBe(200);
    expect(fetchedResponse.json()).toMatchObject({
      id: created.id,
      currency: 'USD',
      status: 'active',
      balanceMinor: '0',
    });
  });

  it('does not expose treasury accounts through the customer endpoint', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/accounts/00000000-0000-4000-8000-000000000001',
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'ACCOUNT_NOT_FOUND' } });
  });

  it('returns not found for an unknown account', async () => {
    const response = await app.inject({ method: 'GET', url: `/v1/accounts/${randomUUID()}` });
    expect(response.statusCode).toBe(404);
  });

  it('rejects currency mutation at the database boundary', async () => {
    const created = await pool.query<{ id: string }>(
      `INSERT INTO accounts (id, currency)
       VALUES ($1, 'INR')
       RETURNING id`,
      [randomUUID()],
    );
    await expect(
      pool.query("UPDATE accounts SET currency = 'USD' WHERE id = $1", [created.rows[0]!.id]),
    ).rejects.toThrow('immutable');
  });
});
