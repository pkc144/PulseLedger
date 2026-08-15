import type { OutboxHandler } from '../outbox/outbox-domain.js';
import type { AuditConsumerStore } from './audit-domain.js';

export interface AuditConsumerTelemetry {
  duplicate(event: { eventId: string }): void;
  processed(event: { eventId: string }): void;
}

const noOpTelemetry: AuditConsumerTelemetry = {
  duplicate: () => undefined,
  processed: () => undefined,
};

/**
 * Adapts the idempotent consumer inbox to the OutboxWorker's handler contract, so it can be
 * used directly as the worker's `handler`. Outbox delivery is at-least-once; this makes the
 * resulting audit effect at-most-once per event.
 */
export class AuditConsumerService {
  private telemetry: AuditConsumerTelemetry = noOpTelemetry;

  public constructor(private readonly store: AuditConsumerStore) {}

  public setTelemetry(telemetry: AuditConsumerTelemetry): void {
    this.telemetry = telemetry;
  }

  public readonly handle: OutboxHandler = async (event) => {
    const result = await this.store.consume({
      aggregateId: event.aggregateId,
      aggregateType: event.aggregateType,
      eventId: event.id,
      eventType: event.eventType,
      payload: event.payload,
    });

    if (result.duplicate) {
      this.telemetry.duplicate({ eventId: event.id });
    } else {
      this.telemetry.processed({ eventId: event.id });
    }
  };
}
