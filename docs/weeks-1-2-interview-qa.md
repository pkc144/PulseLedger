# PulseLedger — Weeks 1 & 2 Interview Q&A (Deep-Dive Prep)

A question bank for the foundation (Week 1) and double-entry journal (Week 2). Every answer is
grounded in this repo; file references let you verify and go deeper. Pairs with
[`weeks-1-2-study-guide.md`](./weeks-1-2-study-guide.md) (the narrative) — this file is the drill set.

**How to practice:** cover the answer, say yours out loud, then compare. Chase the **Follow-up** probes
— that's where interviewers separate "read a blog" from "actually built it".

Legend: 🟢 warm-up · 🟡 core · 🔴 deep/senior.

---

## A. Money & numeric representation

### A1 🟢 How do you store money, and why?

**Answer.** As a **strictly positive integer count of minor units** (paise, cents) in a **`bigint`** —
never a float. In this codebase: PostgreSQL `bigint` columns (`balance_minor`, `amount_minor`),
JavaScript `bigint` in the domain (`Money.minor`), and **decimal strings** on the JSON boundary. The
`Money` value object (`src/modules/ledger/ledger-domain.ts:25`) is the only constructor and it
validates range `1 .. 9_223_372_036_854_775_807` (PG `bigint` max, 2⁶³−1).

**Why not floats?** IEEE-754 binary floating point cannot represent most decimal fractions exactly
(`0.1 + 0.2 === 0.30000000000000004`). Repeated arithmetic accumulates error, and money demands exact
sums. Integers make `Σdebit = Σcredit` an exact comparison.

**Follow-up: why `bigint` and not `number`?** JS `number` is a 64-bit float; integers above
`Number.MAX_SAFE_INTEGER` (2⁵³−1 ≈ 9.0×10¹⁵) silently lose precision. A large balance in paise can
exceed that. `bigint` is arbitrary precision, so no truncation.

### A2 🟡 Why decimal strings in JSON instead of a number field?

**Answer.** JSON has one numeric type that many parsers deserialize into a float, re-introducing the
exact bug we avoided in storage. Serializing money as a string (`balanceMinor: "500"`, response schema
pattern `^-?[0-9]+$` in `account-routes.ts:18`) makes the client parse it deliberately (e.g. into its
own big-integer/decimal type) and guarantees the value survives the wire byte-for-byte.

### A3 🟡 Walk me through `Money.fromMinor`'s validation.

**Answer.** It accepts a `string` or `bigint`. A string must match `^[1-9][0-9]*$` — positive, no sign,
**no leading zero**, no decimal point, no exponent. It converts to `bigint` and rejects anything
`<= 0` or `> 2⁶³−1`. Invalid input throws a typed `LedgerError('INVALID_AMOUNT', ...)`. The
constructor is `private`, so a `Money` cannot exist without passing validation — an _always-valid_
value object.

**Follow-up: why reject leading zeros / a `"0"` amount?** Canonical form avoids ambiguity (`"007"`),
and zero-value postings are meaningless money movements, so they're rejected up front.

### A4 🔴 Where does the "no negative balance" rule for customers actually live?

**Answer.** In the **database**, as `CHECK (is_treasury OR balance_minor >= 0)`
(`migrations/001_accounts.sql:9`). Customers can never go negative; the treasury is exempt so a closed
demo system conserves total value while funding zero-balance customers (it simply goes more negative).
App code also checks funds, but the constraint is the guarantee that survives any bug or raw SQL.

---

## B. Double-entry accounting

### B1 🟢 Explain double-entry bookkeeping in two sentences.

**Answer.** Every transaction records equal-and-opposite **debits and credits** across accounts, so
total debits always equal total credits. That turns "are the books right?" into a checkable invariant
(`Σdebit = Σcredit`) and makes every balance change traceable to a paired cause.

### B2 🟡 What's a debit vs. a credit here — which way does a balance move?

