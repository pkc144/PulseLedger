# Changelog

## v1.2.0 — 2026-08-19

Operational surface: the three things a reviewer asks about after the correctness story — what
happens to an event that fails for good, what stops the tables growing forever, and how you would
see any of it from outside the process. Decision record:
[ADR-006](./docs/adr/006-retention-boundaries-and-operator-replay.md).

### Dead-letter inspection and replay

- `npm run outbox list` / `show <id>` / `replay <id>` / `-- replay --all`. Parked events (attempts
  exhausted) are now a workflow instead of a `psql` session.
- Replay resets the attempt budget and makes the row claimable again, but keeps `last_error` — the
  record of why a human intervened.
- Only parked events can be replayed; a pending or processing row belongs to the worker, and the CLI
  distinguishes "no such event" from "not parked" because they need different responses.
- `OutboxAdminStore` is a separate port from `OutboxStore`, so nothing on the worker's hot path can
  reach inspection or replay.

### Retention

- `npm run retention` deletes processed outbox events (default >30 d) and completed idempotency
  records (default >7 d), in bounded batches, with `--dry-run` and tunable windows.
- `consumer_inbox` and `audit_effects` are **never** swept: the first is the dedup boundary that
  makes redelivery harmless, the second is the audit trail. Both are append-only in the database, so
  the decision is enforced, not just documented.
- Only terminal rows are eligible — an `in_progress` idempotency record may still be reclaimed by a
  retrying caller, however old it is.
- Migration `010` adds partial indexes so each sweep is an index scan and the indexes stay small.

### Metrics

- `GET /metrics` (admin-guarded) in Prometheus exposition format 0.0.4: transfer counters plus
  `pulseledger_outbox_events{status}` gauges. The JSON `/v1/admin/metrics` is unchanged.
- The renderer is a pure function in shared infrastructure with no feature imports; the composition
  root passes it plain numbers.

### Fixed

- `timestamptz 'infinity'` arrives from `pg` as the JS number `Infinity`, not a `Date`, so mapping a
  parked outbox row threw. Latent until now: the worker's claim query never selects those rows.

## v1.1.0 — 2026-08-16

Customer-facing authentication and account ownership — the one gap that made the ledger's central
claim hollow: money could not move _incorrectly_, but anyone who could reach the process could move
it. Decision record: [ADR-005](./docs/adr/005-api-key-authentication-account-ownership.md);
verification record: [docs/release/v1.1.0.md](./docs/release/v1.1.0.md).

### Authentication

- **API keys** (`pl_live_` + 32 random bytes) issued per principal. Only a SHA-256 hash and a
  12-character lookup prefix are stored; the secret is returned exactly once, by the call that
  created it.
- Verification is one indexed read plus a constant-time digest comparison. Unknown, mistyped,
  revoked, and disabled-principal keys all return the same `401 UNAUTHORIZED`.
- Revocation is immediate — there is no token lifetime to wait out.
- Both guards moved to Fastify's `onRequest` hook, which runs **before** body validation. On
  `preHandler` an anonymous caller received schema feedback (`400`) instead of `401`.
- Admin-only credential management: `POST /v1/admin/principals`,
  `POST /v1/admin/principals/:id/api-keys`, `POST /v1/admin/api-keys/:id/revoke`. A customer key
  can never mint or revoke a key.

### Authorization

- `accounts.owner_principal_id` — `NOT NULL` for every customer account, immutable (the trigger that
  freezes identity and currency now freezes ownership), and indexed.
- A principal may read only its own accounts and journal entries, and may spend only from accounts
  it owns. Anyone may be paid. A transfer is readable by either participant.
- Ownership is validated **inside the transfer's `SERIALIZABLE` transaction against the locked
  row**, not in the route, so it cannot be raced.
- Unauthorized resources answer `404`, never `403`, so the API cannot enumerate accounts or
  transfers.
- Idempotency keys are now scoped by principal — unique on `(principal_id, key, operation)`. Two
  callers may both choose `order-42`; neither can replay the other's stored response. Found by a
  test, not in review.

### Everything else

- Migration `009_customer_authentication.sql` creates `principals` and `api_keys`, adds and
  backfills ownership (pre-authentication accounts are attributed to one clearly named
  `legacy-pre-authentication` principal), and re-scopes the idempotency index.
- The seed script, `scripts/demo.sh`, and all four k6 scenarios now provision a principal and key
  first, exactly as a real client would. The demo gained an ownership beat.
- 151 tests (was 126): a new `auth.integration.test.ts` plus ownership cases across the unit suite.

## v1.0.1 — 2026-08-16

