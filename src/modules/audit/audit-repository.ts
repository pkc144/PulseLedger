import type { TransactionalDatabase } from '../../ports/database.js';
import {
  auditConsumerName,
  type AuditConsumeInput,
  type AuditConsumeResult,
  type AuditConsumerStore,
} from './audit-domain.js';

export class PostgresAuditConsumerStore implements AuditConsumerStore {
  public constructor(private readonly database: TransactionalDatabase) {}

  public async consume(input: AuditConsumeInput): Promise<AuditConsumeResult> {
    const connection = await this.database.connect();
    try {
      await connection.query('BEGIN');

      // Claim the (consumer, event) pair first. A conflict means another delivery of the
      // same event already claimed it (either earlier, or concurrently right now) — this
      // INSERT is the atomic dedup boundary, race-safe under real concurrency.
      const claimed = await connection.query(
        `INSERT INTO consumer_inbox (consumer_name, event_id)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING
         RETURNING event_id`,
        [auditConsumerName, input.eventId],
      );

      if (claimed.rowCount === 0) {
        await connection.query('ROLLBACK');
        return { duplicate: true };
      }

      // Only the claiming delivery reaches here, and it does so in the same transaction as
      // the claim: the inbox row and the audit effect commit together or not at all.
      await connection.query(
        `INSERT INTO audit_effects (event_id, aggregate_id, aggregate_type, event_type, payload)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          input.eventId,
          input.aggregateId,
          input.aggregateType,
          input.eventType,
          JSON.stringify(input.payload),
        ],
      );

      await connection.query('COMMIT');
      return { duplicate: false };
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
}
