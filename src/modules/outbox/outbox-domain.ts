export const outboxAggregateTypes = ['transfer', 'funding'] as const;
export type OutboxAggregateType = (typeof outboxAggregateTypes)[number];

export const outboxStatuses = ['pending', 'processing', 'failed', 'processed'] as const;
export type OutboxStatus = (typeof outboxStatuses)[number];

export interface NewOutboxEvent {
  aggregateId: string;
  aggregateType: OutboxAggregateType;
  eventType: string;
  eventVersion?: number;
  payload: unknown;
}

export interface OutboxRecord {
  aggregateId: string;
  aggregateType: OutboxAggregateType;
  attempts: number;
  createdAt: string;
  eventType: string;
  eventVersion: number;
  id: string;
  lastError: string | null;
  nextAttemptAt: string | null;
  payload: unknown;
  processedAt: string | null;
  status: OutboxStatus;
}

export interface Queryable {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number | null }>;
}

export interface OutboxStore {
  insert(db: Queryable, event: NewOutboxEvent): Promise<void>;
  claimBatch(batchSize: number): Promise<OutboxRecord[]>;
  markProcessed(id: string): Promise<void>;
  markFailed(id: string, error: string, nextAttemptAt: string): Promise<void>;
  stats(): Promise<{ failed: number; pending: number; processing: number }>;
}

export type OutboxHandler = (event: OutboxRecord) => Promise<void>;

/**
 * Operator-facing view of the outbox, kept separate from `OutboxStore` so the worker's hot path
 * cannot accidentally reach for inspection or replay, and so a future admin surface can be wired
 * without widening the interface the worker depends on.
 */
export interface OutboxAdminStore {
  /** Events parked after exhausting their attempts: status 'failed' with no next attempt. */
  listParked(limit: number): Promise<OutboxRecord[]>;
  findById(id: string): Promise<OutboxRecord | null>;
  /** Returns false when the id is unknown or the event is not parked. */
  replay(id: string): Promise<boolean>;
  replayAllParked(): Promise<number>;
  countParked(): Promise<number>;
  /** Deletes processed events older than the cutoff, in bounded batches. Returns rows removed. */
  purgeProcessedBefore(cutoff: Date, batchSize: number): Promise<number>;
}

export interface OutboxAdminApplication {
  countParked(): Promise<number>;
  findById(id: string): Promise<OutboxRecord | null>;
  listParked(limit?: number): Promise<OutboxRecord[]>;
  purgeProcessedBefore(cutoff: Date, batchSize?: number): Promise<number>;
  replay(id: string): Promise<boolean>;
  replayAllParked(): Promise<number>;
}

export const outboxDefaultListLimit = 20;
export const outboxDefaultPurgeBatchSize = 1_000;

export interface OutboxWorkerConfig {
  batchSize?: number;
  handler?: OutboxHandler;
  maxAttempts?: number;
  pollIntervalMs?: number;
}

export const outboxDefaultBatchSize = 10;
export const outboxDefaultPollIntervalMs = 1_000;
export const outboxDefaultMaxAttempts = 12;

/** Current schema version stamped on newly written outbox event envelopes. */
export const outboxCurrentEventVersion = 1;

/**
 * How long a claimed ('processing') event is leased to a worker before it is
 * considered abandoned and eligible for reclaim. A worker that crashes between
 * claim and completion leaves the row 'processing'; once the lease elapses,
 * another worker reclaims it so the event is still delivered at least once.
 */
export const outboxDefaultClaimLeaseSeconds = 300;

export function computeNextAttempt(attempts: number, failedAt: Date): Date {
  const baseMs = 100;
  const delay = Math.min(baseMs * 2 ** (attempts - 1), 60_000);
  const jitter = 0.5 + Math.random() * 0.5;
  return new Date(failedAt.getTime() + Math.floor(delay * jitter));
}
