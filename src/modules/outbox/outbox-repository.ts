import type { DatabaseConnection, TransactionalDatabase } from '../../ports/database.js';
import type {
  NewOutboxEvent,
  OutboxRecord,
  OutboxStore,
  Queryable,
} from './outbox-domain.js';

interface OutboxRow extends Record<string, unknown> {
  aggregate_id: string;
  aggregate_type: string;
  attempts: number;
  created_at: Date;
  event_type: string;
  id: string;
  last_error: string | null;
  next_attempt_at: Date | null;
  payload: unknown;
  processed_at: Date | null;
  status: string;
}

function toOutboxRecord(row: OutboxRow): OutboxRecord {
  return {
    aggregateId: row.aggregate_id,
    aggregateType: row.aggregate_type as OutboxRecord['aggregateType'],
    attempts: row.attempts,
    createdAt: row.created_at.toISOString(),
    eventType: row.event_type,
    id: row.id,
    lastError: row.last_error,
    nextAttemptAt: row.next_attempt_at?.toISOString() ?? null,
    payload: row.payload,
    processedAt: row.processed_at?.toISOString() ?? null,
    status: row.status as OutboxRecord['status'],
  };
}

export class PostgresOutboxStore implements OutboxStore {
  public constructor(private readonly database: TransactionalDatabase) {}

  public async insert(db: Queryable, event: NewOutboxEvent): Promise<void> {
    await db.query(
      `INSERT INTO outbox_events (aggregate_id, aggregate_type, event_type, payload)
       VALUES ($1, $2, $3, $4)`,
      [event.aggregateId, event.aggregateType, event.eventType, JSON.stringify(event.payload)],
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
           WHERE status IN ('pending', 'failed')
             AND (next_attempt_at IS NULL OR next_attempt_at <= now())
           ORDER BY created_at
           LIMIT $1
           FOR UPDATE SKIP LOCKED
         )
         UPDATE outbox_events
         SET status = 'processing', attempts = attempts + 1
         WHERE id IN (SELECT id FROM claimed)
         RETURNING id, aggregate_id, aggregate_type, event_type, payload,
                   status, attempts, last_error, next_attempt_at, processed_at, created_at`,
        [batchSize],
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
