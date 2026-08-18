import type { Database, DatabaseConnection, TransactionalDatabase } from '../../ports/database.js';
import {
  outboxCurrentEventVersion,
  outboxDefaultClaimLeaseSeconds,
  type NewOutboxEvent,
  type OutboxAdminStore,
  type OutboxRecord,
  type OutboxStore,
  type Queryable,
} from './outbox-domain.js';

interface OutboxRow extends Record<string, unknown> {
  aggregate_id: string;
  aggregate_type: string;
  attempts: number;
  created_at: Date;
  event_type: string;
  event_version: number;
  id: string;
  last_error: string | null;
  // `timestamptz 'infinity'` -- how a parked event records "no next attempt" -- arrives from pg as
  // the JS number Infinity, not a Date. Only the admin queries ever select such a row: the claim
  // query filters on `next_attempt_at <= now()`, which infinity never satisfies.
  next_attempt_at: Date | number | null;
  payload: unknown;
  processed_at: Date | null;
  status: string;
}

function toNextAttempt(value: Date | number | null): string | null {
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString();
  return value === Number.POSITIVE_INFINITY ? 'infinity' : '-infinity';
}

function toOutboxRecord(row: OutboxRow): OutboxRecord {
  return {
    aggregateId: row.aggregate_id,
    aggregateType: row.aggregate_type as OutboxRecord['aggregateType'],
    attempts: row.attempts,
    createdAt: row.created_at.toISOString(),
    eventType: row.event_type,
    eventVersion: row.event_version,
    id: row.id,
    lastError: row.last_error,
    nextAttemptAt: toNextAttempt(row.next_attempt_at),
    payload: row.payload,
    processedAt: row.processed_at?.toISOString() ?? null,
    status: row.status as OutboxRecord['status'],
  };
}

export interface PostgresOutboxStoreOptions {
  claimLeaseSeconds?: number;
}

export class PostgresOutboxStore implements OutboxStore {
  private readonly claimLeaseSeconds: number;

  public constructor(
    private readonly database: TransactionalDatabase,
    options: PostgresOutboxStoreOptions = {},
  ) {
    this.claimLeaseSeconds = options.claimLeaseSeconds ?? outboxDefaultClaimLeaseSeconds;
  }

