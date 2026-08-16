import type pg from 'pg';
import { PostgresAuthStore } from '../../src/modules/auth/auth-repository.js';
import { AuthService } from '../../src/modules/auth/auth-service.js';

export interface TestPrincipal {
  /** Ready to spread into an `inject`/`fetch` call: `{ authorization: 'Bearer pl_live_...' }`. */
  authHeaders: { authorization: string };
  key: string;
  principalId: string;
}

/**
 * Creates a principal and one live API key through the real service, so tests exercise the same
 * hashing and lookup path production uses instead of inserting rows by hand.
 */
export async function createTestPrincipal(pool: pg.Pool, name: string): Promise<TestPrincipal> {
  const service = new AuthService(new PostgresAuthStore(pool));
  const principal = await service.createPrincipal(`${name}-${Date.now()}`);
  const issued = await service.issueApiKey(principal.id);
  return {
    authHeaders: { authorization: `Bearer ${issued.key}` },
    key: issued.key,
    principalId: principal.id,
  };
}
