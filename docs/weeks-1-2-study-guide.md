# PulseLedger — Weeks 1 & 2 Study Guide (Backend SDE Interview Prep)

A deep, honest walkthrough of everything built in **Week 1 (foundation + account API)** and
**Week 2 (double-entry journal)**, written so you can (a) explain the codebase from memory and
(b) map each decision to the systems concepts a FAANG backend interview probes.

> How to use this: read a section, then open the referenced file and re-derive the "why" out loud.
> The **Interview angle** callouts are the sentences to actually say in a loop.
>
> **Drill set:** a full question bank with detailed answers lives in
> [`weeks-1-2-interview-qa.md`](./weeks-1-2-interview-qa.md) — this guide is the narrative, that file
> is the practice set.

---

## 0. The 60-second elevator pitch

> "PulseLedger is a correctness-first payment ledger. Money is stored as **integer minor units**,
> never floats. Every movement of money is a **balanced double-entry transaction** — total debits
> equal total credits — recorded in an **append-only journal** that is the source of truth. The
> service is a **modular monolith** on Fastify + PostgreSQL, wired with **ports & adapters** so the
> business rules are testable in isolation. Correctness isn't trusted to application code alone:
> PostgreSQL **constraints and triggers** independently enforce positivity, immutability, single
> currency, and balance at commit time. Everything is proven with a **testing pyramid** — unit,
> property-based, and real-database integration tests via Testcontainers — gated in CI."

That paragraph hits: data modeling, money handling, ACID, defense-in-depth, clean architecture,
and test strategy. The rest of this guide is the evidence behind each clause.

---

## 1. What each week delivered

| Week  | Theme                    | Deliverable                                                                                                                                                                                                                                                                         |
| ----- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1** | Foundation & account API | Reproducible TS service: Fastify app, PG + migration runner, config validation, structured logging + request IDs, stable error contract, health checks, account create/lookup, treasury seeding, Docker/Testcontainers/CI.                                                          |
| **2** | Double-entry journal     | `Money` value object, `ledger_transactions` + `journal_entries` schema, balanced posting service, treasury→customer funding, append-only immutability, DB-enforced invariants (positive amounts, single currency, balance-at-commit), unit + property + integration tests, ADR-001. |

The four project invariants (only #1–#3 are in scope for weeks 1–2):

1. Every ledger transaction is **balanced** (Σdebits = Σcredits). ✅ Week 2
2. Journal entries are **immutable** after commit. ✅ Week 2
3. One idempotency key → one result. ⏭ Week 4
4. Each outbox event → at most one effect. ⏭ Weeks 5–6

---

## 2. Week 1 — Foundation & account API

### 2.1 App vs. server split (composition root pattern)

- `src/app.ts` — `buildApp()` constructs adapters and wires them to routes. It **does not** open a
  socket.
- `src/server.ts` — the process entrypoint: loads config, creates the pool, calls `buildApp`, starts
  the outbox worker, `app.listen()`, and installs SIGINT/SIGTERM graceful shutdown.

**Why it matters:** tests build the app and call `app.inject()` (in-memory HTTP) without binding a
port or racing on sockets. Startup concerns (ports, signals, pools) live at the edge; business wiring
is pure and reusable.

> **Interview angle:** "Separating the composition root from the process entrypoint is what makes the
> HTTP layer testable without a live server and keeps side-effecting startup out of business code."

### 2.2 Fail-fast config validation — `src/config.ts`

`loadConfig()` reads `process.env` and **throws at boot** on bad input: `DATABASE_URL` required,
`NODE_ENV` ∈ {development,test,production}, `LOG_LEVEL` in a fixed set, `PORT` an int in 1–65535,
and each `OUTBOX_*` a positive int. Defaults are explicit.

> **Interview angle:** "Config is validated once at startup, not lazily at first use, so a
> misconfigured deploy crashes immediately instead of failing a request an hour later." (fail-fast /
> crash-only design)

### 2.3 Error contract & request IDs — `src/errors.ts`, `src/app.ts:34`

- Every request gets an ID: `genReqId` reuses a client-supplied `x-request-id` (≤128 chars) or mints
  a UUID. Every error response includes `requestId` for traceability.
- `errorHandler` maps failures to a **stable machine-readable shape** `{ error: { code, message,
requestId } }`:
  - `AppError` (transport errors thrown in routes) → its own status.
  - Fastify schema failures → `VALIDATION_ERROR` (400).
  - Domain errors → looked up in a `code → status` table (`domainErrorStatus`).
  - Anything else → logged server-side, returned as `INTERNAL_ERROR` (500) with **no internal
    detail leaked**.

