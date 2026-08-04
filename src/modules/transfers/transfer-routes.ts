import type { FastifyPluginAsync } from 'fastify';
import type { CreateTransferInput, TransferApplication } from './transfer-domain.js';

interface TransferRouteOptions {
  service: TransferApplication;
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
      const transfer = await options.service.create(request.body);
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
    async (request) => await options.service.findById(request.params.id),
  );
};
