# ADR-003: Transactional outbox instead of a dual write

- Status: Accepted
- Date: 2026-08-13

## Context

Every committed transfer must eventually produce a downstream effect (in v1, an audit record; later, a published event). The naive approach writes the transfer to PostgreSQL and then performs the side effect — a message publish or a second-system write — from the request handler. This is a dual write: the two operations are not atomic. A crash, timeout, or rollback between them leaves the system inconsistent in one of two ways:

- The transfer commits but the effect never happens, silently losing intent.
- The effect happens but the transfer rolls back, inventing an event for a transfer that does not exist.

Neither failure is acceptable for a ledger whose entire premise is correctness under concurrency and worker failure.

## Decision

Downstream intent is captured as a row in an `outbox_events` table written **inside the same transaction as the transfer**. Because the event insert and the ledger postings share one `SERIALIZABLE` transaction, they commit or roll back together. A committed transfer always has exactly one committed `transfer.created` event; a rolled-back transfer has none.

Each event carries an envelope: `id`, `aggregate_id`, `aggregate_type`, `event_type`, an `event_version` schema version (currently `1`), a JSON `payload`, and processing bookkeeping (`status`, `attempts`, `last_error`, `next_attempt_at`, `processed_at`, `created_at`).

A separate `OutboxWorker` process drains the table independently of the request path:

1. It claims a bounded batch with `SELECT ... FOR UPDATE SKIP LOCKED`, so multiple worker instances never claim the same row. Claimed rows move to `processing`.
2. It runs the handler for each event, then marks it `processed` with a timestamp, or `failed` with the error and a `next_attempt_at`.
3. Failed events retry with exponential backoff (base 100 ms, capped at 60 s, 50–100% jitter). After `maxAttempts` (default 12) the event is parked as permanently failed (`next_attempt_at = infinity`).
4. Claiming leases each `processing` row for `claimLeaseSeconds` (default 300) by setting `next_attempt_at` into the future. If a worker crashes between claim and completion, the row is left `processing`; once the lease elapses, another worker reclaims and re-runs it. This is why delivery is **at least once**.

Poll interval, batch size, max attempts, and claim lease are configurable via `OUTBOX_*` environment variables. The worker emits structured telemetry (claim errors, per-event processed/failed/permanently-failed, poll summaries, shutdown) and `/health/ready` reports pending/processing/failed counts for visibility. Shutdown is graceful: the worker stops scheduling polls and resolves once the in-flight poll drains.

## Consequences

- The transfer and its event are atomic: no committed transfer without an event, and no event without a committed transfer.
- A committed event is durable and survives worker interruption and restart, because delivery state lives in PostgreSQL, not in process memory.
- Delivery is at-least-once. A crash after the side effect but before `processed` is recorded, or a handler that outruns its lease, can deliver an event twice. The consumer must therefore make effects idempotent — the Week 6 consumer inbox enforces one logical effect per `(consumer, event_id)`.
- Ordering is best-effort by `created_at`; the design does not guarantee strict global ordering across concurrent workers.
- The outbox table grows until a retention/archival policy is added; that is deferred past v1.

## Alternatives considered

- **Publish directly from the request handler (dual write)** was rejected because the write and the publish cannot commit atomically, which is the exact failure this project exists to prevent.
- **Listen/notify or a trigger-driven publish** was rejected because delivery would depend on a live listener; a disconnected or crashed listener drops notifications with no durable backlog to recover from.
- **A dedicated message broker (Kafka/Redpanda) in v1** was rejected by scope: it reintroduces a dual write unless fronted by an outbox anyway, and brokers are explicitly excluded until the correctness core is proven. The worker boundary leaves room to publish to a broker later without changing the transaction contract.
- **Reclaiming stuck `processing` rows via a fixed cleanup job** was rejected in favor of a per-claim lease, which needs no separate scheduler and unifies crash recovery with the normal claim query.
