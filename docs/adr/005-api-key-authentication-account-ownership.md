# ADR-005: API-key authentication with database-enforced account ownership

- Status: Accepted
- Date: 2026-08-16

## Context

Through v1.0.0 the customer-facing API was unauthenticated: anyone who could reach the process could
create an account, read any account's balance and journal, and move money out of any account. That
was a deliberate v1 exclusion — the project's subject was ledger correctness — but it makes the
system's central claim ("money cannot move incorrectly") hollow, because the largest hole is not a
concurrency bug, it is that there was no notion of who is asking.

Two questions had to be answered together:

1. **What is a credential here?** There are no human end users, no browser, and no session. Callers
   are programs.
2. **What does a credential entitle you to?** Authentication alone would only close the front door;
   any authenticated caller could still spend from anyone's account.

## Decision

**Credentials are API keys, one or more per principal.** A `principals` row is an identity; an
`api_keys` row is a way to prove it. A secret is `pl_live_` plus 43 base64url characters (32 bytes
of CSPRNG output). Only two things are stored: a 12-character `key_prefix` — the leading characters
of the secret, used as an indexed lookup handle — and the SHA-256 hash of the whole secret. The
secret itself is returned exactly once, by the call that created it, and never exists in the
database.

Verification is one indexed read by prefix followed by a constant-time comparison of digests. Every
failure — unparseable header, unknown prefix, wrong secret, revoked key, disabled principal —
returns the same `401 UNAUTHORIZED` with the same message.

**A fast hash is correct for this, and would be wrong for a password.** SHA-256 has no work factor;
that matters when the input is a low-entropy human secret vulnerable to dictionary attack. These
secrets are 256 bits of uniform randomness, where an offline attacker gains nothing from a slow
hash — and a slow hash would tax every authenticated request, on the request path of a ledger.

**Authorization is account ownership, enforced in PostgreSQL.** `accounts.owner_principal_id`
references `principals`, is `NOT NULL` for every customer account (`CHECK (is_treasury OR
owner_principal_id IS NOT NULL)`), and is immutable — the same trigger that freezes an account's
identity and currency now rejects a change of owner. The rules:

| Operation                     | Rule                                            |
| ----------------------------- | ----------------------------------------------- |
| Create an account             | It belongs to the calling principal             |
| Read an account or its ledger | Only the owner                                  |
| Transfer **from** an account  | Only the owner                                  |
| Transfer **to** an account    | Anyone — a payee does not consent to being paid |
| Read a transfer               | Either participant's owner                      |
| Fund, reconcile, metrics      | Administrator only, unchanged                   |

**Ownership is checked against locked rows inside the transfer's `SERIALIZABLE` transaction**, not
in the route and not against an earlier read. Reads filter by owner in the `WHERE` clause rather
than fetching a row and comparing afterwards.

**Unauthorized access is reported as `404`, never `403`.** A caller must not be able to distinguish
"an account that exists and belongs to someone else" from "no such account"; a `403` would turn the
API into an oracle for enumerating account and transfer IDs.

**Authentication runs on Fastify's `onRequest` hook, not `preHandler`.** Fastify validates the body
before `preHandler`, so an anonymous caller would otherwise receive schema feedback (`400`) instead
of `401` and could map request shapes without a credential.

**Idempotency keys are scoped to the principal.** A key is a client-chosen string, so two unrelated
callers can both send `order-42`. The unique index became `(principal_id, key, operation)`; a caller
can neither collide with nor replay another caller's stored response.

Keys are minted and revoked only through admin-guarded routes (`POST /v1/admin/principals`,
`POST /v1/admin/principals/:id/api-keys`, `POST /v1/admin/api-keys/:id/revoke`). A customer key
cannot issue a key — for itself or anyone else.

## Consequences

- The API has a real security boundary: a caller can only see and spend its own money, and the
  boundary is enforced by the database, not by remembering to check in every handler.
- Every customer request costs one extra indexed read. There is no session cache and no token
  expiry to reason about; revocation is immediate because the check hits the row every time.
- `owner_principal_id` being immutable means an account cannot be transferred between principals.
  Moving a balance requires a new account and a journaled posting, which keeps the audit trail.
- Legacy accounts created before this change are attributed to one clearly named
  `legacy-pre-authentication` principal by the migration, rather than being left unowned (which the
  constraint forbids) or given invented owners.
- Operational surfaces that drive the customer API — the seed script, `scripts/demo.sh`, and all
  four k6 scenarios — now provision a principal and key first, exactly as a real client would.
- There is still no per-key scope or expiry, and the administrative credential remains a single
  static key. Those are recorded as limitations in [TRADEOFFS.md](../TRADEOFFS.md).

## Alternatives considered

- **JWT bearer tokens with a login endpoint** were rejected for v1.1: they need credential storage
  and password hashing for principals that are programs, plus expiry and refresh handling, and they
  make revocation eventually-consistent (a stolen token stays valid until it expires). API keys give
  immediate revocation with less machinery. The guard resolves a principal behind a plain function
  type, so adding a token verifier later does not touch routes or services.
- **Authentication without authorization** was rejected as security theater: it would close the
  front door while leaving every authenticated caller able to spend anyone's balance.
- **Ownership checked only in the application layer** was rejected for the same reason the balance
  and balancing rules are not application-only (ADR-001): a defect or a direct SQL session would
  otherwise be able to create an unowned account or silently reassign one.
- **`403 Forbidden` for another principal's resources** was rejected because it confirms existence.
- **Argon2/bcrypt for key hashing** was rejected as a cost with no benefit for high-entropy random
  secrets, paid on every request. It would be the right choice the moment a human-chosen password
  enters the system.
- **A global idempotency key space** was kept only until it was tested: a test proved two principals
  could collide on one key, which is why the unique index now includes the principal.
