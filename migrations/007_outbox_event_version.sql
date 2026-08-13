-- Add a schema version to the outbox event envelope so downstream consumers
-- can evolve payload shapes without ambiguity, and widen the claim index to
-- also cover stale 'processing' rows reclaimed after a worker crash.
ALTER TABLE outbox_events
  ADD COLUMN IF NOT EXISTS event_version smallint NOT NULL DEFAULT 1
    CHECK (event_version >= 1);

DROP INDEX IF EXISTS outbox_events_claim_idx;
CREATE INDEX outbox_events_claim_idx
  ON outbox_events (status, next_attempt_at, created_at)
  WHERE status IN ('pending', 'failed', 'processing');