**Answer.** This uses the **asset-account convention**: a **debit increases** an account's
`balance_minor`, a **credit decreases** it (`ADR-001`, and the delta logic in
`post_ledger_transaction`, `002_...sql:254`). Note this is the opposite of the wording on your personal
bank statement (the bank credits _you_ because you're a liability on _their_ books). Always state your
convention explicitly in an interview.

### B3 🟡 Show funding as a double-entry posting.

**Answer.** `fundAccount` (`ledger-service.ts:22`) posts two entries of equal amount and currency:
**debit the customer** (balance up) and **credit the treasury** (balance down). No balance is edited
directly — funding is a journaled treasury→customer transfer, so system-wide value is conserved.

### B4 🔴 Why immutable/append-only? How do you fix a mistake?

**Answer.** The journal is the **auditable source of truth**; editing history destroys the audit trail
and breaks reproducibility. You never update or delete a posted entry — you post a **reversing entry**
(new transaction with opposite directions). `accounts.balance_minor` is a _cached_ projection that can
always be recomputed from the entries (that reconciliation lands in a later week). Immutability is
enforced by triggers (see D2/D3), not convention.

### B5 🔴 How do you _know_ the whole system is consistent, not just one transaction?

**Answer.** Two layers. Per transaction: the deferred balance trigger guarantees each committed
transaction is internally balanced. System-wide: because every posting is balanced and balances are
only ever changed _through_ postings, the sum of all balances is invariant — a closed test system
conserves total value. That "conservation" property is exactly what property/reconciliation tests
assert.

---

## C. Schema design & data modeling

### C1 🟢 Walk me through the core tables.

**Answer.** `accounts` (identity, currency, status, cached `balance_minor`, `is_treasury`);
`ledger_transactions` (one row per business posting: `type`, unique `reference`, `currency`,
`finalized`); `journal_entries` (the debit/credit lines: `direction`, `amount_minor`, links to a
transaction and an account). `ledger_transactions` + `journal_entries` is the authoritative record;
`accounts.balance_minor` is a derived cache.

### C2 🔴 There are composite foreign keys `(account_id, currency)` and `(transaction_id, currency)`. Why not just `account_id`?

**Answer.** To make **single-currency integrity structural**. `accounts` has `UNIQUE (id, currency)`
and `ledger_transactions` has `UNIQUE (id, currency)`, so an entry's `(account_id, currency)` and
`(transaction_id, currency)` FKs can only resolve if the entry's currency **matches both** its account
and its transaction. It becomes physically impossible to attach a USD line to an INR account or an INR
transaction — enforced by referential integrity rather than a runtime check.

**Follow-up: `ON DELETE RESTRICT`?** History is immutable; you must not be able to delete an account or
transaction out from under its entries.

### C3 🟡 Why cache `balance_minor` if the journal is authoritative? Isn't that denormalization?

**Answer.** Yes, deliberately. Summing an account's entries on every read is O(history) and gets slow.
The cached balance is an O(1) read, updated **inside the same transaction** as the entries so it can't
drift within a committed unit. It's reconcilable from the journal, so it's a safe optimization, not a
second source of truth.

### C4 🟡 Why is `reference` `UNIQUE` on `ledger_transactions`?

**Answer.** It's a natural idempotency/dedup key for a posting (e.g. `funding:<uuid>`). Uniqueness lets
the same logical operation be safely keyed and prevents accidental double-posting of the same
reference. It foreshadows the Week 4 idempotency work.

### C5 🔴 Explain the index `(account_id, created_at, id)`.

**Answer.** It's built for **cursor pagination** of an account statement: filter by `account_id`, order
by `created_at`, and use `id` as a tiebreaker so the sort is total and a `(created_at, id)` cursor is
stable even when timestamps collide. Cursor pagination beats `OFFSET` because it stays O(page) as you
scroll deep and doesn't skip/duplicate rows when new entries arrive.

### C6 🟡 Why UUID primary keys instead of auto-increment integers?

**Answer.** UUIDs are generatable **client/app-side before insert** (needed to build a multi-entry
posting and reference it), don't leak volume/ordering, and avoid a central sequence bottleneck /
collisions when merging data. Trade-off: they're wider and randomly ordered (index locality is worse
than serial) — acceptable here, and a deterministic UUID ordering is even reused as the lock order.

---

## D. Constraints, triggers & immutability

### D1 🟢 What invariants are enforced in the schema vs. the app?

**Answer.** Schema: positive amounts (`CHECK amount_minor > 0`), valid `direction`/`status`/`currency`
(CHECKs), one-treasury-per-currency (partial unique index), single currency (composite FKs), no
customer overdraft (`CHECK`), immutability (triggers), and **balance at commit** (deferred constraint
trigger). App: the same balance/currency/positivity checks again for fast typed errors, plus
orchestration. Rule of thumb: **correctness invariants go in the schema; app validation is the friendly
front door.**

