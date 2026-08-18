import { randomUUID } from 'node:crypto';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createPool } from '../../src/infrastructure/database/pool.js';
import { runMigrations } from '../../src/infrastructure/database/migrate.js';
import { PostgresIdempotencyStore } from '../../src/modules/idempotency/idempotency-repository.js';
import { OutboxAdminService } from '../../src/modules/outbox/outbox-admin-service.js';
import {
  PostgresOutboxAdminStore,
  PostgresOutboxStore,
} from '../../src/modules/outbox/outbox-repository.js';
import { createTestPrincipal, type TestPrincipal } from '../helpers/auth.js';

const testAdminApiKey = 'test-admin-api-key-0123456789';
const adminHeaders = { 'x-admin-api-key': testAdminApiKey };
const day = 24 * 60 * 60 * 1000;

let container: StartedPostgreSqlContainer | undefined;
let pool: pg.Pool;
let app: Awaited<ReturnType<typeof buildApp>>;
let principal: TestPrincipal;
let outboxAdmin: OutboxAdminService;
let idempotency: PostgresIdempotencyStore;

beforeAll(async () => {
  let databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) {
    container = await new PostgreSqlContainer('postgres:17-alpine')
      .withDatabase('pulseledger_operations_test')
      .withUsername('pulseledger')
      .withPassword('pulseledger')
      .start();
    databaseUrl = container.getConnectionUri();
  }

  pool = createPool(databaseUrl);
  await runMigrations(pool);
  app = await buildApp({
    adminApiKey: testAdminApiKey,
    database: pool,
    outboxStore: new PostgresOutboxStore(pool),
  });
  principal = await createTestPrincipal(pool, 'operations');
  outboxAdmin = new OutboxAdminService(new PostgresOutboxAdminStore(pool));
  idempotency = new PostgresIdempotencyStore(pool);
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  await pool.query('TRUNCATE outbox_events, idempotency_records');
});