> **Interview angle:** "Domain code never knows about HTTP status codes — the mapping lives in one
> adapter table. That keeps the core framework-agnostic and gives clients a stable error taxonomy."

### 2.4 Schema-validated API — `src/modules/accounts/account-routes.ts`

Fastify JSON Schemas validate **input and serialize output**. Bodies use `additionalProperties:
false` (reject unknown fields), `currency` is an `enum`, `:id` must be `format: uuid`. `balanceMinor`
is a **string** in JSON (`pattern: ^-?[0-9]+$`) — see §4.1 for why money is never a JSON number.

Endpoints: `POST /v1/accounts` (create, 201), `GET /v1/accounts/:id` (404 → `ACCOUNT_NOT_FOUND`).

### 2.5 Accounts schema — `migrations/001_accounts.sql`

```sql
CREATE TABLE accounts (
  id uuid PRIMARY KEY,
  currency varchar(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status   varchar(16) NOT NULL DEFAULT 'active'
           CHECK (status IN ('active','frozen','closed')),
  balance_minor bigint NOT NULL DEFAULT 0,
  is_treasury   boolean NOT NULL DEFAULT false,
  ...
  CHECK (is_treasury OR balance_minor >= 0)   -- customers can't go negative; treasury can
);
```

Things to notice and be able to defend:

- **`CHECK (is_treasury OR balance_minor >= 0)`** — the no-overdraft rule for _customers_ lives in the
  schema, but the treasury is allowed to go negative so a closed demo system **conserves total value**
  while funding zero-balance customers.
- **Partial unique index** `... (currency) WHERE is_treasury` — exactly one treasury per currency,
  enforced by the database, not by app convention.
- **Immutability trigger** `reject_account_identity_change` — an `UPDATE` that changes `id`,
  `currency`, or `is_treasury` raises. Identity and currency are permanent.
- **Idempotent seed** — treasuries are inserted with fixed UUIDs and `ON CONFLICT DO NOTHING`, so the
  migration is safe to re-run.

> **Interview angle:** "A partial unique index is the cleanest way to say 'at most one X per group'
> without a separate table or app-level locking."

### 2.6 Migration runner — `src/infrastructure/database/migrate.ts`

A tiny, dependency-free runner: create a `schema_migrations` ledger table, read `NNN_name.sql` files
sorted, skip already-applied ones, and apply each remaining file **inside its own transaction**
(`BEGIN`/`COMMIT`, `ROLLBACK` on error) recording its name. So migrations are **apply-once,
ordered, and atomic** — a half-applied migration can't be recorded as done.

### 2.7 Connection pool, health, container story

- `src/infrastructure/database/pool.ts` — `pg.Pool` with `max: 10`, connect timeout 5s, idle 30s.
- `src/modules/health/health-routes.ts` — `/health/live` (process up, **no DB query**) vs
  `/health/ready` (runs `SELECT 1`, 503 if the DB is unreachable). This is the classic
  **liveness vs. readiness** split: liveness answers "should you restart me?", readiness answers
  "should you send me traffic?".
- `compose.yaml` — Postgres 17 with a `pg_isready` healthcheck and a **named volume** for
  persistence.
- `Dockerfile` — **multi-stage** build (compile in one stage, ship only `dist` + prod deps in a
  slim runtime stage) running as the non-root `node` user.

### 2.8 Hexagonal architecture (ports & adapters)

Every feature is a vertical slice with four roles:

```
*-routes.ts      (inbound HTTP adapter — validates transport, owns status codes)
      │ calls
*-domain.ts      (ports + domain types/errors — no Fastify, no pg, no HTTP)
      ▲ implements
*-service.ts     (application logic — orchestration, uses injected ports)
      │ depends on
*-repository.ts  (outbound persistence adapter — explicit SQL)
```

`AccountService` is deliberately thin today (`src/modules/accounts/account-service.ts`), but the
_seams_ are what matter: routes depend on the `AccountApplication` interface, not the concrete
service; the service depends on the `AccountStore` port, not on `pg`. A `scripts/check-architecture.ts`
gate (run in CI) rejects illegal imports (e.g. domain importing Fastify, routes importing a repo).

