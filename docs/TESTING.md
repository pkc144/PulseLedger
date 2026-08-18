# Testing and benchmarking

Every command needed to reproduce the project's evidence, and the map from each invariant to the
named test that proves it.

## Commands

### Verification

| Command                      | What it does                                                             |
| ---------------------------- | ------------------------------------------------------------------------ |
| `npm run check`              | The full local gate: architecture → lint → typecheck → all tests → build |
| `npm run architecture:check` | Fails on any dependency that crosses a module boundary the wrong way     |
| `npm run lint`               | ESLint (typescript-eslint, type-aware)                                   |
| `npm run typecheck`          | `tsc --noEmit` in strict mode                                            |
| `npm run format:check`       | Prettier, check only (`npm run format` writes)                           |
| `npm run build`              | Compiles `dist/` with `tsconfig.build.json`                              |

### Tests

| Command                                                       | Scope                               | Needs PostgreSQL |
| ------------------------------------------------------------- | ----------------------------------- | ---------------- |
| `npm test`                                                    | Everything — 171 tests in 19 files  | yes              |
| `npm run test:unit`                                           | 60 unit tests, in-memory ports only | no               |
| `npm run test:integration`                                    | 109 tests against real PostgreSQL   | yes              |
| `npx vitest run tests/property`                               | 2 property tests (fast-check)       | no               |
| `npx vitest run tests/integration/outbox.integration.test.ts` | One file                            | yes              |
| `npx vitest run -t 'never lets two workers double-claim'`     | One test by name                    | yes              |

