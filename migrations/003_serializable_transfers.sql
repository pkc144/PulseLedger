ALTER TABLE ledger_transactions
  DROP CONSTRAINT ledger_transactions_type_check,
  ADD CONSTRAINT ledger_transactions_type_check CHECK (type IN ('funding', 'transfer'));

CREATE TABLE transfers (
  id uuid PRIMARY KEY REFERENCES ledger_transactions (id) ON DELETE RESTRICT,
  source_account_id uuid NOT NULL,
  destination_account_id uuid NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency varchar(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status varchar(16) NOT NULL CHECK (status IN ('completed')),
  created_at timestamptz NOT NULL,
  CHECK (source_account_id <> destination_account_id),
  CONSTRAINT transfers_source_currency_fk
    FOREIGN KEY (source_account_id, currency)
    REFERENCES accounts (id, currency)
    ON DELETE RESTRICT,
  CONSTRAINT transfers_destination_currency_fk
    FOREIGN KEY (destination_account_id, currency)
    REFERENCES accounts (id, currency)
    ON DELETE RESTRICT
);

CREATE INDEX transfers_source_created_idx ON transfers (source_account_id, created_at, id);
CREATE INDEX transfers_destination_created_idx
  ON transfers (destination_account_id, created_at, id);

CREATE TRIGGER transfers_append_only
BEFORE UPDATE OR DELETE ON transfers
FOR EACH ROW
EXECUTE FUNCTION reject_ledger_mutation();
