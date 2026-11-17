# ADR-007: Firebase ID tokens as a second customer credential

- Status: Accepted (unreleased on `main`)
- Supersedes: nothing. Extends [ADR-005](./005-api-key-authentication-account-ownership.md)

## Context

ADR-005 gave every caller an identity (a principal) and a credential (an API key) and assumed the
callers were programs. The browser UI in `web/` changed that assumption: people now sign in with a
Google account or an email and password. Asking a person to paste a `pl_live_` secret into a login
form, or having an administrator mint a key for every person, is not a sign-in flow.

Three constraints shaped the decision:

1. **Nothing past the guard should change.** Ownership, idempotency scoping, and every owner-scoped
   query depend on `request.principalId`. A second kind of user must not become a second kind of
   principal.
2. **No new secret in the backend.** The Firebase Admin SDK needs a service-account credential.
   That is one more secret to store and rotate, and it grants far more than token verification.
3. **First sign-in must be safe under concurrency.** A browser can easily send several requests at
   once before the user "exists". That must never create two principals for one person.

## Decision

**Accept Firebase Authentication ID tokens in the same `Authorization: Bearer` slot as API keys,
verified with Google's public keys only, and map each Firebase user to exactly one principal,
permanently.**

- **Routing by shape.** In `app.ts`, a bearer starting with `pl_live_` takes the API-key path. Any
  other bearer is verified as a Firebase token, but only when `FIREBASE_PROJECT_ID` is set. With
  Firebase off, behavior is identical to v1.2.
- **Verification without the Admin SDK** (`src/infrastructure/http/firebase-id-token.ts`, using
  `jose`). The token must have an RS256 signature against Google's published JWKS, with
  `iss = https://securetoken.google.com/<project>` and `aud = <project>`. Its `exp` must be in the
  future and its `iat` and `auth_time` in the past (`iat` is checked explicitly because `jose` only
  checks it with `maxTokenAge`). Its `sub` must be 1–128 characters. The project ID is validated at
  boot because it is interpolated into the expected issuer.
- **Coarse errors, with one deliberate exception.** Every problem with the token itself is the same
  `401`. If Google's key set cannot be fetched, the result is `503 AUTH_PROVIDER_UNAVAILABLE`,
  because the caller's credential may be valid and telling them to sign in again would be wrong.
- **Policy lives in the auth module, not in infrastructure.** The verifier returns only facts
  (subject, email, emailVerified, display name). `AuthService.authenticateIdentity` decides:
  - An unverified email gets `403 EMAIL_NOT_VERIFIED`, checked **before** any lookup or insert. This
    stops anyone from claiming an email address they don't control.
  - A known `(provider, subject)` returns its principal.
  - On first sign-in, `principals` and `principal_identities` rows are created in **one
    transaction**. The mapping insert is `ON CONFLICT (provider, subject) DO NOTHING`. A request
    that loses the race throws, which rolls back its own principal, and then reads the winner's.
    No orphan principal survives.
  - A disabled principal gets the same generic `401` as a bad API key. Disabling a principal shuts
    off every way in.
- **The mapping is identity, so it is immutable.** Migration `012` makes `(provider, subject)` the
  primary key and `principal_id` unique, and a trigger rejects `UPDATE` and `DELETE`. The key is the
  provider's stable user ID (`sub`), **never the email**, because email addresses change and can be
  reassigned. The email is stored for operators only.
- **Provider text is sanitized.** Display names are user-controlled. Control characters (a NUL makes
  PostgreSQL reject the `text` value, which would fail every sign-in for that user) and lone
  surrogates are dropped, and names are truncated by code point so an emoji is never cut in half.

## Consequences

- One principal model serves both programs (API keys) and people (Firebase). Authorization code did
  not change at all.
- The backend stores no new secret. Its trust in Firebase is limited to Google's public signing
  keys and the configured project ID.
- Token verification makes a network fetch to Google's JWKS endpoint (cached by `jose`). An outage
  there shows up as `503` for Firebase users only. API keys keep working.
- Firebase users are provisioned on demand. There is no admin step, so anyone with a verified
  account in the configured Firebase project can open accounts. Funding still requires the admin
  key, so this does not create money.
- Identity mappings can't be re-pointed. Merging two people's principals, or moving a user to a new
  provider account, would need a new, deliberate migration path. Nothing in the system offers one
  today.
- Evidence: `tests/unit/firebase-auth.test.ts` and
  `tests/integration/firebase-auth.integration.test.ts`. For example, _turns 20 simultaneous first
  sign-ins into exactly one principal_ and _rejects repointing or deleting an identity mapping at
  the database boundary_.
