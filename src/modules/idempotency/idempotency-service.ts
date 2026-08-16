import { createHash } from 'node:crypto';
import {
  canonicalSerialize,
  IdempotencyError,
  type IdempotencyApplication,
  type IdempotencyStore,
  type StoredIdempotentResponse,
} from './idempotency-domain.js';

export interface IdempotencyServiceOptions {
  staleTimeoutMs?: number;
}

export class IdempotencyService implements IdempotencyApplication {
  private readonly staleTimeoutMs: number;

  public constructor(
    private readonly store: IdempotencyStore,
    options: IdempotencyServiceOptions = {},
  ) {
    this.staleTimeoutMs = options.staleTimeoutMs ?? 30_000;
  }

  public async claimOrReplay(
    key: string,
    operation: string,
    principalId: string,
    requestBody: unknown,
  ): Promise<StoredIdempotentResponse | null> {
    const fingerprint = computeCanonicalFingerprint(requestBody);

    const result = await this.store.claim({
      fingerprint,
      key,
      operation,
      principalId,
      staleTimeoutMs: this.staleTimeoutMs,
    });

    if (result.action === 'replay') {
      if (!result.response) {
        throw new IdempotencyError(
          'IDEMPOTENCY_CONFLICT',
          'Duplicate idempotency key with a different request body',
        );
      }
      return result.response;
    }

    return null;
  }
}

export function computeCanonicalFingerprint(requestBody: unknown): string {
  const serialized = canonicalSerialize(requestBody);
  return createHash('sha256').update(serialized).digest('hex');
}
