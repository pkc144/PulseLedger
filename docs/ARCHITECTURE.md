# PulseLedger architecture

## Purpose and status

PulseLedger is a correctness-first payment ledger implemented as a **modular monolith** backed by one PostgreSQL database. This document is the implementation contract for new project work. [PROJECT_PLAN.md](../PROJECT_PLAN.md) defines delivery order and scope; this document defines boundaries and dependency direction.

As of `v1.1.0` the repository implements the foundation, account API, immutable double-entry journal, treasury funding, serializable customer transfers, request idempotency with stable response replay, a transactional outbox drained by a background worker, an idempotent audit consumer fed by that worker, independent balance reconciliation, cursor-paginated journal entries, API-key authentication with database-enforced account ownership, API-key-protected administrative routes, log redaction, and bounded request limits, all verified against real `EXPLAIN ANALYZE` output and real k6 load (`benchmarks/k6/RESULTS.md`). Diagrams of the structures described here: [diagrams/architecture.md](./diagrams/architecture.md) and [diagrams/transfer-flow.md](./diagrams/transfer-flow.md).

## Current system context

```text
API client
    |
    | HTTP + request ID; Idempotency-Key added in Week 4
    v
Fastify application (single deployable process)
    |
    | feature ports and transaction-oriented use cases
    v
PostgreSQL (single source of durable state)
    |- principals and hashed API keys
    |- accounts and cached balances (each owned by a principal)
    |- immutable ledger transactions and journal entries
    |- completed transfer projections
    |- idempotency records and stable responses
    |- transactional outbox events
    `- consumer inbox and audit effects
                  |
                  v
     Outbox worker (background loop in the same process)
                  |
                  v
     consumer inbox (dedup) -> audit effects (append-only)

Reconciliation independently recomputes balances from the immutable journal.
```

PostgreSQL constraints and transactions enforce financial invariants. The immutable journal is the source of truth; `accounts.balance_minor` is only a transactional cache, independently checked by reconciliation. No Redis, message broker, microservice split, or direct balance-editing path belongs in v1. See [ADR-004](./adr/004-modular-monolith-database-worker.md) for why the worker stays in-process and database-backed.

The outbox worker (Week 5) and the audit consumer (Week 6) keep the same process and database boundary:

```text
committed PostgreSQL outbox -> repository worker entrypoint -> consumer inbox + audit effect
```

## Code organization and dependency direction

```text
process entrypoints: server, migration CLI, future worker/commands
                         |
                         v
composition root: app.ts (constructs adapters and injects ports)
                         |
              +----------+----------+
              v                     v
       feature HTTP adapters       operational adapters
          *-routes.ts                 health routes
                |                         |
                v                         v
     application port/interface       shared ports
          *-domain.ts              ports/database.ts
                ^                         ^
                |                         |
       *-service.ts implementation        |
                |                         |
                v                         |
       feature persistence port          |
                ^                         |
                |                         |
       *-repository.ts adapter -----------+
                |
                v
         PostgreSQL / explicit SQL
