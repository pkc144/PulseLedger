ALTER TABLE ledger_transactions
  ADD CONSTRAINT ledger_transactions_id_currency_type_unique UNIQUE (id, currency, type);

DROP INDEX transfers_source_created_idx;
DROP INDEX transfers_destination_created_idx;

ALTER TABLE transfers
  DROP CONSTRAINT transfers_id_fkey,
  DROP COLUMN created_at,
  ADD COLUMN ledger_type varchar(32) NOT NULL DEFAULT 'transfer',
  ADD CONSTRAINT transfers_ledger_type_check CHECK (ledger_type = 'transfer'),
  ADD CONSTRAINT transfers_ledger_identity_fk
    FOREIGN KEY (id, currency, ledger_type)
    REFERENCES ledger_transactions (id, currency, type)
    ON DELETE RESTRICT;

CREATE INDEX transfers_source_id_idx ON transfers (source_account_id, id);
CREATE INDEX transfers_destination_id_idx ON transfers (destination_account_id, id);
