# Three-minute demonstration

A rehearsed walk-through that proves all four v1 invariants against a live system. Two ways to run
it:

- **Scripted** — `ADMIN_API_KEY=<key> ./scripts/demo.sh` runs the whole thing in **≈8 seconds**
  (measured), printing each piece of evidence. Use this when you want the proof, not the narration.
- **Narrated** — the timeline below, where you talk while the same commands run. Budget 2:55.

Both read every number back from the running system. Nothing is hardcoded or pre-recorded.

## Before you start (not counted in the three minutes)

```bash
docker compose up -d postgres
npm ci && npm run db:migrate && npm run build
export ADMIN_API_KEY=$(openssl rand -hex 16)
export DATABASE_URL=postgresql://pulseledger:pulseledger@localhost:5432/pulseledger
```

Have two terminals ready: one for the server, one for requests. Have
[benchmarks/k6/RESULTS.md](../benchmarks/k6/RESULTS.md) open in a third window for the closing beat.

## Timeline

| #   | Beat                                  | Target | Cumulative |
| --- | ------------------------------------- | -----: | ---------: |
| 1   | Problem and the four invariants       |   0:20 |       0:20 |
| 2   | Key, accounts, funding, one transfer  |   0:30 |       0:50 |
| 3   | 50 concurrent duplicates → 1 transfer |   0:25 |       1:15 |
| 3b  | Another principal is locked out       |   0:20 |       1:35 |
| 4   | Kill the worker, restart, one effect  |   0:40 |       2:15 |
| 5   | Reconciliation from the journal       |   0:15 |       2:30 |
| 6   | Measured load and the bottleneck      |   0:25 |       2:55 |

---

### 1 — The problem (0:25)

> "A payment ledger has to stay correct when requests run concurrently, when clients retry, and when
> background workers crash. PulseLedger holds four invariants, and every one of them has a named
> automated test:
>
> 1. Every ledger transaction is balanced — debits equal credits.
> 2. Journal entries are immutable once committed.
> 3. One idempotency key means one request and one stable result.
> 4. Each outbox event produces at most one logical consumer effect.
>
> The journal is the source of truth; PostgreSQL constraints — not application code alone — enforce
> it."

Nothing to run. Start the server as you finish speaking:

```bash
OUTBOX_POLL_INTERVAL_MS=15000 node dist/server.js
```

(The slow poll interval is only so beat 4 can win a race by hand.)

### 2 — A credential, then money that moves once and balances (0:30)

```bash
# An administrator mints a customer identity and one key. The secret is shown exactly once.
PRINCIPAL=$(curl -s -X POST localhost:3000/v1/admin/principals \
  -H 'content-type: application/json' -H "x-admin-api-key: $ADMIN_API_KEY" \
  -d '{"name":"demo"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')
export CUSTOMER_KEY=$(curl -s -X POST localhost:3000/v1/admin/principals/$PRINCIPAL/api-keys \
  -H "x-admin-api-key: $ADMIN_API_KEY" | node -pe 'JSON.parse(require("fs").readFileSync(0)).key')

# Without it, nothing customer-facing answers -- and the 401 comes before schema validation.
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:3000/v1/transfers \
  -H 'content-type: application/json' -d '{}'          # 401

ALICE=$(curl -s -X POST localhost:3000/v1/accounts -H 'content-type: application/json' \
  -H "authorization: Bearer $CUSTOMER_KEY" -d '{"currency":"INR"}' \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')
BOB=$(curl -s -X POST localhost:3000/v1/accounts -H 'content-type: application/json' \
  -H "authorization: Bearer $CUSTOMER_KEY" -d '{"currency":"INR"}' \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')

curl -s -X POST localhost:3000/v1/admin/fund -H 'content-type: application/json' \
  -H "x-admin-api-key: $ADMIN_API_KEY" \
  -d "{\"accountId\":\"$ALICE\",\"amountMinor\":\"250000\"}"

curl -s -X POST localhost:3000/v1/transfers -H 'content-type: application/json' \
  -H 'idempotency-key: demo-1' \
  -d "{\"sourceAccountId\":\"$ALICE\",\"destinationAccountId\":\"$BOB\",\"amountMinor\":\"75000\"}"

curl -s localhost:3000/v1/accounts/$ALICE -H "authorization: Bearer $CUSTOMER_KEY"  # "175000"
curl -s localhost:3000/v1/accounts/$BOB   -H "authorization: Bearer $CUSTOMER_KEY"  # "75000"
```