```

- `src/modules/<feature>/` owns a vertical feature slice: domain types and ports, application behavior, HTTP adapters, and feature-specific persistence.
- `*-domain.ts` contains framework-independent domain values, errors, and port interfaces. It must not depend on Fastify, `pg`, shared infrastructure, or HTTP status semantics.
- `*-service.ts` implements application behavior using injected feature ports. It cannot import routes, repositories, or infrastructure.
- `*-routes.ts` is an inbound HTTP adapter. It validates transport data and calls an injected application interface from `*-domain.ts`; it never imports a concrete service or repository.
- `*-repository.ts` is an outbound persistence adapter. It implements a feature-owned port with explicit SQL and may depend on the generic database port.
- `src/ports/` contains small technology-neutral boundaries shared by multiple features. It must not become a miscellaneous utility directory.
- `src/infrastructure/` owns generic technology setup such as the PostgreSQL pool and migration runner. It does not own business rules and cannot depend on feature modules.
- `src/app.ts` is the HTTP composition root. It is allowed to know concrete adapters and wires them to routes.
- `src/server.ts` and other process entrypoints load configuration, acquire resources, start work, and shut resources down. Business behavior does not live there.

Feature-to-feature dependencies are exceptional. Non-domain code may import only another feature's `*-domain.ts` contract, never its routes, service, or repository. A `*-domain.ts` file itself stays wholly inside its feature. Cross-feature workflows are coordinated by application services through injected ports or shared database invariants.

Run `npm run architecture:check` to enforce these dependency rules. The checker rejects framework/transport leakage into domain files, route-to-service/repository coupling, service-to-adapter coupling, repository-to-inbound coupling, feature dependencies from infrastructure/shared ports, and non-contract cross-feature imports. The command is also part of the main verification gate and CI.

## Runtime flows

### Current account request

```text
request -> account route -> AccountApplication -> AccountService -> AccountStore port
        <- JSON schema  <- Account domain model  <- PostgresAccountStore <- PostgreSQL
