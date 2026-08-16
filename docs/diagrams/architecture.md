# Architecture diagrams

Rendered from the code as it exists at `v1.0.0`. If one of these diagrams disagrees with
`src/`, the code wins and the diagram is a bug — see [ARCHITECTURE.md](../ARCHITECTURE.md) for the
written contract these pictures summarize.

## 1. System context

One deployable Node.js process, one PostgreSQL database, no broker and no cache
([ADR-004](../adr/004-modular-monolith-database-worker.md)).

```mermaid
flowchart TB
    client["API client<br/><i>x-request-id, Idempotency-Key,<br/>x-admin-api-key on /v1/admin/*</i>"]

    subgraph process["Node.js process (src/server.ts)"]
        api["Fastify app (src/app.ts)<br/>accounts · transfers · ledger<br/>reconciliation · health · metrics"]
        worker["OutboxWorker<br/><i>in-process poll loop</i>"]
        consumer["AuditConsumerService<br/><i>worker handler</i>"]
    end

    subgraph pg["PostgreSQL 17 (single source of durable state)"]
        ledger[("ledger_transactions<br/>journal_entries<br/><i>immutable · authoritative</i>")]
        accounts[("accounts<br/><i>cached balance</i>")]
        transfers[("transfers<br/><i>projection</i>")]
        idem[("idempotency_records")]
        outbox[("outbox_events")]
        inbox[("consumer_inbox<br/>audit_effects")]
    end

    cli["npm run reconcile<br/><i>read-only CLI</i>"]

    client -->|HTTP| api
    api -->|"one SERIALIZABLE transaction"| pg
    worker -->|"FOR UPDATE SKIP LOCKED"| outbox
    worker --> consumer
    consumer -->|"one transaction"| inbox
    cli -->|"recompute from journal"| ledger
    api -.->|"/health/ready reports<br/>pending/processing/failed"| outbox

    ledger -.->|"reconciliation compares"| accounts
```

The immutable journal is the financial source of truth. `accounts.balance_minor` is a transactional
cache of it, and reconciliation exists to prove the two never drift.

## 2. Module dependency direction

`npm run architecture:check` (`scripts/check-architecture.ts`) fails the build when an arrow points
the wrong way. Dependencies point **inward**: adapters depend on domain contracts, never the reverse.

```mermaid
flowchart TB
    entry["process entrypoints<br/>server.ts · migrate-cli.ts · reconcile-cli.ts"]
    root["composition root<br/>app.ts"]
    routes["inbound HTTP adapters<br/>*-routes.ts"]
    domain["domain + ports<br/>*-domain.ts<br/><i>no Fastify, no pg, no HTTP status</i>"]
    service["application services<br/>*-service.ts"]
    repo["outbound persistence adapters<br/>*-repository.ts"]
    infra["infrastructure<br/>pool · migrations · logging · admin-auth"]
    db[("PostgreSQL / explicit SQL")]

    entry --> root
    root --> routes
    root --> service
    root --> repo
    root --> infra
    routes -->|"injected application port"| domain
    service -->|"implements"| domain
    service -->|"injected store port"| domain
    repo -->|"implements store port"| domain
    repo --> db
    infra --> db

    classDef inner fill:#eef,stroke:#557
    class domain inner
```

Rules the checker enforces:

| Rule                                                           | Why                                                         |
| -------------------------------------------------------------- | ----------------------------------------------------------- |
| `*-domain.ts` imports no framework, driver, or infrastructure  | Domain stays testable and transport-independent             |
| `*-routes.ts` imports no concrete service or repository        | Transport is swappable; the route sees only a port          |
| `*-service.ts` imports no route, repository, or infrastructure | Application logic never reaches for a connection itself     |
| `*-repository.ts` imports nothing inbound                      | Persistence stays a leaf                                    |
| `infrastructure/` and `ports/` import no feature module        | Shared code cannot depend on a feature it might outlive     |
| A feature may import only another feature's `*-domain.ts`      | Cross-feature coupling is a contract, not an implementation |

## 3. Durable data model

```mermaid
erDiagram
    accounts ||--o{ journal_entries : "account_id + currency"
    ledger_transactions ||--|{ journal_entries : "transaction_id"
    ledger_transactions ||--o| transfers : "(id, currency, ledger_type='transfer')"
    accounts ||--o{ transfers : "source / destination + currency"
    outbox_events ||--o| consumer_inbox : "event_id"
    outbox_events ||--o| audit_effects : "event_id"

    accounts {
        uuid id PK
        text currency "immutable"
        text status "active|frozen|closed"
        bigint balance_minor "cache of the journal"
        bool is_treasury "immutable"
    }
    ledger_transactions {
        uuid id PK
        text type "funding|transfer"
        text currency
        text reference
        bool finalized "no entries after finalize"
    }
    journal_entries {
        uuid id PK
        uuid transaction_id FK
        uuid account_id FK
        text direction "debit|credit"
        bigint amount_minor "> 0"
    }
    transfers {
        uuid id PK "= ledger_transactions.id"
        uuid source_account_id FK
        uuid destination_account_id FK
        bigint amount_minor
        text status "completed"
    }
    idempotency_records {
        text key PK
        text operation PK
        text request_fingerprint "sha256 of canonical body"
        text status "in_progress|completed"
        int response_status_code
        jsonb response_body
    }
    outbox_events {
        uuid id PK
        uuid aggregate_id
        text event_type "transfer.created"
        int event_version
        jsonb payload
        text status "pending|processing|failed|processed"
        int attempts
        timestamptz next_attempt_at "also the claim lease"
    }
    consumer_inbox {
        text consumer_name PK
        uuid event_id PK
    }
    audit_effects {
        uuid id PK
        uuid event_id UK
        jsonb payload
    }
```

Enforcement that lives in PostgreSQL rather than TypeScript:

- **Composite currency foreign keys** — an entry, its transaction, and its account must agree on
  currency, so a mixed-currency posting cannot be inserted even by raw SQL.
- **Deferred constraint triggers** — at `COMMIT`, every transaction must be finalized and have
  `sum(debit) = sum(credit)`; an unbalanced posting aborts the whole transaction.
- **Append-only triggers** — `UPDATE`/`DELETE` on `ledger_transactions`, `journal_entries`,
  `consumer_inbox`, and `audit_effects` are rejected outright.
- **Balance check** — `balance_minor >= 0` for every non-treasury account.
- **Unique `(key, operation)`** — one idempotency key claims exactly one unit of work.
- **Primary key `(consumer_name, event_id)`** — one consumer applies an event at most once.