> "Balances are integer minor units as strings — no floats anywhere. Funding is not a balance edit;
> it is a journaled posting from the currency treasury. The transfer wrote both journal entries,
> both cached balances, the transfer row, the outbox event, and the idempotency response in **one
> SERIALIZABLE transaction**."

### 3 — Fifty duplicates, one transfer (0:30)

```bash
for i in $(seq 1 50); do
  curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:3000/v1/transfers \
    -H 'content-type: application/json' -H 'idempotency-key: demo-storm' \
    -d "{\"sourceAccountId\":\"$ALICE\",\"destinationAccountId\":\"$BOB\",\"amountMinor\":\"1000\"}" &
done | sort | uniq -c

curl -s localhost:3000/v1/admin/metrics -H "x-admin-api-key: $ADMIN_API_KEY"
```

> "Fifty concurrent requests, same key, same body. Every caller gets a `201` with the _same_
> transfer ID — or a `409 IDEMPOTENCY_IN_PROGRESS` if it arrived while the original was still
> committing. The completed-transfer counter moved by exactly one. The database, not the
> application, guarantees that: a unique constraint on `(key, operation)`."

Point at: `transfers.completed` incremented by 1.

### 3b — Another principal cannot touch any of it (0:20)

```bash
INTRUDER=$(curl -s -X POST localhost:3000/v1/admin/principals \
  -H 'content-type: application/json' -H "x-admin-api-key: $ADMIN_API_KEY" \
  -d '{"name":"intruder"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')
INTRUDER_KEY=$(curl -s -X POST localhost:3000/v1/admin/principals/$INTRUDER/api-keys \
  -H "x-admin-api-key: $ADMIN_API_KEY" | node -pe 'JSON.parse(require("fs").readFileSync(0)).key')

PAYLOAD="{\"sourceAccountId\":\"$ALICE\",\"destinationAccountId\":\"$BOB\",\"amountMinor\":\"1000\"}"
curl -s -o /dev/null -w 'read account:  %{http_code}\n' localhost:3000/v1/accounts/$ALICE \
  -H "authorization: Bearer $INTRUDER_KEY"                                    # 404
curl -s -o /dev/null -w 'spend from it: %{http_code}\n' -X POST localhost:3000/v1/transfers \
  -H 'content-type: application/json' -H "authorization: Bearer $INTRUDER_KEY" -d "$PAYLOAD"  # 404
```

> "A perfectly valid credential — it just does not own this account. Note it is a **404, not a
> 403**: the API never confirms that someone else's account exists, so it cannot be used to
> enumerate accounts. And the ownership check happens against the row locked inside the transfer's
> `SERIALIZABLE` transaction, not in the route, so it cannot be raced."

### 4 — Kill the process, restart, exactly one effect (0:40)

```bash
curl -s -X POST localhost:3000/v1/transfers -H 'content-type: application/json' \
  -d "{\"sourceAccountId\":\"$ALICE\",\"destinationAccountId\":\"$BOB\",\"amountMinor\":\"500\"}"

kill -9 %1            # SIGKILL: no graceful shutdown, no flush

docker compose exec -T postgres psql -U pulseledger -d pulseledger -c \
  "SELECT status FROM outbox_events ORDER BY created_at DESC LIMIT 1;"     -- pending
docker compose exec -T postgres psql -U pulseledger -d pulseledger -c \
  "SELECT count(*) FROM audit_effects;"                                    -- unchanged

node dist/server.js &  # restart with the normal 1s poll
```

