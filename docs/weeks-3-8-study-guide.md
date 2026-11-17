# PulseLedger: Weeks 3–8 and later, study guide (backend)

This is the follow-on to [`weeks-1-2-study-guide.md`](./weeks-1-2-study-guide.md). That guide covers
the foundation: money as integers, double-entry bookkeeping, schema, triggers, and migrations. This
one covers everything built on top of it:

| Part | Topic                                        | Plan week / release | Key files                                                                |
| ---- | -------------------------------------------- | ------------------- | ------------------------------------------------------------------------ |
| 1    | Serializable transfers and concurrency       | Week 3              | `src/modules/transfers/*`, `migrations/003`, `004`                       |
| 2    | Request idempotency                          | Week 4 (+ fixes)    | `src/modules/idempotency/*`, `transfer-routes.ts`, `errors.ts`           |
| 3    | Transactional outbox and worker              | Week 5              | `src/modules/outbox/*`, `src/server.ts`, `migrations/006`, `007`         |
| 4    | Idempotent consumer (audit)                  | Week 6              | `src/modules/audit/*`, `migrations/008`                                  |
| 5    | Reconciliation                               | Week 6              | `src/modules/reconciliation/*`                                           |
| 6    | Hardening, errors, shutdown, benchmarks      | Weeks 7–8           | `app.ts`, `errors.ts`, `config.ts`, `logging.ts`, `benchmarks/k6`        |
| 7    | API keys and account ownership               | v1.1.0              | `src/modules/auth/*`, `infrastructure/http/*-auth.ts`, `009`             |
| 8    | Operations: replay, retention, metrics       | v1.2.0              | `outbox-cli.ts`, `retention-cli.ts`, `metrics.ts`, `010`, `011`          |
| 9    | Firebase sign-in, account listing, tx helper | unreleased (`main`) | `firebase-id-token.ts`, `auth-service.ts`, `ports/transaction.ts`, `012` |

> **How to use this guide:** read a part, open the files it names, and explain the "why" out loud
> without looking. The **Say it like this** lines are the sentences to use in an interview. The
> practice questions are in [`weeks-3-8-interview-qa.md`](./weeks-3-8-interview-qa.md).

---

## 0. The whole system in one picture

```text
client ──HTTP──> Fastify (app.ts)
                  ├─ onRequest guard: Bearer API key | Firebase ID token  -> request.principalId
                  ├─ POST /v1/transfers
                  │    ├─ idempotency claim (INSERT ... ON CONFLICT DO NOTHING)
                  │    └─ TransferService: retry loop (max 12)
                  │         └─ ONE SERIALIZABLE transaction:
                  │              lock both accounts (ORDER BY id FOR UPDATE)
                  │              check owner / status / currency / balance
                  │              post_ledger_transaction(...)  -> journal + cached balances
                  │              INSERT transfers                -> projection
                  │              INSERT outbox_events            -> "transfer.created"
                  │              UPDATE idempotency_records      -> completed + stored response (must hit 1 row)
                  │            COMMIT
                  └─ admin guard (x-admin-api-key): fund, principals/keys, reconcile, metrics

OutboxWorker (same process, setTimeout poll loop)
   claim batch: UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)  (lease 300s)
   handler = AuditConsumerService
       ONE transaction: INSERT consumer_inbox ON CONFLICT DO NOTHING -> INSERT audit_effects
   markProcessed | markFailed(backoff) | park after 12 attempts (next_attempt_at = 'infinity')

Reconciliation (HTTP or CLI): sum(journal) per account  vs  accounts.balance_minor  -> report only
```

**Say it like this:** "Every money movement is one serializable transaction. It writes the journal,
the cached balance, the transfer projection, the outbox event, and the idempotency result together.
Everything after the commit, like the audit consumer, is driven from rows that were committed
atomically with the money. Nothing is a dual write."

---

## Part 1: Serializable transfers (Week 3)

### What happens on `POST /v1/transfers`

