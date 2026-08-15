# k6 benchmark scenarios

Four scenarios, each self-seeding via k6's `setup()` (no separate fixture step required beyond a
running server). Every scenario reads `BASE_URL` and `ADMIN_API_KEY` from the environment.

| Scenario                    | What it proves                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------ |
| `normal-transfer.js`        | Baseline throughput/latency for typical, non-contentious transfers                                     |
| `broad-concurrency.js`      | Ramping concurrency across a wide account pool — the general throughput ceiling                        |
| `duplicate-storm.js`        | N concurrent identical requests (same `Idempotency-Key` + body) → exactly one completed transfer       |
| `hot-account-contention.js` | Concurrency concentrated on a handful of accounts → bounded `SERIALIZABLE` retries, no overdraft, ever |

## Running

```bash
# 1. Start Postgres with the resource limits recorded in compose.yaml
docker compose up -d postgres

# 2. Migrate and build
npm run db:migrate
npm run build

# 3. Start the server against it (separate terminal, or backgrounded)
ADMIN_API_KEY=<your-key> DATABASE_URL=postgresql://pulseledger:pulseledger@localhost:5432/pulseledger \
  node dist/server.js

# 4. Run correctness tests first (see PROJECT_PLAN.md Week 7 -- ledger invariants must be green
#    both before and after a benchmark run)
npm test

# 5. Run a scenario
BASE_URL=http://localhost:3000 ADMIN_API_KEY=<your-key> \
  k6 run --summary-export=results/normal-transfer.json benchmarks/k6/normal-transfer.js

# 6. Run correctness tests again, and reconcile
npm test
ADMIN_API_KEY=<your-key> DATABASE_URL=... npm run reconcile
```

Tunable env vars per scenario (all optional, sane defaults baked in):

| Scenario                    | Vars                                   |
| --------------------------- | -------------------------------------- |
| `normal-transfer.js`        | `ACCOUNT_POOL_SIZE`, `VUS`, `DURATION` |
| `broad-concurrency.js`      | `ACCOUNT_POOL_SIZE`, `PEAK_VUS`        |
| `duplicate-storm.js`        | `DUPLICATE_COUNT`                      |
| `hot-account-contention.js` | `HOT_ACCOUNT_COUNT`, `VUS`, `DURATION` |

Every scenario prints an admin-metrics delta (`completed`/`retries`/`exhausted`, from
`GET /v1/admin/metrics`) in its `teardown()`, in addition to k6's own throughput/latency summary
(P50/P90/P95/P99 are always in k6's default text summary; pass `--summary-export=<file>.json` to
also capture the full breakdown as JSON for a report).

Recorded raw results, methodology, and environment for the last real run are in
[`RESULTS.md`](./RESULTS.md).
