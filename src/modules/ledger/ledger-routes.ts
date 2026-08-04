import type { FastifyPluginAsync } from 'fastify';
import type { FundAccountInput, LedgerApplication } from './ledger-domain.js';

interface LedgerRouteOptions {
  service: LedgerApplication;
}

const fundingResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'type', 'reference', 'currency', 'createdAt', 'amountMinor', 'fundedAccountId'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    type: { type: 'string', const: 'funding' },
    reference: { type: 'string' },
    currency: { type: 'string', pattern: '^[A-Z]{3}$' },
    createdAt: { type: 'string', format: 'date-time' },
    amountMinor: { type: 'string', pattern: '^[1-9][0-9]*$' },
    fundedAccountId: { type: 'string', format: 'uuid' },
  },
} as const;

export const ledgerRoutes: FastifyPluginAsync<LedgerRouteOptions> = async (app, options) => {
  app.post<{ Body: FundAccountInput }>(
    '/v1/admin/fund',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['accountId', 'amountMinor'],
          properties: {
            accountId: { type: 'string', format: 'uuid' },
            amountMinor: { type: 'string', pattern: '^[1-9][0-9]*$' },
          },
        },
        response: { 201: fundingResponseSchema },
      },
    },
    async (request, reply) => {
      const result = await options.service.fundAccount(request.body);
      return reply.status(201).send(result);
    },
  );
};