Read `transfer-service.ts` → `create()`:

1. `Money.fromMinor(amountMinor)` validates the amount. The amount arrives as a decimal **string**
   (`^[1-9][0-9]*$`) and becomes a `BigInt`. JavaScript `number` is never used for money.
2. A self-transfer is rejected **before** any database work (`SELF_TRANSFER` → 400).
3. `transferId = randomUUID()` and `reference = transfer:<id>` are created **once, outside the retry
   loop**. Every retry attempts the same logical transfer, and `ledger_transactions.reference` is
   `UNIQUE`.
4. Loop `attempt = 1..12`:
   - `store.runSerializable(...)` → `withTransaction(..., { begin: 'BEGIN TRANSACTION ISOLATION
LEVEL SERIALIZABLE' })`.
   - `lockAccounts(deterministicAccountOrder(src, dst))` runs
     `SELECT ... WHERE id = ANY($1) ORDER BY id FOR UPDATE`.
   - **Inside the transaction, against the locked rows**, it checks: both accounts exist and are not
     treasuries → the caller owns the source → both are active → same currency → `balance >=
amount`.
   - `postTransfer` calls `post_ledger_transaction(...)` with the **source credited and the
     destination debited**. In this ledger a debit increases an asset balance. Then it inserts the
     `transfers` row, then the outbox event, then completes the idempotency record.
   - On SQLSTATE `40001` (serialization failure) or `40P01` (deadlock), it **retries** after
     `min(2ms × 2^(n-1), 50ms) × (0.5..1.0 jitter)`. Any other error, including business errors
     like `INSUFFICIENT_FUNDS`, is thrown immediately.
   - After 12 attempts it throws `TRANSFER_RETRY_EXHAUSTED` → **503** and increments the
     `exhausted` metric.

### Why each piece exists

| Piece                             | Problem it prevents                                                                                                                                                                                    |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `FOR UPDATE` on both accounts     | Lost updates and double-spend: two transfers both read balance 100, both spend 80.                                                                                                                     |
| `ORDER BY id` when locking        | Deadlock: A→B locks A then B while B→A locks B then A. A global lock order makes a deadlock cycle impossible.                                                                                          |
| `SERIALIZABLE` on top of locks    | Anomalies that row locks alone miss, such as decisions based on rows you read but didn't lock. Belt and braces. PostgreSQL's SSI aborts with `40001` instead of committing a non-serializable history. |
| Bounded retries with jitter       | `SERIALIZABLE` _will_ abort some transactions under contention. That's expected. Retries make it invisible to clients, the cap prevents retry storms, and jitter de-synchronizes retrying clients.     |
| Same transfer ID on every attempt | A retry is the same logical transfer, not a new one. If a "failed" attempt somehow committed, the unique reference blocks a second posting.                                                            |
| Business checks on locked rows    | TOCTOU: checking the balance or owner _before_ locking would let another transaction change it between the check and the write.                                                                        |
| Never retry business errors       | Insufficient funds is a correct answer. Retrying it wastes resources and could succeed later for the wrong reason.                                                                                     |

### The `transfers` table is a projection, not a second source of truth

`migrations/004` makes `transfers.(id, currency, ledger_type)` a composite FK to
`ledger_transactions.(id, currency, type)` with `ledger_type` fixed to `'transfer'`. A transfer row
**cannot exist** without its matching ledger transaction of the same currency and type. The
`created_at` column was **removed** from `transfers` and is read from the ledger row instead, so the
two can never disagree. `transfers` is also append-only (trigger).

### Who can read a transfer

`findVisibleById` returns the transfer only if the caller owns **either** side (`EXISTS ... owner =
$2`). A payee can confirm the money arrived, a stranger gets 404.

**Say it like this:** "I lock both rows in a fixed order to rule out deadlocks, run at SERIALIZABLE
to rule out the anomalies locks don't cover, and retry only the two SQLSTATEs that mean 'try
again', with capped, jittered exponential backoff. Under extreme contention the system returns a
503 instead of giving up correctness. The benchmarks report that 503 rate honestly."

