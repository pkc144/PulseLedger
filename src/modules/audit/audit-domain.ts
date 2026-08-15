export const auditConsumerName = 'audit';

export interface AuditConsumeInput {
  aggregateId: string;
  aggregateType: string;
  eventId: string;
  eventType: string;
  payload: unknown;
}

export interface AuditConsumeResult {
  /** True when this event was already processed and no new effect was recorded. */
  duplicate: boolean;
}

export interface AuditConsumerStore {
  /**
   * Claims (consumer_name, event_id) and records the audit effect atomically.
   * A duplicate delivery of an already-claimed event is a successful no-op.
   */
  consume(input: AuditConsumeInput): Promise<AuditConsumeResult>;
}
