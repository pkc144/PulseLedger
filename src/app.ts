import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { errorHandler } from './errors.js';
import { PostgresIdempotencyStore } from './modules/idempotency/idempotency-repository.js';
import { IdempotencyService } from './modules/idempotency/idempotency-service.js';
import { PostgresAccountStore } from './modules/accounts/account-repository.js';
import { accountRoutes } from './modules/accounts/account-routes.js';
import { AccountService } from './modules/accounts/account-service.js';
import { healthRoutes } from './modules/health/health-routes.js';
import { PostgresLedgerStore } from './modules/ledger/ledger-repository.js';
import { ledgerRoutes } from './modules/ledger/ledger-routes.js';
import { LedgerPostingService } from './modules/ledger/ledger-service.js';
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

export interface BuildAppOptions {
  database: TransactionalDatabase;
  logger?: boolean | { level: string };
  outboxStore?: OutboxStore;
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
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

  await app.register(healthRoutes, {
    database: options.database,
    ...(outboxStore ? { outboxStats: () => outboxStore.stats() } : {}),
  });
  await app.register(accountRoutes, {
    service: new AccountService(new PostgresAccountStore(options.database)),
  });
  await app.register(ledgerRoutes, {
    service: new LedgerPostingService(new PostgresLedgerStore(options.database)),
  });
  await app.register(transferRoutes, {
    idempotency: new IdempotencyService(idempotencyStore),
    service: new TransferService(
      new PostgresTransferStore(options.database, outboxStore),
      {
        metrics: transferMetrics,
        telemetry: {
          completed: (event) => app.log.info(event, 'transfer completed'),
          retrying: (event) => app.log.warn(event, 'retrying transfer transaction'),
        },
      },
    ),
  });
  await app.ready();
  return app;
}