Continuous integration fix and a correction to the v1.0.0 release record. **No application code
changed**; `src/`, `migrations/`, and the test suite are identical to `v1.0.0`. Verification record:
[docs/release/v1.0.1.md](./docs/release/v1.0.1.md).

- **CI: one database per integration test file.** The workflow exported `TEST_DATABASE_URL`, pointing
  all eight integration files at a single database while vitest ran them in parallel. Each file runs
  the migrations itself and assumes it owns its rows, so CI deadlocked on concurrent DDL (`40P01`)
  and read other files' data. Every CI run since Week 5 failed this way. With the variable unset,
  Testcontainers gives each file an isolated PostgreSQL, exactly as a local `npm test` does.
- **Record corrected.** `docs/release/v1.0.0.md` claimed the CI gate passed; that claim came from the
  workflow definition rather than run history. It now states plainly that CI was red at the `v1.0.0`
  tag, with the reproduction. The `v1.0.0` tag was left in place rather than moved.
- **Documentation.** `docs/TESTING.md` no longer suggests pointing the whole suite at a shared
  database — `TEST_DATABASE_URL` is for running one file at a time.

## v1.0.0 — 2026-08-16

First release. A correctness-first double-entry payment ledger with the four v1 invariants proven by
126 automated tests and four real k6 benchmark scenarios. Verification record:
[docs/release/v1.0.0.md](./docs/release/v1.0.0.md).

### Ledger core

- Double-entry journal: one `ledger_transactions` row plus balanced `journal_entries`, with deferred
  constraint triggers that reject an unbalanced or non-finalized posting at `COMMIT`.
- Money as integer minor units in PostgreSQL `bigint`, `bigint` in the domain, decimal strings over
  HTTP. Floating point never touches an amount.
- Append-only history: `UPDATE`/`DELETE` on ledger, journal, inbox, and audit tables are rejected by
  triggers. Corrections are reversing postings.
- Accounts with immutable identity, currency, and treasury designation; customer balances cannot go
  negative; funding is a journaled treasury posting, never a balance edit.

### Transfers and concurrency

- `SERIALIZABLE` transfers that lock both accounts in ascending UUID order, so opposing transfers
  cannot deadlock.
- Bounded retry policy: only SQLSTATE `40001`/`40P01`, at most 12 attempts, 2 ms base, 50 ms cap,
  50–100% jitter, then `503 TRANSFER_RETRY_EXHAUSTED`.
- In-process counters for completed transfers, retries, and exhausted budgets on
  `GET /v1/admin/metrics`.

### Idempotency

- `Idempotency-Key` on `POST /v1/transfers`, with a canonical SHA-256 request fingerprint.
- Unique `(key, operation)` claim; the stable response commits inside the transfer's own transaction.
- Replay returns the original status and body; a different body under the same key returns
  `409 IDEMPOTENCY_CONFLICT`; an in-flight duplicate returns `409 IDEMPOTENCY_IN_PROGRESS`; a claim
  stuck for 30 s is reclaimed.

### Asynchronous pipeline

- Transactional outbox: the `transfer.created` event is written inside the transfer transaction, so
  there is no dual write.
- In-process worker claiming batches with `FOR UPDATE SKIP LOCKED`, per-claim leases for crash
  recovery, exponential backoff, and a permanent-failure park after 12 attempts.
- Idempotent audit consumer: `(consumer_name, event_id)` claim and the effect commit together, so
  at-least-once delivery yields at-most-once effect.
- Read-only reconciliation that recomputes every balance from the journal, as
  `POST /v1/admin/reconcile` and `npm run reconcile` (non-zero exit on drift).

### API and operations

- Accounts, transfers, keyset-paginated journal entries, admin funding/reconcile/metrics, liveness,
  and readiness (which reports the outbox backlog).
- Stable machine error codes with a request ID on every response; framework-level client errors
  surface their real status as `REQUEST_REJECTED` instead of collapsing into a 500.
- Admin API key with constant-time comparison, log redaction for secrets, explicit body-size and
  timeout limits, and graceful shutdown that drains the worker, the server, then the pool.

### Verification

- 126 tests: 47 unit, 2 property (fast-check), 77 integration against real PostgreSQL via
  Testcontainers, including 50-concurrent-duplicate, worker-restart recovery, and 1,000-duplicate
  consumer cases.
- Architecture boundary checker (`npm run architecture:check`) enforcing the ports-and-adapters
  dependency direction, wired into CI.
- Four k6 scenarios with committed raw output, plus index verification from real `EXPLAIN ANALYZE`.
- Four ADRs, architecture and transaction-flow diagrams, a full API reference with captured
  responses, and a scripted three-minute demonstration.
