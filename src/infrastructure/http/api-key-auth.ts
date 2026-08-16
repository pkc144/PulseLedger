import type { FastifyRequest } from 'fastify';
import { AppError } from '../../errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Set by {@link requireApiKey} for routes behind the customer guard, and absent everywhere
     * else. Routes treat it as the caller's identity for authorization decisions.
     */
    principalId?: string;
  }
}

/**
 * Resolves a bearer secret to the identity it belongs to, or throws. Deliberately a plain
 * function type rather than an import from the auth module: this file is shared infrastructure
 * and must not depend on a feature (`npm run architecture:check` enforces that), and the
 * transport layer genuinely does not care how a secret is verified.
 */
export type PrincipalResolver = (secret: string) => Promise<{ id: string }>;

const bearerPattern = /^Bearer (.+)$/;

function extractBearerToken(header: string | string[] | undefined): string | null {
  if (typeof header !== 'string') return null;
  const match = bearerPattern.exec(header.trim());
  return match?.[1]?.trim() || null;
}

/**
 * Fastify `onRequest` hook guarding customer-facing routes. Wired only at the composition root
 * around an encapsulated child context, so feature route files never import authentication — they
 * read `request.principalId` and enforce ownership with it.
 *
 * `onRequest` rather than `preHandler` deliberately: Fastify validates the body *before*
 * `preHandler`, so an anonymous caller would otherwise receive schema feedback (400) instead of
 * 401 and could map request shapes without a credential. This hook only reads a header, so it has
 * no reason to wait for a parsed body.
 */
export function requireApiKey(resolve: PrincipalResolver) {
  return async function apiKeyGuard(request: FastifyRequest): Promise<void> {
    const secret = extractBearerToken(request.headers.authorization);
    if (!secret) {
      throw new AppError('UNAUTHORIZED', 401, 'Missing or malformed Authorization header');
    }

    // A rejected key throws UNAUTHORIZED from the resolver with a single generic message, so a
    // caller cannot distinguish "no such key" from "revoked" from "disabled principal".
    const principal = await resolve(secret);
    request.principalId = principal.id;
  };
}
