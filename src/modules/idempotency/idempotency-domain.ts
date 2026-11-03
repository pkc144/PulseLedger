export type IdempotencyErrorCode = 'IDEMPOTENCY_CONFLICT' | 'IDEMPOTENCY_IN_PROGRESS';

export class IdempotencyError extends Error {
  public constructor(
    public readonly code: IdempotencyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'IdempotencyError';
  }
}

export interface IdempotencyRecord {
  completedAt: string | null;
  createdAt: string;
  key: string;
  operation: string;
  requestFingerprint: string;
  responseBody: unknown;
  responseStatus: number | null;
  status: 'in_progress' | 'completed';
}

export interface StoredIdempotentResponse {
  body: unknown;
  status: number;
}

export interface ClaimResult {
  action: 'proceed' | 'replay';
  record?: IdempotencyRecord;
  response?: StoredIdempotentResponse;
}

export interface IdempotencyStore {
  claim(params: {
    fingerprint: string;
    key: string;
    operation: string;
    principalId: string;
    staleTimeoutMs: number;
  }): Promise<ClaimResult>;

  complete(params: {
    key: string;
    operation: string;
    principalId: string;
    responseBody: unknown;
    responseStatus: number;
  }): Promise<void>;

  /** Deletes an unfinished (`in_progress`) claim so the key can be claimed again immediately. */
  release(params: { key: string; operation: string; principalId: string }): Promise<void>;

  /**
   * Deletes completed records older than the cutoff, in bounded batches. Only completed records
   * are eligible: an `in_progress` row may still be reclaimed by a retrying caller.
   */
  purgeCompletedBefore(cutoff: Date, batchSize: number): Promise<number>;
}

export interface IdempotencyApplication {
  /**
   * Keys are scoped to the principal that sent them: two callers may both choose "order-42"
   * without colliding, and one caller can never replay another's stored response.
   */
  claimOrReplay(
    key: string,
    operation: string,
    principalId: string,
    requestBody: unknown,
  ): Promise<StoredIdempotentResponse | null>;

  /**
   * Settles a claim whose operation failed and rolled back. With a `failure` response -- a
   * deterministic rejection such as insufficient funds -- that response becomes the key's stable
   * result and is replayed to every retry, exactly like a success. With `null` -- an outcome that
   * says nothing about the request itself, such as an exhausted retry budget -- the claim is
   * released so the client can retry at once rather than waiting out the stale window.
   */
  settleFailure(
    key: string,
    operation: string,
    principalId: string,
    failure: StoredIdempotentResponse | null,
  ): Promise<void>;
}

/** Matches the `idempotency_records.key` CHECK constraint. */
export const idempotencyKeyMaxLength = 256;

/**
 * Reads an `Idempotency-Key` header: `undefined` when absent or empty (the request simply is not
 * idempotent), `null` when present but too long to store -- which must be rejected as a client
 * error rather than reaching the database CHECK and surfacing as a 500.
 */
export function idempotencyKeyFrom(
  header: string | string[] | undefined,
): string | null | undefined {
  if (typeof header !== 'string' || header.length === 0) return undefined;
  return header.length <= idempotencyKeyMaxLength ? header : null;
}

export function canonicalSerialize(requestBody: unknown): string {
  return JSON.stringify(sortKeysDeep(requestBody));
}

function sortKeysDeep(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  return Object.keys(record)
    .sort()
    .reduce(
      (acc, key) => {
        acc[key] = sortKeysDeep(record[key]);
        return acc;
      },
      {} as Record<string, unknown>,
    );
}
