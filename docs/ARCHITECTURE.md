# PulseLedger architecture

## Purpose and status

PulseLedger is a correctness-first payment ledger implemented as a **modular monolith** backed by one PostgreSQL database. This document is the implementation contract for new project work. [PROJECT_PLAN.md](../PROJECT_PLAN.md) defines delivery order and scope; this document defines boundaries and dependency direction.

The repository currently implements the foundation and account API. Ledger posting, serializable transfers, idempotency, outbox processing, reconciliation, and benchmarks remain planned work and must be added incrementally through the boundaries below.

## System context

```text
API client
    |
    | HTTP + request ID; Idempotency-Key on transfer commands
    v
Fastify application (single deployable process)
    |
    | feature ports and transaction-oriented use cases
    v
PostgreSQL (single source of durable state)
    |
    | claimed outbox rows
    v
Worker entrypoint in the same repository
    |
    v
Consumer inbox and audit effects
```

PostgreSQL constraints and transactions enforce financial invariants. The immutable journal will be the source of truth; `accounts.balance_minor` is only a transactional cache. No Redis, message broker, microservice split, or direct balance-editing path belongs in v1.

## Code organization and dependency direction

```text
process entrypoints: server, migration CLI, future worker/commands
                         |
                         v
composition root: app.ts (constructs adapters and injects ports)
                         |
              +----------+----------+
              v                     v
     feature HTTP adapters    operational adapters
        *-routes.ts              health routes
              |                     |
              v                     v
       feature contracts       shared ports
        *-domain.ts          ports/database.ts
              ^                     ^
              |                     |
       persistence adapters --------+
       *-repository.ts
              |
              v
       PostgreSQL / explicit SQL
```

- `src/modules/<feature>/` owns a vertical feature slice: domain types and ports, application behavior, HTTP adapters, and feature-specific persistence.
- `*-domain.ts` contains framework-independent domain values and port interfaces. It must not depend on Fastify, `pg`, or shared infrastructure.
- `*-routes.ts` is an inbound HTTP adapter. It validates transport data and calls an injected domain/application port; it never constructs or imports a repository.
- `*-repository.ts` is an outbound persistence adapter. It implements a feature-owned port with explicit SQL and may depend on the generic database port.
- `src/ports/` contains small technology-neutral boundaries shared by multiple features. It must not become a miscellaneous utility directory.
- `src/infrastructure/` owns generic technology setup such as the PostgreSQL pool and migration runner. It does not own business rules and cannot depend on feature modules.
- `src/app.ts` is the HTTP composition root. It is allowed to know concrete adapters and wires them to routes.
- `src/server.ts` and other process entrypoints load configuration, acquire resources, start work, and shut resources down. Business behavior does not live there.

Feature-to-feature dependencies are exceptional. When required, a feature may import only another feature's `*-domain.ts` contract, never its routes or repository. Cross-feature workflows should be coordinated by an application service with dependencies injected through ports.

Run `npm run architecture:check` to enforce these dependency rules. The command is also part of the main verification gate and CI.

## Runtime flows

### Current account request

```text
request -> account route -> AccountStore port -> PostgresAccountStore -> PostgreSQL
        <- JSON schema <- Account domain model <- row mapping          <- result
```

The route owns HTTP status codes and schemas. The repository owns SQL and row mapping. The domain contract keeps those concerns independently testable.

### Future monetary command

A transfer or treasury-funding request must execute as one use-case-owned PostgreSQL transaction:

1. Validate authentication, schema, currency, amount, and idempotency metadata before mutation.
2. Begin a `SERIALIZABLE` transaction and claim or replay the idempotency record.
3. Lock accounts in deterministic ID order and validate account state and funds.
4. Insert one ledger transaction and balanced, immutable journal entries.
5. Update cached balances from the same amounts.
6. Insert the outbox event and completed stable response.
7. Commit once; retry only recognized serialization/deadlock failures with a documented bound.

No route or repository may split those steps across independent transactions. The application use case owns the transaction boundary; repositories execute using the injected transaction-scoped database interface.

### Future outbox processing

The API transaction writes an outbox record but performs no external side effect. A separately started worker claims committed records, records a unique consumer-inbox key, applies the audit effect, and marks completion. A crash or retry may repeat delivery, but the inbox makes the logical effect occur at most once.

## Data and correctness rules

These rules outrank convenience and performance:

1. Monetary values are integer minor units in PostgreSQL `bigint`; JSON exposes them as decimal strings.
2. Every posted ledger transaction has total debits equal to total credits in one currency.
3. Committed journal entries are immutable and are the financial source of truth.
4. Account identity, currency, and treasury designation are immutable.
5. Customer balances cannot become negative; demo funding is a journaled treasury transfer.
6. One idempotency key plus operation identifies one request fingerprint and one stable result.
7. Journal rows, cached balances, idempotency completion, and outbox creation commit atomically.
8. Each outbox event produces at most one logical consumer effect.

Enforce an invariant in PostgreSQL whenever practical, then test it at the database boundary. TypeScript validation alone is not a sufficient financial control.

## API and failure contract

- Fastify JSON schemas reject malformed transport input.
- Expected failures use `AppError` with a stable machine code and safe message.
- Every error response includes the request ID; unexpected errors are logged and return `INTERNAL_ERROR` without leaking details.
- Domain/application code must not depend on Fastify reply objects or status codes.
- Liveness reports process health without querying PostgreSQL. Readiness verifies required dependencies.
- Secrets, API keys, idempotency payloads, and sensitive request bodies must not be logged.

## Testing contract

- Unit tests exercise domain/application behavior through in-memory port implementations.
- Integration tests use real PostgreSQL migrations and verify SQL, constraints, transaction behavior, and repositories.
- Property tests prove balanced-entry and amount invariants across generated cases.
- Concurrency tests use independent database connections and synchronized starts.
- Recovery tests stop and restart workers around durable state transitions.
- End-to-end tests cover stable HTTP behavior and replay semantics.

A feature is complete only when its relevant rejection, concurrency, and failure modes are tested. `npm run check` is the local gate; migration and integration checks also run in CI against PostgreSQL.

## Adding a feature

1. Define domain values and the smallest required ports in `src/modules/<feature>/*-domain.ts`.
2. Put orchestration and transaction ownership in an application service within that feature.
3. Implement feature-specific SQL behind the port in `*-repository.ts`.
4. Add a schema-validating `*-routes.ts` adapter that accepts the application port by injection.
5. Wire concrete adapters only in a composition root or process entrypoint.
6. Add migrations and tests that demonstrate the invariants, then update this document if the architecture contract changes.

Material architectural decisions should be recorded in `docs/adr/` when their planned delivery gate is reached. In particular, the project plan calls for ADRs covering double-entry integer accounting, serializable locking/retries, the transactional outbox, and the modular-monolith worker boundary.
