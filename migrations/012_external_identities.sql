-- Sign-in through an external identity provider (Firebase Authentication: Google, email/password).
--
-- A provider account is mapped to exactly one principal, permanently. The principal stays the unit
-- of ownership: accounts, idempotency keys, and authorization are unchanged, so a Firebase user and
-- an API-key caller are the same kind of thing to everything past the authentication guard.
--
-- The primary key is what makes first sign-in safe under concurrency: two simultaneous first
-- requests from the same user both try to insert the mapping, exactly one succeeds, and the other
-- rolls back its freshly created principal and reads the winner's.

CREATE TABLE principal_identities (
  provider text NOT NULL CHECK (provider IN ('firebase')),
  -- The provider's stable user ID (the token's `sub`). Never the email: emails change hands.
  subject text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 128),
  principal_id uuid NOT NULL UNIQUE REFERENCES principals (id) ON DELETE RESTRICT,
  -- Recorded at first sign-in for operators' benefit only; never used for lookup or authorization.
  email text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, subject)
);

-- A mapping is identity, like account ownership: it cannot be repointed at another principal.
CREATE FUNCTION reject_principal_identity_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'principal_identities rows are immutable';
END;
$$;

CREATE TRIGGER principal_identities_immutable
BEFORE UPDATE OR DELETE ON principal_identities
FOR EACH ROW EXECUTE FUNCTION reject_principal_identity_change();