---

## Part 2: Request idempotency (Week 4, plus later fixes)

### The problem

A client sends a payment, the network times out, and the client retries. Without idempotency the
customer pays twice. The client sends an `Idempotency-Key` header, and the server guarantees:
**one (principal, key, operation) → one execution → one stable response, replayed forever after.**

### The state machine (`idempotency_records`)

```text
             INSERT ... ON CONFLICT DO NOTHING
  (none) ───────────────────────────────────────> in_progress
                                                      │
          transfer commits (same tx) / 4xx stored     │  5xx or retry exhausted
                     ┌────────────────────────────────┤──────────────> (row deleted: "released")
                     v                                │
                 completed  <── replayed to every     │ older than 30s (crashed request)
            (status + body stored)  later retry       └──> reclaimed by exactly ONE caller
```

### Walk the code (`transfer-routes.ts` → `idempotency-service.ts` → `idempotency-repository.ts`)

1. **Header parsing** (`idempotencyKeyFrom`): if the header is absent, the request isn't
   idempotent. If it's longer than 256 characters, the server returns 400 instead of letting the DB
   CHECK fail with a 500.
2. **Fingerprint:** SHA-256 of the **canonical JSON** of the body (keys sorted recursively). This
   makes `{a,b}` and `{b,a}` the same request.
3. **Claim** (`tryClaim`):
   - `INSERT ... VALUES (principal, key, op, fingerprint, 'in_progress') ON CONFLICT (principal_id,
key, operation) DO NOTHING RETURNING ...`. If a row comes back, **you own it**, so proceed.
   - Otherwise read the existing row:
     - Different fingerprint → `409 IDEMPOTENCY_CONFLICT` (same key, different payment).
     - `completed` → **replay** the stored status and body.
     - `in_progress` and younger than 30 seconds → `409 IDEMPOTENCY_IN_PROGRESS`.
     - `in_progress` and **stale** → conditional `UPDATE ... WHERE status='in_progress' AND
created_at < threshold RETURNING`. **Only the caller whose UPDATE returned a row proceeds.**
   - If the row vanished between the INSERT and the SELECT (released or swept), try again, up to 3
     times.
4. **Completion inside the money transaction:** `postTransfer` runs `UPDATE idempotency_records SET
status='completed', response_status_code=201, response_body=<transfer> WHERE ... AND
status='in_progress'` and **requires `rowCount === 1`**, otherwise it throws and **the whole
   transfer rolls back**.
