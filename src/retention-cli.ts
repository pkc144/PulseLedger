/**
 * Retention sweep.
 *
 * Four tables grow with traffic. Only two of them may be swept, and the difference is the whole
 * decision (ADR-006):
 *
 *   outbox_events        processed rows are deleted past the retention window. The event was
 *                        delivered; its job is done.
 *   idempotency_records  completed rows are deleted past the window. Past it, no client is still
 *                        retrying and expecting a replay.
 *
 *   consumer_inbox       NEVER deleted. It is the dedup boundary: removing a claim would let a
 *                        redelivered event produce a second effect, which is the exact invariant
 *                        this system exists to hold.
 *   audit_effects        NEVER deleted. It is an audit trail, and it is append-only in the
 *                        database anyway -- the trigger would reject the DELETE.
 *
 * Usage:
 *   npm run retention -- [--outbox-days 30] [--idempotency-days 7] [--batch-size 1000] [--dry-run]
 *
 * Both sweeps delete in bounded batches so a first run over a long-neglected table cannot hold
 * locks for minutes. Safe to run repeatedly; safe to run while the service is serving traffic.
 */
import { loadConfig } from './config.js';
import { createPool } from './infrastructure/database/pool.js';
import { PostgresIdempotencyStore } from './modules/idempotency/idempotency-repository.js';
import { OutboxAdminService } from './modules/outbox/outbox-admin-service.js';
import { PostgresOutboxAdminStore } from './modules/outbox/outbox-repository.js';
import { outboxDefaultPurgeBatchSize } from './modules/outbox/outbox-domain.js';

const defaultOutboxRetentionDays = 30;
const defaultIdempotencyRetentionDays = 7;

function readOption(args: readonly string[], name: string, fallback: number): number {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = Number(args[index + 1]);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return value;
}

function cutoffFor(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const outboxDays = readOption(args, 'outbox-days', defaultOutboxRetentionDays);
const idempotencyDays = readOption(args, 'idempotency-days', defaultIdempotencyRetentionDays);
const batchSize = readOption(args, 'batch-size', outboxDefaultPurgeBatchSize);

const config = loadConfig();
const pool = createPool(config.databaseUrl);

try {
  const outboxCutoff = cutoffFor(outboxDays);
  const idempotencyCutoff = cutoffFor(idempotencyDays);

  if (dryRun) {
    // Counts only, using the same predicates the deletes use, so a dry run cannot disagree with
    // the sweep it is previewing.
    const outboxCount = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM outbox_events
       WHERE status = 'processed' AND processed_at < $1`,
      [outboxCutoff.toISOString()],
    );
    const idempotencyCount = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM idempotency_records
       WHERE status = 'completed' AND completed_at < $1`,
      [idempotencyCutoff.toISOString()],
    );
    console.log(
      JSON.stringify(
        {
          dryRun: true,
          idempotencyRecords: {
            cutoff: idempotencyCutoff.toISOString(),
            eligible: Number(idempotencyCount.rows[0]?.count ?? '0'),
            retentionDays: idempotencyDays,
          },
          outboxEvents: {
            cutoff: outboxCutoff.toISOString(),
            eligible: Number(outboxCount.rows[0]?.count ?? '0'),
            retentionDays: outboxDays,
          },
        },
        null,
        2,
      ),
    );
  } else {
    const outboxAdmin = new OutboxAdminService(new PostgresOutboxAdminStore(pool));
    const idempotency = new PostgresIdempotencyStore(pool);

    const outboxRemoved = await outboxAdmin.purgeProcessedBefore(outboxCutoff, batchSize);
    const idempotencyRemoved = await idempotency.purgeCompletedBefore(idempotencyCutoff, batchSize);

    console.log(
      JSON.stringify(
        {
          dryRun: false,
          idempotencyRecords: {
            cutoff: idempotencyCutoff.toISOString(),
            removed: idempotencyRemoved,
            retentionDays: idempotencyDays,
          },
          outboxEvents: {
            cutoff: outboxCutoff.toISOString(),
            removed: outboxRemoved,
            retentionDays: outboxDays,
          },
        },
        null,
        2,
      ),
    );
    console.log(
      `Retention sweep complete: ${outboxRemoved} outbox event(s), ` +
        `${idempotencyRemoved} idempotency record(s) removed. ` +
        'consumer_inbox and audit_effects are never swept (see ADR-006).',
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'retention sweep failed');
  process.exitCode = 1;
} finally {
  await pool.end();
}
