# PulseLedger

A correctness-first double-entry payment ledger that stays right when transfers run concurrently,
clients retry, and background workers crash mid-flight.

TypeScript · Fastify · PostgreSQL 17 · one deployable process · no broker, no cache, no ORM.

**Status: `v1.1.0`.** Feature-complete against [PROJECT_PLAN.md](./PROJECT_PLAN.md), plus API-key
authentication and account ownership; every claim below is backed by a test you can run or a
benchmark artifact committed in this repository.

## What this proves

Five invariants, each enforced by PostgreSQL rather than by application code alone, and each with a
named automated test.

| #   | Invariant                                                   | Mechanism                                                                              | Proof                                                                                                       |
| --- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 1   | Every ledger transaction is balanced: debits equal credits  | Deferred constraint triggers verify totals at `COMMIT`; composite currency FKs         | `rejects an unbalanced transaction atomically at commit` · `accepts generated balanced postings` (property) |
| 2   | Committed journal entries are immutable and authoritative   | `BEFORE UPDATE OR DELETE` triggers; corrections are reversing postings                 | `rejects journal updates and deletes` · `reports a mismatch and does not repair it when the cache drifts`   |
| 3   | One idempotency key means one request and one stable result | Unique `(principal_id, key, operation)` claim; the response commits with the transfer  | `handles 50 concurrent identical requests creating exactly one transfer`                                    |
| 4   | Each outbox event produces at most one logical effect       | Event written inside the transfer's transaction; consumer inbox dedups redelivery      | `processes 1,000 duplicate deliveries of the same event into exactly one audit effect`                      |
| 5   | You can only see and spend your own money                   | Hashed API keys; immutable `owner_principal_id` constraint, checked under the row lock | `refuses to spend from an account the caller does not own, and posts nothing`                               |

Full mapping, including the concurrency and recovery matrix: [docs/TESTING.md](./docs/TESTING.md).

## Evidence

Measured on the `v1.1.0` tag, with authentication on the request path
([full record](./docs/release/v1.1.0.md)).

| Evidence                    | Result                                                                                                                     |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Automated tests             | **151 passing** — 54 unit, 2 property, 95 integration against real PostgreSQL (`npm test`)                                 |
| Concurrency under real load | 7,369 transfer attempts across 4 k6 scenarios; **zero** overdrafts, lost updates, or unbalanced transactions               |
| Reconciliation after load   | `{ "accountsChecked": 707, "issues": [], "ok": true }` — every cached balance matched the journal exactly                  |
| Baseline throughput         | 2,498 requests, 79.4 req/s, p50 49.4 ms, p95 560 ms (20 VUs, 2-vCPU PostgreSQL container)                                  |
| Observed bottleneck         | `SERIALIZABLE` conflict retries competing for capped database CPU — 17.1% bounded 503s at 75 VUs, reported, not tuned away |
| Idempotency at load         | 50 truly concurrent identical requests → completed-transfer counter moved by **exactly 1**                                 |
| Failure accounting          | In every contention scenario the non-2xx count equals the retry-exhausted count **exactly** — nothing else fails quietly   |
| Failure mode under stress   | `TRANSFER_RETRY_EXHAUSTED` (503) after 12 bounded retries — the system refuses to trade correctness for throughput         |
| Crash recovery              | Process `SIGKILL`ed between commit and delivery; on restart the event is delivered and produces exactly one effect         |
| Access control              | A valid key for another principal gets `404` on read, entries, spend, and transfer read; the balance does not move         |
| Secrets at rest             | 0 rows in `api_keys` match a raw secret — only a SHA-256 hash and a 12-character lookup prefix are stored                  |

No throughput claim is made about the cost of authentication: it is one indexed read plus a digest
per request, and this machine's run-to-run spread is larger than that by more than an order of
magnitude. Earlier runs at larger scale (~14,000 attempts, 763 accounts reconciled) are kept in
[benchmarks/k6/RESULTS.md](./benchmarks/k6/RESULTS.md) alongside the methodology, hardware, and raw
k6 output. Reproduce the crash-recovery, idempotency, and ownership results in ~8 seconds with
`./scripts/demo.sh`.

## Quick start

Requires **Node.js 22+** (`.nvmrc`), npm, and Docker.

```bash
git clone <this-repo> && cd PulseLedger
cp .env.example .env                       # then set ADMIN_API_KEY to a random 16+ char secret
npm ci
docker compose up -d postgres
npm run db:migrate
npm run dev                                # http://localhost:3000
```

Customer routes require an API key, issued by an administrator:

```bash
export ADMIN_API_KEY=$(grep ADMIN_API_KEY .env | cut -d= -f2)
PRINCIPAL=$(curl -s -X POST localhost:3000/v1/admin/principals \
  -H 'content-type: application/json' -H "x-admin-api-key: $ADMIN_API_KEY" \
  -d '{"name":"me"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')

export CUSTOMER_KEY=$(curl -s -X POST localhost:3000/v1/admin/principals/$PRINCIPAL/api-keys \
  -H "x-admin-api-key: $ADMIN_API_KEY" | node -pe 'JSON.parse(require("fs").readFileSync(0)).key')
```

