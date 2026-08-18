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
