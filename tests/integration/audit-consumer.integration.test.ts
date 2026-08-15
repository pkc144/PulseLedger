import { randomUUID } from 'node:crypto';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool } from '../../src/infrastructure/database/pool.js';
import { runMigrations } from '../../src/infrastructure/database/migrate.js';
import type {
  AuditConsumeInput,
  AuditConsumerStore,
} from '../../src/modules/audit/audit-domain.js';
import { PostgresAuditConsumerStore } from '../../src/modules/audit/audit-repository.js';
import { AuditConsumerService } from '../../src/modules/audit/audit-service.js';
import type { OutboxRecord } from '../../src/modules/outbox/outbox-domain.js';
import { PostgresOutboxStore } from '../../src/modules/outbox/outbox-repository.js';
import { OutboxWorker } from '../../src/modules/outbox/outbox-worker.js';

let container: StartedPostgreSqlContainer | undefined;
let pool: pg.Pool;
let store: AuditConsumerStore;

beforeAll(async () => {
  let databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) {
    container = await new PostgreSqlContainer('postgres:17-alpine')
      .withDatabase('pulseledger_audit_test')
      .withUsername('pulseledger')
      .withPassword('pulseledger')
      .start();
    databaseUrl = container.getConnectionUri();
  }

  pool = createPool(databaseUrl);
  await runMigrations(pool);
  store = new PostgresAuditConsumerStore(pool);
});

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  await pool.query('TRUNCATE consumer_inbox, audit_effects, outbox_events');
});

function sampleEvent(eventId: string): AuditConsumeInput {
  return {
    aggregateId: randomUUID(),
    aggregateType: 'transfer',
    eventId,
    eventType: 'transfer.created',
    payload: { hello: 'world' },
  };
}

async function countWhere(table: string, eventId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM ${table} WHERE event_id = $1`,
    [eventId],
  );
  return Number(result.rows[0]!.count);
}

describe('audit consumer inbox', () => {
  it('claims a new event and records the audit effect', async () => {
    const eventId = randomUUID();
    const result = await store.consume(sampleEvent(eventId));

    expect(result.duplicate).toBe(false);
    expect(await countWhere('audit_effects', eventId)).toBe(1);
    expect(await countWhere('consumer_inbox', eventId)).toBe(1);
  });

  it('makes a duplicate delivery a successful no-op', async () => {
    const eventId = randomUUID();
    const event = sampleEvent(eventId);

    const first = await store.consume(event);
    const second = await store.consume(event);

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(await countWhere('audit_effects', eventId)).toBe(1);
  });

  it('commits the inbox claim and the audit effect atomically (never one without the other)', async () => {
    await store.consume(sampleEvent(randomUUID()));
    await store.consume(sampleEvent(randomUUID()));

    const inbox = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM consumer_inbox',
    );
    const effects = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM audit_effects',
    );
    expect(inbox.rows[0]!.count).toBe(effects.rows[0]!.count);
  });

  it('processes 1,000 duplicate deliveries of the same event into exactly one audit effect', async () => {
    const eventId = randomUUID();
    const event = sampleEvent(eventId);

    const results = await Promise.all(Array.from({ length: 1000 }, () => store.consume(event)));

    const processed = results.filter((result) => !result.duplicate).length;
    const duplicates = results.filter((result) => result.duplicate).length;
    expect(processed).toBe(1);
    expect(duplicates).toBe(999);
    expect(await countWhere('audit_effects', eventId)).toBe(1);
  });

  it('never lets two concurrent consumers double-record the same event', async () => {
    const eventId = randomUUID();
    const event = sampleEvent(eventId);
    const consumerA = new PostgresAuditConsumerStore(pool);
    const consumerB = new PostgresAuditConsumerStore(pool);

    const [resultA, resultB] = await Promise.all([
      consumerA.consume(event),
      consumerB.consume(event),
    ]);

    const duplicateCount = [resultA, resultB].filter((result) => result.duplicate).length;
    expect(duplicateCount).toBe(1);
    expect(await countWhere('audit_effects', eventId)).toBe(1);
  });
});

describe('audit consumer wired through the real outbox worker', () => {
  it('is redelivered by the worker (at-least-once) but produces exactly one audit effect', async () => {
    const outboxStore = new PostgresOutboxStore(pool);
    const eventId = randomUUID();
    await pool.query(
      `INSERT INTO outbox_events (id, aggregate_id, aggregate_type, event_type, payload)
       VALUES ($1, $2, 'transfer', 'transfer.created', '{"amountMinor":"100"}')`,
      [eventId, randomUUID()],
    );

    const consumer = new AuditConsumerService(store);
    const deliveries: OutboxRecord[] = [];
    const originalHandle = consumer.handle;
    const trackedHandle = async (event: OutboxRecord): Promise<void> => {
      deliveries.push(event);
      await originalHandle(event);
    };

    const worker = new OutboxWorker(outboxStore, { handler: trackedHandle, pollIntervalMs: 50 });
    worker.start();
    await new Promise((resolve) => setTimeout(resolve, 400));
    await worker.stop();

    expect(deliveries.length).toBeGreaterThanOrEqual(1);
    expect(await countWhere('audit_effects', eventId)).toBe(1);

    // Simulate an at-least-once redelivery: the event is reset to pending with its claim lease
    // cleared, as if the outbox worker crashed after the handler ran but before the row was
    // marked processed and a new worker reclaimed it.
    await pool.query(
      `UPDATE outbox_events SET status = 'pending', next_attempt_at = NULL WHERE id = $1`,
      [eventId],
    );

    const secondWorker = new OutboxWorker(outboxStore, {
      handler: trackedHandle,
      pollIntervalMs: 50,
    });
    secondWorker.start();
    await new Promise((resolve) => setTimeout(resolve, 400));
    await secondWorker.stop();

    expect(deliveries.length).toBeGreaterThanOrEqual(2); // delivered again ...
    expect(await countWhere('audit_effects', eventId)).toBe(1); // ... but still one logical effect
  });
});
