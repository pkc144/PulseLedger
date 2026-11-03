import type { FastifyPluginAsync } from 'fastify';
import { AppError, replayableFailure } from '../../errors.js';
import {
  IdempotencyError,
  idempotencyKeyFrom,
  type IdempotencyApplication,
} from '../idempotency/idempotency-domain.js';
import {
  fundingIdempotencyOperation,
  type FundAccountInput,
  type LedgerApplication,
} from './ledger-domain.js';

interface LedgerRouteOptions {
  /**
   * Optional so the routes can be mounted without idempotency; the composition root always
   * supplies it, scoped to `idempotencyPrincipalId` -- the fixed identity administrative calls
   * act as, since the admin key itself is not a principal.
   */
  idempotency?: { application: IdempotencyApplication; principalId: string };
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
      const idempotency = options.idempotency;
      const key = idempotency ? idempotencyKeyFrom(request.headers['idempotency-key']) : undefined;
      if (key === null) {
        throw new AppError('VALIDATION_ERROR', 400, 'Idempotency-Key must be 1-256 characters');
      }

      if (idempotency && key) {
        const replay = await idempotency.application.claimOrReplay(
          key,
          fundingIdempotencyOperation,
          idempotency.principalId,
          request.body,
        );
        if (replay) return reply.status(replay.status).send(replay.body);
      }

      try {
        const result = await options.service.fundAccount(request.body, {
          idempotency:
            idempotency && key ? { key, principalId: idempotency.principalId } : undefined,
        });
        return reply.status(201).send(result);
      } catch (error) {
        // Same settlement as transfers (see transfer-routes.ts).
        if (idempotency && key && !(error instanceof IdempotencyError)) {
          await idempotency.application
            .settleFailure(
              key,
              fundingIdempotencyOperation,
              idempotency.principalId,
              replayableFailure(error, request.id),
            )
            .catch((settleError: unknown) => {
              request.log.error({ err: settleError }, 'failed to settle idempotency claim');
            });
        }
        throw error;
      }
    },
  );
};
