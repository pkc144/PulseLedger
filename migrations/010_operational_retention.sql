-- Indexes supporting retention sweeps and dead-letter inspection.
--
-- Both sweeps delete by (status, timestamp), and both would otherwise scan a table that grows
-- forever. Partial indexes keep them cheap and, just as importantly, keep them small: only the
-- rows a sweep can ever touch are indexed, so the index does not grow with live traffic.

-- Retention: processed outbox events are deleted by age.
CREATE INDEX outbox_events_processed_at_idx
  ON outbox_events (processed_at)
  WHERE status = 'processed';

-- Dead-letter inspection: parked events are the ones a human has to look at. There are normally
-- very few, so this index is tiny and makes `outbox list` an index scan instead of a seq scan.
CREATE INDEX outbox_events_parked_idx
  ON outbox_events (created_at)
  WHERE status = 'failed' AND next_attempt_at = 'infinity';

-- Retention: completed idempotency records are deleted by age.
CREATE INDEX idempotency_records_completed_at_idx
  ON idempotency_records (completed_at)
  WHERE status = 'completed';
