ALTER TABLE accounts
  ADD CONSTRAINT accounts_id_currency_unique UNIQUE (id, currency);

CREATE TABLE ledger_transactions (
  id uuid PRIMARY KEY,
  type varchar(32) NOT NULL CHECK (type IN ('funding')),
  reference varchar(128) NOT NULL UNIQUE,
  currency varchar(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  finalized boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, currency)
);

CREATE TABLE journal_entries (
  id uuid PRIMARY KEY,
  transaction_id uuid NOT NULL,
  account_id uuid NOT NULL,
  currency varchar(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  direction varchar(6) NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT journal_entries_transaction_currency_fk
    FOREIGN KEY (transaction_id, currency)
    REFERENCES ledger_transactions (id, currency)
    ON DELETE RESTRICT,
  CONSTRAINT journal_entries_account_currency_fk
    FOREIGN KEY (account_id, currency)
    REFERENCES accounts (id, currency)
    ON DELETE RESTRICT
);

CREATE INDEX journal_entries_transaction_id_idx ON journal_entries (transaction_id);
CREATE INDEX journal_entries_account_created_idx
  ON journal_entries (account_id, created_at, id);

CREATE OR REPLACE FUNCTION reject_ledger_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;

CREATE OR REPLACE FUNCTION reject_ledger_transaction_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
    AND OLD.finalized = false
    AND NEW.finalized = true
    AND NEW.id = OLD.id
    AND NEW.type = OLD.type
    AND NEW.reference = OLD.reference
    AND NEW.currency = OLD.currency
    AND NEW.created_at = OLD.created_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ledger_transactions is append-only' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER ledger_transactions_append_only
BEFORE UPDATE OR DELETE ON ledger_transactions
FOR EACH ROW
EXECUTE FUNCTION reject_ledger_transaction_mutation();

CREATE TRIGGER journal_entries_append_only
BEFORE UPDATE OR DELETE ON journal_entries
FOR EACH ROW
EXECUTE FUNCTION reject_ledger_mutation();

CREATE OR REPLACE FUNCTION reject_entry_for_finalized_transaction()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM ledger_transactions
    WHERE id = NEW.transaction_id AND finalized = true
  ) THEN
    RAISE EXCEPTION 'cannot append to finalized ledger transaction' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER journal_entries_finalized_transaction
BEFORE INSERT ON journal_entries
FOR EACH ROW
EXECUTE FUNCTION reject_entry_for_finalized_transaction();

CREATE OR REPLACE FUNCTION assert_ledger_transaction_balanced()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_transaction_id uuid;
  debit_total numeric;
  credit_total numeric;
  debit_count bigint;
  credit_count bigint;
  transaction_finalized boolean;
BEGIN
  IF TG_TABLE_NAME = 'journal_entries' THEN
    target_transaction_id := NEW.transaction_id;
  ELSE
    target_transaction_id := NEW.id;
  END IF;

  SELECT finalized
  INTO transaction_finalized
  FROM ledger_transactions
  WHERE id = target_transaction_id;

  IF transaction_finalized IS NOT TRUE THEN
    RAISE EXCEPTION 'ledger transaction % is not finalized', target_transaction_id
      USING ERRCODE = '23514';
  END IF;

  SELECT
    COALESCE(sum(amount_minor) FILTER (WHERE direction = 'debit'), 0),
    COALESCE(sum(amount_minor) FILTER (WHERE direction = 'credit'), 0),
    count(*) FILTER (WHERE direction = 'debit'),
    count(*) FILTER (WHERE direction = 'credit')
  INTO debit_total, credit_total, debit_count, credit_count
  FROM journal_entries
  WHERE transaction_id = target_transaction_id;

  IF debit_count = 0 OR credit_count = 0 OR debit_total <> credit_total THEN
    RAISE EXCEPTION 'ledger transaction % is not balanced', target_transaction_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER ledger_transaction_must_balance
AFTER INSERT ON ledger_transactions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION assert_ledger_transaction_balanced();

CREATE CONSTRAINT TRIGGER journal_entry_transaction_must_balance
AFTER INSERT ON journal_entries
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION assert_ledger_transaction_balanced();

