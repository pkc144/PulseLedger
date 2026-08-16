# PulseLedger — Project Planning and Execution

## 1. Project objective

Build a production-style payment ledger that remains correct when transfers run concurrently, clients retry requests, and background workers fail or restart.

The finished project must demonstrate four core invariants:

1. Every ledger transaction is balanced: total debits equal total credits.
2. Journal entries are immutable after they are committed.
3. One idempotency key represents one request and produces one stable result.
4. Each outbox event creates at most one logical consumer effect.

The immutable journal is the financial source of truth. PostgreSQL transactions and constraints protect correctness; tests and reproducible benchmarks provide evidence.

## 2. Scope

### Included in v1

- TypeScript and Node.js backend using Fastify.
- PostgreSQL database and SQL migrations.
- Account creation and account lookup.
- Explicit treasury funding flow for demo accounts.
- Immutable double-entry journal.
- Atomic transfers using `SERIALIZABLE` transactions.
- Deterministic locking and bounded serialization retries.
- Idempotency key storage, request fingerprinting, and response replay.
- Transactional database outbox.
- Idempotent audit worker using a consumer inbox.
- Balance reconciliation command and administrative endpoint.
- Structured logs, request IDs, and health endpoints.
- Unit, property, integration, concurrency, recovery, and end-to-end tests.
- Docker Compose, continuous integration, documentation, and k6 benchmarks.

### Excluded from v1

- Kafka or Redpanda.
- Redis.
- Microservices.
- Kubernetes or cloud deployment.
- Customer-facing user interface.
- Multi-tenant administration.
- Full observability stack and distributed tracing.
- Complex dead-letter and replay infrastructure.

These features may be considered only after every v1 release gate passes.

## 3. Proposed technology

| Area              | Choice                                           |
| ----------------- | ------------------------------------------------ |
| Runtime           | Node.js 22 LTS                                   |
| Language          | TypeScript with strict mode                      |
| HTTP framework    | Fastify                                          |
| Database          | PostgreSQL 17                                    |
| Database access   | `pg` with explicit SQL for critical transactions |
| Validation        | TypeBox/Fastify JSON schemas                     |
| Logging           | Pino                                             |
| Test runner       | Vitest                                           |
| Property testing  | fast-check                                       |
| Database testing  | Testcontainers                                   |
| Load testing      | k6                                               |
| Local environment | Docker Compose                                   |
| Automation        | GitHub Actions                                   |
| Package manager   | npm                                              |

## 4. Architecture

PulseLedger will be a modular monolith with one PostgreSQL database.

The maintained implementation rules and dependency boundaries are defined in [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md).

```text
API client
   |
   | API key + Idempotency-Key + request ID
   v
Fastify API
   |
   | one SERIALIZABLE database transaction
   v
PostgreSQL
   |- accounts and cached balances
   |- ledger transactions
   |- immutable journal entries
   |- idempotency records and stable responses
   `- transactional outbox records
                  |
                  v
             Outbox worker
                  |
                  v
        Consumer inbox + audit effect