Integration tests use `TEST_DATABASE_URL` when it is set; otherwise
[Testcontainers](https://testcontainers.com/) starts an isolated `postgres:17-alpine` container **per
test file**, so `docker compose up -d postgres` is optional for tests but required for the app.

> **`TEST_DATABASE_URL` is for one file at a time, not the whole suite.** Each integration file
> assumes it owns its database — it runs the migrations itself and reads back rows it created. Point
> the whole suite at one shared database and the files run in parallel against it, producing DDL
> deadlocks and cross-file interference that look like product failures but are not. That is why CI
> deliberately leaves the variable unset.

```bash
# One file against the compose database (skips container startup for a quick edit-run loop):
TEST_DATABASE_URL=postgresql://pulseledger:pulseledger@localhost:5432/pulseledger \
  npx vitest run tests/integration/outbox.integration.test.ts
```

Node 22 or newer is required (`.nvmrc` pins it). On Node 20 the Testcontainers setup fails before the
first test runs.

### Operational commands

| Command                                              | What it does                                                                     |
| ---------------------------------------------------- | -------------------------------------------------------------------------------- |
| `npm run db:migrate`                                 | Applies pending SQL migrations in order, transactionally                         |
| `npm run reconcile`                                  | Recomputes balances from the journal; exits non-zero on any issue                |
| `SEED_ACCOUNTS=300 SEED_TRANSFERS=3000 npm run seed` | Builds a realistic dataset through the real services (never raw SQL)             |
| `./scripts/demo.sh`                                  | Runs the full four-invariant demonstration (~8 s)                                |
| `npm run outbox list`                                | Lists parked events — those that exhausted their attempt budget                  |
| `npm run outbox show <id>`                           | Prints one event in full, including payload and last error                       |
| `npm run outbox replay <id>`                         | Returns a parked event to the queue with a fresh budget                          |
| `npm run outbox -- replay --all`                     | Returns every parked event (note the `--`, so npm passes the flag)               |
| `npm run retention -- --dry-run`                     | Counts what a sweep would delete, using the sweep's own predicates               |
| `npm run retention`                                  | Deletes processed outbox events (>30 d) and completed idempotency records (>7 d) |

Flags need `npm run <script> -- --flag`; bare subcommands (`npm run outbox list`) pass through as-is.
Retention windows are tunable: `npm run retention -- --outbox-days 14 --idempotency-days 3`.
`consumer_inbox` and `audit_effects` are never swept — see
[ADR-006](./adr/006-retention-boundaries-and-operator-replay.md).

### Benchmarks

Requires [k6](https://k6.io/) and a built server. Full methodology and results:
[benchmarks/k6/RESULTS.md](../benchmarks/k6/RESULTS.md).

```bash
docker compose up -d postgres            # 2 CPU / 2 GiB, per compose.yaml
npm run db:migrate && npm run build
SEED_ACCOUNTS=300 SEED_TRANSFERS=3000 npm run seed

ADMIN_API_KEY=$KEY DATABASE_URL=postgresql://pulseledger:pulseledger@localhost:5432/pulseledger \
  PORT=3900 NODE_ENV=production node dist/server.js &

npm test                                 # correctness gate, before

BASE_URL=http://localhost:3900 ADMIN_API_KEY=$KEY k6 run benchmarks/k6/normal-transfer.js
BASE_URL=http://localhost:3900 ADMIN_API_KEY=$KEY k6 run benchmarks/k6/duplicate-storm.js
BASE_URL=http://localhost:3900 ADMIN_API_KEY=$KEY k6 run benchmarks/k6/hot-account-contention.js
BASE_URL=http://localhost:3900 ADMIN_API_KEY=$KEY k6 run benchmarks/k6/broad-concurrency.js

npm test                                 # correctness gate, after
DATABASE_URL=... ADMIN_API_KEY=$KEY npm run reconcile
```

| Scenario                 | What it is for                                                                |
| ------------------------ | ----------------------------------------------------------------------------- |
| `normal-transfer`        | Baseline throughput and latency, 20 VUs over a 100-account pool               |
| `broad-concurrency`      | Finds the environment's ceiling — ramps to 75 VUs and reports where it breaks |
| `duplicate-storm`        | 50 truly concurrent identical requests; asserts exactly one transfer posts    |
| `hot-account-contention` | Maximum `SERIALIZABLE` conflict; asserts non-negative, conserved balances     |

Raw k6 stdout and `--summary-export` JSON per scenario are committed under
[`benchmarks/k6/results/`](../benchmarks/k6/results/).

### CI

`.github/workflows/ci.yml` runs on every push and pull request against a real PostgreSQL 17 service
container: `npm ci` → architecture check → format check → lint → typecheck → migrate → test → build.

The service container backs the `db:migrate` step, which proves the migrations apply to an empty
database. The tests themselves get their own per-file databases from Testcontainers, so CI runs the
same suite as a local `npm test` rather than a differently-isolated variant of it.

## Test inventory

171 tests, 19 files.

| Layer       | Files | Tests | What it proves                                                             |
| ----------- | ----: | ----: | -------------------------------------------------------------------------- |
| Unit        |     8 |    60 | Domain and application behavior through in-memory ports; no database       |
| Property    |     1 |     2 | Generated postings: balanced always accepted, unequal always rejected      |
| Integration |    10 |   109 | Real migrations, real SQL, real constraints, real concurrency and recovery |

Concurrency, recovery, and end-to-end cases live inside `tests/integration/` rather than separate
directories: they need the same real database, and splitting them would have meant duplicating the
container setup for no gain.

## Invariant → named test

Each of the four v1 invariants, and each row of the project plan's mandatory test matrix, maps to a
test you can run by name.

### Invariant 1 — every transaction is balanced

| Evidence                                | Test                                                                                                                                |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Balanced postings accepted, unequal not | `tests/property/ledger.property.test.ts` → _accepts generated balanced postings_ / _rejects generated unequal postings_             |
| Unbalanced posting aborts at commit     | `tests/integration/accounts.integration.test.ts` → _rejects an unbalanced transaction atomically at commit_                         |
| Funding is a balanced two-sided posting | `tests/integration/accounts.integration.test.ts` → _funds a customer with balanced journal entries and conserved balances_          |
| Mixed currency rejected                 | `tests/unit/ledger.test.ts` → _rejects mixed currencies_                                                                            |
| Zero / negative / unsafe amounts        | `tests/unit/ledger.test.ts` → _rejects JavaScript numbers, including unsafe integers_ · _round-trips the largest PostgreSQL bigint_ |
| Insufficient funds posts nothing        | `tests/integration/transfers.integration.test.ts` → _rejects insufficient funds without partial rows or balance changes_            |

### Invariant 2 — committed journal entries are immutable

| Evidence                            | Test                                                                                                                                        |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Journal mutation rejected in SQL    | `tests/integration/accounts.integration.test.ts` → _rejects journal updates and deletes_                                                    |
| Account identity/currency frozen    | `tests/integration/accounts.integration.test.ts` → _rejects currency mutation at the database boundary_                                     |
| Cache drift is detected, not hidden | `tests/integration/reconciliation.integration.test.ts` → _reports a mismatch and does not repair it when the cache drifts from the journal_ |
| Seeded mismatch detected over HTTP  | `tests/integration/reconciliation.integration.test.ts` → _POST /v1/admin/reconcile reports a seeded mismatch over HTTP_                     |
| Seeded mismatch fails the CLI       | `tests/integration/reconcile-cli.integration.test.ts` → _exits non-zero and prints the issue when a seeded mismatch exists_                 |

### Invariant 3 — one idempotency key, one result

| Evidence                                           | Test                                                                                                                           |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Same key + body replays the original               | `tests/integration/idempotency.integration.test.ts` → _replays a completed response for the same key and body_                 |
| Same key + different body conflicts                | `tests/integration/idempotency.integration.test.ts` → _returns conflict for same key with different request body_              |
| **50 concurrent duplicates post once**             | `tests/integration/idempotency.integration.test.ts` → _handles 50 concurrent identical requests creating exactly one transfer_ |
| Lost-response retry is safe                        | `tests/integration/idempotency.integration.test.ts` → _simulates lost-response retry safely_                                   |
| Record completes inside the transfer's transaction | `tests/integration/idempotency.integration.test.ts` → _stores the idempotency record atomically with the transfer_             |
| Stale in-progress claim is reclaimed               | `tests/unit/idempotency.test.ts` → _reclaims a stale in_progress record_                                                       |

### Invariant 4 — one event, at most one effect

| Evidence                                      | Test                                                                                                                                                        |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Event commits with the transfer               | `tests/integration/outbox.integration.test.ts` → _commits an outbox event with every transfer_                                                              |
| Rolled-back transfer writes no event          | `tests/integration/outbox.integration.test.ts` → _does not create outbox events for insufficient-funds transfers_                                           |
| **Committed event survives a worker restart** | `tests/integration/outbox.integration.test.ts` → _delivers a committed event after a worker restart (stop before processing)_                               |
| A processed event is not redelivered          | `tests/integration/outbox.integration.test.ts` → _does not redeliver an event after restart once committed processed (stop after commit)_                   |
| Two workers never double-claim                | `tests/integration/outbox.integration.test.ts` → _never lets two workers double-claim the same event_                                                       |
| Crashed claim is reclaimed after its lease    | `tests/integration/outbox.integration.test.ts` → _reclaims a stale processing event whose lease has elapsed_                                                |
| **1,000 duplicate deliveries → one effect**   | `tests/integration/audit-consumer.integration.test.ts` → _processes 1,000 duplicate deliveries of the same event into exactly one audit effect_             |
| Concurrent consumers → one effect             | `tests/integration/audit-consumer.integration.test.ts` → _never lets two concurrent consumers double-record the same event_                                 |
| Claim and effect commit together              | `tests/integration/audit-consumer.integration.test.ts` → _commits the inbox claim and the audit effect atomically (never one without the other)_            |
| Real worker redelivery, one effect            | `tests/integration/audit-consumer.integration.test.ts` → _is redelivered by the worker (at-least-once) but produces exactly one audit effect_               |
| Failed attempts are visible and bounded       | `tests/integration/outbox.integration.test.ts` → _marks an event as failed with next attempt time_ · _marks events as permanently failed after maxAttempts_ |

### Concurrency (invariants 1 and 3 under load)

| Evidence                                | Test                                                                                                                                           |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Two overspending requests → one commits | `tests/integration/transfers.integration.test.ts` → _allows only one concurrent withdrawal when two requests would overspend_                  |
| Hot account never goes negative         | `tests/integration/transfers.integration.test.ts` → _keeps a hot source non-negative across concurrent withdrawals_                            |
| Opposing transfers preserve totals      | `tests/integration/transfers.integration.test.ts` → _preserves totals for opposing concurrent transfers_                                       |
| Final state matches a reference model   | `tests/integration/transfers.integration.test.ts` → _matches a sequential reference model_                                                     |
| Retry budget is bounded and observable  | `tests/unit/transfers.test.ts` → _retries recognized database conflicts with bounded backoff and records metrics_ · _stops at the retry bound_ |
| Locks ordered deterministically         | `tests/unit/transfers.test.ts` → _orders account locks deterministically_                                                                      |

### Authentication and ownership

| Evidence                                        | Test                                                                                                                                                                                  |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No credential is rejected                       | `tests/integration/auth.integration.test.ts` → _rejects a request with no Authorization header_                                                                                       |
| Bad credentials are indistinguishable           | `tests/integration/auth.integration.test.ts` → _rejects malformed, unknown, and wrong-scheme credentials identically_                                                                 |
| Auth runs before body validation                | `tests/integration/auth.integration.test.ts` → _authenticates before validating the body, so schemas leak nothing_                                                                    |
| Secrets are stored hashed, never in the clear   | `tests/integration/auth.integration.test.ts` → _never stores the secret, only its hash_                                                                                               |
| Revocation is immediate                         | `tests/integration/auth.integration.test.ts` → _stops accepting a revoked key_                                                                                                        |
| A disabled principal loses access               | `tests/integration/auth.integration.test.ts` → _stops accepting keys belonging to a disabled principal_                                                                               |
| Only an admin can mint credentials              | `tests/integration/auth.integration.test.ts` → _requires the admin key to mint or revoke customer credentials_                                                                        |
| The two credentials do not substitute           | `tests/integration/hardening.integration.test.ts` → _keeps the two credentials separate in both directions_                                                                           |
| **Cannot spend from an account you do not own** | `tests/integration/auth.integration.test.ts` → _refuses to spend from an account the caller does not own, and posts nothing_                                                          |
| Checked under the row lock, not in the route    | `tests/unit/transfers.test.ts` → _refuses to spend from an account the caller does not own, and posts nothing_                                                                        |
| Anyone may be paid                              | `tests/integration/auth.integration.test.ts` → _allows paying an account owned by someone else_                                                                                       |
| Reads are owner-scoped, and leak nothing        | `tests/integration/auth.integration.test.ts` → _hides another principal's account behind a 404_ · _hides another principal's journal entries behind the same 404_                     |
| Transfers are visible to participants only      | `tests/integration/auth.integration.test.ts` → _lets both participants read the transfer, and nobody else_                                                                            |
| Idempotency keys are per principal              | `tests/integration/auth.integration.test.ts` → _scopes an idempotency key to its principal_ · `tests/unit/idempotency.test.ts` → _lets two principals use the same key independently_ |
| Ownership is immutable in SQL                   | `tests/integration/auth.integration.test.ts` → _rejects a change of ownership at the database boundary_                                                                               |
| No customer account can exist unowned           | `tests/integration/auth.integration.test.ts` → _refuses to create a customer account with no owner_                                                                                   |

### Hardening

| Evidence                         | Test                                                                                                                                         |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Admin routes require the key     | `tests/integration/hardening.integration.test.ts` → _rejects /v1/admin/fund with no key_ · _rejects /v1/admin/fund with the wrong key_       |
| Customer/health routes stay open | `tests/integration/hardening.integration.test.ts` → _never protects customer-facing or health routes_                                        |
| Oversized bodies rejected        | `tests/integration/hardening.integration.test.ts` → _rejects an oversized body with 413 REQUEST_REJECTED_                                    |
| Real-socket graceful shutdown    | `tests/integration/hardening.integration.test.ts` → _serves a real request over a real socket, then stops accepting connections after close_ |
| Secrets never logged             | `tests/unit/logging.test.ts` → _redacts the admin API key header_ · _redacts the authorization and cookie headers_                           |
| Config validated before boot     | `tests/unit/config.test.ts` → _rejects a missing admin API key_ · _rejects an admin API key shorter than 16 characters_                      |
| Pagination is exact and bounded  | `tests/integration/accounts.integration.test.ts` → _paginates every entry exactly once, in order, across multiple pages_                     |
