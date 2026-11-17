# PulseLedger: Weeks 3–8 and later, interview Q&A

This is the practice set for [`weeks-3-8-study-guide.md`](./weeks-3-8-study-guide.md). It uses the
same format as [`weeks-1-2-interview-qa.md`](./weeks-1-2-interview-qa.md):
🟢 warm-up · 🟡 standard · 🔴 deep dive. Answer out loud first, then check.

---

## A. Concurrency and transfers

### A1 🟢 Walk me through what happens when I POST a transfer.

The auth guard resolves the principal, and then the idempotency key (if any) is claimed. Next the
service validates the amount and rejects a self-transfer. Then it opens a `SERIALIZABLE`
transaction, locks both accounts `ORDER BY id FOR UPDATE`, and checks ownership, status, currency,
and balance against the locked rows. It then calls `post_ledger_transaction` (journal entries plus
cached balances), inserts the `transfers` projection and the `transfer.created` outbox event,
completes the idempotency record, and commits once. Serialization failures and deadlocks are
retried up to 12 times.

### A2 🔴 You lock rows with `FOR UPDATE`. Why also `SERIALIZABLE`?

Row locks protect the rows you lock. `SERIALIZABLE` (PostgreSQL SSI) also catches anomalies that
come from what you _read_ without locking, plus any future query in the transaction that reads
more. It's defense in depth: the locks make the common case conflict-free and ordered, and SSI
guarantees the outcome equals _some_ serial order or the transaction aborts with `40001`. The cost
is some aborts under contention, which the retry loop absorbs.

### A3 🔴 How do you prevent deadlocks?

Every transaction acquires account locks in the same global order (ascending UUID), both in the app
(`deterministicAccountOrder`, `ORDER BY id`) and in the SQL posting function. A deadlock needs a
cycle, and a total order on acquisition makes a cycle impossible. `40P01` is still in the retry set
as a safety net.

### A4 🟡 Which errors do you retry, and why not all of them?

Only `40001` (serialization_failure) and `40P01` (deadlock_detected). Those mean "nothing happened,
try again". Business errors such as `INSUFFICIENT_FUNDS` are correct answers, and retrying them is
wasted work that could later succeed for the wrong reason. Unknown errors aren't safe to assume
transient.

### A5 🟡 Describe the backoff.

`min(2ms × 2^(attempt-1), 50ms)` multiplied by a jitter factor in [0.5, 1.0], with at most 12
attempts. Exponential backoff spreads load out, the cap keeps latency bounded, and jitter stops
retrying clients from colliding again in lockstep.

### A6 🔴 Why is the transfer ID generated outside the retry loop?

Every attempt is the same _logical_ transfer. `ledger_transactions.reference` is `UNIQUE`, so even
in a weird failure (a commit whose acknowledgement was lost) a second attempt can't post a second
copy.

### A7 🔴 Why check ownership inside the transaction instead of in the route?

TOCTOU (time-of-check to time-of-use). Ownership is immutable today, but the principle is to make
every decision against the locked row you're about to write. That also keeps all transfer
authorization in one place.

### A8 🟡 What does the client see when contention is extreme?

`503 TRANSFER_RETRY_EXHAUSTED`. The system chooses being unavailable over being incorrect. In k6 at
75 VUs on one hot account, 17.1% of requests got bounded 503s, and that number is reported in the
README rather than hidden.

### A9 🔴 How would you scale writes to a single hot account?

Options include sharding the balance into N sub-accounts (sum on read), batching or queuing debits
to that account through a single writer, or relaxing the cached balance into an asynchronous
projection with reservation semantics. Each one trades away the simple "one row, one lock" model,
which is why v1 accepts the contention cost instead (see the `SERIALIZABLE` row in
`TRADEOFFS.md`).

### A10 🟡 What's the `transfers` table for if the journal is authoritative?

It's a read-optimized projection of transfer-shaped facts. A composite FK
`(id, currency, ledger_type) → ledger_transactions(id, currency, type)` means it can't drift from
the ledger, and `created_at` is read from the ledger row rather than duplicated.

---

## B. Idempotency

### B1 🟢 What problem does an idempotency key solve?

A client that times out can't tell whether the payment happened. With a key it can safely retry:
the server runs the payment at most once and replays the original response.

### B2 🟡 How do you detect "same key, different request"?

SHA-256 of the canonical JSON body (keys sorted recursively) is stored as `request_fingerprint`. A
mismatch returns `409 IDEMPOTENCY_CONFLICT`.

### B3 🔴 50 identical requests arrive at the same millisecond. What happens?

