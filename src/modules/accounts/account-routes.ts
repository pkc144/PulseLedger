import type { FastifyPluginAsync } from 'fastify';
import { AppError } from '../../errors.js';
import type { AccountStore, SupportedCurrency } from './account-domain.js';
import { supportedCurrencies } from './account-domain.js';

interface AccountRouteOptions {
  store: AccountStore;
}

const accountResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'currency', 'status', 'balanceMinor', 'createdAt'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    currency: { type: 'string', enum: supportedCurrencies },
    status: { type: 'string', enum: ['active', 'frozen', 'closed'] },
    balanceMinor: { type: 'string', pattern: '^-?[0-9]+$' },
    createdAt: { type: 'string', format: 'date-time' },
  },
} as const;

export const accountRoutes: FastifyPluginAsync<AccountRouteOptions> = async (app, options) => {
  app.post<{ Body: { currency: SupportedCurrency } }>(
    '/v1/accounts',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['currency'],
          properties: { currency: { type: 'string', enum: supportedCurrencies } },
        },
        response: { 201: accountResponseSchema },
      },
    },
    async (request, reply) => {
      const account = await options.store.create({ currency: request.body.currency });
      return reply.status(201).send(account);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/v1/accounts/:id',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        response: { 200: accountResponseSchema },
      },
    },
    async (request) => {
      const account = await options.store.findById(request.params.id);
      if (!account) throw new AppError('ACCOUNT_NOT_FOUND', 404, 'Account not found');
      return account;
    },
  );
};
