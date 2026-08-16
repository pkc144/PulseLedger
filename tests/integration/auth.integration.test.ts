import { randomUUID } from 'node:crypto';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createPool } from '../../src/infrastructure/database/pool.js';
import { runMigrations } from '../../src/infrastructure/database/migrate.js';
import { createTestPrincipal, type TestPrincipal } from '../helpers/auth.js';

const testAdminApiKey = 'test-admin-api-key-0123456789';
const adminHeaders = { 'x-admin-api-key': testAdminApiKey };

let container: StartedPostgreSqlContainer | undefined;
let pool: pg.Pool;
let app: Awaited<ReturnType<typeof buildApp>>;
let alice: TestPrincipal;
let mallory: TestPrincipal;

beforeAll(async () => {
  let databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) {
    container = await new PostgreSqlContainer('postgres:17-alpine')
      .withDatabase('pulseledger_auth_test')
      .withUsername('pulseledger')
      .withPassword('pulseledger')
      .start();
    databaseUrl = container.getConnectionUri();
  }

  pool = createPool(databaseUrl);
  await runMigrations(pool);
  app = await buildApp({ adminApiKey: testAdminApiKey, database: pool });
  alice = await createTestPrincipal(pool, 'alice');
  mallory = await createTestPrincipal(pool, 'mallory');
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

async function createAccount(
  owner: TestPrincipal,
  currency: 'INR' | 'USD' = 'INR',
): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/accounts',
    headers: { ...owner.authHeaders },
    payload: { currency },
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ id: string }>().id;
}

async function fund(accountId: string, amountMinor: string): Promise<void> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/admin/fund',
    headers: adminHeaders,
    payload: { accountId, amountMinor },
  });
  expect(response.statusCode).toBe(201);
}

