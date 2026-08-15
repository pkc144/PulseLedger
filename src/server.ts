import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './infrastructure/database/pool.js';
import { PostgresAuditConsumerStore } from './modules/audit/audit-repository.js';
import { AuditConsumerService } from './modules/audit/audit-service.js';
import { PostgresOutboxStore } from './modules/outbox/outbox-repository.js';
import { OutboxWorker } from './modules/outbox/outbox-worker.js';

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const outboxStore = new PostgresOutboxStore(pool, {
  claimLeaseSeconds: config.outbox.claimLeaseSeconds,
});
const auditConsumer = new AuditConsumerService(new PostgresAuditConsumerStore(pool));
const app = await buildApp({
  adminApiKey: config.adminApiKey,
  database: pool,
  logger: { level: config.logLevel },
  outboxStore,
  requestLimits: config.requestLimits,
});

const worker = new OutboxWorker(outboxStore, {
  batchSize: config.outbox.batchSize,
  handler: auditConsumer.handle,
  maxAttempts: config.outbox.maxAttempts,
  pollIntervalMs: config.outbox.pollIntervalMs,
});
worker.setTelemetry({
  claimError: (err) => app.log.error({ err }, 'outbox worker claim error'),
  eventFailed: (event) => app.log.warn(event, 'outbox event processing failed'),
  eventPermanentlyFailed: (event) => app.log.error(event, 'outbox event permanently failed'),
  eventProcessed: (event) => app.log.info(event, 'outbox event processed'),
  pollCompleted: (event) => app.log.info(event, 'outbox poll completed'),
  shuttingDown: () => app.log.info('outbox worker shutting down'),
});
auditConsumer.setTelemetry({
  duplicate: (event) => app.log.info(event, 'duplicate outbox event skipped by audit consumer'),
  processed: (event) => app.log.info(event, 'audit effect recorded'),
});

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  await worker.stop();
  await app.close();
  await pool.end();
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ host: config.host, port: config.port });
  worker.start();
} catch (error) {
  app.log.fatal({ err: error }, 'server failed to start');
  await pool.end();
  process.exitCode = 1;
}
