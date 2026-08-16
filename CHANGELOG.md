# Changelog

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
