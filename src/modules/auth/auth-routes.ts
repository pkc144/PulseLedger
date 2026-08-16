import type { FastifyPluginAsync } from 'fastify';
import { principalStatuses, type AuthApplication } from './auth-domain.js';

interface AuthRouteOptions {
  service: AuthApplication;
}

const principalResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'name', 'status', 'createdAt'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    status: { type: 'string', enum: principalStatuses },
    createdAt: { type: 'string', format: 'date-time' },
  },
} as const;

const issuedApiKeyResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'principalId', 'keyPrefix', 'key', 'createdAt', 'revokedAt'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    principalId: { type: 'string', format: 'uuid' },
    keyPrefix: { type: 'string' },
    /** Returned exactly once; only a SHA-256 hash of it is stored. */
    key: { type: 'string' },
    createdAt: { type: 'string', format: 'date-time' },
    revokedAt: { type: ['string', 'null'], format: 'date-time' },
  },
} as const;

/**
 * Administrative management of customer credentials. Registered inside the admin child context,
 * so these routes are guarded by the admin API key exactly like funding and reconciliation: a
 * customer key can never mint or revoke another customer key.
 */
export const authRoutes: FastifyPluginAsync<AuthRouteOptions> = async (app, options) => {
  app.post<{ Body: { name: string } }>(
    '/v1/admin/principals',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['name'],
          properties: { name: { type: 'string', minLength: 1, maxLength: 128 } },
        },
        response: { 201: principalResponseSchema },
      },
    },
    async (request, reply) => {
      const principal = await options.service.createPrincipal(request.body.name);
      return reply.status(201).send(principal);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/v1/admin/principals/:id/api-keys',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        response: { 201: issuedApiKeyResponseSchema },
      },
    },
    async (request, reply) => {
      const issued = await options.service.issueApiKey(request.params.id);
      return reply.status(201).send(issued);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/v1/admin/api-keys/:id/revoke',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'revoked'],
            properties: {
              id: { type: 'string', format: 'uuid' },
              revoked: { type: 'boolean', const: true },
            },
          },
        },
      },
    },
    async (request) => {
      await options.service.revokeApiKey(request.params.id);
      return { id: request.params.id, revoked: true as const };
    },
  );
};