5. **Settling failures** (`settleFailure` in the route's `catch`):
   - Deterministic 4xx (`replayableFailure` in `errors.ts`): the error response is **stored as the
     key's result** and replayed.
   - 5xx or retry exhaustion: the claim is **released** (deleted) so the client can retry right
     away.
   - If settling itself fails, the error is logged and never replaces the error owed to the client.

### The two bugs that were fixed (good interview stories)

The `CHANGELOG.md` "Unreleased → Fixes" section records both:

- **"One idempotency key could post two transfers."** Stale-claim reclaim used to `UPDATE` without
  checking which row it moved, then re-read and proceed. Every concurrent reclaimer proceeded, so
  each posted a transfer. Fix: `UPDATE ... RETURNING` decides ownership, **plus** a backstop: the
  money transaction requires its idempotency completion to hit exactly one row. Now the guarantee no
  longer depends on the claim step being right.
- **"Failed requests wedged their key."** `INSUFFICIENT_FUNDS` left the claim `in_progress`, so
  retries got 409 for 30 seconds and were then silently re-executed. Fix: settle every failure
  (store 4xx, release 5xx).

### Keys are scoped per principal

Migration `009` replaced the global `(key, operation)` primary key with a unique index on
`(principal_id, key, operation) NULLS NOT DISTINCT`. Two customers can both send `order-42`, and
neither can replay the other's response. Admin funding uses the fixed, **disabled**
`system-administrator` principal (migration `011`) as its owner, because the admin key isn't a
principal.

**Say it like this:** "The claim is an atomic INSERT. The result is committed in the same
transaction as the money, and that completion must affect exactly one row, so even a bug in the
claim logic can't produce two transfers. Business rejections are stored and replayed like
successes, and infrastructure failures release the key."

---

## Part 3: Transactional outbox (Week 5)

### The problem: dual writes

Suppose you commit a transfer and then publish "transfer.created" to a queue. If the process dies
between the two steps, the money moved but nobody downstream ever hears about it. If you publish
first and the commit fails, downstream hears about a payment that never happened.

### The solution

Write the event **as a row in the same transaction** (`outbox_events`, inserted inside
`postTransfer` and inside funding). It commits with the money or not at all. A separate worker then
delivers committed rows.

### The worker (`outbox-worker.ts`)

- A `setTimeout`-chained poll loop runs every `OUTBOX_POLL_INTERVAL_MS` (default 1s). There is
  **at most one poll chain**, and `stop()` waits for the in-flight batch.
- **Claim** (`claimBatch`, one transaction):
  ```sql
  WITH claimed AS (
    SELECT id FROM outbox_events
    WHERE status IN ('pending','failed','processing')
      AND (next_attempt_at IS NULL OR next_attempt_at <= now())
    ORDER BY created_at LIMIT $1
    FOR UPDATE SKIP LOCKED)
  UPDATE outbox_events SET status='processing', attempts=attempts+1,
         next_attempt_at = now() + lease          -- the lease
  WHERE id IN (SELECT id FROM claimed) RETURNING ...
  ```
  - `SKIP LOCKED`: two workers never claim the same row and never block each other.
  - **Lease:** a claimed row's `next_attempt_at` is pushed 300 seconds ahead. If the worker crashes,
    the row stays `processing`, and once the lease expires the same query picks it up again. This
    is why `'processing'` is in the `WHERE` clause and why migration `007` widened the partial
    index.
- **Per event:** run the handler, then `markProcessed`, or on error `markFailed` with exponential
  backoff (`100ms × 2^(n-1)`, cap 60s, jitter). After `maxAttempts` (12) the event is **parked**:
  `status='failed', next_attempt_at='infinity'`. It is never claimed again until a human replays it.
- `markProcessed` and `markFailed` both include `WHERE status='processing'`, so they never overwrite
  a row someone else has moved on.
- `event_version` (migration `007`) is stamped on every envelope so consumers can evolve the payload
  shape.

### Delivery guarantee

The outbox gives **at-least-once** delivery: a crash after the handler succeeds but before
`markProcessed` causes redelivery. Exactly-once is not a transport property. You get it by making
the **consumer** idempotent (Part 4).

**Say it like this:** "The outbox turns a dual write into a single atomic write. The worker uses
SKIP LOCKED for safe parallel claiming and a lease for crash recovery, so delivery is at-least-once.
The consumer's inbox makes the _effect_ happen once."

---

## Part 4: Idempotent consumer (Week 6)

`AuditConsumerService.handle` is the worker's handler. `PostgresAuditConsumerStore.consume` runs
**one transaction**:

1. `INSERT INTO consumer_inbox (consumer_name, event_id) ON CONFLICT DO NOTHING RETURNING`
2. No row returned → **duplicate**, return success (no error, no retry).
3. Row returned → `INSERT INTO audit_effects (...)` in the same transaction.

The `(consumer_name, event_id)` primary key is the dedup boundary. Because the claim and the effect
commit together, you can never have a claim without an effect, or an effect without a claim. Both
tables are **append-only** (they reuse `reject_ledger_mutation()` from migration `002`), and
`audit_effects.event_id` is also `UNIQUE` as a second guard.

`consumer_name` is in the key so a _second_ consumer (email, analytics) could process the same
event independently.

Proof: _processes 1,000 duplicate deliveries of the same event into exactly one audit effect_.

**Say it like this:** "Transport is at-least-once. The effect is at-most-once because the inbox claim
is a unique insert in the same transaction as the effect. Together that gives effectively-once."

---

## Part 5: Reconciliation (Week 6)

`accounts.balance_minor` is a **cache** that is updated in the same transaction as the journal.
Reconciliation checks it independently (`reconciliation-repository.ts`):

```sql
WITH computed AS (SELECT account_id, currency,
                    sum(CASE WHEN direction='debit' THEN amount_minor ELSE -amount_minor END)
                  FROM journal_entries GROUP BY account_id, currency)
SELECT ... FROM accounts a FULL OUTER JOIN computed c ON c.account_id = a.id
```

It can report three kinds of issue:

- `mismatched`: the cached and computed balances disagree.
- `missing`: a non-zero cached balance with **no** journal entries behind it.
- `unexpected`: journal entries for an account ID that has no `accounts` row. The FKs make this
  impossible today, but it's still checked rather than trusted.

It is **read-only**: it reports drift and never repairs it. A human decides on a correcting entry.
The same logic is available through `POST /v1/admin/reconcile` and `npm run reconcile`, which exits
with code 1 if any issue is found, so it can gate CI or cron.

**Why FULL OUTER JOIN?** A LEFT JOIN from `accounts` would miss journal rows without an account, and
an INNER JOIN would miss accounts without journal rows. Only a FULL OUTER JOIN sees both kinds of
problem.

---

## Part 6: Hardening, errors, shutdown, benchmarks (Weeks 7–8)

### Error contract (`src/errors.ts`)

- Domain errors carry only a **code**. `domainErrorStatus` is the **single** code→HTTP map, so domain
  code never knows about HTTP.
- Every error body is `{ error: { code, message, requestId } }`.
- Schema failure → `400 VALIDATION_ERROR`. Fastify's own 4xx (oversized body, bad content type) →
  its real status with `REQUEST_REJECTED`. Anything else → logged, then `500 INTERNAL_ERROR` with no
  details leaked.
- `replayableFailure()` reuses the same mapping to decide what idempotency may store (4xx only).

### Request limits and IDs

`bodyLimit` 16 KiB, `connectionTimeout` 10s, `keepAliveTimeout` 5s, `requestTimeout` 30s, all
configurable and validated in `config.ts`. `x-request-id` is honored if it's 128 characters or
fewer, otherwise a UUID is generated.

### Log redaction (`infrastructure/http/logging.ts`)

Pino `redact` covers `authorization`, `x-admin-api-key`, and `cookie`/`set-cookie`. It is always on
when logging is on, so secrets stay out of logs even if headers get logged later.

### Graceful shutdown (`server.ts`)

On SIGTERM/SIGINT: `worker.stop()` (waits for the in-flight batch) → `app.close()` (drains requests,
503s late arrivals) → `pool.end()`. The order matters: closing the pool first would break a claimed
batch, and it would then only be redelivered after the 5-minute lease.

### Pool resilience (`infrastructure/database/pool.ts`)

The pool has `max 10` connections and a 5s connect timeout, and **always** has a `pool.on('error')`
listener. Without it, an idle connection dropped by PostgreSQL (for example during a failover) would
raise an unhandled `error` event and **crash the process**.

### Health

`/health/live` never touches the database (a liveness probe must not restart the app because the DB
is down). `/health/ready` runs `SELECT 1` and reports outbox `pending`/`processing`/`failed` counts.
They are the only unauthenticated routes.

### Benchmarks (`benchmarks/k6/`, see `RESULTS.md`)

There are four scenarios: **normal-transfer** (baseline), **hot-account-contention** (everyone hits
one account), **broad-concurrency** (many accounts), and **duplicate-storm** (the same idempotency
key, concurrently). The headline v1.1.0 numbers are 7,369 attempts, zero overdrafts or drift, a
baseline of 79.4 req/s with p95 560 ms, and a **17.1% bounded 503 rate at 75 VUs**. The observed
bottleneck is `SERIALIZABLE` conflict retries competing for capped DB CPU, and it is **reported, not
tuned away**. In every contention scenario, the non-2xx count equals the retry-exhausted count
exactly, so no request fails silently.

---

## Part 7: API keys and account ownership (v1.1.0, ADR-005)

### Data model (migration `009`)

- `principals`: who someone is (`active` or `disabled`).
- `api_keys`: how they prove it. Stores `key_prefix` (12 chars, `UNIQUE`) and `key_hash`
  (SHA-256 hex). **The secret itself is never stored.**
- `accounts.owner_principal_id`: what they may touch. A CHECK makes it `NOT NULL` for customer
  accounts, and a trigger makes it **immutable**. Legacy accounts were back-filled to a clearly
  named `legacy-pre-authentication` principal.

### Key format and verification (`auth-service.ts`)

- Secret = `pl_live_` + 43 base64url chars (32 random bytes). It is returned **once**, at issue
  time.
- Verify: take the prefix → one indexed lookup (revoked keys excluded in SQL) → SHA-256 the
  presented secret → `timingSafeEqual` against the stored hash → reject disabled principals.
- **Why SHA-256 and not bcrypt?** The secret is 256 bits of randomness, not a human password, so
  there's no dictionary to defend against and a slow hash would only add latency to every request.
- **Every failure gives the same `401 "Invalid API key"`.** Callers can't tell an unknown key from a
  revoked one or a disabled principal.

### Guards (`infrastructure/http/api-key-auth.ts`, `admin-auth.ts`)

- Registered only in `app.ts`, each inside its **own encapsulated Fastify child context**. Route
  files never import auth. They just read `request.principalId`.
- Both run on **`onRequest`**, before body parsing and validation. On `preHandler`, an anonymous
  caller would get 400 schema errors and could map out request shapes without a credential.
- The admin guard does a constant-time compare against `ADMIN_API_KEY` (at least 16 chars, checked
  at boot). Admin and customer credentials **don't substitute** for each other.
- Only admins can create principals and issue or revoke keys. Revoking is idempotent
  (`coalesce(revoked_at, now())`).

### Authorization: ownership, and 404 instead of 403

- Reads put ownership **in the WHERE clause** (`... AND owner_principal_id = $2`), so another
  person's account is indistinguishable from a non-existent one and the response is 404.
- Spending checks `source.ownerPrincipalId === principalId` **inside the transaction on the locked
  row**. If it fails, the error is `ACCOUNT_NOT_FOUND`, not 403, so callers can't enumerate account
  IDs.
- Anyone can **pay** any active customer account. Only the owner can **spend** from it.

---

## Part 8: Operations (v1.2.0, ADR-006)

| Capability      | How                                                                                                                                                           | Key rule                                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Dead-letter     | `npm run outbox list / show <id> / replay <id> / replay --all`                                                                                                | Only **parked** rows can be replayed. Replay resets `attempts` to 0 and **keeps `last_error`** as the record of why someone stepped in.   |
| Retention       | `npm run retention -- [--outbox-days 30] [--idempotency-days 7] [--batch-size 1000] [--dry-run]`                                                              | Deletes only `processed` outbox rows and `completed` idempotency rows, in **bounded batches**. Never `in_progress`, never inbox or audit. |
| Metrics         | `GET /metrics` (Prometheus text, admin-guarded) and `GET /v1/admin/metrics` (JSON)                                                                            | Transfer counters (completed, retries, exhausted) plus outbox depth by status. Counters reset on restart, which is what `rate()` expects. |
| Partial indexes | Migration `010`: `outbox_events(processed_at) WHERE processed`, `outbox_events(created_at) WHERE parked`, `idempotency_records(completed_at) WHERE completed` | Indexes stay small because they only cover rows a sweep or inspection can touch.                                                          |

**Why can't `consumer_inbox` ever be deleted?** It's the dedup memory. Delete a claim and a
redelivered event produces a second effect, which is exactly the invariant the system exists to
hold. The append-only trigger would reject the DELETE anyway.

**Why is `OutboxAdminStore` a separate port from `OutboxStore`?** So the worker's hot path
**cannot** call replay or purge by accident. Least privilege, applied at the interface level.

---

## Part 9: Unreleased work on `main`

### Firebase sign-in (ADR-007, migration `012`)

- **One bearer slot, two credential kinds.** `pl_live_…` → API key path. Anything else → Firebase
  token, but only if `FIREBASE_PROJECT_ID` is set.
- **Verification without a service account** (`firebase-id-token.ts`, `jose`): an RS256 signature
  against Google's JWKS, issuer and audience bound to the project, `exp` in the future, `iat` and
  `auth_time` in the past, and a `sub` of 1–128 characters.
- **Token problem → 401. Can't fetch Google's keys → 503.** The user's token may be fine, so
  telling them to sign in again would be wrong.
- **Policy lives in `AuthService.authenticateIdentity`:**
  - An unverified email gets 403 **before** anything is created.
  - The user is looked up by `(provider, subject)`.
  - On first sign-in, a principal and the mapping are created in one transaction. If a concurrent
    first sign-in wins the PK race, this request rolls back and returns the winner's principal.
  - A disabled principal gets the generic 401.
- `principal_identities` is keyed by the provider's **subject (UID), never the email**, because
  emails change hands. The table is immutable (trigger).
- Display names are sanitized (control characters such as NUL and lone surrogates are dropped) and
  truncated by code point.
- Past the guard, a Firebase user **is just a principal**. Nothing else changed.

### `GET /v1/accounts`

This lists the caller's own accounts, oldest first, keyset-paginated on `(created_at, id)`, with
`limit` ≤ 100 and an opaque `nextCursor`. It fetches `limit + 1` rows to know whether another page
exists. Cursor timestamps use PostgreSQL's microsecond text (`to_char(... AT TIME ZONE 'UTC')`),
because JavaScript `Date` only has millisecond precision and would re-include boundary rows.

### `withTransaction` (`src/ports/transaction.ts`)

This is the one place that handles BEGIN/COMMIT/ROLLBACK. If `ROLLBACK` itself fails, the
**original error is still thrown**, and the connection is released **with an error** so `pg`
destroys it instead of handing a half-open transaction to the next request.

---

## Cheat sheet: numbers and names to know cold

| Thing                    | Value                                                                                                                            |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Transfer retry budget    | 12 attempts, base 2 ms, cap 50 ms, 50–100% jitter, SQLSTATE `40001`/`40P01` only                                                 |
| Idempotency stale window | 30 s, key ≤ 256 chars, unique on `(principal_id, key, operation)`                                                                |
| Outbox                   | poll 1 s, batch 10, lease 300 s, max 12 attempts, backoff 100 ms→60 s, parked = `next_attempt_at='infinity'`                     |
| Retention defaults       | outbox 30 days, idempotency 7 days, batch 1,000                                                                                  |
| API key                  | `pl_live_` + 43 chars, 12-char prefix, SHA-256, shown once                                                                       |
| Request limits           | body 16 KiB, connect 10 s, keep-alive 5 s, request 30 s                                                                          |
| Pool                     | max 10, connect timeout 5 s, idle 30 s                                                                                           |
| Migrations               | 12 (`001` accounts … `012` external identities)                                                                                  |
| Admin principal          | `00000000-0000-4000-8000-0000000000ad`, `disabled`, owns funding idempotency keys                                                |
| Error → status           | `INSUFFICIENT_FUNDS` 409, `ACCOUNT_NOT_FOUND` 404, `IDEMPOTENCY_*` 409, `TRANSFER_RETRY_EXHAUSTED` 503, `EMAIL_NOT_VERIFIED` 403 |
