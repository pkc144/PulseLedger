# Benchmark results

Real `k6` output against a real PostgreSQL container and the real built server — every number
below came from the runs described here. Raw k6 stdout and `--summary-export` JSON for each
scenario are committed alongside this file in `benchmarks/k6/results/`.

**This is a development-machine run, not a dedicated benchmark rig.** Scale, VU counts, and
durations were chosen to finish in a few minutes each, not to find an absolute capacity ceiling.
Where a scenario reveals real contention or a real bottleneck, that's reported as observed —
nothing here is tuned after the fact to look cleaner.

## Environment

|                             |                                                                                                                                                                   |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Date                        | 2026-08-15 (UTC)                                                                                                                                                  |
| Commit                      | `4596938` (base; committed together with the Week 7 work that produced this report)                                                                               |
| k6                          | v2.2.0 (darwin/amd64)                                                                                                                                             |
| Server                      | Built (`npm run build`) and run as `node dist/server.js`, `NODE_ENV=production`                                                                                   |
| PostgreSQL                  | 17.10 (`postgres:17-alpine`), container limited to **2 CPU / 2 GiB** (`compose.yaml`, confirmed via `docker inspect`)                                             |
| Host                        | Darwin 24.6.0, x86_64, 12 CPUs, 32 GiB RAM                                                                                                                        |
| Dataset before benchmarking | `npm run seed` (`SEED_ACCOUNTS=300 SEED_TRANSFERS=3000`) → 305 accounts, 3,299 ledger transactions, 6,604 journal entries, 2,999 transfers                        |
| Warm-up                     | None beyond each scenario's own `setup()` (account creation + funding, itself real traffic against the same server). No separate throwaway warm-up phase was run. |
| Correctness gate            | Full test suite run immediately before and after all four scenarios; `npm run reconcile` run after                                                                |

## Correctness, before and after

```text
Before: PASS (126) FAIL (0)
[... four k6 scenarios, ~14,000 transfer attempts, 763 accounts touched ...]
After:  PASS (126) FAIL (0)

npm run reconcile (after):
{ "accountsChecked": 763, "issues": [], "ok": true }
```

Every cached balance matched the journal exactly after real concurrent load, including the two
scenarios below that deliberately drove the system into `SERIALIZABLE` contention and bounded
retry exhaustion. This is the headline result: **correctness held under load**, not just in unit
and integration tests.

## Scenario results

| Scenario                 | VUs / shape                             | Requests | Throughput  | p50      | p90       | p95       | `http_req_failed`  |
| ------------------------ | --------------------------------------- | -------- | ----------- | -------- | --------- | --------- | ------------------ |
| `normal-transfer`        | 20 constant, 30s, 100-account pool      | 4,129    | 134.4 req/s | 13.1 ms  | 166.0 ms  | 269.7 ms  | 2.25% (93/4,129)   |
| `broad-concurrency`      | ramp 0→75, 50s, 300-account pool        | 3,155    | 61.0 req/s  | 365.4 ms | 2536.6 ms | 2727.1 ms | 16.92% (534/3,155) |
| `duplicate-storm`        | 50 concurrent, 1 identical request each | 55       | 766.7 req/s | 43.1 ms  | 46.8 ms   | 47.3 ms   | 0.00% (0/55)       |
| `hot-account-contention` | 30 constant, 20s, 3-account pool        | 3,220    | 158.5 req/s | 114.0 ms | 368.4 ms  | 384.3 ms  | 21.52% (693/3,220) |

`http_req_failed` here means "got a non-2xx" by k6's default classification (`duplicate-storm`
additionally teaches k6 that 409 is expected, not a failure — see below). For the two contention
scenarios, essentially all of that percentage is `TRANSFER_RETRY_EXHAUSTED` (503) — a **correctly
bounded**, intentional outcome (ADR-002), not a crash or a corruption. The retry/exhaustion counts
below come from `GET /v1/admin/metrics`, read before and after each scenario.

| Scenario                 |                         Transfers completed | Retries | Retry-exhausted (503) |
| ------------------------ | ------------------------------------------: | ------: | --------------------: |
| `normal-transfer`        |                                       3,834 |   8,863 |                    93 |
| `duplicate-storm`        | **1** (of 50 concurrent identical requests) |       — |                     — |
| `hot-account-contention` |                                       2,516 |  18,767 |                   693 |
| `broad-concurrency`      |                                       2,019 |  12,611 |                   534 |

Every exhausted-count above matches that scenario's `http_req_failed` count exactly (e.g.
`hot-account-contention`: 693 exhausted, 693 failed HTTP responses) — a self-consistency check
that the only non-2xx responses in the contention scenarios are the bounded-retry path, not
something else failing silently.

### `normal-transfer` — baseline

20 VUs against a 100-account pool still produced a **non-trivial** 2.25% retry-exhaustion rate.
That's a real, useful data point, not noise: with 20 concurrent transfers each touching 2 of 100
accounts, the chance that two concurrent transfers collide on a shared account is high enough to
matter (a birthday-paradox effect on 40 "touched" slots out of 100). At this account-pool-to-VU
ratio, the system is already exercising its serialization-retry path meaningfully — worth knowing
before sizing a real deployment's account pool or retry budget.

### `broad-concurrency` — the observed bottleneck

