# Transaction-flow diagrams

How money actually moves, including every place the system can fail. Companion to
[architecture.md](./architecture.md); the narrative version lives in
[ARCHITECTURE.md § Runtime flows](../ARCHITECTURE.md#runtime-flows).

## 1. Idempotent transfer, happy path

The important line in this diagram is the transaction boundary: the journal entries, both cached
balances, the transfer projection, the outbox event, and the completed idempotency response are
**one commit**. Nothing outside PostgreSQL happens during the request.

```mermaid
sequenceDiagram
    autonumber
    participant C as Client
    participant R as transfer-routes.ts
    participant I as IdempotencyService
    participant T as TransferService
    participant PG as PostgreSQL

    C->>R: POST /v1/transfers<br/>Idempotency-Key: k1
    R->>I: claimOrReplay(k1, "transfer", body)
    I->>PG: INSERT idempotency_records (k1,'transfer',sha256(body),'in_progress')<br/>ON CONFLICT (key,operation) DO NOTHING
    PG-->>I: inserted → first use
    I-->>R: null (proceed)

    R->>T: create(input, {idempotencyKey: k1})
    Note over T: validate amount (positive integer minor units)<br/>reject self-transfer · mint transferId + reference

    rect rgb(238, 240, 255)
        Note over T,PG: attempt 1..12 — one SERIALIZABLE transaction each
        T->>PG: BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE
        T->>PG: SELECT ... FROM accounts WHERE id = ANY($1)<br/>ORDER BY id FOR UPDATE
        Note over T: validate: both exist · non-treasury · active<br/>same currency · source balance >= amount
        T->>PG: SELECT post_ledger_transaction(id,'transfer',...)<br/>credit source · debit destination · update both balances · finalize
        T->>PG: INSERT INTO transfers (...)
        T->>PG: INSERT INTO outbox_events ('transfer.created', v1)
        T->>PG: UPDATE idempotency_records SET status='completed', response_body=...
        T->>PG: COMMIT
        Note right of PG: deferred triggers fire here:<br/>debits = credits, transaction finalized,<br/>balance_minor >= 0
    end

    T-->>R: Transfer
    R-->>C: 201 Created + transfer body
```

Direction convention (ADR-001, asset accounts): a **debit increases** a balance and a **credit
decreases** it. A transfer therefore credits the source and debits the destination by the same
positive amount.

## 2. Every branch the same endpoint can take

```mermaid
flowchart TD
    start["POST /v1/transfers"] --> haskey{"Idempotency-Key<br/>present?"}
    haskey -->|no| exec
    haskey -->|yes| claim["INSERT ... ON CONFLICT DO NOTHING"]

    claim -->|inserted| exec["run transfer attempt loop"]
    claim -->|"conflict, record completed,<br/>same fingerprint"| replay["replay stored status + body<br/><b>201</b> (no new transfer)"]
    claim -->|"conflict, different fingerprint"| conflict["<b>409</b> IDEMPOTENCY_CONFLICT"]
    claim -->|"conflict, in_progress,<br/>younger than 30s"| inprog["<b>409</b> IDEMPOTENCY_IN_PROGRESS"]
    claim -->|"conflict, in_progress,<br/>older than 30s"| reclaim["reclaim the stale record"] --> exec

    exec --> validate{"validation<br/>inside the lock"}
    validate -->|"unknown / treasury account"| e404["<b>404</b> ACCOUNT_NOT_FOUND"]
    validate -->|"frozen or closed"| e409a["<b>409</b> ACCOUNT_NOT_ACTIVE"]
    validate -->|"currencies differ"| e400a["<b>400</b> CURRENCY_MISMATCH"]
    validate -->|"balance < amount"| e409b["<b>409</b> INSUFFICIENT_FUNDS<br/><i>rolled back: nothing posted</i>"]
    validate -->|"source == destination"| e400b["<b>400</b> SELF_TRANSFER"]
    validate -->|ok| commit["COMMIT"]

    commit -->|success| ok["<b>201</b> Created"]
    commit -->|"SQLSTATE 40001 / 40P01"| retry{"attempts < 12?"}
    retry -->|yes| backoff["sleep 2ms · x2 · cap 50ms<br/>50-100% jitter"] --> exec
    retry -->|no| e503["<b>503</b> TRANSFER_RETRY_EXHAUSTED<br/><i>bounded by design (ADR-002)</i>"]
```

Only `40001` (serialization failure) and `40P01` (deadlock) are retried. Business errors are
returned immediately — retrying "insufficient funds" would just burn the budget. The same
`transferId` and `reference` are reused across attempts, so a retry can never double-post.

## 3. Outbox event lifecycle

The worker's claim query and its crash-recovery mechanism are the same query: claiming pushes
`next_attempt_at` into the future, which doubles as a lease.

```mermaid
stateDiagram-v2
    [*] --> pending: INSERT inside the<br/>transfer transaction
    pending --> processing: claimBatch()<br/>FOR UPDATE SKIP LOCKED<br/>lease = now() + 300s
    processing --> processed: handler resolved<br/>markProcessed()
    processing --> failed: handler threw<br/>markFailed(err, next_attempt_at)
    processing --> processing: worker crashed mid-flight<br/><i>lease elapsed → reclaimed</i>
    failed --> processing: backoff elapsed<br/>(100ms · x2 · cap 60s · jitter)
    failed --> parked: attempts >= 12<br/>next_attempt_at = infinity
    processed --> [*]
    parked --> [*]: operator intervention

    note right of processing
        The reclaim edge is why delivery
        is AT LEAST ONCE.
    end note
```

`/health/ready` exposes `pending` / `processing` / `failed` counts so a stuck backlog is visible
without a database session.

## 4. At-least-once delivery, at-most-once effect

The worker never tries to avoid redelivery. The consumer makes redelivery harmless — the
unique-constraint claim is the dedup boundary, and it commits in the same transaction as the effect
it guards.

```mermaid
sequenceDiagram
    autonumber
    participant W as OutboxWorker
    participant A as AuditConsumerService
    participant PG as PostgreSQL

    W->>PG: claimBatch(10) — SKIP LOCKED, lease 300s
    PG-->>W: [event e1, ...]
    W->>A: handle(e1)

    A->>PG: BEGIN
    A->>PG: INSERT INTO consumer_inbox (consumer_name, e1)<br/>ON CONFLICT DO NOTHING RETURNING event_id

    alt first delivery (row returned)
        A->>PG: INSERT INTO audit_effects (event_id=e1, payload)
        A->>PG: COMMIT
        A-->>W: { duplicate: false }
        Note over PG: inbox claim + audit effect commit together
    else redelivery (rowCount = 0)
        A->>PG: ROLLBACK
        A-->>W: { duplicate: true } — successful no-op
        Note over A,W: no error, no retry, no second effect
    end

    W->>PG: markProcessed(e1)
```

Proven at scale by `tests/integration/audit-consumer.integration.test.ts`: **1,000 duplicate
deliveries of one event produce exactly one `audit_effects` row**, and two concurrent consumers
racing the same event still produce one.

## 5. Reconciliation

Independent of every write path above: it re-derives balances from the immutable journal and
compares. It is deliberately read-only — it reports drift and never repairs it, so a human decides
whether to post a reversing entry (ADR-001, ADR-004).

```mermaid
flowchart LR
    j[("journal_entries")] -->|"sum(debit) - sum(credit)<br/>GROUP BY account_id"| computed["computed balance"]
    a[("accounts.balance_minor")] --> cached["cached balance"]
    computed --> cmp{"equal?"}
    cached --> cmp
    cmp -->|yes| ok["ok: true"]
    cmp -->|"differ"| mism["issue: mismatched"]
    cmp -->|"cached ≠ 0, no entries"| miss["issue: missing"]
    cmp -->|"entries, no account row"| unexp["issue: unexpected"]

    ok --> out["POST /v1/admin/reconcile → 200<br/>npm run reconcile → exit 0"]
    mism --> bad["report lists every issue<br/>npm run reconcile → exit 1"]
    miss --> bad
    unexp --> bad
```