```

The route owns HTTP status codes and schemas. The repository owns SQL and row mapping. The domain contract keeps those concerns independently testable.

### Current journal entries pagination

`GET /v1/accounts/:id/entries` is registered from `account-routes.ts` (public, customer-facing) but
reads through an **injected `LedgerApplication`** — the sanctioned cross-feature pattern of
depending only on another feature's `*-domain.ts` contract. The data itself is ledger-owned
(`journal_entries`), so the query logic stays in the `ledger` module; the URL shape reflects the
client's resource hierarchy (an account's entries), which does not have to match module ownership.

Pagination is keyset-based (`WHERE account_id = $1 AND (created_at, id) > (cursor) ORDER BY
created_at, id LIMIT n`), using the `journal_entries_account_created_idx (account_id, created_at,
id)` index defined in Week 2 — before pagination existed, but exactly shaped for it. The opaque
cursor is base64url-encoded JSON; its `createdAt` field is Postgres's own microsecond-precision
text rendering of `created_at` (`to_char(..., 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`), never a JS `Date`
round-trip — `Date.toISOString()` only carries millisecond precision, and building a cursor from it
can silently re-include a boundary row on the next page whenever two entries land in the same
millisecond. A malformed cursor raises `INVALID_CURSOR` (400); an unknown account raises
`ACCOUNT_NOT_FOUND` (404, matching the existing account-lookup contract).

### Current treasury-funding command

```text
request -> ledger route -> LedgerPostingService -> LedgerStore port
                        -> money + balance validation
                        -> PostgreSQL posting function
                           |- lock accounts in UUID order
                           |- insert transaction and two entries
                           |- update both cached balances
                           `- finalize the transaction
```

The database function executes as one PostgreSQL statement and therefore one atomic transaction when called by the API. Composite foreign keys enforce one currency across the transaction, entries, and accounts. Deferred constraint triggers verify the final debit and credit totals at commit. Finalization prevents later entries, while mutation triggers reject updates and deletes.

Asset-account directions are explicit: a debit increases an account balance and a credit decreases it. Treasury funding therefore debits the customer and credits the treasury by the same positive minor-unit amount.

### Current transfer command

A transfer request executes through a service-owned bounded attempt loop:

1. Validate the HTTP schema, positive integer amount, and distinct account IDs before mutation.
2. Begin a `SERIALIZABLE` PostgreSQL transaction.
3. Lock both accounts in ascending UUID order and validate ownership of the source, then their current status, currency, and source balance — all against the locked rows, so authorization cannot be raced.
4. Insert one ledger transaction, equal credit/debit journal entries, cached balance updates, and the stable transfer record.
5. Commit once.
6. Retry only SQLSTATE `40001` serialization failures and `40P01` deadlocks, using at most 12 attempts with exponential backoff, 50–100% jitter, and a 50 ms delay cap.

Each attempt reloads and validates the locked account state. A failed attempt rolls back before the same transfer ID and reference are retried. Business errors such as insufficient funds are never retried. Retry counts and elapsed time are emitted in structured logs; in-process counters track completed transfers, retries, and exhausted budgets.

The transfer row, journal, and cached balances are committed atomically. `GET /v1/transfers/:id` reads the transfer and immutable ledger reference as one stable representation.

The `transfers` table is a transfer-specific projection, not a second source of financial truth. A composite foreign key requires its ID, currency, and fixed `transfer` ledger type to match one `ledger_transactions` row. Creation time and reference are read from that ledger row rather than duplicated in the projection.

### Current authenticated request

Every customer request resolves an identity before anything else happens:

```text
request -> onRequest guard -> AuthApplication.authenticate(secret)
                              |- parse "Bearer <secret>", take the 12-char prefix
                              |- one indexed read on api_keys (revoked rows excluded)
                              |- constant-time compare of SHA-256 digests
                              `- reject a disabled principal
        -> request.principalId -> route -> application service (owner-scoped queries)
```

Only a SHA-256 hash of a secret is stored; the secret itself is returned once, by the call that issued it. Every failure mode returns the same `401 UNAUTHORIZED`, so a caller cannot tell an unknown key from a revoked one.

### Current idempotent monetary command

An idempotent transfer request extends the transaction boundary to claim or replay an idempotency record before mutation and commits its stable response atomically with the transfer.

1. The route extracts the `Idempotency-Key` header and calls the idempotency service with the authenticated principal; records are unique on `(principal_id, key, operation)`, so two callers may use the same key string without colliding.
2. On first use: the key is claimed (INSERT as `in_progress`) before entering the transfer service.
3. On replay: a completed record returns the stored status code and response body immediately.
4. On conflict: the same key with a different payload body returns `IDEMPOTENCY_CONFLICT`.
5. On stale detection: an `in_progress` record older than 30 seconds is atomically reclaimed.
6. The transfer repository updates the idempotency record to `completed` inside the same `SERIALIZABLE` transaction that posts the transfer. A rollback leaves the record `in_progress` for eventual reclamation.

No route may split monetary steps across independent transactions. The application use case owns the transaction lifecycle through an injected store; persistence executes SQL using one transaction-scoped database connection.

### Current outbox processing

The transfer transaction writes a `transfer.created` outbox record inside the same `SERIALIZABLE` transaction that posts the transfer, so the event and the ledger commit atomically — no dual write. The request path performs no external side effect.

A separately started `OutboxWorker` drains the table independently. It claims a bounded batch with `FOR UPDATE SKIP LOCKED` (so multiple worker instances never claim the same row), runs the handler, then marks each event `processed` or `failed` with bounded exponential backoff and a maximum attempt cap. Each claim leases the row for a configurable interval by pushing `next_attempt_at` forward; a worker that crashes between claim and completion leaves the row `processing`, and once the lease elapses another worker reclaims it. Delivery is therefore **at least once**; poll/batch/attempt/lease are configurable via `OUTBOX_*`, and `/health/ready` reports pending/processing/failed counts. See [ADR-003](./adr/003-transactional-outbox.md).

### Current audit consumption

The worker's handler is `AuditConsumerService`. For each claimed event it attempts to insert `(consumer_name, event_id)` into `consumer_inbox`; a unique-constraint conflict means the event was already processed, and the call returns as a **successful no-op** — no error, no retry. A first-time claim proceeds, inside the _same_ transaction, to record the effect in `audit_effects` (today an audit-log row; a real downstream side effect would replace or extend this handler). Both tables reuse the ledger's append-only trigger, so a recorded effect cannot be altered or removed after the fact.

Because delivery is at-least-once but the claim is a unique-constraint insert, the audit effect is produced **at most once logically per event**, regardless of how many times the outbox redelivers it. See [ADR-004](./adr/004-modular-monolith-database-worker.md) for why this split (transport at-least-once, consumer exactly-once-in-effect) is the design, not a gap.

### Current reconciliation

`ReconciliationService` independently recomputes each account's balance by summing debits minus credits from `journal_entries` and compares it against the cached `accounts.balance_minor`. It is **read-only**: it reports drift, it never repairs it — a human decides whether and how to post a correcting entry. Three outcomes are reported: `mismatched` (both sides exist but disagree), `missing` (a nonzero cached balance with zero journal entries behind it), and `unexpected` (a computed balance for an account id with no `accounts` row — structurally prevented today by the composite currency foreign keys, but checked independently rather than assumed). Available as `POST /v1/admin/reconcile` and as the `npm run reconcile` CLI, which exits non-zero when any issue is found.

## Data and correctness rules

These rules outrank convenience and performance. All nine rules are enforced now.

1. Monetary values are integer minor units in PostgreSQL `bigint`; JSON exposes them as decimal strings.
2. Every posted ledger transaction has total debits equal to total credits in one currency.
3. Committed journal entries are immutable and are the financial source of truth.
4. Account identity, currency, and treasury designation are immutable.
5. Customer balances cannot become negative; demo funding is a journaled treasury transfer.
6. One principal plus idempotency key and operation identifies one request fingerprint and one stable result.
7. Journal rows, cached balances, idempotency completion, and outbox creation commit atomically.
8. Each outbox event produces at most one logical consumer effect.
9. Every customer account has exactly one owning principal, fixed for the life of the account.

Enforce an invariant in PostgreSQL whenever practical, then test it at the database boundary. TypeScript validation alone is not a sufficient financial control.

### Current durable model

```text
principals (identity) 1 ---- * api_keys (prefix + sha256 hash, revocable)
    |
    | owns (immutable, NOT NULL for customer accounts)
    v
accounts (identity, status, cached balance)
    ^                              ^
    | account + currency FK        | source/destination + currency FK
    |                              |
journal_entries * -------- 1 ledger_transactions 1 -------- 0..1 transfers
       immutable              immutable/finalized             immutable
       debit or credit        type + currency + reference     transfer projection
```

- `ledger_transactions` plus `journal_entries` is the authoritative financial record.
- `accounts.balance_minor` is updated in the same transaction and can later be reconciled from entries.
- Composite foreign keys prevent mixed-currency entries and transfer projections.
- Deferred balance triggers reject non-finalized, one-sided, or unequal postings at commit.
- Mutation/finalization triggers prevent changes to committed ledger history.

## API and failure contract

- Fastify JSON schemas reject malformed transport input.
- Domain errors contain only a stable machine code and safe message. The HTTP error adapter owns the explicit code-to-status mapping; domain and application code never carry HTTP status codes.
- Route-local HTTP failures may use `AppError` because the route is already a transport adapter.
- Every error response includes the request ID; unexpected errors are logged and return `INTERNAL_ERROR` without leaking details. Framework-level client errors (oversized body, malformed content-type, header limits) surface their own real `statusCode` as `REQUEST_REJECTED` instead of collapsing into `INTERNAL_ERROR`.
- Domain/application code must not depend on Fastify reply objects or status codes.
- Liveness reports process health without querying PostgreSQL. Readiness verifies required dependencies and reports outbox backlog counts.
- Secrets, API keys, idempotency payloads, and sensitive request bodies must not be logged. Pino `redact` (`src/infrastructure/http/logging.ts`) is applied whenever logging is enabled, covering `authorization`, `x-admin-api-key`, and `cookie`/`set-cookie` headers regardless of whether Fastify's own request logging currently serializes headers, so a future call that logs them stays safe by construction.
- Customer routes (`/v1/accounts*`, `/v1/transfers*`) require `Authorization: Bearer <api key>`; administrative routes require `x-admin-api-key`. Both guards are constant-time comparisons wired only at the composition root, each around its own encapsulated child context, so route files stay unaware that authentication exists. The two credentials are not interchangeable, and only health endpoints are unauthenticated.
- Both guards run on Fastify's `onRequest` hook, **before** body parsing and schema validation. On `preHandler` (which runs after validation) an anonymous caller would receive schema feedback as a 400 and could map request shapes without a credential.
- Authorization is account ownership: `accounts.owner_principal_id` is `NOT NULL` for customer accounts, immutable, and checked against the row locked inside the transfer transaction. A resource owned by another principal answers `404`, never `403`, so the API cannot be used to enumerate accounts or transfers. See [ADR-005](./adr/005-api-key-authentication-account-ownership.md).
- Request size, connection, keep-alive, and total-request timeouts are explicit Fastify constructor options (`bodyLimit`, `connectionTimeout`, `keepAliveTimeout`, `requestTimeout`), configurable via `REQUEST_BODY_LIMIT_BYTES`/`CONNECTION_TIMEOUT_MS`/`KEEP_ALIVE_TIMEOUT_MS`/`REQUEST_TIMEOUT_MS` with bounded defaults rather than Fastify's larger built-in defaults.
- Shutdown closes the outbox worker, then the Fastify server (which stops accepting new connections and drains in-flight ones; Fastify's default `return503OnClosing` answers any request that still arrives mid-shutdown with 503), then the database pool — verified with a real listening socket in `tests/integration/hardening.integration.test.ts`, not just `app.inject()`.

### Current operational surface

Three operator-facing capabilities sit outside the request path and share the same rule: they act
only on terminal state, never on work the system still owes.

- **Dead-letter inspection and replay** (`npm run outbox`). Events that exhaust their attempt budget
  are parked (`status = 'failed'`, `next_attempt_at = 'infinity'`) rather than dropped. `OutboxAdminStore`
  is a port separate from `OutboxStore` so the worker's hot path cannot reach inspection or replay.
  Replay resets `attempts` and clears `next_attempt_at` — making the row claimable by the ordinary
  claim query again — while keeping `last_error` as the record of why a human intervened. A pending
  or processing row cannot be replayed; it already belongs to the worker.
- **Retention** (`npm run retention`). Deletes processed outbox events and completed idempotency
  records past their windows, in bounded batches, supported by partial indexes. `consumer_inbox` and
  `audit_effects` are never swept — the first is the dedup boundary and the second is the audit
  trail, and both carry the append-only trigger that would reject the delete anyway. See
  [ADR-006](./adr/006-retention-boundaries-and-operator-replay.md).
- **Metrics** (`GET /metrics`, admin-guarded). Transfer counters and outbox depth by status in
  Prometheus exposition format, rendered by a pure function in `infrastructure/http/metrics.ts` that
  knows nothing about features — the composition root passes it plain numbers. The JSON
  `/v1/admin/metrics` is unchanged.

## Testing contract

- Unit tests exercise domain/application behavior through in-memory port implementations.
- Integration tests use real PostgreSQL migrations and verify SQL, constraints, transaction behavior, and repositories.
- Property tests prove balanced-entry and amount invariants across generated cases.
- Concurrency tests use independent pooled database connections and concurrently issued requests.
- Recovery tests stop and restart workers around durable state transitions.
- End-to-end tests cover stable HTTP behavior and replay semantics.

A feature is complete only when its relevant rejection, concurrency, and failure modes are tested. `npm run check` is the local gate; migration and integration checks also run in CI against PostgreSQL.

## Adding a feature

1. Define domain values and the smallest required ports in `src/modules/<feature>/*-domain.ts`.
2. Put orchestration and transaction ownership in an application service within that feature.
3. Implement the application interface in `*-service.ts` using injected ports.
4. Implement feature-specific SQL behind the persistence port in `*-repository.ts`.
5. Add a schema-validating `*-routes.ts` adapter that accepts the application port by injection.
6. Wire concrete services and adapters only in a composition root or process entrypoint.
7. Add migrations and tests that demonstrate the invariants, then update this document if the architecture contract changes.

Material architectural decisions are recorded in [`docs/adr/`](./adr/README.md). The four v1 records cover double-entry integer accounting, serializable locking/retries, the transactional outbox, and the modular-monolith worker boundary; a change that invalidates one of them needs a new ADR, not an edit to the old one.
