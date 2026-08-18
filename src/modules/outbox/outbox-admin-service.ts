import {
  outboxDefaultListLimit,
  outboxDefaultPurgeBatchSize,
  type OutboxAdminApplication,
  type OutboxAdminStore,
  type OutboxRecord,
} from './outbox-domain.js';

/**
 * Inspection, deliberate replay, and retention for the outbox. Every operation here is something
 * a human chose to do: the worker never calls into this service.
 */
export class OutboxAdminService implements OutboxAdminApplication {
  public constructor(private readonly store: OutboxAdminStore) {}

  public async listParked(limit: number = outboxDefaultListLimit): Promise<OutboxRecord[]> {
    return await this.store.listParked(Math.max(1, Math.trunc(limit)));
  }

  public async countParked(): Promise<number> {
    return await this.store.countParked();
  }

  public async findById(id: string): Promise<OutboxRecord | null> {
    return await this.store.findById(id);
  }

  public async replay(id: string): Promise<boolean> {
    return await this.store.replay(id);
  }

  public async replayAllParked(): Promise<number> {
    return await this.store.replayAllParked();
  }

  public async purgeProcessedBefore(
    cutoff: Date,
    batchSize: number = outboxDefaultPurgeBatchSize,
  ): Promise<number> {
    return await this.store.purgeProcessedBefore(cutoff, Math.max(1, Math.trunc(batchSize)));
  }
}
