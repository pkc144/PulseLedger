import { randomUUID } from 'node:crypto';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createPool } from '../../src/infrastructure/database/pool.js';
import { runMigrations } from '../../src/infrastructure/database/migrate.js';
import { createTestPrincipal, type TestPrincipal } from '../helpers/auth.js';
import { PostgresOutboxStore } from '../../src/modules/outbox/outbox-repository.js';
import { OutboxWorker } from '../../src/modules/outbox/outbox-worker.js';
import {
  outboxDefaultBatchSize,
  type OutboxRecord,
  type OutboxStore,
} from '../../src/modules/outbox/outbox-domain.js';

const testAdminApiKey = 'test-admin-api-key-0123456789';

let container: StartedPostgreSqlContainer | undefined;
let pool: pg.Pool;
let outboxStore: OutboxStore;
let app: Awaited<ReturnType<typeof buildApp>>;
let principal: TestPrincipal;

beforeAll(async () => {
  let databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) {
    container = await new PostgreSqlContainer('postgres:17-alpine')
      .withDatabase('pulseledger_outbox_test')
      .withUsername('pulseledger')
      .withPassword('pulseledger')
      .start();
    databaseUrl = container.getConnectionUri();
  }

  pool = createPool(databaseUrl);
  await runMigrations(pool);
  outboxStore = new PostgresOutboxStore(pool);
  app = await buildApp({ adminApiKey: testAdminApiKey, database: pool, outboxStore });
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
    headers: { ...principal.authHeaders },
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

describe('outbox integration', () => {
  describe('transfer outbox event', () => {
    it('commits an outbox event with every transfer', async () => {
      const sourceId = await createAccount('INR');
      const destinationId = await createAccount('INR');
      await fund(sourceId, '5000');

      const response = await app.inject({
        headers: { ...principal.authHeaders, 'idempotency-key': randomUUID() },
        method: 'POST',
        url: '/v1/transfers',
        payload: {
          amountMinor: '2000',
          destinationAccountId: destinationId,
          sourceAccountId: sourceId,
        },
      });
      expect(response.statusCode).toBe(201);
      const transfer = response.json<{ id: string }>();

      const result = await pool.query(
        `SELECT id, aggregate_id, aggregate_type, event_type, event_version, payload, status
         FROM outbox_events
         WHERE aggregate_id = $1`,
        [transfer.id],
      );

      expect(result.rows).toHaveLength(1);
      const row = result.rows[0] as Record<string, unknown>;
      expect(row.aggregate_type).toBe('transfer');
      expect(row.event_type).toBe('transfer.created');
      expect(row.event_version).toBe(1);
      expect(row.status).toBe('pending');
    });

    it('does not create outbox events for insufficient-funds transfers', async () => {
      const sourceId = await createAccount('INR');
      const destinationId = await createAccount('INR');
      await fund(sourceId, '1000');

      const response = await app.inject({
        headers: { ...principal.authHeaders, 'idempotency-key': randomUUID() },
        method: 'POST',
        url: '/v1/transfers',
        payload: {
          amountMinor: '5000',
          destinationAccountId: destinationId,
          sourceAccountId: sourceId,
        },
      });
      expect(response.statusCode).toBe(409);

      const result = await pool.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM outbox_events',
      );
      expect(result.rows[0]!.count).toBe(0);
    });
  });

  describe('claiming', () => {
    it('claims pending events in created_at order', async () => {
      const record1 = await pool.query<{ id: string }>(
        `INSERT INTO outbox_events (aggregate_id, aggregate_type, event_type, payload)
         VALUES ($1, 'transfer', 'transfer.created', '{"test":1}')
         RETURNING id`,
        [randomUUID()],
      );
      const record2 = await pool.query<{ id: string }>(
        `INSERT INTO outbox_events (aggregate_id, aggregate_type, event_type, payload)
         VALUES ($1, 'transfer', 'transfer.created', '{"test":2}')
         RETURNING id`,
        [randomUUID()],
      );

      const claimed = await outboxStore.claimBatch(10);

      expect(claimed).toHaveLength(2);
      expect(claimed[0]!.id).toBe(record1.rows[0]!.id);
      expect(claimed[1]!.id).toBe(record2.rows[0]!.id);
      expect(claimed[0]!.status).toBe('processing');
      expect(claimed[0]!.attempts).toBe(1);
    });

    it('does not claim already-processing events', async () => {
      await pool.query(
        `INSERT INTO outbox_events (aggregate_id, aggregate_type, event_type, payload)
         VALUES ($1, 'transfer', 'transfer.created', '{}')`,
        [randomUUID()],
      );

      const firstClaim = await outboxStore.claimBatch(10);
      expect(firstClaim).toHaveLength(1);

      const secondClaim = await outboxStore.claimBatch(10);
      expect(secondClaim).toHaveLength(0);
    });

    it('allows claiming failed events whose backoff has elapsed', async () => {
      await pool.query(
        `INSERT INTO outbox_events (aggregate_id, aggregate_type, event_type, payload, status, attempts, next_attempt_at)
         VALUES ($1, 'transfer', 'transfer.created', '{}', 'failed', 2, $2)`,
        [randomUUID(), new Date(Date.now() - 1000).toISOString()],
      );

      const claimed = await outboxStore.claimBatch(10);
      expect(claimed).toHaveLength(1);
      expect(claimed[0]!.status).toBe('processing');
      expect(claimed[0]!.attempts).toBe(3);
    });

    it('skips failed events whose backoff has not elapsed', async () => {
      await pool.query(
        `INSERT INTO outbox_events (aggregate_id, aggregate_type, event_type, payload, status, attempts, next_attempt_at)
         VALUES ($1, 'transfer', 'transfer.created', '{}', 'failed', 2, $2)`,
        [randomUUID(), new Date(Date.now() + 60_000).toISOString()],
      );

      const claimed = await outboxStore.claimBatch(10);
      expect(claimed).toHaveLength(0);
    });

    it('reclaims a stale processing event whose lease has elapsed', async () => {
      // Simulates a worker that claimed the event then crashed before finishing:
      // the row is left 'processing' with a lease in the past.
      await pool.query(
        `INSERT INTO outbox_events (aggregate_id, aggregate_type, event_type, payload, status, attempts, next_attempt_at)
         VALUES ($1, 'transfer', 'transfer.created', '{}', 'processing', 1, $2)`,
        [randomUUID(), new Date(Date.now() - 1000).toISOString()],
      );

      const claimed = await outboxStore.claimBatch(10);
      expect(claimed).toHaveLength(1);
      expect(claimed[0]!.status).toBe('processing');
      expect(claimed[0]!.attempts).toBe(2);
    });

    it('does not reclaim a processing event whose lease is still active', async () => {
      await pool.query(
        `INSERT INTO outbox_events (aggregate_id, aggregate_type, event_type, payload, status, attempts, next_attempt_at)
         VALUES ($1, 'transfer', 'transfer.created', '{}', 'processing', 1, $2)`,
        [randomUUID(), new Date(Date.now() + 60_000).toISOString()],
      );

      const claimed = await outboxStore.claimBatch(10);
      expect(claimed).toHaveLength(0);
    });

    it('never lets two workers double-claim the same event', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 20; i += 1) {
        const inserted = await pool.query<{ id: string }>(
          `INSERT INTO outbox_events (aggregate_id, aggregate_type, event_type, payload)
           VALUES ($1, 'transfer', 'transfer.created', '{}')
           RETURNING id`,
          [randomUUID()],
        );
        ids.push(inserted.rows[0]!.id);
      }

      const workerA = new PostgresOutboxStore(pool);
      const workerB = new PostgresOutboxStore(pool);
      const [batchA, batchB] = await Promise.all([workerA.claimBatch(20), workerB.claimBatch(20)]);

      const claimedIds = [...batchA, ...batchB].map((event) => event.id);
      expect(claimedIds).toHaveLength(20);
      expect(new Set(claimedIds).size).toBe(20);
      expect([...claimedIds].sort()).toEqual([...ids].sort());
    });
  });

  describe('processing result', () => {
    it('marks an event as processed on success', async () => {
      const eventId = randomUUID();
      await pool.query(
        `INSERT INTO outbox_events (id, aggregate_id, aggregate_type, event_type, payload)
         VALUES ($1, $2, 'transfer', 'transfer.created', '{}')`,
        [eventId, randomUUID()],
      );

      const claimed = await outboxStore.claimBatch(1);
      expect(claimed).toHaveLength(1);

      await outboxStore.markProcessed(claimed[0]!.id);

      const result = await pool.query<{ processed_at: Date | null; status: string }>(
        'SELECT status, processed_at FROM outbox_events WHERE id = $1',
        [eventId],
      );
      expect(result.rows[0]!.status).toBe('processed');
      expect(result.rows[0]!.processed_at).not.toBeNull();
    });

    it('marks an event as failed with next attempt time', async () => {
      const eventId = randomUUID();
      await pool.query(
        `INSERT INTO outbox_events (id, aggregate_id, aggregate_type, event_type, payload)
         VALUES ($1, $2, 'transfer', 'transfer.created', '{}')`,
        [eventId, randomUUID()],
      );

      const claimed = await outboxStore.claimBatch(1);
      expect(claimed).toHaveLength(1);

      const nextAttempt = new Date(Date.now() + 5_000);
      await outboxStore.markFailed(claimed[0]!.id, 'simulated failure', nextAttempt.toISOString());

      const result = await pool.query<{
        last_error: string | null;
        next_attempt_at: Date | null;
        status: string;
      }>('SELECT status, last_error, next_attempt_at FROM outbox_events WHERE id = $1', [eventId]);
      expect(result.rows[0]!.status).toBe('failed');
      expect(result.rows[0]!.last_error).toBe('simulated failure');
      expect(result.rows[0]!.next_attempt_at).not.toBeNull();
    });
  });

  describe('worker lifecycle', () => {
    it('processes a pending event end-to-end', async () => {
      const processedEvents: OutboxRecord[] = [];
      const worker = new OutboxWorker(outboxStore, {
        batchSize: outboxDefaultBatchSize,
        handler: async (event) => {
          processedEvents.push(event);
        },
      });

      await pool.query(
        `INSERT INTO outbox_events (aggregate_id, aggregate_type, event_type, payload)
         VALUES ($1, 'transfer', 'transfer.created', '{}')`,
        [randomUUID()],
      );

      worker.start();
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await worker.stop();

      expect(processedEvents.length).toBeGreaterThanOrEqual(1);

      const result = await pool.query<{ status: string }>(
        "SELECT status FROM outbox_events WHERE status = 'processed'",
      );
      expect(result.rows.length).toBeGreaterThanOrEqual(1);
    });

    it('retries failed events', async () => {
      let callCount = 0;
      const worker = new OutboxWorker(outboxStore, {
        batchSize: 1,
        pollIntervalMs: 100,
        handler: async () => {
          callCount += 1;
          throw new Error('handler failure');
        },
      });

      await pool.query(
        `INSERT INTO outbox_events (aggregate_id, aggregate_type, event_type, payload)
         VALUES ($1, 'transfer', 'transfer.created', '{}')`,
        [randomUUID()],
      );

      worker.start();
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await worker.stop();

      expect(callCount).toBeGreaterThanOrEqual(2);

      const result = await pool.query<{
        attempts: number;
        last_error: string | null;
        status: string;
      }>('SELECT status, attempts, last_error FROM outbox_events LIMIT 1');
      expect(result.rows[0]!.status).toBe('failed');
      expect(result.rows[0]!.attempts).toBeGreaterThanOrEqual(2);
      expect(result.rows[0]!.last_error).toBe('handler failure');
    });

    it('marks events as permanently failed after maxAttempts', async () => {
      let callCount = 0;
      const worker = new OutboxWorker(outboxStore, {
        batchSize: 1,
        maxAttempts: 3,
        pollIntervalMs: 50,
        handler: async () => {
          callCount += 1;
          throw new Error('permanent failure');
        },
      });

      await pool.query(
        `INSERT INTO outbox_events (aggregate_id, aggregate_type, event_type, payload)
         VALUES ($1, 'transfer', 'transfer.created', '{}')`,
        [randomUUID()],
      );

      worker.start();
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await worker.stop();

      expect(callCount).toBeGreaterThanOrEqual(3);

      const result = await pool.query<{
        attempts: number;
        last_error: string | null;
        status: string;
      }>('SELECT status, attempts, last_error FROM outbox_events LIMIT 1');
      expect(result.rows[0]!.status).toBe('failed');
      expect(result.rows[0]!.attempts).toBeGreaterThanOrEqual(3);
      expect(result.rows[0]!.last_error).toBe('permanent failure');
    });

    it('supports graceful shutdown', async () => {
      const worker = new OutboxWorker(outboxStore, {
        batchSize: 1,
        pollIntervalMs: 50,
      });

      expect(worker.isRunning()).toBe(false);
      worker.start();
      expect(worker.isRunning()).toBe(true);
      await worker.stop();
      expect(worker.isRunning()).toBe(false);
    });

    it('is safe to stop a stopped worker', async () => {
      const worker = new OutboxWorker(outboxStore);
      await worker.stop();
    });
  });

  describe('stats', () => {
    it('returns counts by status', async () => {
      await pool.query(
        `INSERT INTO outbox_events (aggregate_id, aggregate_type, event_type, payload)
         VALUES ($1, 'transfer', 'transfer.created', '{}')`,
        [randomUUID()],
      );
      await pool.query(
        `INSERT INTO outbox_events (aggregate_id, aggregate_type, event_type, payload, status, attempts)
         VALUES ($1, 'transfer', 'transfer.created', '{}', 'failed', 2)`,
        [randomUUID()],
      );

      const stats = await outboxStore.stats();
      expect(stats.pending).toBe(1);
      expect(stats.failed).toBe(1);
      expect(stats.processing).toBe(0);
    });
  });

  describe('recovery', () => {
    it('delivers a committed event after a worker restart (stop before processing)', async () => {
      await pool.query(
        `INSERT INTO outbox_events (aggregate_id, aggregate_type, event_type, payload)
         VALUES ($1, 'transfer', 'transfer.created', '{}')`,
        [randomUUID()],
      );

      // First worker is interrupted before it ever claims the event: its poll is
      // scheduled far in the future and it is stopped before the timer fires.
      const interrupted = new OutboxWorker(outboxStore, { pollIntervalMs: 60_000 });
      interrupted.start();
      await interrupted.stop();

      const beforeRestart = await outboxStore.stats();
      expect(beforeRestart.pending).toBe(1);

      // A fresh worker started after the restart still delivers the durable event.
      const processed: OutboxRecord[] = [];
      const restarted = new OutboxWorker(outboxStore, {
        pollIntervalMs: 50,
        handler: async (event) => {
          processed.push(event);
        },
      });
      restarted.start();
      await new Promise((resolve) => setTimeout(resolve, 500));
      await restarted.stop();

      expect(processed.length).toBeGreaterThanOrEqual(1);
      const result = await pool.query<{ status: string }>(
        'SELECT status FROM outbox_events LIMIT 1',
      );
      expect(result.rows[0]!.status).toBe('processed');
    });

    it('does not redeliver an event after restart once committed processed (stop after commit)', async () => {
      await pool.query(
        `INSERT INTO outbox_events (aggregate_id, aggregate_type, event_type, payload)
         VALUES ($1, 'transfer', 'transfer.created', '{}')`,
        [randomUUID()],
      );

      let deliveries = 0;
      const handler = async (): Promise<void> => {
        deliveries += 1;
      };

      const first = new OutboxWorker(outboxStore, { pollIntervalMs: 50, handler });
      first.start();
      await new Promise((resolve) => setTimeout(resolve, 400));
      await first.stop();
      expect(deliveries).toBe(1);

      // Restart: the already-processed event must not be delivered a second time.
      const second = new OutboxWorker(outboxStore, { pollIntervalMs: 50, handler });
      second.start();
      await new Promise((resolve) => setTimeout(resolve, 400));
      await second.stop();

      expect(deliveries).toBe(1);
    });
  });

  describe('health readiness', () => {
    it('reports outbox stats on /health/ready', async () => {
      await pool.query(
        `INSERT INTO outbox_events (aggregate_id, aggregate_type, event_type, payload)
         VALUES ($1, 'transfer', 'transfer.created', '{}')`,
        [randomUUID()],
      );
      await pool.query(
        `INSERT INTO outbox_events (aggregate_id, aggregate_type, event_type, payload, status, attempts)
         VALUES ($1, 'transfer', 'transfer.created', '{}', 'failed', 2)`,
        [randomUUID()],
      );

      const response = await app.inject({ method: 'GET', url: '/health/ready' });
      expect(response.statusCode).toBe(200);
      const body = response.json<{
        outbox: { failed: number; pending: number; processing: number };
        status: string;
      }>();
      expect(body.status).toBe('ready');
      expect(body.outbox).toEqual({ pending: 1, processing: 0, failed: 1 });
    });
  });
});