### D2 🟡 How is the journal made append-only?

**Answer.** A `BEFORE UPDATE OR DELETE` trigger on `journal_entries` (`reject_ledger_mutation`) raises
on any mutation (`ERRCODE 55000`). `ledger_transactions` has a stricter trigger
(`reject_ledger_transaction_mutation`) that permits **exactly one** state change — `finalized` flipping
`false → true` with every other column unchanged — and rejects everything else. So the only legal
mutation in the whole ledger is finalizing a transaction once.

### D3 🔴 The balance check is a `DEFERRABLE INITIALLY DEFERRED` constraint trigger. Why deferred?

**Answer.** Balance is a **multi-row** invariant — it can only be true once _all_ the entries of a
transaction are inserted. A transaction is built from several `INSERT`s and is transiently unbalanced
mid-build. A normal per-statement check would reject valid work in progress. `DEFERRABLE INITIALLY
DEFERRED` moves evaluation to **`COMMIT`**, so partial state is allowed but an unbalanced transaction
can never commit. The function (`assert_ledger_transaction_balanced`) requires the transaction is
finalized, has ≥1 debit **and** ≥1 credit, and `Σdebit = Σcredit`, else raises `23514`.

**Follow-up: why check finalized inside it?** Finalization is the signal that the transaction is
"complete"; an unfinalized transaction at commit is a bug, so it's rejected too.

### D4 🟡 What stops someone appending an entry to an already-posted transaction?

**Answer.** `reject_entry_for_finalized_transaction`, a `BEFORE INSERT` trigger on `journal_entries`:
if the target transaction is already `finalized`, the insert raises. Combined with the append-only
triggers, a finalized transaction is sealed.

### D5 🔴 Why enforce things in the DB when the app already validates?

**Answer.** **Defense in depth.** App validation is a UX/performance optimization — fast, typed,
friendly errors. But app code can be bypassed by a bug, a new code path, a migration, or a direct
`psql` session. For financial correctness the invariant must hold no matter who writes; only a database
constraint gives that. The redundancy is intentional.

### D6 🟡 Which error codes do these raise and why care?

**Answer.** `55000` (raise_exception / object-not-in-prerequisite-state) for immutability, `23514`
(check_violation) for unbalanced/mixed-currency, `23503` (foreign_key_violation) for a missing account,
`22023` (invalid_parameter_value) for malformed posting arrays. Stable SQLSTATEs let the app map DB
failures to domain errors deterministically instead of string-matching messages.

---

## E. Transactions, isolation, concurrency & locking

### E1 🟢 Why does posting run inside one transaction / one function?

**Answer.** **Atomicity.** Inserting the transaction, inserting entries, updating both cached balances,
and finalizing must all commit or all roll back — a partial posting would corrupt the ledger.
`post_ledger_transaction` (`002_...sql:151`) does the whole unit as a single statement, which the API
executes as one transaction, and the deferred balance trigger validates it at commit.

### E2 🔴 Two postings touch the same accounts concurrently. How do you avoid deadlock?

**Answer.** **Deterministic global lock order.** The function locks the involved account rows with
`SELECT ... ORDER BY a.id FOR UPDATE` (`002_...sql:190`). If every transaction acquires locks in the
same order (ascending UUID), no two can hold-and-wait in a cycle — the standard resolution of the
dining-philosophers / lock-cycle deadlock. Without a fixed order, A locks acct1 then acct2 while B
locks acct2 then acct1 → deadlock.

### E3 🟡 What does `FOR UPDATE` actually do?

**Answer.** It takes a **row-level exclusive lock** on the selected rows for the duration of the
transaction, so a concurrent transaction that also wants to lock or update those rows blocks until this
one commits/rolls back. It serializes access to the specific accounts involved without locking the
whole table.

### E4 🔴 Name the concurrency anomalies and which one bites a ledger hardest.

**Answer.** Dirty read, non-repeatable read, phantom, and (the tricky one) **write skew** / lost
update. For a ledger the danger is two transfers each reading a stale sufficient balance and both
committing, overspending the account. Row locks + reading the balance under lock mitigate it here;
Week 3 escalates transfers to **`SERIALIZABLE`** isolation with bounded retries to make the whole check
atomic under contention.