describe('API key authentication', () => {
  it('rejects a request with no Authorization header', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/accounts',
      payload: { currency: 'INR' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
  });

  it('rejects malformed, unknown, and wrong-scheme credentials identically', async () => {
    const credentials = [
      'Basic abc',
      'Bearer',
      'Bearer ',
      `Bearer ${alice.key.slice(0, -4)}`, // right prefix, wrong secret
      'Bearer pl_live_not-a-real-key-at-all-000000000000000000',
      'Bearer totally-wrong',
    ];

    for (const authorization of credentials) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/accounts',
        headers: { authorization },
        payload: { currency: 'INR' },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
    }
  });

  it('authenticates before validating the body, so schemas leak nothing', async () => {
    // Fastify validates the body before `preHandler`, so this guard runs on `onRequest`. Without
    // that, an anonymous caller could map request schemas by reading 400s.
    const response = await app.inject({
      method: 'POST',
      url: '/v1/transfers',
      payload: { nonsense: true },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });

    const admin = await app.inject({
      method: 'POST',
      url: '/v1/admin/fund',
      payload: { nonsense: true },
    });
    expect(admin.statusCode).toBe(401);
  });

  it('accepts a valid key and attributes the account to its principal', async () => {
    const accountId = await createAccount(alice);
    const owner = await pool.query<{ owner_principal_id: string }>(
      'SELECT owner_principal_id FROM accounts WHERE id = $1',
      [accountId],
    );
    expect(owner.rows[0]?.owner_principal_id).toBe(alice.principalId);
  });

  it('never stores the secret, only its hash', async () => {
    const stored = await pool.query<{ key_hash: string; key_prefix: string }>(
      'SELECT key_prefix, key_hash FROM api_keys WHERE principal_id = $1',
      [alice.principalId],
    );
    const row = stored.rows[0]!;
    expect(alice.key).toContain(row.key_prefix);
    expect(row.key_hash).toMatch(/^[0-9a-f]{64}$/);
    // The full secret appears nowhere in the row.
    expect(JSON.stringify(row)).not.toContain(alice.key);
  });

  it('stops accepting a revoked key', async () => {
    const victim = await createTestPrincipal(pool, 'revoked');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/accounts',
          headers: { ...victim.authHeaders },
          payload: { currency: 'INR' },
        })
      ).statusCode,
    ).toBe(201);

    const keyRow = await pool.query<{ id: string }>(
      'SELECT id FROM api_keys WHERE principal_id = $1',
      [victim.principalId],
    );
    const revoke = await app.inject({
      method: 'POST',
      url: `/v1/admin/api-keys/${keyRow.rows[0]!.id}/revoke`,
      headers: adminHeaders,
    });
    expect(revoke.statusCode).toBe(200);

    const afterRevocation = await app.inject({
      method: 'POST',
      url: '/v1/accounts',
      headers: { ...victim.authHeaders },
      payload: { currency: 'INR' },
    });
    expect(afterRevocation.statusCode).toBe(401);
  });

  it('stops accepting keys belonging to a disabled principal', async () => {
    const suspended = await createTestPrincipal(pool, 'suspended');
    await pool.query("UPDATE principals SET status = 'disabled' WHERE id = $1", [
      suspended.principalId,
    ]);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/accounts',
      headers: { ...suspended.authHeaders },
      payload: { currency: 'INR' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('requires the admin key to mint or revoke customer credentials', async () => {
    const withCustomerKey = await app.inject({
      method: 'POST',
      url: '/v1/admin/principals',
      headers: { ...alice.authHeaders },
      payload: { name: 'self-issued' },
    });
    expect(withCustomerKey.statusCode).toBe(401);

    const withAdminKey = await app.inject({
      method: 'POST',
      url: '/v1/admin/principals',
      headers: adminHeaders,
      payload: { name: 'issued-by-admin' },
    });
    expect(withAdminKey.statusCode).toBe(201);

    const issued = await app.inject({
      method: 'POST',
      url: `/v1/admin/principals/${withAdminKey.json<{ id: string }>().id}/api-keys`,
      headers: adminHeaders,
    });
    expect(issued.statusCode).toBe(201);
    // The secret is returned exactly once, here, and never again.
    expect(issued.json<{ key: string }>().key).toMatch(/^pl_live_[A-Za-z0-9_-]{43}$/);
  });

  it('reports an unknown principal when issuing a key for one', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/v1/admin/principals/${randomUUID()}/api-keys`,
      headers: adminHeaders,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'PRINCIPAL_NOT_FOUND' } });
  });
});

describe('account ownership', () => {
  it("hides another principal's account behind a 404", async () => {
    const accountId = await createAccount(alice);

    const owner = await app.inject({
      method: 'GET',
      url: `/v1/accounts/${accountId}`,
      headers: { ...alice.authHeaders },
    });
    expect(owner.statusCode).toBe(200);

    const intruder = await app.inject({
      method: 'GET',
      url: `/v1/accounts/${accountId}`,
      headers: { ...mallory.authHeaders },
    });
    expect(intruder.statusCode).toBe(404);
    expect(intruder.json()).toMatchObject({ error: { code: 'ACCOUNT_NOT_FOUND' } });
  });

  it("hides another principal's journal entries behind the same 404", async () => {
    const accountId = await createAccount(alice);
    await fund(accountId, '5000');

    const owner = await app.inject({
      method: 'GET',
      url: `/v1/accounts/${accountId}/entries`,
      headers: { ...alice.authHeaders },
    });
    expect(owner.statusCode).toBe(200);
    expect(owner.json<{ entries: unknown[] }>().entries.length).toBe(1);

    const intruder = await app.inject({
      method: 'GET',
      url: `/v1/accounts/${accountId}/entries`,
      headers: { ...mallory.authHeaders },
    });
    expect(intruder.statusCode).toBe(404);
  });

  it('refuses to spend from an account the caller does not own, and posts nothing', async () => {
    const aliceAccount = await createAccount(alice);
    const malloryAccount = await createAccount(mallory);
    await fund(aliceAccount, '10000');

    const before = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM transfers',
    );

    const response = await app.inject({
      method: 'POST',
      url: '/v1/transfers',
      headers: { ...mallory.authHeaders },
      payload: {
        sourceAccountId: aliceAccount,
        destinationAccountId: malloryAccount,
        amountMinor: '10000',
      },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'ACCOUNT_NOT_FOUND' } });

    const after = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM transfers',
    );
    expect(after.rows[0]!.count).toBe(before.rows[0]!.count);

    const balance = await app.inject({
      method: 'GET',
      url: `/v1/accounts/${aliceAccount}`,
      headers: { ...alice.authHeaders },
    });
    expect(balance.json<{ balanceMinor: string }>().balanceMinor).toBe('10000');
  });

  it('allows paying an account owned by someone else', async () => {
    const aliceAccount = await createAccount(alice);
    const malloryAccount = await createAccount(mallory);
    await fund(aliceAccount, '10000');

    const response = await app.inject({
      method: 'POST',
      url: '/v1/transfers',
      headers: { ...alice.authHeaders },
      payload: {
        sourceAccountId: aliceAccount,
        destinationAccountId: malloryAccount,
        amountMinor: '2500',
      },
    });
    expect(response.statusCode).toBe(201);
  });

  it('lets both participants read the transfer, and nobody else', async () => {
    const aliceAccount = await createAccount(alice);
    const malloryAccount = await createAccount(mallory);
    const bystander = await createTestPrincipal(pool, 'bystander');
    await fund(aliceAccount, '10000');

    const created = await app.inject({
      method: 'POST',
      url: '/v1/transfers',
      headers: { ...alice.authHeaders },
      payload: {
        sourceAccountId: aliceAccount,
        destinationAccountId: malloryAccount,
        amountMinor: '1500',
      },
    });
    expect(created.statusCode).toBe(201);
    const transferId = created.json<{ id: string }>().id;

    for (const participant of [alice, mallory]) {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/transfers/${transferId}`,
        headers: { ...participant.authHeaders },
      });
      expect(response.statusCode).toBe(200);
    }

    const outsider = await app.inject({
      method: 'GET',
      url: `/v1/transfers/${transferId}`,
      headers: { ...bystander.authHeaders },
    });
    expect(outsider.statusCode).toBe(404);
    expect(outsider.json()).toMatchObject({ error: { code: 'TRANSFER_NOT_FOUND' } });
  });

  it('scopes an idempotency key to its principal', async () => {
    const aliceAccount = await createAccount(alice);
    const malloryAccount = await createAccount(mallory);
    await fund(aliceAccount, '10000');
    await fund(malloryAccount, '10000');

    const sharedKey = `shared-${randomUUID()}`;
    const payload = {
      sourceAccountId: aliceAccount,
      destinationAccountId: malloryAccount,
      amountMinor: '100',
    };

    const first = await app.inject({
      method: 'POST',
      url: '/v1/transfers',
      headers: { ...alice.authHeaders, 'idempotency-key': sharedKey },
      payload,
    });
    expect(first.statusCode).toBe(201);

    // Same key, same body, different caller: this is a different unit of work, so it must not
    // replay Alice's response -- and Mallory does not own the source, so it must not post either.
    const second = await app.inject({
      method: 'POST',
      url: '/v1/transfers',
      headers: { ...mallory.authHeaders, 'idempotency-key': sharedKey },
      payload,
    });
    expect(second.statusCode).toBe(404);
    expect(second.json()).toMatchObject({ error: { code: 'ACCOUNT_NOT_FOUND' } });
  });

  it('rejects a change of ownership at the database boundary', async () => {
    const accountId = await createAccount(alice);
    const error = await pool
      .query('UPDATE accounts SET owner_principal_id = $2 WHERE id = $1', [
        accountId,
        mallory.principalId,
      ])
      .then(
        () => null,
        (caught: Error) => caught,
      );
    expect(error?.message).toContain('ownership is immutable');
  });

  it('refuses to create a customer account with no owner', async () => {
    const error = await pool
      .query("INSERT INTO accounts (id, currency) VALUES ($1, 'INR')", [randomUUID()])
      .then(
        () => null,
        (caught: Error) => caught,
      );
    expect(error?.message).toContain('accounts_customer_owner_check');
  });
});
