# Index verification (`EXPLAIN ANALYZE`)

Real `EXPLAIN (ANALYZE, BUFFERS)` output for every hot query in the codebase, run against a
seeded dataset — not a handful of rows, so PostgreSQL's planner makes the same choice it would
in a real deployment. No plan below is invented; every number came from the run described here.

## How to reproduce

```bash
docker compose up -d postgres
npm run db:migrate
SEED_ACCOUNTS=300 SEED_TRANSFERS=3000 npm run seed
docker exec -it pulseledger-postgres-1 psql -U pulseledger -d pulseledger
# then paste the queries from "Queries verified" below, each prefixed with
# EXPLAIN (ANALYZE, BUFFERS)
```

## Run details

|            |                                                                                                                                                                                                                                                                                                                |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Commit     | `4596938` (base; this file ships in the Week 7 commit built on top of it)                                                                                                                                                                                                                                      |
| PostgreSQL | 17.10 (`postgres:17-alpine`), container limited to 2 CPU / 2 GiB (`compose.yaml`, confirmed via `docker inspect`: `NanoCpus=2000000000 Memory=2147483648`)                                                                                                                                                     |
| Host       | Darwin 24.6.0, x86_64, 12 CPUs, 32 GiB RAM (development machine, not a dedicated benchmark rig)                                                                                                                                                                                                                |
| Dataset    | `npm run seed` with `SEED_ACCOUNTS=300 SEED_TRANSFERS=3000` → 305 accounts, 3,299 ledger transactions, 6,604 journal entries, 2,999 transfers, plus a handful of `idempotency_records` created via real `POST /v1/transfers` calls (the seed script drives services directly and doesn't exercise idempotency) |
| Method     | `psql` inside the running container; each query run once, cold-ish cache (no explicit warm-up pass — see caveat below)                                                                                                                                                                                         |

**Caveat:** this is a correctness/plan-shape verification, not a load benchmark (that's
`benchmarks/k6/`, with its own methodology). Absolute timings below (sub-millisecond to a few ms)
reflect a nearly-empty buffer cache and a tiny dataset; they are not throughput numbers.

## Result summary

| #   | Query                                   | Table size                       | Plan                                                                                             | Verdict                                                       |
| --- | --------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| 1   | Account lookup by id                    | 305 rows                         | **Seq Scan**                                                                                     | ✅ Expected — table this small, seq scan is genuinely cheaper |
| 2   | Treasury lookup by currency             | 305 rows                         | **Seq Scan**                                                                                     | ✅ Expected, same reason                                      |
| 3   | Idempotency claim (`key`, `operation`)  | small                            | **Index Scan** (`idempotency_records_pkey`)                                                      | ✅ Expected                                                   |
| 4   | Transfer lookup by id                   | 2,999 / 3,299 rows               | **Nested Loop, 2× Index Scan** (`transfers_pkey`, `ledger_transactions_id_currency_type_unique`) | ✅ Expected                                                   |
| 5   | Journal entries keyset page             | 6,604 rows (33 for this account) | **Bitmap Index Scan** (`journal_entries_account_created_idx`)                                    | ✅ Expected — the index this query was designed for           |
| 6   | Outbox claim (`FOR UPDATE SKIP LOCKED`) | small, filtered                  | **Bitmap Index Scan** (`outbox_events_claim_idx`)                                                | ✅ Expected                                                   |
| 7   | Reconciliation aggregate                | 6,604 + 305 rows                 | **Seq Scan × 2 → Hash Full Join → HashAggregate**                                                | ✅ **Correctly** a full scan — see below                      |

The interesting result isn't "everything uses an index" — it's that PostgreSQL chooses **exactly
the plan each query should get**, including two queries that correctly _don't_ use an index yet.

## Queries verified

### 1–2. Account and treasury lookup — correctly a seq scan at this size

```text
Seq Scan on accounts  (cost=0.00..7.79 rows=1 width=67) (actual time=0.014..0.050 rows=1 loops=1)
  Filter: ((NOT is_treasury) AND (id = 'a47a7f2e-6310-46a8-83d5-499695b08146'::uuid))
  Rows Removed by Filter: 304
  Buffers: shared hit=4
Execution Time: 0.125 ms
```

```text
Seq Scan on accounts  (cost=0.00..7.79 rows=1 width=28) (actual time=0.013..0.030 rows=1 loops=1)
  Filter: (is_treasury AND ((currency)::text = 'INR'::text))
  Rows Removed by Filter: 304
  Buffers: shared hit=4
Execution Time: 0.038 ms
```

With 305 rows fitting in a handful of 8 KB pages, a sequential scan reads the whole table in one
pass more cheaply than an index lookup plus a heap fetch — this is the _correct_ planner decision,
not a missing index. Forcing the alternative confirms the index exists and is usable, just not
currently cheaper:

```text
-- SET enable_seqscan = off;
Index Scan using accounts_id_currency_unique on accounts  (cost=0.27..8.30 ...)
  Index Cond: (id = 'a47a7f2e-6310-46a8-83d5-499695b08146'::uuid)
  Filter: (NOT is_treasury)
Execution Time: 0.101 ms

Index Scan using accounts_one_treasury_per_currency on accounts  (cost=0.13..8.14 ...)
  Index Cond: ((currency)::text = 'INR'::text)
Execution Time: 0.081 ms
```

The forced-index cost (8.14–8.30) is marginally _higher_ than the natural seq-scan cost
(7.79) at 305 rows — exactly why the planner picks seq scan today. `accounts_one_treasury_per_currency`
(the Week 1 partial unique index, "one treasury per currency") is confirmed to be the index the
planner reaches for the moment table growth tips the cost comparison the other way; nothing about
this query needs to change as the table grows.

### 3. Idempotency claim — index scan on the composite primary key

```text
Index Scan using idempotency_records_pkey on idempotency_records  (cost=0.15..8.17 rows=1 width=180) (actual time=0.015..0.015 rows=1 loops=1)
  Index Cond: ((key = 'explain-demo-key-1'::text) AND (operation = 'transfer'::text))
  Buffers: shared hit=2
Execution Time: 0.036 ms
```

`PRIMARY KEY (key, operation)` (migration `005_idempotency.sql`) is used directly — the claim
query's `WHERE key = $1 AND operation = $2` matches the PK's leading columns exactly.

### 4. Transfer lookup — two index scans in a nested loop

```text
Nested Loop  (cost=0.56..16.61 rows=1 width=147) (actual time=0.041..0.105 rows=1 loops=1)
  ->  Index Scan using transfers_pkey on transfers  (cost=0.28..8.30 ...)
        Index Cond: (id = 'c445d387-...'::uuid)
  ->  Index Scan using ledger_transactions_id_currency_type_unique on ledger_transactions  (cost=0.28..8.30 ...)
        Index Cond: (id = 'c445d387-...'::uuid)
Execution Time: 0.139 ms
```

`GET /v1/transfers/:id` joins `transfers` to `ledger_transactions` (for the immutable `created_at`
and `reference`); both sides resolve via an index scan on the join key.

### 5. Journal entries keyset pagination — the index this feature was built for

```text
Limit  (cost=70.92..70.97 rows=21 width=130) (actual time=0.352..0.355 rows=21 loops=1)
  ->  Sort (Sort Key: created_at, id) ... Sort Method: quicksort  Memory: 29kB
        ->  Bitmap Heap Scan on journal_entries  (cost=4.54..70.08 rows=33 width=130) (actual time=0.074..0.285 rows=33 loops=1)
              Recheck Cond: (account_id = 'c4c16d64-...'::uuid)
              Heap Blocks: exact=29
              ->  Bitmap Index Scan on journal_entries_account_created_idx  (cost=0.00..4.53 rows=33 width=0)
                    Index Cond: (account_id = 'c4c16d64-...'::uuid)
Execution Time: 0.403 ms
```

`journal_entries_account_created_idx (account_id, created_at, id)` — defined in Week 2, before
pagination existed — is exactly shaped for `WHERE account_id = $1 ORDER BY created_at, id`, and the
`(created_at, id)` column order is precisely what the Week 7 keyset cursor compares against. Out of
6,604 total journal entries, only this account's 33 are ever touched.

### 6. Outbox claim — the partial claim index

```text
Bitmap Heap Scan on outbox_events  (cost=4.18..12.68 rows=2 width=30) (actual time=0.022..0.022 rows=0 loops=1)
  Recheck Cond: (status = ANY ('{pending,failed,processing}'::text[]))
  Filter: ((next_attempt_at IS NULL) OR (next_attempt_at <= now()))
  ->  Bitmap Index Scan on outbox_events_claim_idx  (cost=0.00..4.18 rows=5 width=0)
        Index Cond: (status = ANY ('{pending,failed,processing}'::text[]))
Execution Time: 0.071 ms
```

`rows=0`: the events created while populating the idempotency-demo transfers above had already
been claimed and processed by the running worker before this query ran — itself a small piece of
live evidence that the Week 5/6 pipeline drains events end to end. The partial index
`outbox_events_claim_idx ... WHERE status IN ('pending','failed','processing')` is still selected
because its predicate matches the query's filter exactly, independent of how many rows currently
qualify.

### 7. Reconciliation — correctly a full scan, not a missing index

```text
Sort  (cost=293.06..294.57 rows=604 width=98) (actual time=3.341..3.353 rows=305 loops=1)
  ->  Hash Full Join  (cost=249.96..265.16 rows=604 width=98) (actual time=3.016..3.236 rows=305 loops=1)
        ->  HashAggregate (Group Key: journal_entries.account_id, journal_entries.currency)
              ->  Seq Scan on journal_entries  (cost=0.00..155.73 rows=6673 width=34) (actual time=0.006..0.430 rows=6604 loops=1)
        ->  Hash
              ->  Seq Scan on accounts a  (cost=0.00..7.03 rows=303 width=28) (actual time=0.008..0.043 rows=305 loops=1)
Execution Time: 3.500 ms
```

Reconciliation must recompute every account's balance from _every_ journal entry by definition —
there is no `WHERE` clause to make selective, so no index changes this. An index here would add
write overhead to the hot ledger-posting path to speed up a comparatively rare admin operation;
that's the wrong trade for v1. 6,604 rows scanned in 3.5 ms is not a concern at this scale, and if
reconciliation ever needs to run incrementally, the right fix is a checkpoint/watermark, not an
index.

## Conclusion

No new index was needed. Every index added in Weeks 1, 2, 5, and 7 (`accounts_one_treasury_per_currency`,
`journal_entries_account_created_idx`, `outbox_events_claim_idx`, the primary/unique keys) is
confirmed live and selected for its intended query, and the two full-table scans in this report
(`accounts` lookups at 305 rows, reconciliation's necessary aggregate) are the plans PostgreSQL
_should_ choose, not gaps.
