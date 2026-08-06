CREATE TABLE idempotency_records (
  key text NOT NULL CHECK (char_length(key) BETWEEN 1 AND 256),
  operation text NOT NULL CHECK (operation ~ '^[a-z_]{1,64}$'),
  request_fingerprint text NOT NULL,
  status text NOT NULL CHECK (status IN ('in_progress', 'completed')),
  response_status_code integer,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (key, operation)
);
