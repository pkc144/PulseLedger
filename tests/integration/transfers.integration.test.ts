import { randomUUID } from 'node:crypto';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
      .withDatabase('pulseledger_transfers_test')
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

async function createAccount(currency: 'INR' | 'USD' = 'INR'): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/accounts',
    payload: { currency },
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ id: string }>().id;
}

async function fund(accountId: string, amountMinor: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/admin/fund',
    headers: { 'x-admin-api-key': testAdminApiKey },
    payload: { accountId, amountMinor },
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ id: string }>().id;
}

async function balance(accountId: string): Promise<string> {
  const response = await app.inject({ method: 'GET', url: `/v1/accounts/${accountId}` });
  expect(response.statusCode).toBe(200);
  return response.json<{ balanceMinor: string }>().balanceMinor;
}

async function transfer(
  sourceAccountId: string,
  destinationAccountId: string,
  amountMinor: string,
) {
  return await app.inject({
    method: 'POST',
    url: '/v1/transfers',
    payload: { sourceAccountId, destinationAccountId, amountMinor },
  });
}

describe('serializable transfers with PostgreSQL', () => {
  it('validates identity, account status, and currency before posting', async () => {
    const sourceId = await createAccount();
    const destinationId = await createAccount();
    const usdDestinationId = await createAccount('USD');
    await fund(sourceId, '100');

    const self = await transfer(sourceId, sourceId, '1');
    expect(self.statusCode).toBe(400);
    expect(self.json()).toMatchObject({ error: { code: 'SELF_TRANSFER' } });

    const crossCurrency = await transfer(sourceId, usdDestinationId, '1');
    expect(crossCurrency.statusCode).toBe(400);
    expect(crossCurrency.json()).toMatchObject({ error: { code: 'CURRENCY_MISMATCH' } });

    await pool.query("UPDATE accounts SET status = 'frozen' WHERE id = $1", [destinationId]);
    const inactive = await transfer(sourceId, destinationId, '1');
    expect(inactive.statusCode).toBe(409);
    expect(inactive.json()).toMatchObject({ error: { code: 'ACCOUNT_NOT_ACTIVE' } });
  });

  it('rejects insufficient funds without partial rows or balance changes', async () => {
    const sourceId = await createAccount();
    const destinationId = await createAccount();
    await fund(sourceId, '25');
    const before = await pool.query<{ ledger_count: string; transfer_count: string }>(
      `SELECT
         (SELECT count(*)::text FROM ledger_transactions) AS ledger_count,
         (SELECT count(*)::text FROM transfers) AS transfer_count`,
    );

    const response = await transfer(sourceId, destinationId, '26');

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'INSUFFICIENT_FUNDS' } });
    const after = await pool.query<{ ledger_count: string; transfer_count: string }>(
      `SELECT
         (SELECT count(*)::text FROM ledger_transactions) AS ledger_count,
         (SELECT count(*)::text FROM transfers) AS transfer_count`,
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
    expect(await balance(sourceId)).toBe('25');
    expect(await balance(destinationId)).toBe('0');
  });

  it('commits a transfer and returns the same stable lookup representation', async () => {
    const sourceId = await createAccount();
    const destinationId = await createAccount();
    await fund(sourceId, '90');

    const completedBefore = app.transferMetrics.snapshot().completed;
    const response = await transfer(sourceId, destinationId, '40');
    expect(response.statusCode).toBe(201);
    const created = response.json<{ id: string }>();

    const fetched = await app.inject({ method: 'GET', url: `/v1/transfers/${created.id}` });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json()).toEqual(response.json());
    expect(app.transferMetrics.snapshot().completed).toBe(completedBefore + 1);
    expect(await balance(sourceId)).toBe('50');
    expect(await balance(destinationId)).toBe('40');

    const entries = await pool.query<{ credits: string; debits: string }>(
      `SELECT
         sum(amount_minor) FILTER (WHERE direction = 'debit')::text AS debits,
         sum(amount_minor) FILTER (WHERE direction = 'credit')::text AS credits
       FROM journal_entries WHERE transaction_id = $1`,
      [created.id],
    );
    expect(entries.rows[0]).toEqual({ credits: '40', debits: '40' });
  });

  it('allows only one concurrent withdrawal when two requests would overspend', async () => {
    const sourceId = await createAccount();
    const destinations = await Promise.all([createAccount(), createAccount()]);
    await fund(sourceId, '100');

    const responses = await Promise.all(
      destinations.map(async (destinationId) => await transfer(sourceId, destinationId, '80')),
    );

    expect(responses.map(({ statusCode }) => statusCode).sort()).toEqual([201, 409]);
    expect(await balance(sourceId)).toBe('20');
    const destinationBalances = await Promise.all(destinations.map(balance));
    expect(destinationBalances.sort()).toEqual(['0', '80']);
  });

  it('keeps a hot source non-negative across concurrent withdrawals', async () => {
    const sourceId = await createAccount();
    const destinations = await Promise.all(
      Array.from({ length: 12 }, async () => await createAccount()),
    );
    await fund(sourceId, '300');

    const responses = await Promise.all(
      destinations.map(async (destinationId) => await transfer(sourceId, destinationId, '25')),
    );

    expect(
      responses
        .filter(({ statusCode }) => statusCode !== 201)
        .map((response) => ({ body: response.json<unknown>(), statusCode: response.statusCode })),
    ).toEqual([]);
    expect(await balance(sourceId)).toBe('0');
    expect(await Promise.all(destinations.map(balance))).toEqual(
      Array.from({ length: 12 }, () => '25'),
    );
  });

  it('preserves totals for opposing concurrent transfers', async () => {
    const firstId = await createAccount();
    const secondId = await createAccount();
    await Promise.all([fund(firstId, '500'), fund(secondId, '500')]);

    const operations = Array.from({ length: 6 }, () => [
      transfer(firstId, secondId, '10'),
      transfer(secondId, firstId, '10'),
    ]).flat();
    const responses = await Promise.all(operations);

    expect(
      responses
        .filter(({ statusCode }) => statusCode !== 201)
        .map((response) => ({ body: response.json<unknown>(), statusCode: response.statusCode })),
    ).toEqual([]);
    const finalBalances = [BigInt(await balance(firstId)), BigInt(await balance(secondId))];
    expect(finalBalances).toEqual([500n, 500n]);
    expect(finalBalances.reduce((sum, value) => sum + value, 0n)).toBe(1000n);
  });

  it('matches a sequential reference model', async () => {
    const accountIds = await Promise.all([createAccount(), createAccount(), createAccount()]);
    const expected = new Map<string, bigint>([
      [accountIds[0], 300n],
      [accountIds[1], 200n],
      [accountIds[2], 100n],
    ]);
    await Promise.all([
      fund(accountIds[0], '300'),
      fund(accountIds[1], '200'),
      fund(accountIds[2], '100'),
    ]);
    const operations = [
      [0, 1, 50n],
      [1, 2, 30n],
      [2, 0, 20n],
      [0, 2, 40n],
    ] as const;

    for (const [sourceIndex, destinationIndex, amount] of operations) {
      const sourceId = accountIds[sourceIndex];
      const destinationId = accountIds[destinationIndex];
      const response = await transfer(sourceId, destinationId, amount.toString());
      expect(response.statusCode).toBe(201);
      expected.set(sourceId, expected.get(sourceId)! - amount);
      expected.set(destinationId, expected.get(destinationId)! + amount);
    }

    const actual = await Promise.all(accountIds.map(async (id) => BigInt(await balance(id))));
    expect(actual).toEqual(accountIds.map((id) => expected.get(id)));
  });

  it('returns not found for an unknown transfer', async () => {
    const response = await app.inject({ method: 'GET', url: `/v1/transfers/${randomUUID()}` });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'TRANSFER_NOT_FOUND' } });
  });

  it('rejects a transfer record linked to a funding ledger transaction', async () => {
    const sourceId = await createAccount();
    const destinationId = await createAccount();
    const fundingTransactionId = await fund(sourceId, '10');

    await expect(
      pool.query(
        `INSERT INTO transfers
           (id, source_account_id, destination_account_id, amount_minor, currency, status)
         VALUES ($1, $2, $3, 10, 'INR', 'completed')`,
        [fundingTransactionId, sourceId, destinationId],
      ),
    ).rejects.toThrow('transfers_ledger_identity_fk');
  });
});
