-- Idempotent consumer inbox + the audit effect it guards. The
-- (consumer_name, event_id) primary key is the dedup boundary: outbox
-- delivery is at-least-once, but a duplicate delivery's claim attempt
-- conflicts on this key and inserts nothing, so the business effect in
-- audit_effects is produced at most once per event.
CREATE TABLE consumer_inbox (
  consumer_name text NOT NULL CHECK (char_length(consumer_name) BETWEEN 1 AND 64),
  event_id uuid NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer_name, event_id)
);

CREATE TABLE audit_effects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL UNIQUE,
  aggregate_id uuid NOT NULL,
  aggregate_type text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_effects_aggregate_idx ON audit_effects (aggregate_id);

-- Reuse the append-only guard already defined for the ledger (migration 002):
-- neither the inbox claim nor the effect it produced may be mutated or removed.
CREATE TRIGGER consumer_inbox_append_only
BEFORE UPDATE OR DELETE ON consumer_inbox
FOR EACH ROW
EXECUTE FUNCTION reject_ledger_mutation();

CREATE TRIGGER audit_effects_append_only
BEFORE UPDATE OR DELETE ON audit_effects
FOR EACH ROW
EXECUTE FUNCTION reject_ledger_mutation();
