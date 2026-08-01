import type { FastifyPluginAsync } from 'fastify';
import type { Database } from '../../ports/database.js';

interface HealthRouteOptions {
  database: Database;
}

const healthSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['status'],
  properties: { status: { type: 'string' } },
} as const;

export const healthRoutes: FastifyPluginAsync<HealthRouteOptions> = async (app, options) => {
  app.get('/health/live', { schema: { response: { 200: healthSchema } } }, async () => ({
    status: 'ok',
  }));

  app.get(
    '/health/ready',
    { schema: { response: { 200: healthSchema, 503: healthSchema } } },
    async (_request, reply) => {
      try {
        await options.database.query('SELECT 1');
        return { status: 'ready' };
      } catch {
        return reply.status(503).send({ status: 'unavailable' });
      }
    },
  );
};
