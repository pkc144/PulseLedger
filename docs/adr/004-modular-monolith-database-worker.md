# ADR-004: Modular monolith with a database-backed worker for v1

- Status: Accepted
- Date: 2026-08-15

## Context

By Week 6 the system has a full asynchronous pipeline: a transfer commits an outbox event, a worker
drains it, and a consumer must apply exactly one logical business effect. Two architecture questions
recur at every step: should the API and the worker be separate deployable services communicating over
a network, and should the worker be driven by a message broker instead of polling PostgreSQL? Both
questions were implicitly answered as early as Week 1 (one Fastify process, one database) and Week 5
(the outbox worker runs inside that same process); this ADR makes the decision explicit and states why
it still holds now that the pipeline is complete.

## Decision

PulseLedger v1 is a **modular monolith**: one deployable Node.js process, one PostgreSQL database.
`src/modules/<feature>/` slices (accounts, ledger, transfers, idempotency, outbox, audit,
reconciliation) are isolated by the ports-and-adapters boundary enforced in
`scripts/check-architecture.ts`, but they are compiled, deployed, and scaled together.

The background `OutboxWorker` (ADR-003) runs as an in-process loop started by `server.ts` alongside
`app.listen()` — not as a separate service. It polls `outbox_events` directly with `FOR UPDATE SKIP
LOCKED` rather than publishing to or consuming from a message broker. Its handler is the audit
consumer (`AuditConsumerService`), which claims `(consumer_name, event_id)` in `consumer_inbox` and
records the effect in `audit_effects` inside one transaction. No new infrastructure — no Kafka,
Redpanda, or Redis — is introduced to move an event from "committed" to "consumed".

**Why this still holds with the full pipeline in place:**

- A distributed transaction across an API service, a broker, and a worker service reintroduces the
  dual-write problem this project exists to eliminate (see ADR-003) unless an outbox is added in front
  of it anyway — at which point the broker has bought failure modes (broker availability, consumer
  group rebalancing, offset management) without buying correctness.
- PostgreSQL already gives the worker exactly what a broker would need to provide — durability,
  ordering by `created_at`, and safe concurrent claiming (`SKIP LOCKED`) — as a side effect of being
  the same database the ledger already trusts.
- One process and one database is trivially reproducible (`docker compose up`, one migration runner,
  one CI job) and keeps the whole system testable with Testcontainers instead of a multi-service test
  harness.

## At-least-once delivery, at-most-once effect

These are two different guarantees, made by two different mechanisms, and neither is a "nice to have":

- **Delivery is at least once.** The outbox worker can redeliver an event: a claim's lease can expire
  before the handler finishes (Week 5), a handler can throw and retry with backoff, or an operator can
  manually replay a `failed` row. The worker makes no attempt to prevent redelivery — that would
  require distributed consensus for no benefit.
- **The effect is logically at most once.** The consumer inbox (`consumer_inbox`, keyed by
  `(consumer_name, event_id)`) is what converts "delivered possibly more than once" into "applied
  exactly once from the business's point of view." A duplicate delivery's claim conflicts on that key,
  inserts nothing, and the audit effect is skipped — a **successful no-op**, not an error.

Pushing the exactly-once guarantee to the _consumer_ rather than the _transport_ is the standard
resolution: it is far cheaper to make an idempotent insert than to make delivery itself exactly once,
and it is the same trade-off already made for HTTP retries in Week 4's idempotency key design — one
key per unit of work, claimed once, replayed safely.

## Consequences

- Deploying, restarting, or scaling the process scales the API and the worker together; there is no
  independent worker fleet. A `server.ts` crash pauses both request handling and event draining at
  once — mitigated by the outbox's crash-lease reclaim (ADR-003), so a restart resumes exactly where
  the durable state left off, and by graceful shutdown draining both before exit.
- Local development and CI need only PostgreSQL, not a broker; `docker compose up` remains the entire
  dependency footprint through v1.
- The worker boundary is already a real module (`OutboxWorker` + `AuditConsumerService`, wired only at
  `server.ts`); extracting it into its own process later — or replacing DB polling with a broker
  subscription — is a composition-root change, not a rewrite of the transaction or dedup logic.
- Reconciliation (`ReconciliationService`) deliberately stays **read-only**: it reports drift between
  cached balances and the journal and never repairs it, so an operator always makes the repair decision
  and the audit trail of _why_ a balance was corrected (a reversing entry, per ADR-001) is preserved.

## Alternatives considered

- **Separate API and worker services** was rejected for v1 because it buys independent scaling at the
  cost of a second deployable, a second health/readiness surface, and no correctness benefit — the
  transaction boundary that matters (transfer + outbox row) is already inside one database transaction
  regardless of which process later reads the outbox table.
- **A message broker (Kafka/Redpanda/SQS) driving the worker** was rejected for v1 for the reasons in
  ADR-003: it does not remove the need for an outbox, and it adds operational surface before the
  correctness core has been proven under load (Week 7). The worker boundary is designed so a broker can
  be introduced later as a downstream fan-out from the same outbox table.
- **Exactly-once delivery instead of an idempotent consumer** was rejected because no transport gives
  that guarantee for free across a crash; an idempotent consumer gives the same observable outcome
  (one effect) using a mechanism already proven in this codebase (unique-constraint claiming, per
  Week 4's idempotency store).
- **Microservices per bounded context** (accounts, ledger, outbox, audit) was rejected for v1 per the
  project's stated exclusions — it would force sagas or distributed transactions to replace the ACID
  guarantees the ledger depends on, before the single-database core has even been benchmarked.
