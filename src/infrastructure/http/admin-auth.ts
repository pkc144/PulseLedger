import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../../errors.js';

export const adminApiKeyHeader = 'x-admin-api-key';

/**
 * Fastify preHandler guarding administrative routes with a shared secret. Wired only at the
 * composition root (app.ts) around an encapsulated child context, so feature route files stay
 * unaware of authentication entirely.
 */
export function requireAdminApiKey(expectedKey: string) {
  const expected = Buffer.from(expectedKey, 'utf8');

  return async function adminApiKeyGuard(request: FastifyRequest): Promise<void> {
    const provided = request.headers[adminApiKeyHeader];
    if (typeof provided !== 'string' || provided.length === 0) {
      throw new AppError('UNAUTHORIZED', 401, 'Missing admin API key');
    }

    const providedBuffer = Buffer.from(provided, 'utf8');
    const valid =
      providedBuffer.length === expected.length && timingSafeEqual(providedBuffer, expected);
    if (!valid) {
      throw new AppError('UNAUTHORIZED', 401, 'Invalid admin API key');
    }
  };
}