  public async insert(db: Queryable, event: NewOutboxEvent): Promise<void> {
    await db.query(
      `INSERT INTO outbox_events (aggregate_id, aggregate_type, event_type, event_version, payload)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        event.aggregateId,
        event.aggregateType,
        event.eventType,
        event.eventVersion ?? outboxCurrentEventVersion,
        JSON.stringify(event.payload),
      ],
    );
  }

  public async claimBatch(batchSize: number): Promise<OutboxRecord[]> {
    const connection: DatabaseConnection = await this.database.connect();
    try {
      await connection.query('BEGIN');
      const result = await connection.query<OutboxRow>(
        `WITH claimed AS (
           SELECT id
           FROM outbox_events
           WHERE status IN ('pending', 'failed', 'processing')
             AND (next_attempt_at IS NULL OR next_attempt_at <= now())
           ORDER BY created_at
           LIMIT $1
           FOR UPDATE SKIP LOCKED
         )
         UPDATE outbox_events
         SET status = 'processing',
             attempts = attempts + 1,
             next_attempt_at = now() + make_interval(secs => $2)
         WHERE id IN (SELECT id FROM claimed)
         RETURNING id, aggregate_id, aggregate_type, event_type, event_version, payload,
                   status, attempts, last_error, next_attempt_at, processed_at, created_at`,
        [batchSize, this.claimLeaseSeconds],
      );
      await connection.query('COMMIT');
      return result.rows.map(toOutboxRecord);
    } catch (error) {
      try {
        await connection.query('ROLLBACK');
      } catch {
        // Preserve the original failure.
      }
      throw error;
    } finally {
      connection.release();
    }
  }

  public async markProcessed(id: string): Promise<void> {
    await this.database.query(
      `UPDATE outbox_events
       SET status = 'processed', processed_at = now()
       WHERE id = $1 AND status = 'processing'`,
      [id],
    );
  }

  public async markFailed(id: string, error: string, nextAttemptAt: string): Promise<void> {
    await this.database.query(
      `UPDATE outbox_events
       SET status = 'failed', last_error = $2, next_attempt_at = $3
       WHERE id = $1 AND status = 'processing'`,
      [id, error, nextAttemptAt],
    );
  }

  public async stats(): Promise<{ failed: number; pending: number; processing: number }> {
    const result = await this.database.query<{ count: string; status: string }>(
      `SELECT status, count(*)::text AS count
       FROM outbox_events
       WHERE status IN ('pending', 'processing', 'failed')
       GROUP BY status`,
    );
    const stats = { pending: 0, processing: 0, failed: 0 };
    for (const row of result.rows) {
      if (row.status === 'pending') stats.pending = Number(row.count);
      else if (row.status === 'processing') stats.processing = Number(row.count);
      else if (row.status === 'failed') stats.failed = Number(row.count);
    }
    return stats;
  }
}

const outboxSelectColumns = `id, aggregate_id, aggregate_type, event_type, event_version, payload,
         status, attempts, last_error, next_attempt_at, processed_at, created_at`;

/**
 * Operator-facing outbox queries: inspection, deliberate replay, and retention. Separate from
 * `PostgresOutboxStore` so nothing on the worker's hot path can reach them by accident.
 */
export class PostgresOutboxAdminStore implements OutboxAdminStore {
  public constructor(private readonly database: Database) {}

  public async listParked(limit: number): Promise<OutboxRecord[]> {
    const result = await this.database.query<OutboxRow>(
      `SELECT ${outboxSelectColumns}
       FROM outbox_events
       WHERE status = 'failed' AND next_attempt_at = 'infinity'
       ORDER BY created_at
       LIMIT $1`,
      [limit],
    );
    return result.rows.map(toOutboxRecord);
  }

  public async countParked(): Promise<number> {
    const result = await this.database.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM outbox_events
       WHERE status = 'failed' AND next_attempt_at = 'infinity'`,
    );
    return Number(result.rows[0]?.count ?? '0');
  }

  public async findById(id: string): Promise<OutboxRecord | null> {
    const result = await this.database.query<OutboxRow>(
      `SELECT ${outboxSelectColumns} FROM outbox_events WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row ? toOutboxRecord(row) : null;
  }

  public async replay(id: string): Promise<boolean> {
    // Only a parked event can be replayed: a pending or processing row is already the worker's,
    // and resetting it under the worker's feet would duplicate in-flight work. `attempts` goes
    // back to zero so the event gets a fresh budget, while `last_error` is deliberately kept --
    // it is the record of why a human had to intervene.
    const result = await this.database.query(
      `UPDATE outbox_events
       SET status = 'pending', attempts = 0, next_attempt_at = NULL
       WHERE id = $1 AND status = 'failed' AND next_attempt_at = 'infinity'`,
      [id],
    );
    return (result.rowCount ?? 0) > 0;
  }

  public async replayAllParked(): Promise<number> {
    const result = await this.database.query(
      `UPDATE outbox_events
       SET status = 'pending', attempts = 0, next_attempt_at = NULL
       WHERE status = 'failed' AND next_attempt_at = 'infinity'`,
    );
    return result.rowCount ?? 0;
  }

  public async purgeProcessedBefore(cutoff: Date, batchSize: number): Promise<number> {
    // Deleted in bounded batches so a first sweep over a long-neglected table cannot hold locks
    // or bloat WAL for minutes at a time. Only 'processed' rows are eligible: a pending, failed,
    // or in-flight event still has work owed to it.
    let removed = 0;
    for (;;) {
      const result = await this.database.query(
        `DELETE FROM outbox_events
         WHERE id IN (
           SELECT id FROM outbox_events
           WHERE status = 'processed' AND processed_at < $1
           ORDER BY processed_at
           LIMIT $2
         )`,
        [cutoff.toISOString(), batchSize],
      );
      const deleted = result.rowCount ?? 0;
      removed += deleted;
      if (deleted < batchSize) return removed;
    }
  }
}