### E5 🟡 What isolation level are we at in Week 2, and is that enough?

**Answer.** Default PostgreSQL isolation is **Read Committed**. For the single-writer funding path,
row-level `FOR UPDATE` locking is sufficient because we lock the accounts before reading and mutating
them. Multi-party concurrent _transfers_ (Week 3) need stronger guarantees, which is why they move to
`SERIALIZABLE` — Read Committed can't prevent all write-skew across two accounts.

### E6 🔴 Why compute balance deltas as a single grouped `UPDATE`?

**Answer.** `post_ledger_transaction` builds signed deltas (`debit → +amount`, `credit → −amount`),
groups by account, and applies one `UPDATE ... FROM (grouped deltas)` (`002_...sql:248`). Set-based SQL
is atomic and avoids N round-trips and per-row race windows; an account appearing in multiple entries
is netted correctly in one write.

---

## F. Migrations & schema evolution

### F1 🟢 How does the migration runner work?

**Answer.** `src/infrastructure/database/migrate.ts`: create a `schema_migrations` tracking table, read
`NNN_name.sql` files sorted lexically, skip any already recorded, and apply each remaining file **inside
its own `BEGIN/COMMIT`** (`ROLLBACK` on failure) while recording its name. Result: migrations are
**ordered, applied exactly once, and atomic** — a failed migration is never marked as applied.

### F2 🟡 What makes a migration "safe to re-run"?

**Answer.** Two levels: the runner won't re-apply a recorded file; and the SQL itself is written
defensively (e.g. seeds use `ON CONFLICT DO NOTHING`, later migrations use `ADD COLUMN IF NOT EXISTS` /
`DROP INDEX IF EXISTS`). So even re-pointing at a fresh DB or replaying is idempotent.

### F3 🔴 Why version SQL files instead of an ORM's auto-sync?

**Answer.** Explicit, reviewable SQL is auditable, works with triggers/constraints/functions an ORM
won't model well, and gives deterministic, ordered, forward-only history that CI can apply to an empty
DB. For a correctness-critical financial schema, "the migration is the spec" beats magic sync.

### F4 🟡 The number prefix ordering — what breaks it and how would you scale it?

**Answer.** Lexical sort means `010` must sort after `009` — zero-pad or you'll misorder at 10+. At team
scale, sequential integers cause merge collisions; teams move to timestamp prefixes or a tool
(Flyway/Sqitch) with a dependency graph. For a solo/linear project, ordered integers are simplest.

---

## G. API design, validation & errors

### G1 🟢 How is request input validated?

**Answer.** **Fastify JSON Schema** per route (`account-routes.ts`). Bodies/params declare types,
`enum`s, `format: uuid`, and `additionalProperties: false` to reject unknown fields. Validation runs
before the handler; failures are turned into a stable `VALIDATION_ERROR` (400). Schemas also **serialize
responses**, so output shape is guaranteed too.

### G2 🟡 Describe the error response contract.

**Answer.** Every error is `{ error: { code, message, requestId } }` (`src/errors.ts`). `code` is a
stable machine string; `message` is safe/generic; `requestId` ties it to logs. The handler maps:
`AppError` → its status; Fastify validation → `VALIDATION_ERROR`; recognized domain errors → a
`code → HTTP status` table (`domainErrorStatus`); anything unrecognized → `INTERNAL_ERROR` (500) with
**no internal details leaked** (the real error is logged server-side).

**Follow-up: why keep HTTP status out of domain errors?** So domain/application code stays
transport-agnostic and testable; the route/error adapter owns the HTTP mapping. Swapping to gRPC
wouldn't touch the domain.

### G3 🟡 Why `additionalProperties: false`?

**Answer.** It rejects unexpected fields instead of silently ignoring them — catches client bugs and
typos (`ammount`), and prevents mass-assignment-style surprises. Strict input contracts age better.

### G4 🟡 How are request IDs handled and why?

**Answer.** `genReqId` (`app.ts:34`) trusts a client `x-request-id` (≤128 chars) or generates a UUID.
Every log line and every error response carries it, enabling **end-to-end tracing** of one request
across services/logs — the backbone of debugging distributed systems.

### G5 🔴 An unknown 404 route — what happens?

