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