> **Interview angle:** "Dependencies point inward toward the domain. The HTTP framework and Postgres
> are replaceable details behind ports, which is exactly what lets me unit-test business rules with
> in-memory fakes and integration-test the SQL separately."

### 2.9 Testing & CI

- **Vitest** for unit/property, **Testcontainers** to spin a real Postgres per integration run (no
  mocks of SQL behavior — the constraints and triggers are actually exercised).
- `.github/workflows/ci.yml` runs, against a service Postgres: `architecture:check → format:check →
lint → typecheck → db:migrate → test → build`. A clean clone must pass all of it.

---

## 3. Week 2 — The double-entry journal

### 3.1 `Money` value object — `src/modules/ledger/ledger-domain.ts:25`

```ts
export class Money {
  private constructor(public readonly minor: bigint) {}
  public static fromMinor(value: unknown): Money {
    // must be a positive-integer string like "500" (no leading zero, no sign, no decimal) or a bigint
    // range: 1 .. 9_223_372_036_854_775_807  (bigint, i.e. PG bigint max)
  }
}
```

Key properties:

- **Integer minor units** (paise/cents), stored/compared as **`bigint`** — never JavaScript
  `number`. This dodges IEEE-754 float error _and_ `Number.MAX_SAFE_INTEGER` (2⁵³) truncation.
- Constructed only through validation; immutable (`private constructor`, `readonly`).
- The API accepts/returns money as **decimal strings**, converted to `bigint` at the boundary.

> **Interview angle:** "Representing money as a float is the canonical correctness bug. I use integer
> minor units in `bigint` end-to-end and only stringify at the JSON edge, so no rounding or
> safe-integer loss can ever touch a stored balance." (See ADR-001.)

### 3.2 Ledger schema — `migrations/002_double_entry_ledger.sql`

Two tables model the accounting core:

- `ledger_transactions` — one row per business posting: `type`, unique `reference`, `currency`, and a
  `finalized` flag. Has a composite `UNIQUE (id, currency)`.
- `journal_entries` — the debit/credit lines: `direction ∈ {debit,credit}`, `amount_minor > 0`, plus
  **two composite foreign keys**:
  - `(transaction_id, currency) → ledger_transactions(id, currency)`
  - `(account_id, currency)     → accounts(id, currency)`

**Why the composite FKs are clever:** because the entry's `currency` must match _both_ its transaction
and its account, it is **structurally impossible** to attach a USD entry to an INR account or an INR
transaction. Single-currency integrity is enforced by referential integrity, not by a runtime check.

Indexes: `(transaction_id)` for fetching a transaction's lines, and `(account_id, created_at, id)` —
purpose-built for **cursor pagination** of an account's statement.

### 3.3 The four correctness guarantees, enforced in the database

This is the heart of Week 2 and the richest interview material. All four are in
`002_double_entry_ledger.sql`.

| Guarantee                    | Mechanism                                                            | How                                                                                                             |
| ---------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Amounts are positive         | `CHECK (amount_minor > 0)`                                           | column constraint                                                                                               |
| Journal is append-only       | `reject_ledger_mutation` trigger                                     | any `UPDATE`/`DELETE` on `journal_entries` raises (`ERRCODE 55000`)                                             |
| Transactions are append-only | `reject_ledger_transaction_mutation`                                 | allows **only** the one `finalized: false → true` flip with all other columns unchanged; everything else raises |
| No appending to a closed txn | `reject_entry_for_finalized_transaction`                             | inserting an entry whose transaction is already `finalized` raises                                              |
| **Balance holds at commit**  | **deferred constraint trigger** `assert_ledger_transaction_balanced` | see below                                                                                                       |

The balance check is the subtle one:

```sql
CREATE CONSTRAINT TRIGGER journal_entry_transaction_must_balance
AFTER INSERT ON journal_entries
DEFERRABLE INITIALLY DEFERRED           -- runs at COMMIT, not per-row
FOR EACH ROW EXECUTE FUNCTION assert_ledger_transaction_balanced();
```

It fires at **commit**, and requires: the transaction is finalized, there is ≥1 debit **and** ≥1
credit, and `Σdebit = Σcredit` (`ERRCODE 23514`, check_violation). **Deferred** is essential: a
transaction is built from multiple `INSERT`s that are transiently unbalanced; a per-statement check
would reject valid work mid-build. Deferring to commit lets the whole unit be validated atomically.