CREATE OR REPLACE FUNCTION post_ledger_transaction(
  requested_transaction_id uuid,
  requested_type varchar,
  requested_reference varchar,
  requested_entry_ids uuid[],
  requested_account_ids uuid[],
  requested_directions varchar[],
  requested_amounts bigint[]
)
RETURNS TABLE (
  id uuid,
  type varchar,
  reference varchar,
  currency varchar,
  created_at timestamptz
)
LANGUAGE plpgsql
AS $$
DECLARE
  entry_count integer := cardinality(requested_entry_ids);
  posting_currency varchar(3);
  debit_total numeric;
  credit_total numeric;
BEGIN
  IF entry_count < 2
    OR entry_count <> cardinality(requested_account_ids)
    OR entry_count <> cardinality(requested_directions)
    OR entry_count <> cardinality(requested_amounts) THEN
    RAISE EXCEPTION 'invalid posting entry arrays' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (SELECT 1 FROM unnest(requested_amounts) AS amount WHERE amount <= 0)
    OR EXISTS (
      SELECT 1 FROM unnest(requested_directions) AS direction
      WHERE direction NOT IN ('debit', 'credit')
    ) THEN
    RAISE EXCEPTION 'invalid posting entry' USING ERRCODE = '22023';
  END IF;

  PERFORM a.id
  FROM accounts a
  WHERE a.id = ANY(requested_account_ids)
  ORDER BY a.id
  FOR UPDATE;

  SELECT min(a.currency)
  INTO posting_currency
  FROM accounts a
  WHERE a.id = ANY(requested_account_ids)
    AND a.status = 'active';

  IF (
    SELECT count(*)
    FROM accounts AS existing_account
    WHERE existing_account.id = ANY(requested_account_ids)
      AND existing_account.status = 'active'
  ) <> (
    SELECT count(DISTINCT requested_account.account_id)
    FROM unnest(requested_account_ids) AS requested_account(account_id)
  ) THEN
    RAISE EXCEPTION 'posting account unavailable' USING ERRCODE = '23503';
  END IF;

  IF (SELECT count(DISTINCT a.currency) FROM accounts a WHERE a.id = ANY(requested_account_ids)) <> 1 THEN
    RAISE EXCEPTION 'mixed-currency posting' USING ERRCODE = '23514';
  END IF;

  SELECT
    COALESCE(sum(amount) FILTER (WHERE direction = 'debit'), 0),
    COALESCE(sum(amount) FILTER (WHERE direction = 'credit'), 0)
  INTO debit_total, credit_total
  FROM unnest(requested_directions, requested_amounts) AS entry(direction, amount);

  IF debit_total <> credit_total THEN
    RAISE EXCEPTION 'unbalanced posting' USING ERRCODE = '23514';
  END IF;

  INSERT INTO ledger_transactions (id, type, reference, currency)
  VALUES (requested_transaction_id, requested_type, requested_reference, posting_currency);

  INSERT INTO journal_entries (
    id, transaction_id, account_id, currency, direction, amount_minor
  )
  SELECT
    entry_id,
    requested_transaction_id,
    account_id,
    posting_currency,
    direction,
    amount
  FROM unnest(
    requested_entry_ids,
    requested_account_ids,
    requested_directions,
    requested_amounts
  ) AS entry(entry_id, account_id, direction, amount);

  UPDATE accounts a
  SET balance_minor = a.balance_minor + delta.amount,
      updated_at = now()
  FROM (
    SELECT
      account_id,
      sum(CASE direction WHEN 'debit' THEN amount ELSE -amount END) AS amount
    FROM unnest(requested_account_ids, requested_directions, requested_amounts)
      AS entry(account_id, direction, amount)
    GROUP BY account_id
  ) AS delta
  WHERE a.id = delta.account_id;

  UPDATE ledger_transactions
  SET finalized = true
  WHERE ledger_transactions.id = requested_transaction_id;

  RETURN QUERY
  SELECT ledger_transaction.id, ledger_transaction.type, ledger_transaction.reference,
         ledger_transaction.currency, ledger_transaction.created_at
  FROM ledger_transactions AS ledger_transaction
  WHERE ledger_transaction.id = requested_transaction_id;
END;
$$;
