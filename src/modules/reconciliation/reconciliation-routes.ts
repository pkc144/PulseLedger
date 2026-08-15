import type { FastifyPluginAsync } from 'fastify';
import {
  reconciliationIssueTypes,
  type ReconciliationApplication,
} from './reconciliation-domain.js';

interface ReconciliationRouteOptions {
  service: ReconciliationApplication;
}

const reconciliationIssueSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['accountId', 'type', 'cachedBalanceMinor', 'computedBalanceMinor', 'currency'],
  properties: {
    accountId: { type: 'string', format: 'uuid' },
    type: { type: 'string', enum: reconciliationIssueTypes },
    cachedBalanceMinor: { type: ['string', 'null'], pattern: '^-?[0-9]+$' },
    computedBalanceMinor: { type: 'string', pattern: '^-?[0-9]+$' },
    currency: { type: ['string', 'null'] },
  },
} as const;

const reconciliationReportSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'accountsChecked', 'generatedAt', 'issues'],
  properties: {
    ok: { type: 'boolean' },
    accountsChecked: { type: 'integer' },
    generatedAt: { type: 'string', format: 'date-time' },
    issues: { type: 'array', items: reconciliationIssueSchema },
  },
} as const;

export const reconciliationRoutes: FastifyPluginAsync<ReconciliationRouteOptions> = async (
  app,
  options,
) => {
  app.post(
    '/v1/admin/reconcile',
    {
      schema: {
        response: { 200: reconciliationReportSchema },
      },
    },
    async () => {
      return await options.service.run();
    },
  );
};