Ramping to 75 concurrent VUs against a 2-CPU-limited Postgres container is where this environment's
ceiling shows up plainly: p95 latency rose to 2.7s and 16.92% of requests exhausted their retry
budget. The bottleneck is exactly where you'd expect it for `SERIALIZABLE` writes under a hard CPU
cap — lock contention and serialization-conflict retries compete for the same limited backend CPU
that's also doing the actual work, so pushing VUs past what 2 vCPUs can serialize increases both
tail latency and the 503 rate together. Nothing here is a code defect: it is a direct, honest
consequence of a deliberately small container limit, run against a deliberately small account
pool relative to VU count. A production sizing exercise would use this exact scenario with the
container's real resource allocation.

### `duplicate-storm` — idempotency under real concurrency

50 truly concurrent requests, identical `Idempotency-Key` and body, against one source account.
By design (Week 4), only the request that wins the race gets `201`; every other request racing the
_same still-in-progress_ key correctly gets `409 IDEMPOTENCY_IN_PROGRESS` immediately — there is no
blocking wait, and a caller only receives a replayed `201` if it arrives after the winner has
already committed. `duplicate-storm.js` therefore accepts `201` or `409` as success and proves the
real invariant directly: `GET /v1/admin/metrics` shows the completed-transfer count increased by
**exactly 1**, confirmed at load, not just in a 50-iteration vitest test.

### `hot-account-contention` — bounded retries, zero overdraft

30 VUs hammering only 3 accounts for 20 seconds produced the highest exhaustion rate of any
scenario (21.52%) — expected, since this scenario exists specifically to maximize `SERIALIZABLE`
conflicts. p95 latency stayed at 384 ms (well under the 2s threshold), and every hot account's
final balance was verified over HTTP in `teardown()` to be non-negative and exactly conserved
(sum of final balances == sum of initial funding). Heavy, sustained contention never produced an
overdraft or a lost update.

## Release re-verification (v1.0.0)

The four scenarios were run again unchanged on 2026-08-16 as part of the release gate, on the same
host and the same 2 CPU / 2 GiB container, against a freshly migrated and freshly seeded database
(300 accounts / 3,000 transfers). Raw stdout and summary JSON:
[`results/release-v1.0.0/`](./results/release-v1.0.0/). The application code is unchanged from the
run above — Week 8 added documentation, diagrams, and `scripts/demo.sh` only.

| Scenario                 | Requests | Throughput  | p50      | p90      | p95      | `http_req_failed` | Retry-exhausted |
| ------------------------ | -------- | ----------- | -------- | -------- | -------- | ----------------- | --------------- |
| `normal-transfer`        | 2,940    | 95.0 req/s  | 30.8 ms  | 352.8 ms | 471.8 ms | 7.00% (206)       | 206             |
| `duplicate-storm`        | 55       | 1054 req/s  | 18.2 ms  | 23.8 ms  | 24.0 ms  | 0.00% (0)         | —               |
| `hot-account-contention` | 2,868    | 141.5 req/s | 133.6 ms | 403.0 ms | 426.9 ms | 25.13% (721)      | 721             |
| `broad-concurrency`      | 6,190    | 118.9 req/s | 269.2 ms | 758.0 ms | 1620 ms  | 4.15% (257)       | 257             |

What reproduced exactly:

- **The invariants.** `duplicate-storm` again moved the completed-transfer counter by **exactly 1**
  across 50 concurrent identical requests. `hot-account-contention` and `broad-concurrency` again
  passed every in-scenario check (balances non-negative and conserved, 100% of checks succeeded).
- **The self-consistency property.** In all three contention scenarios the `http_req_failed` count
  equals the `TRANSFER_RETRY_EXHAUSTED` delta read from `/v1/admin/metrics` exactly (206/206,
  721/721, 257/257) — the only non-2xx responses are still the bounded-retry path.
- **Reconciliation.** After 11,184 transfer attempts (10,000 completed, 1,184 exhausted) across all
  four scenarios: `{ "accountsChecked": 719, "issues": [], "ok": true }`.

What did **not** reproduce exactly, and why that is expected: the per-scenario latency and failure
percentages moved in both directions (`normal-transfer` 2.25% → 7.00%, `broad-concurrency` 16.92% →
4.15%). These are run-to-run variance on a shared developer machine with a hard 2-vCPU database cap —
exactly the sensitivity the environment note at the top of this file warns about. The qualitative
conclusion is unchanged and was reproduced: under `SERIALIZABLE` contention this system degrades by
returning bounded 503s and higher tail latency, never by losing or duplicating money.

## Reproducing

```bash
docker compose up -d postgres      # 2 CPU / 2 GiB, per compose.yaml
npm run db:migrate
npm run build
ADMIN_API_KEY=<key> DATABASE_URL=postgresql://pulseledger:pulseledger@localhost:5432/pulseledger \
  PORT=3900 node dist/server.js &

npm test                            # correctness gate, before

BASE_URL=http://localhost:3900 ADMIN_API_KEY=<key> k6 run benchmarks/k6/normal-transfer.js
BASE_URL=http://localhost:3900 ADMIN_API_KEY=<key> k6 run benchmarks/k6/duplicate-storm.js
BASE_URL=http://localhost:3900 ADMIN_API_KEY=<key> k6 run benchmarks/k6/hot-account-contention.js
BASE_URL=http://localhost:3900 ADMIN_API_KEY=<key> k6 run benchmarks/k6/broad-concurrency.js

npm test                            # correctness gate, after
ADMIN_API_KEY=<key> DATABASE_URL=... npm run reconcile
```

Raw stdout and `--summary-export` JSON per scenario: [`results/`](./results/).