> **Interview angle:** "The balanced-books invariant can't be expressed as a single-row `CHECK`
> because it spans rows. A `DEFERRABLE INITIALLY DEFERRED` constraint trigger is the right tool: it
> evaluates the multi-row invariant exactly once, at commit, so partial in-progress state is fine but
> an unbalanced transaction can never commit."

### 3.4 The posting function — `post_ledger_transaction(...)`

Instead of the app issuing five round-trips, one PL/pgSQL function does the whole posting **as a
single statement / single transaction** when called from the API. In order it:

1. validates array shape (≥2 entries, equal-length parallel arrays);
2. validates every amount `> 0` and every direction valid;
3. **locks the involved accounts `FOR UPDATE` in `ORDER BY id`** — deterministic lock order to
   prevent deadlocks between concurrent postings;
4. resolves the posting currency and checks all accounts exist and are `active`;
5. rejects **mixed currency** (`count(distinct currency) <> 1`) and **unbalanced** (`Σdebit <>
Σcredit`);
6. inserts the transaction + all journal entries;
7. applies **signed cached-balance deltas** (`debit → +amount`, `credit → −amount`) grouped per
   account;
8. flips `finalized → true`, which arms the deferred balance trigger to verify at commit.

Note the asset-account sign convention: **a debit increases an account's balance, a credit decreases
it.** (That's the opposite of a bank's external statement wording, and worth stating explicitly.)

> **Interview angle:** "Deterministic lock ordering (`ORDER BY id FOR UPDATE`) is the standard fix for
> the dining-philosophers / lock-cycle deadlock: if every transaction grabs rows in the same global
> order, no two can hold-and-wait on each other."

### 3.5 Funding flow — `src/modules/ledger/ledger-service.ts`

`fundAccount` is the first real use of the posting engine and the demo money source:

1. `Money.fromMinor(amountMinor)` — validate.
2. Find the target account; reject if missing **or is a treasury**, reject if not `active`.
3. Find the treasury for that currency.
4. Post two entries: **debit the customer** (balance up) and **credit the treasury** (balance down),
   same amount, same currency.

So funding never edits a balance directly — it's a journaled transfer from treasury to customer, and
total system value is conserved (treasury simply goes more negative).

### 3.6 Defense in depth — the same rule, twice

`validatePosting()` (`ledger-domain.ts:97`) re-checks ≥2 entries, single currency, and balance **in
TypeScript** before the SQL ever runs — and the database checks them **again**. This is intentional
redundancy:

- App-level checks give **fast, friendly, typed errors** (`LedgerError` → HTTP code via `errors.ts`).
- DB-level checks are the **last line of defense**: even a raw `psql` session, a bug, or a future code
  path physically cannot commit invalid financial state.

> **Interview angle:** "Application validation is a UX optimization; the database constraint is the
> actual guarantee. If an invariant matters for correctness, it belongs in the schema — app code is
> the friendly front door, not the lock."

---

## 4. Concepts to master (and the crisp answer for each)

### 4.1 Why never floats for money?

IEEE-754 binary floating point can't represent most decimal fractions exactly (`0.1 + 0.2 ≠ 0.3`),
and JS `number` loses integer precision past 2⁵³. Store **integer minor units in `bigint`**; format
as a decimal string only at the API boundary.

### 4.2 What is double-entry, in one breath?

Every transaction has equal-and-opposite debits and credits, so the books always balance and every
change is traceable to a paired cause. It converts "did we lose money?" into a checkable invariant
(`Σdebit = Σcredit`) instead of trust.

### 4.3 Why an immutable/append-only journal?

The journal is the **auditable source of truth**. You never edit or delete history; you post a
**reversing entry**. Cached `balance_minor` is a read optimization that can always be recomputed from
entries (reconciliation, later weeks).

### 4.4 ACID & isolation (what the DB is buying you)

