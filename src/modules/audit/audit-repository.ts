import type { TransactionalDatabase } from '../../ports/database.js';
import { withTransaction } from '../../ports/transaction.js';
import {
  auditConsumerName,
  type AuditConsumeInput,
  type AuditConsumeResult,
  type AuditConsumerStore,
} from './audit-domain.js';

export class PostgresAuditConsumerStore implements AuditConsumerStore {
  public constructor(private readonly database: TransactionalDatabase) {}

  public async consume(input: AuditConsumeInput): Promise<AuditConsumeResult> {
    return await withTransaction(this.database, async (connection) => {
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

      // A lost claim wrote nothing, so committing the empty transaction is a no-op.
      if (claimed.rowCount === 0) return { duplicate: true };

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

      return { duplicate: false };
    });
  }
}
