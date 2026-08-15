import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { RequestLimitsConfig } from './config.js';
import { errorHandler } from './errors.js';
import { requireAdminApiKey } from './infrastructure/http/admin-auth.js';
import { withRedaction } from './infrastructure/http/logging.js';
import { PostgresIdempotencyStore } from './modules/idempotency/idempotency-repository.js';
import { IdempotencyService } from './modules/idempotency/idempotency-service.js';
import { PostgresAccountStore } from './modules/accounts/account-repository.js';
import { accountRoutes } from './modules/accounts/account-routes.js';
import { AccountService } from './modules/accounts/account-service.js';
import { healthRoutes } from './modules/health/health-routes.js';
import { PostgresLedgerStore } from './modules/ledger/ledger-repository.js';
import { ledgerRoutes } from './modules/ledger/ledger-routes.js';
import { LedgerPostingService } from './modules/ledger/ledger-service.js';
import { PostgresReconciliationStore } from './modules/reconciliation/reconciliation-repository.js';
import { reconciliationRoutes } from './modules/reconciliation/reconciliation-routes.js';
import { ReconciliationService } from './modules/reconciliation/reconciliation-service.js';
import { PostgresTransferStore } from './modules/transfers/transfer-repository.js';
import { transferRoutes } from './modules/transfers/transfer-routes.js';
import { TransferMetrics, TransferService } from './modules/transfers/transfer-service.js';
import type { TransactionalDatabase } from './ports/database.js';
import type { OutboxStore } from './modules/outbox/outbox-domain.js';

declare module 'fastify' {
  interface FastifyInstance {
    transferMetrics: TransferMetrics;
  }
}

// Applied whenever a caller (tests) doesn't supply explicit limits from config; mirrors
// config.ts's own defaults so behavior is identical either way.
const defaultRequestLimits: RequestLimitsConfig = {
  bodyLimitBytes: 16 * 1024,
  connectionTimeoutMs: 10_000,
  keepAliveTimeoutMs: 5_000,
  requestTimeoutMs: 30_000,
};

const metricsResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['transfers'],
  properties: {
    transfers: {
      type: 'object',
      additionalProperties: false,
      required: ['completed', 'retries', 'exhausted'],
      properties: {
        completed: { type: 'integer' },
        retries: { type: 'integer' },
        exhausted: { type: 'integer' },
      },
    },
  },
} as const;

export interface BuildAppOptions {
  adminApiKey: string;
  database: TransactionalDatabase;
  logger?: boolean | { level: string };
  outboxStore?: OutboxStore;
  requestLimits?: RequestLimitsConfig;
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const limits = options.requestLimits ?? defaultRequestLimits;

  const app = Fastify({
    bodyLimit: limits.bodyLimitBytes,
    connectionTimeout: limits.connectionTimeoutMs,
    keepAliveTimeout: limits.keepAliveTimeoutMs,
    requestTimeout: limits.requestTimeoutMs,
    // Matches the pre-existing default: no explicit `logger` option means disabled, exactly as
    // it did before request-limit/redaction hardening was added.
    logger:
      options.logger === undefined || options.logger === false
        ? false
        : withRedaction(typeof options.logger === 'object' ? options.logger : {}),
    genReqId: (request) => {
      const suppliedId = request.headers['x-request-id'];
      return typeof suppliedId === 'string' && suppliedId.length <= 128 ? suppliedId : randomUUID();
    },
  });

  app.setErrorHandler(errorHandler);
  const transferMetrics = new TransferMetrics();
  app.decorate('transferMetrics', transferMetrics);
  app.setNotFoundHandler((request, reply) => {
    void reply.status(404).send({
      error: {
        code: 'ROUTE_NOT_FOUND',
        message: 'Route not found',
        requestId: request.id,
      },
    });
  });

  const idempotencyStore = new PostgresIdempotencyStore(options.database);
  const outboxStore = options.outboxStore;
  const ledgerService = new LedgerPostingService(new PostgresLedgerStore(options.database));

  await app.register(healthRoutes, {
    database: options.database,
    ...(outboxStore ? { outboxStats: () => outboxStore.stats() } : {}),
  });
  await app.register(accountRoutes, {
    ledger: ledgerService,
    service: new AccountService(new PostgresAccountStore(options.database)),
  });
  await app.register(transferRoutes, {
    idempotency: new IdempotencyService(idempotencyStore),
    service: new TransferService(new PostgresTransferStore(options.database, outboxStore), {
      metrics: transferMetrics,
      telemetry: {
        completed: (event) => app.log.info(event, 'transfer completed'),
        retrying: (event) => app.log.warn(event, 'retrying transfer transaction'),
      },
    }),
  });

  // Administrative routes share one API-key guard, applied via an encapsulated child context.
  // Fastify plugin encapsulation keeps this preHandler from leaking to any route registered
  // above, so ledgerRoutes/reconciliationRoutes stay unaware that auth exists at all.
  await app.register(async (adminApp) => {
    adminApp.addHook('preHandler', requireAdminApiKey(options.adminApiKey));

    await adminApp.register(ledgerRoutes, { service: ledgerService });
    await adminApp.register(reconciliationRoutes, {
      service: new ReconciliationService(new PostgresReconciliationStore(options.database)),
    });

    // Exposes the Week 3 in-process transfer counters (completed/retries/exhausted) for
    // operational visibility and benchmark reporting. Trivial enough to inline here rather
    // than a dedicated module for one read of an already-decorated value.
    adminApp.get(
      '/v1/admin/metrics',
      { schema: { response: { 200: metricsResponseSchema } } },
      async () => ({ transfers: transferMetrics.snapshot() }),
    );
  });

  await app.ready();
  return app;
}
