import type { FastifyPluginAsync } from 'fastify';
import { AppError } from '../../errors.js';
import type { IdempotencyApplication } from '../idempotency/idempotency-domain.js';
import type { CreateTransferInput, TransferApplication } from './transfer-domain.js';

interface TransferRouteOptions {
  idempotency: IdempotencyApplication;
  service: TransferApplication;
}

/** See the note on the identical helper in account-routes.ts. */
function principalOf(request: { principalId?: string }): string {
  const principalId = request.principalId;
  if (!principalId) throw new AppError('UNAUTHORIZED', 401, 'Authentication required');
  return principalId;
}

const transferResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'sourceAccountId',
    'destinationAccountId',
    'amountMinor',
    'currency',
    'status',
    'reference',
    'createdAt',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    sourceAccountId: { type: 'string', format: 'uuid' },
    destinationAccountId: { type: 'string', format: 'uuid' },
    amountMinor: { type: 'string', pattern: '^[1-9][0-9]*$' },
    currency: { type: 'string', pattern: '^[A-Z]{3}$' },
    status: { type: 'string', const: 'completed' },
    reference: { type: 'string' },
    createdAt: { type: 'string', format: 'date-time' },
  },
} as const;

export const transferRoutes: FastifyPluginAsync<TransferRouteOptions> = async (app, options) => {
  app.post<{ Body: CreateTransferInput }>(
    '/v1/transfers',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['sourceAccountId', 'destinationAccountId', 'amountMinor'],
          properties: {
            sourceAccountId: { type: 'string', format: 'uuid' },
            destinationAccountId: { type: 'string', format: 'uuid' },
            amountMinor: { type: 'string', pattern: '^[1-9][0-9]*$' },
          },
        },
        response: { 201: transferResponseSchema },
      },
    },
    async (request, reply) => {
      const principalId = principalOf(request);
      const idempotencyKey = request.headers['idempotency-key'];
      const key =
        typeof idempotencyKey === 'string' && idempotencyKey.length > 0
          ? idempotencyKey
          : undefined;

      if (key) {
        // Keys are namespaced by principal in storage, so two callers may pick the same string
        // without colliding and neither can replay the other's stored response.
        const replay = await options.idempotency.claimOrReplay(
          key,
          'transfer',
          principalId,
          request.body,
        );
        if (replay) {
          return reply.status(replay.status).send(replay.body);
        }
      }

      const transfer = await options.service.create(request.body, principalId, {
        idempotencyKey: key,
      });
      return reply.status(201).send(transfer);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/v1/transfers/:id',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        response: { 200: transferResponseSchema },
      },
    },
    async (request) => await options.service.findById(request.params.id, principalOf(request)),
  );
};
