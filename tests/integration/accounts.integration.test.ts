import { randomUUID } from 'node:crypto';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createPool } from '../../src/infrastructure/database/pool.js';
import { runMigrations } from '../../src/infrastructure/database/migrate.js';
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
      .withDatabase('pulseledger_test')
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

// Every test creates its own customer accounts, but the treasury row is shared process-wide;
// without resetting it, one test's funding activity silently shifts the absolute balance another
// test asserts on.
beforeEach(async () => {
  await pool.query(
    'TRUNCATE outbox_events, transfers, journal_entries, ledger_transactions, idempotency_records',
  );
  await pool.query(
    'UPDATE accounts SET balance_minor = 0, updated_at = now() WHERE NOT is_treasury',
  );
  await pool.query(
    `UPDATE accounts SET balance_minor = 0, updated_at = now()
     WHERE is_treasury AND currency IN ('INR', 'USD')`,
  );
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
      headers: { ...principal.authHeaders },
      payload: { currency: 'USD' },
    });
    expect(createdResponse.statusCode).toBe(201);
    const created = createdResponse.json<{ id: string }>();

    const fetchedResponse = await app.inject({
      method: 'GET',
      url: `/v1/accounts/${created.id}`,
      headers: { ...principal.authHeaders },
    });
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
      headers: { ...principal.authHeaders },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'ACCOUNT_NOT_FOUND' } });
  });

  it('returns not found for an unknown account', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/accounts/${randomUUID()}`,
      headers: { ...principal.authHeaders },
    });
    expect(response.statusCode).toBe(404);
  });

  it('rejects currency mutation at the database boundary', async () => {
    const created = await pool.query<{ id: string }>(
      `INSERT INTO accounts (id, currency, owner_principal_id)
       VALUES ($1, 'INR', $2)
       RETURNING id`,
      [randomUUID(), principal.principalId],
    );
    await expect(
      pool.query("UPDATE accounts SET currency = 'USD' WHERE id = $1", [created.rows[0]!.id]),
    ).rejects.toThrow('immutable');
  });
});

interface JournalEntriesResponse {
  entries: { amountMinor: string; createdAt: string; direction: string; id: string }[];
  nextCursor: string | null;
}

describe('GET /v1/accounts/:id/entries', () => {
  async function createFundedAccount(fundingCount: number): Promise<string> {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/accounts',
      headers: { ...principal.authHeaders },
      payload: { currency: 'INR' },
    });
    const accountId = created.json<{ id: string }>().id;
    for (let i = 0; i < fundingCount; i += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/admin/fund',
        headers: { 'x-admin-api-key': testAdminApiKey },
        payload: { accountId, amountMinor: '100' },
      });
      expect(response.statusCode).toBe(201);
    }
    return accountId;
  }

  it('returns an empty page with no next cursor for a fresh account', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/accounts',
      headers: { ...principal.authHeaders },
      payload: { currency: 'INR' },
    });
    const accountId = created.json<{ id: string }>().id;

    const response = await app.inject({
      method: 'GET',
      url: `/v1/accounts/${accountId}/entries`,
      headers: { ...principal.authHeaders },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<JournalEntriesResponse>()).toEqual({ entries: [], nextCursor: null });
  });

  it('paginates every entry exactly once, in order, across multiple pages', async () => {
    const accountId = await createFundedAccount(5);

    const collected: JournalEntriesResponse['entries'] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const query = cursor ? `?limit=2&cursor=${encodeURIComponent(cursor)}` : '?limit=2';
      const response = await app.inject({
        method: 'GET',
        url: `/v1/accounts/${accountId}/entries${query}`,
        headers: { ...principal.authHeaders },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json<JournalEntriesResponse>();
      collected.push(...body.entries);
      cursor = body.nextCursor ?? undefined;
      pages += 1;
      expect(pages).toBeLessThanOrEqual(10); // guard against an accidental infinite loop
    } while (cursor);

    expect(pages).toBe(3); // 2 + 2 + 1
    expect(collected).toHaveLength(5);
    expect(new Set(collected.map((entry) => entry.id)).size).toBe(5); // no duplicates
    expect(collected.every((entry) => entry.direction === 'debit')).toBe(true);
    const timestamps = collected.map((entry) => entry.createdAt);
    expect(timestamps).toEqual([...timestamps].sort());
  });

  it('respects a custom limit', async () => {
    const accountId = await createFundedAccount(5);

    const response = await app.inject({
      method: 'GET',
      url: `/v1/accounts/${accountId}/entries?limit=3`,
      headers: { ...principal.authHeaders },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<JournalEntriesResponse>();
    expect(body.entries).toHaveLength(3);
    expect(body.nextCursor).not.toBeNull();
  });

  it('returns 404 for an unknown account', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/accounts/${randomUUID()}/entries`,
      headers: { ...principal.authHeaders },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'ACCOUNT_NOT_FOUND' } });
  });

  it('returns 400 for a malformed cursor', async () => {
    const accountId = await createFundedAccount(1);
    const response = await app.inject({
      method: 'GET',
      url: `/v1/accounts/${accountId}/entries?cursor=not-a-real-cursor`,
      headers: { ...principal.authHeaders },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'INVALID_CURSOR' } });
  });
});