**Answer.** A `setNotFoundHandler` returns the same structured error shape with `ROUTE_NOT_FOUND` and
the request ID, so clients get one consistent error envelope for _every_ failure, including routing
misses — not Fastify's default HTML/JSON default.

---

## H. Architecture & code organization

### H1 🟢 Describe the overall architecture.

**Answer.** A **modular monolith**: one deployable Fastify process, one PostgreSQL database, organized
into vertical feature slices (`accounts`, `ledger`, …) using **ports & adapters (hexagonal)**. Each
slice has `*-domain.ts` (types + port interfaces, framework-free), `*-service.ts` (application logic),
`*-routes.ts` (inbound HTTP adapter), `*-repository.ts` (outbound SQL adapter). Wiring happens only at
the composition root (`app.ts`).

### H2 🟡 What's the dependency rule and how is it enforced?

**Answer.** Dependencies point **inward**: routes → domain port; service → domain port; repository
implements a domain port; nothing in the core imports Fastify or `pg`. `scripts/check-architecture.ts`
runs in CI and rejects violations (domain importing a framework, a route importing a concrete
repo/service, cross-feature non-contract imports). The boundary is a _tested_ rule, not a guideline.

### H3 🟡 Why split `app.ts` from `server.ts`?

**Answer.** `buildApp()` constructs and wires the app but doesn't listen; `server.ts` loads config,
creates the pool, starts the app + background worker, and handles SIGINT/SIGTERM shutdown. Tests use
`app.inject()` (in-memory HTTP) with zero networking; side-effecting startup stays at the edge.

### H4 🔴 `AccountService` just delegates to the store. Isn't that a pointless layer?

**Answer.** Today it's thin, but the **seam** is the point: the route depends on the
`AccountApplication` interface, not a concrete class, and the service depends on the `AccountStore`
port, not `pg`. That's what enables in-memory unit tests and lets business rules grow (auth, limits,
events) without touching transport or SQL. Premature collapse of the layer would cost that later.

### H5 🔴 Why a modular monolith and not microservices?

**Answer.** For a correctness-first ledger, one database gives real ACID transactions across accounts
and journal — the exact property microservices sacrifice (distributed transactions, sagas, eventual
consistency). Modules with enforced boundaries keep the option to extract a service later without
paying distributed-systems complexity before it's justified (documented as a v1 exclusion).

---

## I. Observability, health & ops

### I1 🟢 Liveness vs. readiness — what's the difference here?

**Answer.** `/health/live` reports process health with **no dependency checks** — "restart me if this
fails". `/health/ready` runs `SELECT 1` and returns **503** if the DB is unreachable — "only send me
traffic if my dependencies are healthy". Conflating them causes either needless restart loops or
traffic black-holing.

### I2 🟡 How is logging set up and what must never be logged?

**Answer.** **Pino** via Fastify's logger, structured JSON with the request ID on every line, level
from validated config. Secrets, API keys, and sensitive request bodies (idempotency payloads) must
never be logged — the architecture contract makes that explicit, and unexpected errors are logged
server-side while the client only sees `INTERNAL_ERROR`.

### I3 🟡 How does graceful shutdown work and why bother?

**Answer.** `server.ts` registers `SIGINT`/`SIGTERM` handlers that stop the worker, `app.close()`
(drain in-flight requests), then `pool.end()`. Without it, a deploy/rollout can cut active requests and
leak connections. Graceful drain is what makes rolling deploys safe.

### I4 🔴 How would you detect cached-balance drift in production?

**Answer.** Because balances are recomputable from the immutable journal, a **reconciliation** job can
re-sum entries per account and compare to `balance_minor`, alerting on mismatch. That's a scheduled
Week-6 feature; the schema (immutable journal + cached balance) is designed to make it possible.

---

## J. Testing & CI

### J1 🟢 Describe the testing strategy.

**Answer.** A pyramid: **unit** tests for pure logic (`Money`, `validatePosting`) with in-memory
fakes; **property-based** tests with **fast-check** that generate random balanced and invalid postings
and assert invariants hold across thousands of cases; **integration** tests against **real Postgres**
via Testcontainers so constraints, triggers, and SQL are genuinely exercised; later, concurrency and
recovery tests.

### J2 🔴 Why Testcontainers instead of mocking the DB or using SQLite?

