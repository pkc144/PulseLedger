import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { errorHandler } from './errors.js';
import { PostgresAccountStore } from './modules/accounts/account-repository.js';
import { accountRoutes } from './modules/accounts/account-routes.js';
import { healthRoutes } from './modules/health/health-routes.js';
import type { Database } from './ports/database.js';

export interface BuildAppOptions {
  database: Database;
  logger?: boolean | { level: string };
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
  app.setNotFoundHandler((request, reply) => {
    void reply.status(404).send({
      error: {
        code: 'ROUTE_NOT_FOUND',
        message: 'Route not found',
        requestId: request.id,
      },
    });
  });

  await app.register(healthRoutes, { database: options.database });
  await app.register(accountRoutes, { store: new PostgresAccountStore(options.database) });
  await app.ready();
  return app;
}
