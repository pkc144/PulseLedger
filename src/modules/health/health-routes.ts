import type { FastifyPluginAsync } from 'fastify';
import type { Database } from '../../ports/database.js';

export interface OutboxHealthStats {
  failed: number;
  pending: number;
  processing: number;
}

interface HealthRouteOptions {
  database: Database;
  outboxStats?: () => Promise<OutboxHealthStats>;
}

const healthSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['status'],
  properties: { status: { type: 'string' } },
} as const;

const readySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['status'],
  properties: {
    status: { type: 'string' },
    outbox: {
      type: 'object',
      additionalProperties: false,
      required: ['pending', 'processing', 'failed'],
      properties: {
        pending: { type: 'integer' },
        processing: { type: 'integer' },
        failed: { type: 'integer' },
      },
    },
  },
} as const;

export const healthRoutes: FastifyPluginAsync<HealthRouteOptions> = async (app, options) => {
  app.get('/health/live', { schema: { response: { 200: healthSchema } } }, async () => ({
    status: 'ok',
  }));

  app.get(
    '/health/ready',
    { schema: { response: { 200: readySchema, 503: healthSchema } } },
    async (_request, reply) => {
      try {
        await options.database.query('SELECT 1');
        if (options.outboxStats) {
          return { status: 'ready', outbox: await options.outboxStats() };
        }
        return { status: 'ready' };
      } catch {
        return reply.status(503).send({ status: 'unavailable' });
      }
    },
  );
};