The secret is shown once — only its SHA-256 hash is stored.

Verify:

```bash
curl -s localhost:3000/health/ready
# {"status":"ready","outbox":{"pending":0,"processing":0,"failed":0}}
```

Run the whole verification gate the way CI does:

```bash
npm run check      # architecture → lint → typecheck → 151 tests → build
```

## Move some money

```bash
json() { node -pe 'JSON.parse(require("fs").readFileSync(0))'"$1"; }

ALICE=$(curl -s -X POST localhost:3000/v1/accounts -H 'content-type: application/json' \
          -H "authorization: Bearer $CUSTOMER_KEY" -d '{"currency":"INR"}' | json .id)
BOB=$(curl -s -X POST localhost:3000/v1/accounts -H 'content-type: application/json' \
        -H "authorization: Bearer $CUSTOMER_KEY" -d '{"currency":"INR"}' | json .id)

curl -s -X POST localhost:3000/v1/admin/fund -H 'content-type: application/json' \
  -H "x-admin-api-key: $ADMIN_API_KEY" \
  -d "{\"accountId\":\"$ALICE\",\"amountMinor\":\"250000\"}"

curl -s -X POST localhost:3000/v1/transfers -H 'content-type: application/json' \
  -H "authorization: Bearer $CUSTOMER_KEY" -H 'idempotency-key: my-first-transfer' \
  -d "{\"sourceAccountId\":\"$ALICE\",\"destinationAccountId\":\"$BOB\",\"amountMinor\":\"75000\"}"
```

```json
{
  "id": "73c606e2-6a4e-4905-8fbc-846d8c918252",
  "sourceAccountId": "97a673f8-be2c-4226-a61e-6718e645b594",
  "destinationAccountId": "184714b5-4832-466d-9c03-9082bdeb384d",
  "amountMinor": "75000",
  "currency": "INR",
  "status": "completed",
  "reference": "transfer:73c606e2-6a4e-4905-8fbc-846d8c918252",
  "createdAt": "2026-08-16T10:29:20.883Z"
}
```

Send that exact request again with the same `Idempotency-Key` and you get the same body back — same
ID, same timestamp — and no second transfer exists. Change the amount under the same key and you get
`409 IDEMPOTENCY_CONFLICT`.

Amounts are **integer minor units as strings** (`"75000"` = ₹750.00). No floats anywhere, and no
`JSON.parse` rounding: PostgreSQL `bigint` exceeds `Number.MAX_SAFE_INTEGER`.

Every endpoint, every error code, and real captured responses: [docs/API.md](./docs/API.md).

| Method | Path                       | Auth  | Purpose                                    |
| ------ | -------------------------- | ----- | ------------------------------------------ |
| `POST` | `/v1/accounts`             | —     | Create a zero-balance customer account     |
| `GET`  | `/v1/accounts/:id`         | —     | Read an account and its cached balance     |
| `GET`  | `/v1/accounts/:id/entries` | —     | Cursor-paginated journal entries           |
| `POST` | `/v1/transfers`            | —     | Transfer money (accepts `Idempotency-Key`) |
| `GET`  | `/v1/transfers/:id`        | —     | Read a stable transfer result              |
| `POST` | `/v1/admin/fund`           | Admin | Fund a demo account from its treasury      |
| `POST` | `/v1/admin/reconcile`      | Admin | Recompute balances from the journal        |
| `GET`  | `/v1/admin/metrics`        | Admin | In-process transfer counters               |
| `GET`  | `/health/live`             | —     | Liveness, never touches PostgreSQL         |
| `GET`  | `/health/ready`            | —     | Readiness plus outbox backlog              |

## How it works

```text
POST /v1/transfers
      │
      ├─ authenticate                         Bearer key -> principal (before body validation)
      ├─ claim the idempotency key            unique (principal, key, operation)
      │
      └─ BEGIN SERIALIZABLE ─────────────────────────────────────────────┐
           lock both accounts in ascending UUID order  (no deadlocks)    │
           validate ownership, status, currency, and the locked balance  │
           post 2 journal entries + update 2 cached balances             │
           insert the transfer projection                                │
           insert the outbox event            ← no dual write            │
           mark the idempotency record completed                         │
         COMMIT ──────────────────────────────────────────────────────────┘
           deferred triggers: debits == credits, finalized, balance >= 0

  outbox worker (same process, polls with FOR UPDATE SKIP LOCKED)
      → audit consumer: claim (consumer_name, event_id), then record the effect
        at-least-once delivery · at-most-once effect

  reconciliation: recompute every balance from journal_entries and compare
```

- **Serializable transfers with bounded retries.** Only SQLSTATE `40001`/`40P01` are retried, at most
  12 attempts, 2 ms base, 50 ms cap, 50–100% jitter — ≤362 ms of total sleep, then a clear 503.
- **The journal is the source of truth.** `accounts.balance_minor` is a transactional cache, and
  reconciliation exists to prove it never silently drifts.