async function insertEvent(overrides: {
  attempts?: number;
  nextAttemptAt?: string | null;
  processedAt?: string | null;
  status: string;
}): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO outbox_events
       (aggregate_id, aggregate_type, event_type, payload, status, attempts, last_error,
        next_attempt_at, processed_at)
     VALUES ($1, 'transfer', 'transfer.created', '{"demo":true}', $2, $3, 'handler exploded', $4, $5)
     RETURNING id`,
    [
      randomUUID(),
      overrides.status,
      overrides.attempts ?? 0,
      overrides.nextAttemptAt ?? null,
      overrides.processedAt ?? null,
    ],
  );
  return result.rows[0]!.id;
}

async function statusOf(id: string): Promise<{ attempts: number; status: string }> {
  const result = await pool.query<{ attempts: number; status: string }>(
    'SELECT status, attempts FROM outbox_events WHERE id = $1',
    [id],
  );
  return result.rows[0]!;
}

describe('dead-letter inspection and replay', () => {
  it('lists only events parked after exhausting their attempts', async () => {
    const parked = await insertEvent({ attempts: 12, nextAttemptAt: 'infinity', status: 'failed' });
    await insertEvent({ attempts: 3, nextAttemptAt: new Date().toISOString(), status: 'failed' });
    await insertEvent({ status: 'pending' });
    await insertEvent({ processedAt: new Date().toISOString(), status: 'processed' });

    const events = await outboxAdmin.listParked();
    expect(events.map(({ id }) => id)).toEqual([parked]);
    expect(await outboxAdmin.countParked()).toBe(1);
    // A failed event still inside its backoff belongs to the worker, not to an operator.
    expect(events[0]?.lastError).toBe('handler exploded');
    // A parked row stores `infinity`, which pg hands back as a number rather than a Date.
    expect(events[0]?.nextAttemptAt).toBe('infinity');
  });

  it('returns a parked event to the queue with a fresh attempt budget', async () => {
    const id = await insertEvent({ attempts: 12, nextAttemptAt: 'infinity', status: 'failed' });

    expect(await outboxAdmin.replay(id)).toBe(true);

    const after = await statusOf(id);
    expect(after.status).toBe('pending');
    expect(after.attempts).toBe(0);
    // The error survives replay: it is the record of why a human intervened.
    const record = await outboxAdmin.findById(id);
    expect(record?.lastError).toBe('handler exploded');
    expect(record?.nextAttemptAt).toBeNull();
  });

  it('refuses to replay an event the worker still owns', async () => {
    const pending = await insertEvent({ status: 'pending' });
    const processing = await insertEvent({ nextAttemptAt: 'infinity', status: 'processing' });
    const backingOff = await insertEvent({
      attempts: 2,
      nextAttemptAt: new Date(Date.now() + 60_000).toISOString(),
      status: 'failed',
    });

    for (const id of [pending, processing, backingOff]) {
      expect(await outboxAdmin.replay(id)).toBe(false);
    }
    expect((await statusOf(pending)).status).toBe('pending');
    expect((await statusOf(processing)).status).toBe('processing');
  });

  it('reports an unknown id rather than pretending to replay it', async () => {
    expect(await outboxAdmin.replay(randomUUID())).toBe(false);
    expect(await outboxAdmin.findById(randomUUID())).toBeNull();
  });

  it('replays every parked event at once', async () => {
    await insertEvent({ attempts: 12, nextAttemptAt: 'infinity', status: 'failed' });
    await insertEvent({ attempts: 12, nextAttemptAt: 'infinity', status: 'failed' });
    await insertEvent({ status: 'pending' });

    expect(await outboxAdmin.replayAllParked()).toBe(2);
    expect(await outboxAdmin.countParked()).toBe(0);
  });

  it('makes a replayed event claimable again by the worker', async () => {
    const id = await insertEvent({ attempts: 12, nextAttemptAt: 'infinity', status: 'failed' });
    await outboxAdmin.replay(id);

    // The point of replay is that the normal claim query picks the event up again.
    const claimable = await pool.query<{ id: string }>(
      `SELECT id FROM outbox_events
       WHERE status IN ('pending', 'failed', 'processing')
         AND (next_attempt_at IS NULL OR next_attempt_at <= now())`,
    );
    expect(claimable.rows.map((row) => row.id)).toContain(id);
  });
});

describe('retention', () => {
  it('deletes processed outbox events past the cutoff and keeps everything else', async () => {
    const old = await insertEvent({
      processedAt: new Date(Date.now() - 40 * day).toISOString(),
      status: 'processed',
    });
    const recent = await insertEvent({
      processedAt: new Date(Date.now() - 1 * day).toISOString(),
      status: 'processed',
    });
    const parked = await insertEvent({
      attempts: 12,
      nextAttemptAt: 'infinity',
      status: 'failed',
    });
    const pending = await insertEvent({ status: 'pending' });

    const removed = await outboxAdmin.purgeProcessedBefore(new Date(Date.now() - 30 * day));
    expect(removed).toBe(1);

    const surviving = await pool.query<{ id: string }>('SELECT id FROM outbox_events');
    const ids = surviving.rows.map((row) => row.id);
    expect(ids).not.toContain(old);
    // Undelivered work is never retention's business, however old it is.
    expect(ids).toEqual(expect.arrayContaining([recent, parked, pending]));
  });

  it('deletes completed idempotency records past the cutoff but never in-progress ones', async () => {
    await pool.query(
      `INSERT INTO idempotency_records
         (principal_id, key, operation, request_fingerprint, status, response_status_code,
          response_body, created_at, completed_at)
       VALUES
         ($1, 'old-done',    'transfer', 'fp', 'completed', 201, '{}', now() - interval '40 days', now() - interval '40 days'),
         ($1, 'recent-done', 'transfer', 'fp', 'completed', 201, '{}', now() - interval '1 day',  now() - interval '1 day'),
         ($1, 'old-claim',   'transfer', 'fp', 'in_progress', NULL, NULL, now() - interval '40 days', NULL)`,
      [principal.principalId],
    );

    const removed = await idempotency.purgeCompletedBefore(new Date(Date.now() - 7 * day), 1_000);
    expect(removed).toBe(1);

    const keys = await pool.query<{ key: string }>(
      'SELECT key FROM idempotency_records ORDER BY key',
    );
    // An in_progress row may still be reclaimed by a retrying caller, so age alone cannot retire it.
    expect(keys.rows.map((row) => row.key)).toEqual(['old-claim', 'recent-done']);
  });

  it('sweeps in batches without missing rows', async () => {
    for (let i = 0; i < 7; i += 1) {
      await insertEvent({
        processedAt: new Date(Date.now() - 40 * day).toISOString(),
        status: 'processed',
      });
    }

    const removed = await outboxAdmin.purgeProcessedBefore(new Date(Date.now() - 30 * day), 2);
    expect(removed).toBe(7);
    const remaining = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM outbox_events WHERE status = 'processed'",
    );
    expect(remaining.rows[0]!.count).toBe('0');
  });

  it('never sweeps the dedup boundary or the audit trail', async () => {
    const eventId = randomUUID();
    await pool.query(
      `INSERT INTO consumer_inbox (consumer_name, event_id, processed_at)
       VALUES ('audit', $1, now() - interval '400 days')`,
      [eventId],
    );
    await pool.query(
      `INSERT INTO audit_effects (event_id, aggregate_id, aggregate_type, event_type, payload, created_at)
       VALUES ($1, $2, 'transfer', 'transfer.created', '{}', now() - interval '400 days')`,
      [eventId, randomUUID()],
    );

    // Both tables are append-only in the database, so retention could not sweep them even if a
    // future maintainer decided it should. Deleting an inbox claim would let a redelivered event
    // produce a second effect -- the one thing the consumer inbox exists to prevent.
    await expect(
      pool.query('DELETE FROM consumer_inbox WHERE event_id = $1', [eventId]),
    ).rejects.toThrow(/append-only/);
    await expect(
      pool.query('DELETE FROM audit_effects WHERE event_id = $1', [eventId]),
    ).rejects.toThrow(/append-only/);
  });
});

describe('GET /metrics', () => {
  it('requires the admin key', async () => {
    const response = await app.inject({ method: 'GET', url: '/metrics' });
    expect(response.statusCode).toBe(401);
  });

  it('is not reachable with a customer key', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { ...principal.authHeaders },
    });
    expect(response.statusCode).toBe(401);
  });

  it('exposes transfer counters and outbox depth in exposition format', async () => {
    await insertEvent({ status: 'pending' });
    await insertEvent({ status: 'pending' });
    await insertEvent({ attempts: 12, nextAttemptAt: 'infinity', status: 'failed' });

    const response = await app.inject({ method: 'GET', url: '/metrics', headers: adminHeaders });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain; version=0.0.4');
    expect(response.body).toContain('# TYPE pulseledger_transfers_completed_total counter');
    expect(response.body).toContain('pulseledger_outbox_events{status="pending"} 2');
    expect(response.body).toContain('pulseledger_outbox_events{status="failed"} 1');
    expect(response.body).toContain('pulseledger_outbox_events{status="processing"} 0');
  });

  it('reports the same transfer numbers as the JSON endpoint', async () => {
    const json = await app.inject({
      method: 'GET',
      url: '/v1/admin/metrics',
      headers: adminHeaders,
    });
    const { completed } = json.json<{ transfers: { completed: number } }>().transfers;

    const text = await app.inject({ method: 'GET', url: '/metrics', headers: adminHeaders });
    expect(text.body).toContain(`pulseledger_transfers_completed_total ${completed}`);
  });
});