> "The transfer committed, then the process died before the worker touched the event. The event is
> still there, because it was written **inside the transfer's transaction** — no dual write. On
> restart the worker claims it and the audit effect appears."

```bash
docker compose exec -T postgres psql -U pulseledger -d pulseledger -c \
  "SELECT status FROM outbox_events ORDER BY created_at DESC LIMIT 1;"     -- processed
docker compose exec -T postgres psql -U pulseledger -d pulseledger -c \
  "SELECT count(*) FROM audit_effects;"                                    -- +1
```

Now force a redelivery — the case a crashed lease or a replay actually produces:

```bash
docker compose exec -T postgres psql -U pulseledger -d pulseledger -c \
  "UPDATE outbox_events SET status='pending', next_attempt_at=NULL
   WHERE id = (SELECT id FROM outbox_events ORDER BY created_at DESC LIMIT 1);"
# wait one poll, then:
docker compose exec -T postgres psql -U pulseledger -d pulseledger -c \
  "SELECT count(*) FROM audit_effects;"                                    -- still the same
```

> "Delivery is at-least-once and the worker makes no attempt to prevent duplicates. The consumer
> inbox does: `(consumer_name, event_id)` is a primary key, so the duplicate's claim conflicts,
> inserts nothing, and returns a successful no-op. At-least-once transport, at-most-once effect."

### 5 — Reconciliation (0:20)

```bash
curl -s -X POST localhost:3000/v1/admin/reconcile -H "x-admin-api-key: $ADMIN_API_KEY"
# {"ok":true,"accountsChecked":14,"generatedAt":"...","issues":[]}
```

> "This ignores the cached balances entirely: it re-derives every balance from the immutable journal
> and compares. Clean after everything we just did, including the crash. It is deliberately
> read-only — it reports drift, it never repairs it, because a correction belongs in the ledger as a
> reversing entry that a human approved."

Optional, if there is time — seed drift and show it caught:

```bash
docker compose exec -T postgres psql -U pulseledger -d pulseledger -c \
  "UPDATE accounts SET balance_minor = balance_minor + 1 WHERE id = '$ALICE';"
curl -s -X POST localhost:3000/v1/admin/reconcile -H "x-admin-api-key: $ADMIN_API_KEY"
# {"ok":false, ... "type":"mismatched","cachedBalanceMinor":"174001","computedBalanceMinor":"174000"}
```

### 6 — What it costs under load (0:25)

Show [benchmarks/k6/RESULTS.md](../benchmarks/k6/RESULTS.md):

> "Real k6 against a 2-vCPU PostgreSQL container. Baseline: 4,129 requests, 134 req/s, p95 270 ms.
> The hot-account scenario — 30 VUs on 3 accounts — pushed 21.5% of requests into
> `TRANSFER_RETRY_EXHAUSTED`. That is the bottleneck, and it is the _designed_ one: serialization
> conflicts and their retries compete for the same capped database CPU. Nothing overdrew, nothing
> was lost, and the full test suite plus reconciliation passed before and after ~14,000 transfers.
> The bounded 503 is the system refusing to trade correctness for throughput."

## Questions you should expect

| Question                                      | One-line answer                                                                                          |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| "Why `SERIALIZABLE` and not row locks alone?" | Row locks stop lost updates but not every read-write anomaly; the retry cost is measured and bounded.    |
| "Isn't 21% of requests failing bad?"          | That scenario is designed to maximize conflict. The alternative is unbounded latency or a wrong balance. |
| "Why not Kafka?"                              | A broker does not remove the need for an outbox; the outbox is the correctness mechanism (ADR-003).      |
| "What if the cached balance drifts?"          | Reconciliation finds it — demonstrated above with a seeded 1-minor-unit mismatch.                        |
| "How do you fix a bad transfer?"              | A reversing posting. Journal rows cannot be updated or deleted; database triggers reject it.             |
| "Would this scale?"                           | Vertically today. The seams for a separate worker or a broker exist; see [TRADEOFFS.md](./TRADEOFFS.md). |
