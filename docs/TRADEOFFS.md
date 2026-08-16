# Trade-offs, limitations, and what comes after v1

An honest account of what `v1.0.0` chose, what it deliberately does not do, and where the seams for
later work are. The decisions with the most consequence have their own ADRs
([001](./adr/001-double-entry-integer-accounting.md), [002](./adr/002-serializable-locking-retries.md),
[003](./adr/003-transactional-outbox.md), [004](./adr/004-modular-monolith-database-worker.md));
this page is the summary and the list of things those ADRs consciously left on the table.

## Deliberate trade-offs

| Decision                                                    | What it buys                                                                         | What it costs                                                                                                  |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `SERIALIZABLE` for every transfer                           | No lost updates, no overdraft, no phantom read — provable rather than argued         | Conflict aborts under contention: 21.5% of requests in the hot-account benchmark ended in a bounded 503        |
| Bounded retry budget (12 attempts, ≤362 ms of sleep)        | Predictable tail latency; a struggling database is not hammered indefinitely         | A caller can get `TRANSFER_RETRY_EXHAUSTED` and must retry; the system prefers a clear failure to a long stall |
| Cached `accounts.balance_minor` alongside the journal       | O(1) balance reads instead of summing entries forever                                | Two representations that can theoretically drift — which is exactly why reconciliation exists                  |
| Integer minor units, exposed as decimal strings             | No float rounding, no `Number.MAX_SAFE_INTEGER` truncation                           | Every boundary needs explicit `bigint` ↔ string conversion; clients must not `JSON.parse` amounts into numbers |
| Append-only ledger; corrections are reversing entries       | A complete audit trail; history cannot be quietly rewritten                          | No `UPDATE` escape hatch — fixing a mistake requires posting a new transaction                                 |
| Transactional outbox instead of publishing from the handler | Transfer and event commit atomically; no dual write                                  | Delivery is at-least-once, so every consumer must be idempotent; the outbox table grows                        |
| Idempotency claim is a separate statement from the transfer | A concurrent duplicate is rejected instantly (409) instead of blocking on a lock     | A crashed request leaves an `in_progress` row for up to 30 s before it can be reclaimed                        |
| Worker in the same process as the API                       | One deployable, one dependency, trivially reproducible locally and in CI             | API and worker scale together; a process crash pauses both                                                     |
| Postgres polling instead of a broker                        | No new infrastructure; durability, ordering and safe claiming come from the database | Poll latency (default 1 s) and no fan-out to other systems                                                     |
| Invariants enforced in SQL, not only in TypeScript          | A defect or a raw `psql` session still cannot commit invalid financial state         | Some rules are asserted twice, and constraint errors are less expressive than domain errors                    |
| Static admin API key for `/v1/admin/*`                      | Demo-grade protection with a constant-time comparison and no new dependency          | Not a real authn/authz story: no users, roles, rotation, or per-caller audit                                   |

## Known limitations of v1

These are real gaps, listed so nobody has to discover them by surprise.

**Security and access control**

- Customer-facing routes (`/v1/accounts`, `/v1/transfers`) are **unauthenticated**. The project's
  subject is ledger correctness; anyone deploying this would put real authentication in front.
- One shared static admin key, no rotation and no per-caller identity.
- No rate limiting. The bounded body size, connection, keep-alive, and request timeouts are the only
  request-level protection.

**Operational**

- `/v1/admin/metrics` counters are **in-process**: they reset on restart and describe one instance
  only. There is no Prometheus endpoint, no dashboards, and no distributed tracing.
- No retention or archival for `outbox_events`, `idempotency_records`, `consumer_inbox`, or
  `audit_effects`. All four grow without bound; a production deployment needs a policy.
- Events parked as permanently failed (`attempts >= 12`) need manual SQL to inspect or replay. There
  is no dead-letter UI or CLI.
- Outbox ordering is best-effort by `created_at`. Concurrent workers make no global-order guarantee.
- Reconciliation is read-only by design and scans every account with journal entries — fine at demo
  scale, but it is a full recompute, not an incremental check.

**Domain**

- Two demo currencies (`INR`, `USD`) and no FX: cross-currency transfers are rejected, not converted.
- No transfer reversal, cancellation, or scheduling API. A correction means posting a new transaction
  by hand.
- No account lifecycle API: `frozen` and `closed` are enforced everywhere but nothing sets them.
- The `transfers` projection only ever holds `status: "completed"`. There is no pending/settling
  state machine, because a transfer either commits atomically or does not exist.
- Idempotency records never expire, and the 30-second stale-claim window is a fixed default.

**Evidence**

- Benchmarks were run on a developer machine against a deliberately CPU-capped (2 vCPU) PostgreSQL
  container. They demonstrate behavior under contention and are reproducible; they are **not** a
  capacity ceiling for real hardware. See [benchmarks/k6/RESULTS.md](../benchmarks/k6/RESULTS.md).
- There is no separate `tests/e2e/` directory. End-to-end behavior (lost-response retry, real-socket
  shutdown, HTTP-level reconciliation) is covered inside `tests/integration/` against a real
  PostgreSQL and, where it matters, a real listening socket.

## After v1

Each of these has a seam already in place, which is the point of the boundaries the ADRs defend.

| Extension                               | Where it plugs in                                                                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Publish events to Kafka/Redpanda        | Replace or extend the worker's handler (`AuditConsumerService`). The outbox table stays the source; no transaction change |
| Extract the worker into its own process | It already claims rows with `SKIP LOCKED`; starting a second process is a composition-root change in `server.ts`          |
| Real authentication and authorization   | A Fastify `preHandler` in a child context, exactly as `requireAdminApiKey` is wired today                                 |
| Rate limiting                           | Same hook point; add Redis only if measurements justify it                                                                |
| OpenTelemetry traces and metrics        | Around the existing telemetry callbacks (`transfer completed/retrying`, worker poll events)                               |
| Retention and dead-letter tooling       | New CLI beside `reconcile-cli.ts`, reading the same `status`/`attempts` columns                                           |
| Multi-currency support with FX          | New posting type in the ledger module; the composite currency foreign keys already force explicitness                     |
| Transfer reversal                       | A new ledger transaction type that posts the mirror image — never an `UPDATE` (ADR-001)                                   |

The project plan's own backlog is in [PROJECT_PLAN.md § 12](../PROJECT_PLAN.md#12-post-v1-backlog).