**Answer.** The correctness lives _in_ Postgres — deferred constraint triggers, `FOR UPDATE`, composite
FKs, SQLSTATEs. A mock would test the mock; SQLite doesn't have these semantics. Testcontainers boots a
disposable real Postgres per run so tests prove the actual behavior. Cost: needs Docker and is slower
than unit tests — hence the pyramid keeps most tests fast and unit-level.

### J3 🟡 What does property-based testing add over example tests?

**Answer.** Instead of a few hand-picked cases, fast-check **generates** many inputs (random amounts,
directions, entry counts) and checks a _property_ — e.g. "a balanced posting always succeeds; an
unbalanced one always fails". It finds edge cases you'd never enumerate and **shrinks** failures to a
minimal counterexample.

### J4 🟡 What does CI gate on?

**Answer.** `ci.yml` runs on push/PR against a service Postgres: `architecture:check → format:check →
lint → typecheck → db:migrate → test → build`, on Node 22. A **clean clone must pass all of it** — the
"works on my machine" defense. Migrations are applied to an empty DB as part of the gate.

---

## K. Trade-offs, scale & "what would you change"

### K1 🔴 The cached balance is a hot row under contention. How would you scale writes to one account?

**Answer.** Options, in order of complexity: (1) keep the row lock — fine until an account is genuinely
hot; (2) reduce transaction time so locks are held briefly; (3) for extreme hotspots, **balance
striping** (N sub-balance rows summed on read) to spread lock contention; (4) an append-only "commands"
stream with asynchronous balance materialization. v1 correctly starts simple and measures before
optimizing.

### K2 🟡 Why `bigint` minor units instead of PostgreSQL `numeric`?

**Answer.** Currencies here have fixed minor units, so integer minor units are exact and **bounded**
`bigint` arithmetic is simpler to validate and serialize than arbitrary-precision `numeric` (which is
also slower and variable-width). `numeric` would matter for assets with variable precision (FX rates,
crypto) — a deliberate v1 scoping choice in ADR-001.

### K3 🔴 Where does this break if you add multi-currency transfers?

**Answer.** The composite-currency FKs deliberately forbid mixed-currency postings, so cross-currency
value movement can't be a single posting. You'd model it as **two balanced postings** (debit source
currency, credit destination currency) linked by an FX transaction that also books the rate/spread —
never one entry spanning currencies. Rejecting it in v1 keeps the core honest.

### K4 🟡 What did you consciously _not_ build in Weeks 1–2, and why?

**Answer.** No transfers/idempotency/outbox/reconciliation yet (later weeks), no Redis/Kafka/
microservices/K8s (v1 exclusions), no UI. The discipline is to make the accounting core provably
correct first; every excluded item has a named later gate. Over-engineering the periphery before the
core is the risk the plan explicitly guards against.

### K5 🔴 If you had to make one thing production-harder next, what and why?

**Answer.** Escalate concurrent _transfers_ to `SERIALIZABLE` with deterministic locking + bounded
retries (Week 3), because the biggest correctness risk under real load is two concurrent withdrawals
both passing a stale balance check and overspending. That's the difference between "balances are right
in tests" and "balances are right under production concurrency".

---

## L. Rapid-fire (say the one-liner)

- **Money type?** Integer minor units, `bigint`, decimal strings at the JSON edge.
- **Double-entry invariant?** Σdebit = Σcredit, checked at commit by a deferred constraint trigger.
- **Fix a bad posting?** Reversing entry — never edit history.
- **Deadlock avoidance?** Lock accounts `FOR UPDATE` in ascending UUID order.
- **Balance check timing?** At `COMMIT`, because it's a multi-row invariant.
- **Single-currency enforcement?** Composite `(id, currency)` foreign keys.
- **One treasury per currency?** Partial unique index `WHERE is_treasury`.
- **Overdraft rule?** `CHECK (is_treasury OR balance_minor >= 0)` — treasury may go negative.
- **Validation philosophy?** DB constraint = the guarantee; app validation = the friendly front door.
- **Liveness vs readiness?** Restart-me vs. route-traffic-to-me (readiness pings the DB).
- **Migrations?** Tracked, ordered, applied once, each in its own transaction.
- **Architecture?** Modular monolith, ports & adapters, dependencies point inward, boundary tested in CI.
- **Tests?** Unit + property (fast-check) + real-Postgres integration (Testcontainers), gated in CI.
