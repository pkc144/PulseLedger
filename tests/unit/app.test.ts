import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import type {
  DatabaseConnection,
  QueryResult,
  TransactionalDatabase,
} from '../../src/ports/database.js';

class StubDatabase implements TransactionalDatabase, DatabaseConnection {
  public shouldFail = false;

  public async connect(): Promise<DatabaseConnection> {
    return this;
  }

  public release(): void {}

  public async query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>> {
    if (this.shouldFail) throw new Error('database unavailable');

    if (text.includes('INSERT INTO accounts')) {
      return {
        rowCount: 1,
        rows: [
          {
            id: randomUUID(),
            currency: values?.[1],
            status: 'active',
            balance_minor: '0',
            created_at: new Date('2026-08-01T00:00:00.000Z'),
          } as unknown as Row,
        ],
      };
    }

    return { rowCount: text.includes('SELECT 1') ? 1 : 0, rows: [] };
  }
}

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

describe('application routes', () => {
  it('reports liveness', async () => {
    const app = await buildApp({ database: new StubDatabase() });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/health/live' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('reports database readiness failure', async () => {
    const database = new StubDatabase();
    database.shouldFail = true;
    const app = await buildApp({ database });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'unavailable' });
  });

  it('creates a zero-balance account', async () => {
    const app = await buildApp({ database: new StubDatabase() });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/accounts',
      payload: { currency: 'INR' },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      currency: 'INR',
      status: 'active',
      balanceMinor: '0',
    });
  });

  it('returns a stable validation error with a request ID', async () => {
    const app = await buildApp({ database: new StubDatabase() });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/accounts',
      headers: { 'x-request-id': 'test-request-id' },
      payload: { currency: 'XYZ' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        requestId: 'test-request-id',
      },
    });
  });
});
