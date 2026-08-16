import type { FastifyPluginAsync } from 'fastify';
import { AppError } from '../../errors.js';
import {
  journalEntriesMaxLimit,
  ledgerDirections,
  type LedgerApplication,
} from '../ledger/ledger-domain.js';
import type { AccountApplication, SupportedCurrency } from './account-domain.js';
import { supportedCurrencies } from './account-domain.js';

interface AccountRouteOptions {
  ledger: LedgerApplication;
  service: AccountApplication;
}

/**
 * The customer guard (wired at the composition root) sets `principalId` before any handler runs,
 * so this only fails if these routes are ever registered outside it — a wiring mistake that
 * should surface as a refusal to serve, not as an unauthenticated read.
 */
function principalOf(request: { principalId?: string }): string {
  const principalId = request.principalId;
  if (!principalId) throw new AppError('UNAUTHORIZED', 401, 'Authentication required');
  return principalId;
}

const journalEntriesResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['entries', 'nextCursor'],
  properties: {
    entries: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'transactionId', 'direction', 'amountMinor', 'currency', 'createdAt'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          transactionId: { type: 'string', format: 'uuid' },
          direction: { type: 'string', enum: ledgerDirections },
          amountMinor: { type: 'string', pattern: '^[1-9][0-9]*$' },
          currency: { type: 'string', pattern: '^[A-Z]{3}$' },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
    },
    nextCursor: { type: ['string', 'null'] },
  },
} as const;

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
      const account = await options.service.create(
        { currency: request.body.currency },
        principalOf(request),
      );
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
      const account = await options.service.findOwnedById(request.params.id, principalOf(request));
      if (!account) throw new AppError('ACCOUNT_NOT_FOUND', 404, 'Account not found');
      return account;
    },
  );

  app.get<{ Params: { id: string }; Querystring: { cursor?: string; limit?: number } }>(
    '/v1/accounts/:id/entries',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            cursor: { type: 'string', minLength: 1 },
            limit: { type: 'integer', minimum: 1, maximum: journalEntriesMaxLimit },
          },
        },
        response: { 200: journalEntriesResponseSchema },
      },
    },
    async (request) => {
      return await options.ledger.listJournalEntries(request.params.id, principalOf(request), {
        ...(request.query.cursor !== undefined ? { cursor: request.query.cursor } : {}),
        ...(request.query.limit !== undefined ? { limit: request.query.limit } : {}),
      });
    },
  );
};