All 50 run `INSERT ... ON CONFLICT DO NOTHING`. Exactly one gets a row back and proceeds. The other
49 read the existing row and get either `409 IDEMPOTENCY_IN_PROGRESS` (still running) or the replay
of the stored 201 (if it finished). Proven by _handles 50 concurrent identical requests creating
exactly one transfer_ and by the k6 duplicate-storm scenario.

### B4 🔴 What if the request that claimed the key crashes?

The row stays `in_progress`. After 30 seconds it's stale and a retry can reclaim it, but only
through a conditional `UPDATE ... WHERE status='in_progress' AND created_at < threshold RETURNING`.
Only the caller whose UPDATE returned a row proceeds.

### B5 🔴 Tell me about a real bug you fixed here.

Reclaiming a stale claim used to run an UPDATE without checking whether it matched, then re-read
the row and proceed if it was `in_progress`. Under concurrency **every** reclaimer proceeded, so one
key posted several transfers. I fixed it in two layers. First, `RETURNING` decides ownership.
Second, as a backstop, the money transaction itself completes the key with `WHERE
status='in_progress'` and requires `rowCount === 1`, otherwise it throws and rolls back the money.
After that, the guarantee doesn't depend on the claim code being correct.

### B6 🟡 The transfer fails with insufficient funds. What happens to the key?

A deterministic 4xx is stored as the key's completed result and replayed to every retry, even after
the account is topped up. "Same key, same answer" is the contract. A 5xx or retry exhaustion
releases the key instead, so the client can retry immediately.

### B7 🟡 Why is completion written inside the transfer transaction?

If it were written afterwards, a crash between the commit and the write would leave money moved but
the key `in_progress`. After 30 seconds a retry would reclaim it and pay again. Committing them
together removes that window.

### B8 🟡 Why are keys scoped per principal?