Atomicity (all-or-nothing postings), Consistency (constraints/triggers hold invariants), Isolation
(concurrent postings don't corrupt each other — deepened to `SERIALIZABLE` for transfers in Week 3),
Durability (committed = survives crash). Be ready to name the anomalies: dirty read, non-repeatable
read, phantom, write skew.

### 4.5 Constraints vs. triggers vs. app code

`CHECK`/`UNIQUE`/`FK` for single-row and referential rules; **constraint triggers (deferred)** for
multi-row invariants evaluated at commit (the balance check); plain triggers for immutability; app
code for orchestration and friendly errors. Push the invariant as far down the stack as it will go.

### 4.6 Liveness vs. readiness

Liveness = "restart me if this fails" (no dependencies). Readiness = "route traffic only if my
dependencies are healthy" (checks the DB). Conflating them causes restart storms or black-holed
traffic.

### 4.7 Ports & adapters / dependency inversion

Business logic depends on **interfaces it owns**; frameworks and drivers are adapters plugged in at
the composition root. Enables isolated unit tests and swappable infrastructure.

### 4.8 Testing pyramid here

Unit (Money, `validatePosting`) → property-based with **fast-check** (generate random balanced &
invalid postings, assert invariants) → integration on **real Postgres** (constraints/triggers/SQL) →
(later) concurrency & recovery. CI runs the lot on a clean checkout.

---

## 5. Likely interview questions (mapped to this code)

> This is the short list. The full bank — ~55 questions with detailed answers and follow-ups, tagged
> 🟢/🟡/🔴 — is in [`weeks-1-2-interview-qa.md`](./weeks-1-2-interview-qa.md).

1. **"Design a ledger / wallet / payments table."** → §2.5 + §3.2: accounts with cached balance +
   no-overdraft check; immutable `ledger_transactions` + `journal_entries` with composite-currency
   FKs; balance enforced by a deferred constraint trigger.
2. **"How do you store money?"** → §4.1: integer minor units in `bigint`, decimal strings at the edge,
   `Money` value object. ADR-001 has the alternatives (float, `numeric`) and why they were rejected.
3. **"Two transfers hit the same accounts at once — deadlock?"** → §3.4: lock rows `FOR UPDATE` in a
   deterministic global order (`ORDER BY id`). (Week 3 adds `SERIALIZABLE` + bounded retries.)
4. **"How do you guarantee the books balance?"** → §3.3: `DEFERRABLE INITIALLY DEFERRED` constraint
   trigger checks `Σdebit = Σcredit` once at commit; per-statement checks would reject valid in-flight
   state.
5. **"Where does validation live — app or DB?"** → §3.6: both, deliberately. App = fast typed errors;
   DB = the real guarantee no code path can bypass.
6. **"How do migrations stay safe?"** → §2.6: tracked in `schema_migrations`, ordered, applied once,
   each in its own transaction; seeds are `ON CONFLICT DO NOTHING`.
7. **"Liveness vs. readiness?"** → §2.7.
8. **"How is this testable without mocking the database?"** → §2.9 + §4.8: Testcontainers runs real
   Postgres so triggers/constraints are actually exercised.

---

## 6. File map (where to look)

| Concern                                        | File                                                        |
| ---------------------------------------------- | ----------------------------------------------------------- |
| Composition root / process entrypoint          | `src/app.ts`, `src/server.ts`                               |
| Config validation                              | `src/config.ts`                                             |
| Error contract & request IDs                   | `src/errors.ts`                                             |
| DB pool / migration runner                     | `src/infrastructure/database/{pool,migrate,migrate-cli}.ts` |
| Accounts (domain/service/repo/routes)          | `src/modules/accounts/*`                                    |
| Health checks                                  | `src/modules/health/health-routes.ts`                       |
| Accounts schema + treasury seed + immutability | `migrations/001_accounts.sql`                               |
| `Money` + posting validation + ports           | `src/modules/ledger/ledger-domain.ts`                       |
| Funding orchestration                          | `src/modules/ledger/ledger-service.ts`                      |
| Ledger schema, triggers, posting function      | `migrations/002_double_entry_ledger.sql`                    |
| Architecture contract & rules                  | `docs/ARCHITECTURE.md`                                      |
| ADR: money + double-entry decisions            | `docs/adr/001-double-entry-integer-accounting.md`           |
| Delivery plan & progress tracker               | `PROJECT_PLAN.md`                                           |

---

## 7. One-line takeaways to memorize

- **Money:** integer minor units, `bigint`, decimal strings only at the JSON edge.
- **Double-entry:** Σdebit = Σcredit, always; corrections are reversing entries, never edits.
- **Immutability:** the journal is append-only and authoritative; cached balances are recomputable.
- **Enforcement:** invariant → schema constraint/trigger first; app validation is the friendly front
  door.
- **Concurrency:** deterministic lock order to avoid deadlocks (serializable transfers come in Week 3).
- **Architecture:** ports & adapters; dependencies point inward; composition root at the edge.
- **Proof:** unit + property + real-Postgres integration tests, gated in CI from a clean clone.
