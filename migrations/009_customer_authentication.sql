-- Customer authentication and account ownership.
--
-- Three pieces: `principals` is who a caller is, `api_keys` is how they prove it, and
-- `accounts.owner_principal_id` is what they are allowed to touch. Ownership lives here rather
-- than only in the application because it is an invariant, not a policy: an account with no
-- owner, or an account that quietly changes hands, is a bug no HTTP layer can undo.

CREATE TABLE principals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 128),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id uuid NOT NULL REFERENCES principals (id) ON DELETE RESTRICT,
  -- Public lookup handle: the leading characters of the secret. Safe to store and display, and
  -- the unique index turns verification into one indexed read instead of hashing every row.
  key_prefix text NOT NULL UNIQUE CHECK (char_length(key_prefix) = 12),
  -- SHA-256 of the whole secret. The secret is 256 bits of CSPRNG output, not a human password:
  -- there is no dictionary to attack and no work factor worth tuning, so a fast hash is correct
  -- here in a way it would not be for a password column.
  key_hash text NOT NULL CHECK (char_length(key_hash) = 64),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE INDEX api_keys_principal_idx ON api_keys (principal_id);

ALTER TABLE accounts
  ADD COLUMN owner_principal_id uuid REFERENCES principals (id) ON DELETE RESTRICT;

-- Accounts created before authentication existed keep their journal history, but they must still
-- belong to someone or the CHECK below would reject them. Attribute them to one clearly named
-- principal rather than inventing a plausible owner per account.
DO $$
DECLARE
  legacy_principal_id uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM accounts WHERE is_treasury = false AND owner_principal_id IS NULL) THEN
    INSERT INTO principals (name) VALUES ('legacy-pre-authentication')
    RETURNING id INTO legacy_principal_id;

    UPDATE accounts
    SET owner_principal_id = legacy_principal_id
    WHERE is_treasury = false AND owner_principal_id IS NULL;
  END IF;
END;
$$;

-- Treasuries belong to the system and have no owner; every customer account has exactly one.
ALTER TABLE accounts
  ADD CONSTRAINT accounts_customer_owner_check CHECK (is_treasury OR owner_principal_id IS NOT NULL);

CREATE INDEX accounts_owner_idx ON accounts (owner_principal_id);

-- An account cannot change hands. Ownership joins identity, currency, and treasury status in the
-- existing immutability guard, so a transfer of control has to be a new account plus a journaled
-- posting, never a silent UPDATE. Replaced after the backfill above, which legitimately writes
-- the column once.
CREATE OR REPLACE FUNCTION reject_account_identity_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.currency <> OLD.currency OR NEW.is_treasury <> OLD.is_treasury THEN
    RAISE EXCEPTION 'account identity, currency, and treasury status are immutable';
  END IF;
  IF NEW.owner_principal_id IS DISTINCT FROM OLD.owner_principal_id THEN
    RAISE EXCEPTION 'account ownership is immutable';
  END IF;
  RETURN NEW;
END;
$$;

-- An idempotency key is chosen by the client, so two unrelated callers can legitimately both send
-- "order-42". Before authentication the key space was global and that collision was impossible to
-- express; now the owning principal is part of the identity of a request. Historical rows predate
-- authentication and keep a NULL principal -- NULLS NOT DISTINCT keeps them deduplicating against
-- each other exactly as the old primary key did.
ALTER TABLE idempotency_records
  ADD COLUMN principal_id uuid REFERENCES principals (id) ON DELETE RESTRICT;

ALTER TABLE idempotency_records DROP CONSTRAINT idempotency_records_pkey;

CREATE UNIQUE INDEX idempotency_records_identity
  ON idempotency_records (principal_id, key, operation) NULLS NOT DISTINCT;