- **The outbox removes the dual write.** The event and the money commit together or not at all.
- **The consumer, not the transport, provides exactly-once.** A duplicate delivery's inbox claim
  conflicts, inserts nothing, and returns a successful no-op.
- **Authorization is a database constraint, not a handler check.** Every customer account has an
  immutable owner; spending is validated against the locked row inside the transfer transaction, and
  anything you do not own answers `404`, never `403`.

Diagrams: [system architecture](./docs/diagrams/architecture.md) ·
[transaction flows](./docs/diagrams/transfer-flow.md). Written contract:
[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md).

Decision records:

- [ADR-001 — Double-entry accounting with integer minor units](./docs/adr/001-double-entry-integer-accounting.md)
- [ADR-002 — Serializable transfers, deterministic locking, bounded retries](./docs/adr/002-serializable-locking-retries.md)
- [ADR-003 — Transactional outbox instead of a dual write](./docs/adr/003-transactional-outbox.md)
- [ADR-004 — Modular monolith with a database-backed worker](./docs/adr/004-modular-monolith-database-worker.md)
- [ADR-005 — API-key authentication with database-enforced account ownership](./docs/adr/005-api-key-authentication-account-ownership.md)

## Commands

```bash
npm run dev                # watch mode
npm run check              # architecture + lint + typecheck + tests + build (the local gate)
npm test                   # 151 tests (Testcontainers starts PostgreSQL if needed)
npm run test:unit          # 54 tests, no database
npm run test:integration   # 95 tests against real PostgreSQL
npm run db:migrate         # apply pending migrations
npm run reconcile          # recompute balances from the journal; non-zero exit on drift
npm run seed               # realistic dataset via the real services (SEED_ACCOUNTS / SEED_TRANSFERS)
./scripts/demo.sh          # the four-invariant demonstration, ~8 seconds
npm run build && npm start # production build and run
```

Benchmark commands and per-scenario intent: [docs/TESTING.md](./docs/TESTING.md).

## Configuration

`.env` is read by your shell/`--env-file`; the process validates everything before it listens.

| Variable                     | Default            | Notes                                                         |
| ---------------------------- | ------------------ | ------------------------------------------------------------- |
| `DATABASE_URL`               | — (required)       | PostgreSQL connection string                                  |
| `ADMIN_API_KEY`              | — (required)       | ≥16 chars; guards `/v1/admin/*`                               |
| `PORT` / `HOST`              | `3000` / `0.0.0.0` |                                                               |
| `NODE_ENV`                   | `development`      | `development` \| `test` \| `production`                       |
| `LOG_LEVEL`                  | `info`             | Pino level; secrets are redacted at every level               |
| `OUTBOX_POLL_INTERVAL_MS`    | `1000`             | Worker poll cadence                                           |
| `OUTBOX_BATCH_SIZE`          | `10`               | Events claimed per poll                                       |
| `OUTBOX_MAX_ATTEMPTS`        | `12`               | Then the event is parked as permanently failed                |
| `OUTBOX_CLAIM_LEASE_SECONDS` | `300`              | How long a claim is held before another worker may reclaim it |
| `REQUEST_BODY_LIMIT_BYTES`   | `16384`            | Larger bodies get `413 REQUEST_REJECTED`                      |
| `CONNECTION_TIMEOUT_MS`      | `10000`            |                                                               |
| `KEEP_ALIVE_TIMEOUT_MS`      | `5000`             |                                                               |
| `REQUEST_TIMEOUT_MS`         | `30000`            |                                                               |

## What this is not

There is one static admin key, API keys have no scopes or expiry, metrics are in-process only, and
the outbox has no retention policy — this is a correctness demonstrator, not a deployable payments
platform. The full honest list, with the seams each extension would use, is in
[docs/TRADEOFFS.md](./docs/TRADEOFFS.md).

## Repository map

```text
src/modules/<feature>/     vertical slices: *-domain (ports) · *-service · *-routes · *-repository
src/infrastructure/        pool, migrations, logging redaction, admin auth
src/app.ts · src/server.ts composition root · process entrypoint
migrations/                ordered SQL; every invariant that can live in the database does
tests/                     unit · property · integration (concurrency, recovery, end-to-end)
benchmarks/k6/             four scenarios, raw output, and RESULTS.md
scripts/                   architecture checker · seeder · demo.sh
docs/                      ARCHITECTURE · API · TESTING · TRADEOFFS · DEMO · adr/ · diagrams/
```

`npm run architecture:check` fails the build if a dependency crosses a module boundary the wrong way.

## More

- [docs/DEMO.md](./docs/DEMO.md) — the three-minute walkthrough, timed
- [PROJECT_PLAN.md](./PROJECT_PLAN.md) — the eight-week plan, gates, and progress tracker
- [docs/release/v1.1.0.md](./docs/release/v1.1.0.md) — current release verification record
- [docs/release/v1.0.0.md](./docs/release/v1.0.0.md) — the v1.0.0 record it builds on
- [docs/weeks-1-2-study-guide.md](./docs/weeks-1-2-study-guide.md) — background notes
