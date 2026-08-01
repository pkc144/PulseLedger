CREATE TABLE accounts (
  id uuid PRIMARY KEY,
  currency varchar(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status varchar(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'frozen', 'closed')),
  balance_minor bigint NOT NULL DEFAULT 0,
  is_treasury boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (is_treasury OR balance_minor >= 0)
);

CREATE UNIQUE INDEX accounts_one_treasury_per_currency
  ON accounts (currency)
  WHERE is_treasury;

CREATE OR REPLACE FUNCTION reject_account_identity_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.currency <> OLD.currency OR NEW.is_treasury <> OLD.is_treasury THEN
    RAISE EXCEPTION 'account identity, currency, and treasury status are immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER accounts_immutable_identity
BEFORE UPDATE ON accounts
FOR EACH ROW
EXECUTE FUNCTION reject_account_identity_change();

INSERT INTO accounts (id, currency, is_treasury)
VALUES
  ('00000000-0000-4000-8000-000000000001', 'INR', true),
  ('00000000-0000-4000-8000-000000000002', 'USD', true)
ON CONFLICT DO NOTHING;
