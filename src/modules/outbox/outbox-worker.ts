import {
  computeNextAttempt,
  outboxDefaultBatchSize,
  outboxDefaultMaxAttempts,
  outboxDefaultPollIntervalMs,
  type OutboxHandler,
  type OutboxStore,
  type OutboxWorkerConfig,
} from './outbox-domain.js';

export interface OutboxWorkerTelemetry {
  claimError(error: unknown): void;
  eventFailed(event: { eventId: string; error: string }): void;
  eventPermanentlyFailed(event: { attempts: number; eventId: string; lastError: string }): void;
  eventProcessed(event: { eventId: string }): void;
  pollCompleted(event: { batchSize: number; claimed: number; durationMs: number }): void;
  shuttingDown(): void;
}

const noOpHandler: OutboxHandler = async () => undefined;

const noOpTelemetry: OutboxWorkerTelemetry = {
  claimError: () => undefined,
  eventFailed: () => undefined,
  eventPermanentlyFailed: () => undefined,
  eventProcessed: () => undefined,
  pollCompleted: () => undefined,
  shuttingDown: () => undefined,
};

export class OutboxWorker {
  private readonly batchSize: number;
  private readonly handler: OutboxHandler;
  private readonly maxAttempts: number;
  private readonly pollIntervalMs: number;
  private readonly store: OutboxStore;
  private readonly telemetry: OutboxWorkerTelemetry;

  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped: Promise<void> | null = null;
  private resolveStopped: (() => void) | null = null;

  public constructor(store: OutboxStore, config: OutboxWorkerConfig = {}) {
    this.store = store;
    this.batchSize = config.batchSize ?? outboxDefaultBatchSize;
    this.handler = config.handler ?? noOpHandler;
    this.maxAttempts = config.maxAttempts ?? outboxDefaultMaxAttempts;
    this.pollIntervalMs = config.pollIntervalMs ?? outboxDefaultPollIntervalMs;
    this.telemetry = noOpTelemetry;
  }

  public setTelemetry(telemetry: OutboxWorkerTelemetry): void {
    (this as unknown as { telemetry: OutboxWorkerTelemetry }).telemetry = telemetry;
  }

  public start(): void {
    if (this.running) return;
    this.running = true;
    this.schedulePoll();
  }

  public async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.telemetry.shuttingDown();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.stopped) {
      this.stopped = new Promise((resolve) => {
        this.resolveStopped = resolve;
      });
    }
    this.resolveStopped?.();
    return this.stopped;
  }

  public isRunning(): boolean {
    return this.running;
  }

  private schedulePoll(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      void this.poll();
    }, this.pollIntervalMs);
  }

  private async poll(): Promise<void> {
    const startedAt = Date.now();
    try {
      const batch = await this.store.claimBatch(this.batchSize);
      for (const event of batch) {
        await this.processEvent(event);
      }
      const durationMs = Date.now() - startedAt;
      this.telemetry.pollCompleted({ batchSize: this.batchSize, claimed: batch.length, durationMs });
    } catch (error) {
      this.telemetry.claimError(error);
    } finally {
      if (this.running) {
        this.schedulePoll();
      } else {
        this.resolveStopped?.();
      }
    }
  }

  private async processEvent(event: { id: string; attempts: number }): Promise<void> {
    try {
      await this.handler(event as Parameters<OutboxHandler>[0]);
      await this.store.markProcessed(event.id);
      this.telemetry.eventProcessed({ eventId: event.id });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'unknown processing error';

      if (event.attempts >= this.maxAttempts) {
        await this.store.markFailed(event.id, message, 'infinity');
        this.telemetry.eventPermanentlyFailed({
          attempts: event.attempts,
          eventId: event.id,
          lastError: message,
        });
      } else {
        const nextAttemptAt = computeNextAttempt(event.attempts + 1, new Date());
        await this.store.markFailed(event.id, message, nextAttemptAt.toISOString());
        this.telemetry.eventFailed({ eventId: event.id, error: message });
      }
    }
  }
}
