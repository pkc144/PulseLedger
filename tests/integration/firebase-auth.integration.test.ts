import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createPool } from '../../src/infrastructure/database/pool.js';
import { runMigrations } from '../../src/infrastructure/database/migrate.js';
import { createFirebaseTokenVerifier } from '../../src/infrastructure/http/firebase-id-token.js';
import { createTestPrincipal } from '../helpers/auth.js';
import {
  createTestFirebaseSigner,
  testFirebaseProjectId,
  type TestFirebaseSigner,
} from '../helpers/firebase.js';

let container: StartedPostgreSqlContainer | undefined;
let pool: pg.Pool;
let app: Awaited<ReturnType<typeof buildApp>>;
let signer: TestFirebaseSigner;

beforeAll(async () => {
  let databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) {
    container = await new PostgreSqlContainer('postgres:17-alpine')
      .withDatabase('pulseledger_firebase_test')
      .withUsername('pulseledger')
      .withPassword('pulseledger')
      .start();
    databaseUrl = container.getConnectionUri();
  }

  pool = createPool(databaseUrl);
  await runMigrations(pool);
  signer = await createTestFirebaseSigner();
  app = await buildApp({
    adminApiKey: 'test-admin-api-key-0123456789',
    database: pool,
    firebaseTokenVerifier: createFirebaseTokenVerifier({
      keys: signer.keys,
      projectId: testFirebaseProjectId,
    }),
  });
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function identityRows(subject: string) {
  const result = await pool.query<{ principal_id: string }>(
    `SELECT principal_id FROM principal_identities WHERE provider = 'firebase' AND subject = $1`,
    [subject],
  );
  return result.rows;
}

describe('Firebase ID tokens as customer credentials', () => {
  it('provisions a principal on first sign-in and keeps the same one on every later sign-in', async () => {
    const token = await signer.sign({ sub: 'uid-first-login', name: 'First Login' });

    const created = await app.inject({
      method: 'POST',
      url: '/v1/accounts',
      headers: bearer(token),
      payload: { currency: 'INR' },
    });
    expect(created.statusCode).toBe(201);
    const accountId = created.json<{ id: string }>().id;

    // A brand-new token for the same user (as after a refresh) sees the same accounts.
    const later = await signer.sign({ sub: 'uid-first-login', iat: Math.floor(Date.now() / 1000) });
    const listed = await app.inject({ method: 'GET', url: '/v1/accounts', headers: bearer(later) });
    expect(listed.statusCode).toBe(200);
    expect(listed.json<{ accounts: { id: string }[] }>().accounts.map(({ id }) => id)).toEqual([
      accountId,
    ]);

    const rows = await identityRows('uid-first-login');
    expect(rows).toHaveLength(1);
    const principal = await pool.query<{ name: string; status: string }>(
      'SELECT name, status FROM principals WHERE id = $1',
      [rows[0]!.principal_id],
    );
    expect(principal.rows[0]).toEqual({ name: 'First Login', status: 'active' });
  });

  it('provisions a user whose display name contains characters PostgreSQL rejects', async () => {
    // A NUL in `text` is a hard PostgreSQL error; before sanitizing, this user's first sign-in
    // failed with a 500 every time and the identity could never be provisioned.
    const token = await signer.sign({ sub: 'uid-nul-name', name: 'Nul\u0000 Name' });
    const response = await app.inject({
      method: 'GET',
      url: '/v1/accounts',
      headers: bearer(token),
    });
    expect(response.statusCode).toBe(200);

    const rows = await identityRows('uid-nul-name');
    const principal = await pool.query<{ name: string }>(
      'SELECT name FROM principals WHERE id = $1',
      [rows[0]!.principal_id],
    );
    expect(principal.rows[0]!.name).toBe('Nul Name');
  });

  it('turns 20 simultaneous first sign-ins into exactly one principal', async () => {
    const subject = 'uid-concurrent-first-login';
    const name = `concurrent-${Date.now()}`;
    const token = await signer.sign({ sub: subject, name });

    const responses = await Promise.all(
      Array.from({ length: 20 }, () =>
        app.inject({ method: 'GET', url: '/v1/accounts', headers: bearer(token) }),
      ),
    );
    expect(responses.map((response) => response.statusCode)).toEqual(Array(20).fill(200));

    expect(await identityRows(subject)).toHaveLength(1);
    // The losers rolled back their own principal inserts: none is left orphaned.
    const principals = await pool.query('SELECT 1 FROM principals WHERE name = $1', [name]);
    expect(principals.rowCount).toBe(1);
  });

  it('refuses an unverified email with 403 and creates nothing', async () => {
    const token = await signer.sign({ sub: 'uid-unverified', email_verified: false });
    const response = await app.inject({
      method: 'GET',
      url: '/v1/accounts',
      headers: bearer(token),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'EMAIL_NOT_VERIFIED' } });
    expect(await identityRows('uid-unverified')).toHaveLength(0);
  });

  it('answers 401 for a token from another project, before any body validation', async () => {
    const token = await signer.sign({ aud: 'someone-elses-project' });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/transfers',
      headers: bearer(token),
      payload: { nonsense: true },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
  });

  it('isolates Firebase users from each other exactly like API-key principals', async () => {
    const owner = await signer.sign({ sub: 'uid-owner' });
    const stranger = await signer.sign({ sub: 'uid-stranger' });
    const created = await app.inject({
      method: 'POST',
      url: '/v1/accounts',
      headers: bearer(owner),
      payload: { currency: 'USD' },
    });
    const accountId = created.json<{ id: string }>().id;

    const peek = await app.inject({
      method: 'GET',
      url: `/v1/accounts/${accountId}`,
      headers: bearer(stranger),
    });
    expect(peek.statusCode).toBe(404);
  });

  it('locks out a Firebase user whose principal is disabled', async () => {
    const token = await signer.sign({ sub: 'uid-to-disable' });
    expect(
      (await app.inject({ method: 'GET', url: '/v1/accounts', headers: bearer(token) })).statusCode,
    ).toBe(200);
    const [row] = await identityRows('uid-to-disable');
    await pool.query("UPDATE principals SET status = 'disabled' WHERE id = $1", [
      row!.principal_id,
    ]);

    const response = await app.inject({
      method: 'GET',
      url: '/v1/accounts',
      headers: bearer(token),
    });
    expect(response.statusCode).toBe(401);
  });

  it('still accepts PulseLedger API keys on the same routes', async () => {
    const principal = await createTestPrincipal(pool, 'api-key-alongside-firebase');
    const response = await app.inject({
      method: 'GET',
      url: '/v1/accounts',
      headers: principal.authHeaders,
    });
    expect(response.statusCode).toBe(200);
  });

  it('rejects repointing or deleting an identity mapping at the database boundary', async () => {
    const token = await signer.sign({ sub: 'uid-immutable' });
    await app.inject({ method: 'GET', url: '/v1/accounts', headers: bearer(token) });
    const other = await createTestPrincipal(pool, 'repoint-target');

    await expect(
      pool.query(
        `UPDATE principal_identities SET principal_id = $1 WHERE subject = 'uid-immutable'`,
        [other.principalId],
      ),
    ).rejects.toThrow('immutable');
    await expect(
      pool.query(`DELETE FROM principal_identities WHERE subject = 'uid-immutable'`),
    ).rejects.toThrow('immutable');
  });
});