Clients choose keys. Two customers may both use `order-42`. With a global key space, one would get
a false conflict or, worse, replay the other's response. The unique index is `(principal_id, key,
operation) NULLS NOT DISTINCT`. The NULL part keeps pre-auth rows deduplicating against each other.

### B9 🔴 Admin funding has no principal. How is it idempotent?

Migration `011` seeds a fixed, **disabled** `system-administrator` principal that owns admin
idempotency keys. It can never authenticate. It exists only to give those keys a namespace, which
avoids a NULL special case in every query.

### B10 🟡 How long are idempotency records kept?

Completed records are kept for 7 days by default, then removed by the retention sweep in bounded
batches. `in_progress` rows are never swept, because deleting one would hand a duplicate request a
clean claim.

---

## C. Outbox and consumer

### C1 🟢 What is the transactional outbox pattern?

You write the event as a row in the same DB transaction as the business change, and a separate
process delivers it. That removes the dual-write problem.

### C2 🔴 Explain `FOR UPDATE SKIP LOCKED` in your claim query.

`FOR UPDATE` locks the selected rows so they can be moved to `processing`. `SKIP LOCKED` makes a
second worker skip rows another worker holds instead of blocking on them. N workers can claim
disjoint batches in parallel with no coordinator.

### C3 🔴 A worker crashes after claiming. How is the event not lost?

The claim pushes `next_attempt_at` 300 seconds ahead (a lease). The claim query includes
`processing` rows whose lease has expired, so another worker or the restarted one reclaims it.

### C4 🟡 So delivery is exactly-once?

No. It's at-least-once: a crash after the handler succeeds but before `markProcessed` causes
redelivery. Exactly-once _effect_ comes from the idempotent consumer.

### C5 🔴 How does the consumer guarantee one effect?

In one transaction it runs `INSERT INTO consumer_inbox(consumer_name, event_id) ON CONFLICT DO
NOTHING RETURNING`. No row means a duplicate, which is a successful no-op. A row means it inserts
the `audit_effects` row in the same transaction, so the claim and the effect commit together. Proof:
1,000 duplicate deliveries produce one effect.

### C6 🟡 What happens to an event that keeps failing?

It gets exponential backoff (100 ms → 60 s cap, jittered). After 12 attempts it's **parked** with
`status='failed', next_attempt_at='infinity'`, which the claim query never matches. An operator
inspects it with `npm run outbox list/show` and runs `replay <id>`, which resets `attempts` but
keeps `last_error`.

### C7 🔴 Why not Kafka or RabbitMQ?

At this scale PostgreSQL already provides durable, transactional, lockable rows, so a broker would
add a second system that must agree with the first, which is the dual-write problem again. The
outbox table is the queue. ADR-004 keeps the door open: the worker boundary is designed so a broker
can be added later as a downstream fan-out from the same outbox table.

### C8 🟡 Why include `consumer_name` in the inbox key?

So more consumers can be added later, each deduplicating independently against the same event IDs.

### C9 🟡 How does shutdown avoid breaking an in-flight batch?

`worker.stop()` stops scheduling and **awaits the in-flight poll**. Only then does the app close and
the pool end. Otherwise the batch would be redelivered only after the 5-minute lease.

---

## D. Reconciliation

### D1 🟢 Why have reconciliation if everything is transactional?

Defense in depth. The cached balance is denormalized, and a bug, a manual SQL fix, or a bad
migration could make it drift. Reconciliation recomputes balances from the immutable journal and
compares.

### D2 🟡 Why doesn't it auto-repair?

Drift means something is wrong that you don't understand yet. Silently overwriting the cache hides
the evidence. Corrections must be journaled postings that a human decides on.

### D3 🔴 Why a FULL OUTER JOIN?

To catch both directions of error: accounts with a balance but no journal (`missing`) and journal
entries with no account (`unexpected`). A LEFT or INNER join would miss one of them.

### D4 🟡 How would you run it in production?

As `npm run reconcile` on a schedule. It exits non-zero on any issue, so the scheduler can alert.
For large ledgers, run it incrementally against checkpoints or on a replica.

---

## E. Authentication and authorization

### E1 🟢 How do customers authenticate?

`Authorization: Bearer <secret>`, where the secret is either a PulseLedger API key (`pl_live_…`) or,
when enabled, a Firebase ID token. Admins use a separate `x-admin-api-key` header.

### E2 🔴 How are API keys stored and verified?

Only a 12-character public prefix and the SHA-256 of the whole secret are stored. Verification is a
lookup by the unique prefix (one indexed read), a hash of the presented secret, a `timingSafeEqual`
comparison, and a check that the principal is active. The secret is shown once at issue time.

### E3 🔴 Why SHA-256 and not bcrypt or argon2?

Slow hashes defend low-entropy human passwords against dictionary attacks. These secrets are 256
bits of CSPRNG output, which is infeasible to brute-force with any hash. A slow hash would only add
latency to every request.

### E4 🟡 Why one error message for every auth failure?

So an attacker can't learn whether a prefix exists, a key was revoked, or a principal is disabled.

### E5 🔴 Why does auth run on `onRequest` and not `preHandler`?

Fastify validates the body before `preHandler`. An anonymous caller would get 400 schema errors and
could map the API's request shapes without credentials. `onRequest` runs before parsing.

### E6 🔴 Why 404 instead of 403 for someone else's account?

A 403 confirms the account exists, which lets an attacker enumerate IDs. Ownership is in the
`WHERE` clause, so "not yours" and "doesn't exist" are the same row-not-found result.

### E7 🟡 What stops an account from changing owner?

The database. `owner_principal_id` is `NOT NULL` for customer accounts (CHECK) and immutable
(trigger). Changing control would have to be a new account plus a journaled transfer.

### E8 🟡 How are route files kept unaware of auth?

Guards are registered only in `app.ts`, inside encapsulated Fastify child contexts (one for
customers, one for admins). Routes just read `request.principalId`. `npm run architecture:check`
stops infrastructure from importing features.

---

## F. Firebase sign-in (unreleased)

### F1 🟢 Why add Firebase when API keys exist?

API keys suit programs. People need "Sign in with Google" or email/password for the web UI. Firebase
provides that without the backend running a password store.

### F2 🔴 How do you verify a Firebase ID token without the Admin SDK?

With `jose`: an RS256 signature against Google's published JWKS (cached), `iss =
https://securetoken.google.com/<project>`, `aud = <project>`, `exp` in the future, `iat` and
`auth_time` in the past, and `sub` of 1–128 characters. No service-account secret is needed.

### F3 🔴 Two first sign-ins from the same new user arrive at once. What happens?

Each opens a transaction, inserts a principal, then inserts the mapping `ON CONFLICT (provider,
subject) DO NOTHING`. One wins. The loser gets zero rows, throws, which **rolls back its own
principal**, and then reads the winner's. There is no orphan and no duplicate. Proof: _turns 20
simultaneous first sign-ins into exactly one principal_.

### F4 🟡 Why map by `sub` and not email?

Emails change and get reassigned, while `sub` is the provider's stable user ID. Keying by email
could hand someone else's money to a new owner of a recycled address.

### F5 🟡 Why reject unverified emails, and why before lookup?

