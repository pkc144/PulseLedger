import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createPool } from '../../src/infrastructure/database/pool.js';
import { runMigrations } from '../../src/infrastructure/database/migrate.js';
import { createTestPrincipal, type TestPrincipal } from '../helpers/auth.js';
import type { ReconciliationReport } from '../../src/modules/reconciliation/reconciliation-domain.js';
import { PostgresReconciliationStore } from '../../src/modules/reconciliation/reconciliation-repository.js';

const testAdminApiKey = 'test-admin-api-key-0123456789';

let container: StartedPostgreSqlContainer | undefined;
let pool: pg.Pool;
let store: PostgresReconciliationStore;
let app: Awaited<ReturnType<typeof buildApp>>;
let principal: TestPrincipal;

beforeAll(async () => {
  let databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) {
    container = await new PostgreSqlContainer('postgres:17-alpine')
      .withDatabase('pulseledger_reconciliation_test')
      .withUsername('pulseledger')
      .withPassword('pulseledger')
      .start();
    databaseUrl = container.getConnectionUri();
  }

  pool = createPool(databaseUrl);
  await runMigrations(pool);
  store = new PostgresReconciliationStore(pool);
  app = await buildApp({ adminApiKey: testAdminApiKey, database: pool });
  principal = await createTestPrincipal(pool, 'integration');
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

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

async function createAccount(currency: 'INR' | 'USD' = 'INR'): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/accounts',
    payload: { currency },
    headers: { ...principal.authHeaders },
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

function findIssue(report: ReconciliationReport, accountId: string) {
  return report.issues.find((issue) => issue.accountId === accountId);
}

describe('reconciliation', () => {
  it('reports a clean system when cached balances match the journal', async () => {
    const accountId = await createAccount('INR');
    await fund(accountId, '2500');

    const report = await store.run();

    expect(findIssue(report, accountId)).toBeUndefined();
  });

  it('reports a mismatch and does not repair it when the cache drifts from the journal', async () => {
    const accountId = await createAccount('INR');
    await fund(accountId, '5000');

    // Seed corruption: directly overwrite the cached balance, bypassing the ledger entirely —
    // this is exactly the class of bug reconciliation exists to catch.
    await pool.query('UPDATE accounts SET balance_minor = 999999 WHERE id = $1', [accountId]);

    const report = await store.run();
    const issue = findIssue(report, accountId);

    expect(report.ok).toBe(false);
    expect(issue).toMatchObject({
      cachedBalanceMinor: '999999',
      computedBalanceMinor: '5000',
      type: 'mismatched',
    });

    // Reconciliation is read-only: running it must not have touched the corrupted row.
    const after = await pool.query<{ balance_minor: string }>(
      'SELECT balance_minor::text FROM accounts WHERE id = $1',
      [accountId],
    );
    expect(after.rows[0]!.balance_minor).toBe('999999');
  });

  it('reports a missing issue when a nonzero cached balance has no journal support', async () => {
    const accountId = await createAccount('USD');
    // No funding/transfer ever posted — zero journal entries for this account — yet the cache
    // shows a balance. This can only happen if something wrote balance_minor directly.
    await pool.query('UPDATE accounts SET balance_minor = 4200 WHERE id = $1', [accountId]);

    const report = await store.run();
    const issue = findIssue(report, accountId);

    expect(report.ok).toBe(false);
    expect(issue).toMatchObject({
      cachedBalanceMinor: '4200',
      computedBalanceMinor: '0',
      type: 'missing',
    });
  });

  it('does not report a fresh zero-balance account with no journal entries', async () => {
    const accountId = await createAccount('INR');

    const report = await store.run();

    expect(findIssue(report, accountId)).toBeUndefined();
  });

  it('POST /v1/admin/reconcile returns a clean report over HTTP', async () => {
    const accountId = await createAccount('INR');
    await fund(accountId, '1000');

    const response = await app.inject({
      method: 'POST',
      url: '/v1/admin/reconcile',
      headers: { 'x-admin-api-key': testAdminApiKey },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<ReconciliationReport>();
    expect(findIssue(body, accountId)).toBeUndefined();
  });

  it('POST /v1/admin/reconcile reports a seeded mismatch over HTTP', async () => {
    const accountId = await createAccount('INR');
    await fund(accountId, '1000');
    await pool.query('UPDATE accounts SET balance_minor = 1 WHERE id = $1', [accountId]);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/admin/reconcile',
      headers: { 'x-admin-api-key': testAdminApiKey },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<ReconciliationReport>();
    expect(body.ok).toBe(false);
    expect(findIssue(body, accountId)).toMatchObject({ type: 'mismatched' });
  });

  it('rejects POST /v1/admin/reconcile without a valid admin API key', async () => {
    const missingKey = await app.inject({ method: 'POST', url: '/v1/admin/reconcile' });
    expect(missingKey.statusCode).toBe(401);
    expect(missingKey.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });

    const wrongKey = await app.inject({
      method: 'POST',
      url: '/v1/admin/reconcile',
      headers: { 'x-admin-api-key': 'not-the-right-key' },
    });
    expect(wrongKey.statusCode).toBe(401);
  });
});