describe('double-entry ledger with PostgreSQL', () => {
  async function createCustomer(currency: 'INR' | 'USD' = 'INR'): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/accounts',
      headers: { ...principal.authHeaders },
      payload: { currency },
    });
    expect(response.statusCode).toBe(201);
    return response.json<{ id: string }>().id;
  }

  it('funds a customer with balanced journal entries and conserved balances', async () => {
    const customerId = await createCustomer();
    const before = await pool.query<{ total: string }>(
      `SELECT sum(balance_minor)::text AS total FROM accounts WHERE currency = 'INR'`,
    );

    const response = await app.inject({
      method: 'POST',
      url: '/v1/admin/fund',
      headers: { 'x-admin-api-key': testAdminApiKey },
      payload: { accountId: customerId, amountMinor: '12500' },
    });

    expect(response.statusCode).toBe(201);
    const transaction = response.json<{ id: string; reference: string }>();
    expect(transaction.reference).toBe(`funding:${transaction.id}`);

    const entries = await pool.query<{
      account_id: string;
      amount_minor: string;
      direction: string;
    }>(
      `SELECT account_id, direction, amount_minor::text
       FROM journal_entries
       WHERE transaction_id = $1
       ORDER BY direction`,
      [transaction.id],
    );
    expect(entries.rows).toEqual([
      {
        account_id: '00000000-0000-4000-8000-000000000001',
        direction: 'credit',
        amount_minor: '12500',
      },
      { account_id: customerId, direction: 'debit', amount_minor: '12500' },
    ]);

    const balances = await pool.query<{ balance_minor: string; id: string }>(
      `SELECT id, balance_minor::text
       FROM accounts
       WHERE id = ANY($1::uuid[])
       ORDER BY id`,
      [['00000000-0000-4000-8000-000000000001', customerId]],
    );
    expect(new Map(balances.rows.map(({ id, balance_minor }) => [id, balance_minor]))).toEqual(
      new Map([
        ['00000000-0000-4000-8000-000000000001', '-12500'],
        [customerId, '12500'],
      ]),
    );

    const after = await pool.query<{ total: string }>(
      `SELECT sum(balance_minor)::text AS total FROM accounts WHERE currency = 'INR'`,
    );
    expect(after.rows[0]!.total).toBe(before.rows[0]!.total);
  });

  it('rejects an unbalanced transaction atomically at commit', async () => {
    const customerId = await createCustomer('USD');
    const transactionId = randomUUID();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO ledger_transactions (id, type, reference, currency)
         VALUES ($1, 'funding', $2, 'USD')`,
        [transactionId, `unbalanced:${transactionId}`],
      );
      await client.query(
        `INSERT INTO journal_entries
           (id, transaction_id, account_id, currency, direction, amount_minor)
         VALUES ($1, $2, $3, 'USD', 'debit', 10)`,
        [randomUUID(), transactionId, customerId],
      );
      await client.query('UPDATE ledger_transactions SET finalized = true WHERE id = $1', [
        transactionId,
      ]);
      await expect(client.query('COMMIT')).rejects.toThrow('not balanced');
    } finally {
      client.release();
    }

    const rows = await pool.query('SELECT 1 FROM ledger_transactions WHERE id = $1', [
      transactionId,
    ]);
    expect(rows.rowCount).toBe(0);
  });

  it('rejects journal updates and deletes', async () => {
    const customerId = await createCustomer();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/admin/fund',
      headers: { 'x-admin-api-key': testAdminApiKey },
      payload: { accountId: customerId, amountMinor: '7' },
    });
    const transactionId = response.json<{ id: string }>().id;

    await expect(
      pool.query(`UPDATE journal_entries SET amount_minor = 8 WHERE transaction_id = $1`, [
        transactionId,
      ]),
    ).rejects.toThrow('append-only');
    await expect(
      pool.query('DELETE FROM journal_entries WHERE transaction_id = $1', [transactionId]),
    ).rejects.toThrow('append-only');
    await expect(
      pool.query(
        `INSERT INTO journal_entries
           (id, transaction_id, account_id, currency, direction, amount_minor)
         VALUES ($1, $2, $3, 'INR', 'debit', 7)`,
        [randomUUID(), transactionId, customerId],
      ),
    ).rejects.toThrow('finalized');
    await expect(
      pool.query(`UPDATE ledger_transactions SET reference = $2 WHERE id = $1`, [
        transactionId,
        `changed:${transactionId}`,
      ]),
    ).rejects.toThrow('append-only');
  });

  it.each(['0', '-1', '9223372036854775808'])(
    'rejects invalid funding amount %s without a posting',
    async (amountMinor) => {
      const customerId = await createCustomer();
      const before = await pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM ledger_transactions',
      );
      const response = await app.inject({
        method: 'POST',
        url: '/v1/admin/fund',
        headers: { 'x-admin-api-key': testAdminApiKey },
        payload: { accountId: customerId, amountMinor },
      });
      expect(response.statusCode).toBe(400);

      const after = await pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM ledger_transactions',
      );
      expect(after.rows[0]!.count).toBe(before.rows[0]!.count);
    },
  );
});