Otherwise anyone could sign up as `ceo@company.com` with a password and get a principal. Checking
first means nothing is ever created for an unverified identity.

### F6 🔴 Why is a JWKS fetch failure a 503 and not a 401?

401 means "your credential is bad, sign in again", and that's false when Google's key endpoint is
down. 503 tells the client to retry. Only errors about the token itself map to 401.

### F7 🟡 How do you decide between the API-key path and the Firebase path?

By shape. A secret starting with `pl_live_` is an API key. Anything else is a Firebase token, but
only when `FIREBASE_PROJECT_ID` is configured. With Firebase off, behavior is unchanged.

### F8 🟡 What did sanitizing display names fix?

A NUL character in a Google display name made PostgreSQL reject the `text` insert, so that user's
first sign-in returned 500 every time. Control characters and lone surrogates are now stripped, and
names are truncated by code point so emojis aren't split.

---

## G. Operations, reliability, hardening

### G1 🟡 What may the retention job delete, and what may it never delete?

It may delete processed outbox events (default 30 days) and completed idempotency records (default
7 days). It may never delete `consumer_inbox` (the dedup memory) or `audit_effects` (the audit
trail); both are append-only in the DB anyway. It also never deletes `in_progress` or unprocessed
rows.

### G2 🟡 Why delete in bounded batches?

A first sweep over a large table in one `DELETE` would hold locks and generate WAL for minutes.
Batches of 1,000 keep each statement short, so it's safe to run during live traffic.

### G3 🟡 Why partial indexes for retention?

The index then only covers rows a sweep can touch (`WHERE status='processed'`, etc.). It stays
small and doesn't grow with live traffic.

### G4 🟡 Liveness vs. readiness?

Liveness never touches the DB, because restarting the app won't fix a DB outage. Readiness runs
`SELECT 1` and reports the outbox backlog. These are the only unauthenticated routes.

### G5 🔴 Why does `createPool` always attach an `error` listener?

An idle client dropped by PostgreSQL (failover, admin kill) emits `error` on the pool. On an
EventEmitter with no listener that's an uncaught exception, which crashes the whole process while
every in-flight transaction was fine.

### G6 🔴 What does `withTransaction` do that a naive try/catch doesn't?

If `ROLLBACK` itself fails, the original error is still the one thrown, and the connection is
released **with an error** so the pool destroys it. Otherwise a connection stuck in an aborted
transaction would go back into the pool and fail the next unrelated request.

### G7 🟡 Why is `/metrics` behind the admin key?

The backlog and throughput of a payments system are sensitive. A Prometheus scrape config can send
a header.

### G8 🟡 How do you keep secrets out of logs?

Pino `redact` on `authorization`, `x-admin-api-key`, `cookie`, and `set-cookie`, always on when
logging is enabled. The API-key secret is never stored, and the admin key is only compared.

---

## H. Testing and evidence

### H1 🟡 How do you prove concurrency correctness instead of just claiming it?

Integration tests against real PostgreSQL (Testcontainers) fire truly concurrent requests: two
overspends where only one commits, a hot account that never goes negative, opposing transfers that
conserve totals, and a final state that matches a sequential reference model. k6 load runs follow,
and reconciliation runs after them.

### H2 🔴 How do you test crash recovery?

Stop the worker after the commit but before processing, restart, and assert exactly one effect.
Stop after `markProcessed` and assert no redelivery. `scripts/demo.sh` `SIGKILL`s the real process
mid-flight.

### H3 🟡 What does the benchmark actually tell you?

Throughput is limited by `SERIALIZABLE` retries competing for DB CPU, not by app code. Every non-2xx
equals a retry-exhausted count exactly, so nothing fails silently. Correctness held: zero drift
across 707 reconciled accounts.

---

## I. Rapid-fire one-liners

- **Lock order?** Ascending account UUID.
- **Retry codes?** `40001`, `40P01`.
- **Max transfer attempts?** 12.
- **Idempotency unique key?** `(principal_id, key, operation)`.
- **Stale claim window?** 30 seconds.
- **Outbox delivery?** At-least-once. Effect: once, through the inbox.
- **Parked event marker?** `status='failed'`, `next_attempt_at='infinity'`.
- **Outbox lease?** 300 seconds.
- **API key storage?** 12-char prefix + SHA-256. The secret is never stored.
- **Wrong owner?** 404, not 403.
- **Firebase mapping key?** `(provider, sub)`, never email.
- **Can reconciliation fix drift?** No. It reports only.
- **Tables never swept?** `consumer_inbox`, `audit_effects`.
