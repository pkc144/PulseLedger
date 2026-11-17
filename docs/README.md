# PulseLedger documentation: reading order (backend)

Read top to bottom. Each step lists the code to open next to it. The frontend (`web/README.md`) is
deliberately left out.

## 1. Big picture

1. [`../README.md`](../README.md): what the project is, the four hard problems, and the five
   invariants.
2. [`../PROJECT_PLAN.md`](../PROJECT_PLAN.md): scope, tech choices, and the week-by-week build
   order.
3. [`diagrams/architecture.md`](./diagrams/architecture.md), then
   [`ARCHITECTURE.md`](./ARCHITECTURE.md): module layering, runtime flows, and the ten data rules.
   _Code:_ `src/app.ts`, `src/server.ts`, `src/modules/accounts/*`.

## 2. Foundations (weeks 1–2)

4. [`weeks-1-2-study-guide.md`](./weeks-1-2-study-guide.md): integer money, double-entry
   bookkeeping, schema, triggers, and migrations.
   _Code:_ `migrations/001`, `002`, `src/modules/ledger/*`, `src/infrastructure/database/*`.
5. [`adr/README.md`](./adr/README.md), then [`adr/001`](./adr/001-double-entry-integer-accounting.md).

## 3. The core transfer path (weeks 3–4)

6. [`diagrams/transfer-flow.md`](./diagrams/transfer-flow.md)
7. [`adr/002`](./adr/002-serializable-locking-retries.md): `SERIALIZABLE`, lock order, retries.
8. [`weeks-3-8-study-guide.md`](./weeks-3-8-study-guide.md) **Parts 1–2**: transfers and
   idempotency.
   _Code:_ `src/modules/transfers/*`, `src/modules/idempotency/*`, `src/errors.ts`, `migrations/003–005`.
9. [`API.md`](./API.md): request and response contracts. Skim it.

## 4. Reliability (weeks 5–6)

10. [`adr/003`](./adr/003-transactional-outbox.md), then
    [`adr/004`](./adr/004-modular-monolith-database-worker.md).
11. Study guide **Parts 3–5**: outbox, idempotent consumer, reconciliation.
    _Code:_ `src/modules/outbox/*`, `src/modules/audit/*`, `src/modules/reconciliation/*`, `migrations/006–008`.

## 5. Security and operations (v1.1, v1.2, unreleased)

12. [`adr/005`](./adr/005-api-key-authentication-account-ownership.md) and study guide **Part 7**.
    _Code:_ `src/modules/auth/*`, `src/infrastructure/http/api-key-auth.ts`, `admin-auth.ts`, `migrations/009`.
13. [`adr/006`](./adr/006-retention-boundaries-and-operator-replay.md) and study guide **Part 8**.
    _Code:_ `src/retention-cli.ts`, `src/modules/outbox/outbox-cli.ts`, `src/infrastructure/http/metrics.ts`, `migrations/010–011`.
14. [`adr/007`](./adr/007-firebase-id-tokens-as-customer-credentials.md) and study guide **Part 9**.
    _Code:_ `src/infrastructure/http/firebase-id-token.ts`, `src/ports/transaction.ts`, `migrations/012`.

## 6. Proof

15. [`TESTING.md`](./TESTING.md): every invariant mapped to the named test that proves it.
16. [`../benchmarks/k6/README.md`](../benchmarks/k6/README.md), then
    [`RESULTS.md`](../benchmarks/k6/RESULTS.md).
17. [`performance/index-verification.md`](./performance/index-verification.md): index choices
    backed by `EXPLAIN ANALYZE`.
18. [`TRADEOFFS.md`](./TRADEOFFS.md): known limits and what comes next.

## 7. Practice

19. [`DEMO.md`](./DEMO.md): run `./scripts/demo.sh` yourself.
20. [`weeks-1-2-interview-qa.md`](./weeks-1-2-interview-qa.md), then
    [`weeks-3-8-interview-qa.md`](./weeks-3-8-interview-qa.md). Answer out loud before reading.
21. [`../CHANGELOG.md`](../CHANGELOG.md) and [`release/`](./release/): how the system changed
    version by version.