Reconciliation recomputes balances from the immutable journal.
```

### Planned repository structure

```text
pulseledger/
├── src/
│   ├── modules/
│   │   ├── accounts/
│   │   ├── ledger/
│   │   ├── idempotency/
│   │   ├── outbox/
│   │   └── reconciliation/
│   ├── infrastructure/
│   │   ├── database/
│   │   └── logging/
│   ├── app.ts
│   └── server.ts
├── tests/
│   ├── unit/
│   ├── property/
│   ├── integration/
│   └── e2e/
├── benchmarks/k6/
├── migrations/
├── scripts/
├── docs/
│   ├── adr/
│   └── diagrams/
├── docker-compose.yml
└── README.md
```

## 5. Domain and API decisions

### Money and accounts

- Store money as positive integer minor units; never use floating point.
- Store an explicit ISO 4217 currency code on every account.
- An account's currency and identity are immutable.
- Transfers between different currencies are rejected in v1.
- New customer accounts begin at zero.
- Demo funding is posted from a designated treasury account through the ledger; balances are never edited directly.
- A cached account balance may optimize reads, but the journal remains authoritative.

### Minimum API

| Method | Route                      | Purpose                                    |
| ------ | -------------------------- | ------------------------------------------ |
| `POST` | `/v1/accounts`             | Create an account                          |
| `GET`  | `/v1/accounts/:id`         | Read account and current balance           |
| `GET`  | `/v1/accounts/:id/entries` | Read cursor-paginated journal entries      |
| `POST` | `/v1/transfers`            | Transfer funds; requires `Idempotency-Key` |
| `GET`  | `/v1/transfers/:id`        | Read a stable transfer result              |
| `POST` | `/v1/admin/fund`           | Fund a demo account from treasury          |
| `POST` | `/v1/admin/reconcile`      | Compare cached balances with the journal   |
| `GET`  | `/v1/admin/metrics`        | Read in-process transfer counters          |
| `GET`  | `/health/live`             | Process liveness                           |
| `GET`  | `/health/ready`            | Application and database readiness         |

### Idempotency state model

An idempotency record contains the key, route/operation, request fingerprint, state, response status, response body, and timestamps.

- First valid request claims the key.
- The key and request fingerprint are protected by a unique constraint.
- The same key with a different fingerprint returns a stable conflict error.
- A completed request returns its original status and response body.
- Concurrent identical requests must never create more than one transfer.
- The transfer, completed idempotency response, journal entries, cached balance updates, and outbox event commit atomically.
- Failure behavior and stale in-progress recovery must be documented and tested before release.

## 6. Definition of done

A feature is complete only when:

- Its behavior and error cases are implemented.
- Database constraints protect the relevant invariants where possible.
- Automated tests cover success, rejection, and concurrency or failure behavior.
- Logging does not expose secrets or sensitive payloads.
- Documentation and API examples match the implementation.
- Linting, type checking, tests, migrations, and build all pass from a clean checkout.

## 7. Week-by-week execution plan

### Week 1 — Foundation and account API

### Goal

Create a reproducible TypeScript service with PostgreSQL, migrations, health checks, and the first account endpoints.

### Tasks

- [x] Replace the sample Python file with the planned Node.js/TypeScript project structure.
- [x] Initialize npm and pin the Node.js version.
- [x] Configure strict TypeScript, linting, formatting, and build scripts.
- [x] Create the Fastify application and separate application startup from server startup.
- [x] Validate environment variables at boot.
- [x] Configure Pino logging, request IDs, and stable error responses.
- [x] Add PostgreSQL to Docker Compose with a health check and persistent volume.
- [x] Create a migration runner and initial account schema.
- [x] Add account status and immutable currency rules.
- [x] Seed one treasury account per supported demo currency.
- [x] Implement account creation and lookup routes.
- [x] Implement `/health/live` and `/health/ready`.
- [x] Configure Vitest and Testcontainers.
- [x] Add GitHub Actions for install, lint, type check, test, migration, and build.
- [x] Write initial local-development instructions.

### Verification

- [x] A clean clone installs and builds successfully.
- [x] `docker compose up` starts a healthy PostgreSQL instance.
- [x] Migrations apply to an empty database and are safe to rerun.
- [x] An account can be created and retrieved.
- [x] Invalid currency and malformed input return stable machine-readable errors.
- [x] Readiness fails when PostgreSQL is unavailable.

### Week 1 deliverable

A clean, tested service skeleton that starts locally and creates zero-balance accounts.

### Week 2 — Double-entry journal

### Goal

Implement the accounting core and enforce balanced, immutable postings.

### Tasks

- [x] Implement a money value object using integer minor units.
- [x] Add ledger transaction and journal entry migrations.
- [x] Define debit and credit directions clearly.
- [x] Implement the balanced posting service.
- [x] Reject zero, negative, unsafe, and out-of-range amounts.
- [x] Reject mixed-currency postings.
- [x] Enforce append-only journal entries using database permissions or triggers.
- [x] Add database constraints for positive amounts and valid directions.
- [x] Implement treasury-to-account funding as a balanced posting.
- [x] Add domain error codes and transaction references.
- [x] Add unit tests for money and posting validation.
- [x] Add fast-check properties for generated balanced and invalid postings.
- [x] Write ADR-001: double-entry accounting and integer minor units.

### Verification

- [x] Every valid posting has equal debits and credits.
- [x] An unbalanced posting is rejected atomically.
- [x] Journal updates and deletes are rejected.
- [x] No code path stores floating-point money.
- [x] Funding changes both treasury and customer balances through journal entries.
- [x] The sum of balances for a closed test system remains conserved.

### Week 2 deliverable

An immutable journal with property-tested double-entry accounting.

### Week 3 — Serializable transfers and concurrency

### Goal

Transfer value safely without overdrafts or partial postings under concurrent load.

### Tasks

- [x] Implement source, destination, status, amount, and currency validation.
- [x] Reject self-transfers and cross-currency transfers.
- [x] Lock involved accounts in deterministic ID order.
- [x] Run transfer posting inside a `SERIALIZABLE` transaction.
- [x] Update cached balances and journal entries atomically.
- [x] Enforce the insufficient-funds rule.
- [x] Detect serialization failures and retry with bounded exponential backoff and jitter.
- [x] Expose retry attempt counts in structured logs and internal metrics.
- [x] Implement transfer lookup.
- [x] Test opposing transfers, hot accounts, and overspend races using real PostgreSQL.
- [x] Add a reference model comparison test.
- [x] Write ADR-002: serializable isolation, locking, and bounded retries.

### Verification

- [x] Insufficient funds creates no partial transaction or journal entries.
- [x] Concurrent withdrawals cannot make a customer account negative.
- [x] Opposing transfers preserve the total amount.
- [x] Account lock order is deterministic.
- [x] Retry count and elapsed time are bounded.
- [x] Final database state matches the sequential reference model.

### Week 3 deliverable

Atomic transfers that preserve balances during genuine database concurrency.

### Week 4 — Request idempotency

### Goal

Ensure client retries and simultaneous duplicate requests produce exactly one transfer and one stable response.

### Tasks

- [x] Add the idempotency record migration and uniqueness constraints.
- [x] Define canonical request serialization and hashing.
- [x] Bind each key to its route/operation and request fingerprint.
- [x] Implement first-request key claiming.
- [x] Implement completed-response storage and replay.
- [x] Return a conflict for the same key with a different payload.
- [x] Decide and document the failed-request retention policy.
- [x] Implement safe behavior for concurrent in-progress requests.
- [x] Define stale in-progress detection and recovery behavior.
- [x] Ensure the completed idempotency record commits with the transfer.
- [x] Test a lost-response retry.
- [x] Test 50 identical concurrent requests against real PostgreSQL.
- [x] Test key reuse across different operations.

### Verification

- [x] Fifty concurrent identical requests create one ledger transaction.
- [x] All successful duplicate requests return the same transfer ID and response.
- [x] Same key with different content returns `IDEMPOTENCY_CONFLICT`.
- [x] A simulated lost response can be retried safely.
- [x] Failed and stale request policies have named automated tests.
- [x] All Weeks 1–4 invariants pass in CI.

### Week 4 hard gate

Do not begin the worker until ledger, concurrency, and idempotency tests are green.

### Week 4 deliverable

A correctness-complete synchronous transfer API with safe retries.

### Week 5 — Transactional outbox

### Goal

Preserve downstream event intent without a database/message-broker dual-write failure.

### Tasks

- [x] Add the outbox event migration.
- [x] Write a transfer-created event in the same transaction as the transfer.
- [x] Define an event envelope and schema version.
- [x] Implement bounded batch claiming with `FOR UPDATE SKIP LOCKED`.
- [x] Support multiple worker instances without duplicate claiming.
- [x] Mark processing success with timestamps.
- [x] Record attempts, next-attempt time, and last failure.
- [x] Add bounded backoff and a maximum attempt policy.
- [x] Implement graceful worker shutdown.
- [x] Make worker polling and batch size configurable.
- [x] Add failure visibility through structured logs and health status.
- [x] Add stop-before-processing and stop-after-commit recovery tests.
- [x] Write ADR-003: transactional outbox instead of dual writes.

### Verification

- [x] Every committed transfer has a committed outbox event.
- [x] A rolled-back transfer has no outbox event.
- [x] A committed event survives worker interruption and restart.
- [x] Two workers cannot claim the same available row simultaneously.
- [x] Failed attempts are visible and retry according to a bounded policy.

### Week 5 deliverable

A durable database-backed outbox worker with tested crash recovery.

### Week 6 — Idempotent consumer and reconciliation

### Goal

Prevent repeated business effects and independently verify cached balances against the journal.

### Tasks

- [x] Add consumer inbox and audit effect migrations.
- [x] Enforce unique `(consumer_name, event_id)` processing.
- [x] Implement audit-event consumption in one database transaction.
- [x] Make duplicate event delivery a successful no-op.
- [x] Add journal-derived balance queries.
- [x] Implement reconciliation as a CLI command.
- [x] Add the protected reconciliation administrative endpoint.
- [x] Report missing, mismatched, and unexpected balance records.
- [x] Ensure reconciliation does not silently repair data in v1.
- [x] Add seeded-corruption and mismatch tests.
- [x] Test 1,000 duplicate deliveries producing one logical audit effect.
- [x] Document why delivery is at-least-once while effects are logically once.
- [x] Write ADR-004: modular monolith and database worker for v1.

### Verification

- [x] Duplicate delivery creates one logical consumer effect.
- [x] Inbox and effect commit atomically.
- [x] Reconciliation reports a seeded mismatch.
- [x] A healthy database produces a clean reconciliation report.
- [x] The CLI returns a non-zero exit status when mismatches exist.

### Week 6 deliverable

An idempotent audit consumer and a trustworthy reconciliation tool.

### Week 7 — Quality, security, and benchmarks

### Goal

Harden behavior, test realistic workloads, and produce reproducible performance evidence.

### Tasks

- [x] Review all error codes and HTTP status mappings.
- [x] Add cursor pagination for account journal entries.
- [x] Add API-key protection to administrative endpoints.
- [x] Redact credentials and sensitive headers from logs.
- [x] Add request size, timeout, and connection limits.
- [x] Add graceful API shutdown and connection draining.
- [x] Seed realistic account and transfer datasets.
- [x] Add required indexes and verify them using `EXPLAIN ANALYZE`.
- [x] Create k6 normal-transfer scenario.
- [x] Create k6 broad-concurrency scenario.
- [x] Create k6 duplicate-storm scenario.
- [x] Create k6 hot-account contention scenario.
- [x] Record throughput, P50/P95/P99, failures, serialization conflicts, and retry counts.
- [x] Record commit SHA, machine details, container limits, dataset, duration, and warm-up.
- [x] Keep correctness tests running before and after every benchmark.

### Verification

- [x] All required test layers pass from a clean checkout.
- [x] Logs contain request IDs and do not expose secrets.
- [x] Query plans show expected index usage.
- [x] Every benchmark can be rerun from committed scripts.
- [x] Benchmark results include raw output and exact environment details.
- [x] Ledger invariants remain green after load tests.

### Week 7 deliverable

A hardened service with honest, reproducible performance results.

### Week 8 — Documentation, demonstration, and release

### Goal

Freeze features, verify the complete system, and publish evidence that another developer can reproduce.

### Tasks

- [x] Freeze features at the start of the week. No `src/` behavior changed in Week 8.
- [x] Complete the README in the planned evidence-first order.
- [x] Add architecture and transaction-flow diagrams (`docs/diagrams/`).
- [x] Review and finalize all four ADRs (index in `docs/adr/README.md`; ADR-003 wording corrected, ADR-002 updated with measured outcomes).
- [x] Add copy-paste API examples and expected responses (`docs/API.md`, captured from a running server).
- [x] Document trade-offs, limitations, and post-v1 extensions (`docs/TRADEOFFS.md`).
- [x] Document every test and benchmark command (`docs/TESTING.md`).
- [x] Run a clean-clone installation and migration test.
- [x] Run the complete unit, property, integration, concurrency, recovery, and end-to-end suite. 126 passed.
- [x] Run and save the final benchmark evidence (`benchmarks/k6/results/release-v1.0.0/`).
- [x] Verify documentation against the actual implementation.
- [x] Prepare and rehearse the three-minute demonstration (`scripts/demo.sh`, 7.8 s measured; `docs/DEMO.md` narrated at 2:55).
- [x] Complete the résumé bullet using measured results only.
- [x] Create a verified `v1.0.0` release tag.

### Three-minute demonstration

1. State the problem and the four invariants.
2. Create and fund two accounts, then complete a transfer.
3. Send concurrent duplicate requests and show one posting.
4. Stop and restart the worker and show outbox recovery with one audit effect.
5. Run reconciliation and show a balanced result.
6. Show the measured benchmark and explain the observed bottleneck.

### Verification

- [x] A fresh clone starts exactly as documented.
- [x] Each core invariant points to a named automated test.
- [x] Concurrent duplicate and worker recovery tests pass.
- [x] Reconciliation detects a seeded mismatch.
- [x] The benchmark is independently reproducible.
- [x] Architecture diagrams match the implementation.
- [x] The demonstration completes in under three minutes.
- [x] The release tag points to the fully verified commit.

### Week 8 deliverable

A polished, reproducible `v1.0.0` release with implementation, tests, benchmarks, and interview-ready evidence.

## 8. Mandatory test matrix

| Area           | Required scenario                       | Evidence                       |
| -------------- | --------------------------------------- | ------------------------------ |
| Accounting     | Debits equal credits                    | Property and integration tests |
| Accounting     | Zero/negative amounts rejected          | Unit and API tests             |
| Accounting     | Currency mismatch rejected              | Integration test               |
| Accounting     | Insufficient funds posts nothing        | Transaction integration test   |
| Accounting     | Journal mutation rejected               | Database integration test      |
| Idempotency    | Same key/body replays original response | Integration test               |
| Idempotency    | Same key/different body conflicts       | Integration test               |
| Idempotency    | 50 concurrent duplicates post once      | Concurrency test               |
| Idempotency    | Lost-response retry is safe             | End-to-end test                |
| Concurrency    | Opposing transfers preserve totals      | Concurrency test               |
| Concurrency    | Hot account stays non-negative          | Concurrency test               |
| Concurrency    | Retry budget is bounded                 | Integration test               |
| Concurrency    | Final state matches reference model     | Property/integration test      |
| Outbox         | Committed event survives restart        | Recovery test                  |
| Outbox         | Two workers do not double-claim         | Integration test               |
| Consumer       | Duplicate event has one effect          | Integration test               |
| Recovery       | Failed attempt is visible               | Integration test               |
| Reconciliation | Seeded mismatch is detected             | Integration test               |

## 9. Risks and controls

| Risk                                        | Control                                                              |
| ------------------------------------------- | -------------------------------------------------------------------- |
| Over-engineering delays the accounting core | Enforce the v1 exclusions and weekly hard gates                      |
| Cached balance diverges from journal        | Atomic updates, constraints, and reconciliation                      |
| Concurrent transfers overspend              | Serializable isolation, deterministic locks, bounded retries         |
| Duplicate HTTP requests move money twice    | Unique idempotency key, request fingerprint, atomic stable response  |
| Transfer commits but event disappears       | Write outbox row inside the transfer transaction                     |
| Worker retries repeat an effect             | Consumer inbox uniqueness and atomic processing                      |
| Benchmarks produce misleading claims        | Commit scripts, raw output, hardware, configuration, and methodology |
| Tests pass only on one developer machine    | Docker Compose, Testcontainers, CI, and clean-clone verification     |

## 10. Progress tracker

Update this table at the end of every implementation session.

| Week                        | Status   | Completion | Gate result | Notes                                                                                                                                                                                                |
| --------------------------- | -------- | ---------: | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 — Foundation              | Complete |       100% | Passed      | 15 automated tests and local API smoke test passed                                                                                                                                                   |
| 2 — Journal                 | Complete |       100% | Passed      | Immutable balanced journal and funding gate passed                                                                                                                                                   |
| 3 — Transfers               | Complete |       100% | Passed      | Concurrency, reference-model, and architecture gates passed                                                                                                                                          |
| 4 — Idempotency             | Complete |       100% | Passed      | 66 tests, idempotency replay/conflict/concurrency gates passed                                                                                                                                       |
| 5 — Outbox                  | Complete |       100% | Passed      | Transactional outbox + worker; atomic event, SKIP LOCKED claim, crash-lease recovery, health stats; ADR-003                                                                                          |
| 6 — Consumer/reconciliation | Complete |       100% | Passed      | Idempotent audit consumer (1,000-duplicate test), read-only reconciliation (CLI + admin endpoint), ADR-004                                                                                           |
| 7 — Quality/benchmark       | Complete |       100% | Passed      | Admin API-key auth, pagination, log redaction, request limits; real k6 results (4 scenarios, ~14k transfers, 0 reconciliation issues); index verification via real EXPLAIN ANALYZE                   |
| 8 — Release                 | Complete |       100% | Passed      | README/API/TESTING/TRADEOFFS/DEMO docs, mermaid architecture + flow diagrams, ADR index and corrections, clean-clone test, 126 tests green, benchmarks re-run on the release commit, `v1.0.0` tagged |

Allowed status values: `Not started`, `In progress`, `Blocked`, and `Complete`.

## 11. Release gate

PulseLedger v1 is finished only when all of the following are true. Evidence for every row:
[docs/release/v1.0.0.md](./docs/release/v1.0.0.md).

- [x] Fresh clone starts as documented.
- [x] The four invariants have named automated tests.
- [x] Concurrent duplicate requests create one transfer.
- [x] Worker recovery creates one logical audit effect.
- [x] Reconciliation detects intentional corruption.
- [x] All retry policies are bounded and observable.
- [x] CI passes linting, type checks, tests, migrations, and build. Green from `v1.0.1` onward; red at the `v1.0.0` tag, where CI shared one database across parallel integration files. See [docs/release/v1.0.0.md](./docs/release/v1.0.0.md#ci-status).
- [x] Benchmarks are reproducible and contain no invented metrics.
- [x] Architecture documentation matches the code.
- [x] Four ADRs are complete.
- [x] The demo completes in under three minutes.
- [x] `v1.0.0` points to the verified commit.

## 12. Post-v1 backlog

Consider these only after the release gate is fully green:

- Publish outbox events to Redpanda/Kafka behind the existing worker boundary.
- Add Redis-backed rate limiting if measured abuse or load requires it.
- Add OpenTelemetry and dashboards based on concrete operational questions.
- Add multi-tenant policy and administration.
- Add dead-letter inspection and controlled replay tooling.
- Add cloud deployment and infrastructure automation.
- Add a user interface or external integration only when the API is stable.
