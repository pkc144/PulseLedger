import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../../src/infrastructure/database/pool.js';
import { runMigrations } from '../../src/infrastructure/database/migrate.js';
import { createTestPrincipal, type TestPrincipal } from '../helpers/auth.js';

const execFileAsync = promisify(execFile);
const cliPath = path.resolve('src/modules/reconciliation/reconcile-cli.ts');

let container: StartedPostgreSqlContainer | undefined;
let pool: pg.Pool;
let databaseUrl: string;
let principal: TestPrincipal;

beforeAll(async () => {
  databaseUrl = process.env.TEST_DATABASE_URL ?? '';
  if (!databaseUrl) {
    container = await new PostgreSqlContainer('postgres:17-alpine')
      .withDatabase('pulseledger_reconcile_cli_test')
      .withUsername('pulseledger')
      .withPassword('pulseledger')
      .start();
    databaseUrl = container.getConnectionUri();
  }

  pool = createPool(databaseUrl);
  await runMigrations(pool);
  principal = await createTestPrincipal(pool, 'reconcile-cli');
});

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

interface CliResult {
  code: number;
  stdout: string;
}

async function runReconcileCli(): Promise<CliResult> {
  try {
    const { stdout } = await execFileAsync('node', ['--import', 'tsx', cliPath], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        ADMIN_API_KEY: 'test-admin-api-key-0123456789',
      },
    });
    return { code: 0, stdout };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? '' };
  }
}

describe('reconcile CLI', () => {
  it('exits 0 and prints a clean report on a healthy database', async () => {
    await pool.query(
      'UPDATE accounts SET balance_minor = 0, updated_at = now() WHERE NOT is_treasury',
    );

    const result = await runReconcileCli();

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('"ok": true');
  });

  it('exits non-zero and prints the issue when a seeded mismatch exists', async () => {
    const accountId = randomUUID();
    await pool.query(
      `INSERT INTO accounts (id, currency, owner_principal_id) VALUES ($1, 'INR', $2)`,
      [accountId, principal.principalId],
    );
    await pool.query('UPDATE accounts SET balance_minor = 999 WHERE id = $1', [accountId]);

    try {
      const result = await runReconcileCli();

      expect(result.code).toBe(1);
      expect(result.stdout).toContain('"ok": false');
      expect(result.stdout).toContain(accountId);
    } finally {
      await pool.query('DELETE FROM accounts WHERE id = $1', [accountId]);
    }
  });
});
