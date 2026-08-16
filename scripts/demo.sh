#!/usr/bin/env bash
#
# PulseLedger three-minute demonstration.
#
# Proves the four v1 invariants against a real server and a real PostgreSQL, in the order they are
# presented in docs/DEMO.md. Every number printed is read back from the running system; nothing is
# hardcoded.
#
# Prerequisites (see README quick start):
#   docker compose up -d postgres && npm run db:migrate && npm run build
#
# Usage:
#   ADMIN_API_KEY=<key> ./scripts/demo.sh
#
# Environment:
#   ADMIN_API_KEY   required, >= 16 chars
#   DATABASE_URL    defaults to the compose database
#   PORT            defaults to 3900 (kept off 3000 so a dev server can stay up)
#   PSQL            how to reach psql; defaults to the compose container
set -euo pipefail

PORT="${PORT:-3900}"
BASE="http://localhost:${PORT}"
DATABASE_URL="${DATABASE_URL:-postgresql://pulseledger:pulseledger@localhost:5432/pulseledger}"
ADMIN_API_KEY="${ADMIN_API_KEY:?ADMIN_API_KEY is required (at least 16 characters)}"
PSQL="${PSQL:-docker compose exec -T postgres psql -U pulseledger -d pulseledger -tAc}"
# Step 3 kills the process before the outbox worker's first poll, so the demo starts with a poll
# interval slow enough to win that race by hand, then restarts with the production default.
SLOW_POLL_MS="${SLOW_POLL_MS:-15000}"
FAST_POLL_MS="${FAST_POLL_MS:-1000}"

SERVER_LOG="$(mktemp -t pulseledger-demo)"
SERVER_PID=""

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }
json() {
  node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const o=JSON.parse(d);console.log(process.argv[1].split(".").reduce((a,k)=>a[k],o));});' "$1"
}
sql() { $PSQL "$1"; }

start_server() {
  local pollMs="${1:-$FAST_POLL_MS}"
  DATABASE_URL="$DATABASE_URL" ADMIN_API_KEY="$ADMIN_API_KEY" PORT="$PORT" \
    NODE_ENV=production LOG_LEVEL=warn OUTBOX_POLL_INTERVAL_MS="$pollMs" \
    node dist/server.js >>"$SERVER_LOG" 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 1 40); do
    if curl -sf "$BASE/health/live" >/dev/null 2>&1; then return 0; fi
    sleep 0.25
  done
  echo "server did not become live; see $SERVER_LOG" >&2
  exit 1
}

stop_server() {
  local signal="${1:-TERM}"
  [ -n "$SERVER_PID" ] || return 0
  kill "-$signal" "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
  SERVER_PID=""
}

cleanup() { stop_server KILL; }
trap cleanup EXIT

admin() { curl -s -H "x-admin-api-key: $ADMIN_API_KEY" "$@"; }
# Customer routes need a customer credential; the admin key does not open them.
customer() { curl -s -H "authorization: Bearer $CUSTOMER_KEY" "$@"; }

# ---------------------------------------------------------------------------
bold "0. Start the server (outbox poll interval ${SLOW_POLL_MS} ms)"
start_server "$SLOW_POLL_MS"
note "ready: $(curl -s "$BASE/health/ready")"

# ---------------------------------------------------------------------------
bold "1. A principal, its API key, two accounts, one transfer  [invariant 1: debits == credits]"
PRINCIPAL=$(admin -X POST "$BASE/v1/admin/principals" -H 'content-type: application/json' \
  -d '{"name":"demo"}' | json id)
CUSTOMER_KEY=$(admin -X POST "$BASE/v1/admin/principals/$PRINCIPAL/api-keys" | json key)
note "principal=$PRINCIPAL"
note "api key=${CUSTOMER_KEY:0:20}...  (shown once; only its SHA-256 hash is stored)"
note "unauthenticated POST /v1/transfers -> HTTP $(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/transfers" -H 'content-type: application/json' -d '{}')"

ALICE=$(customer -X POST "$BASE/v1/accounts" -H 'content-type: application/json' -d '{"currency":"INR"}' | json id)
BOB=$(customer -X POST "$BASE/v1/accounts" -H 'content-type: application/json' -d '{"currency":"INR"}' | json id)
note "alice=$ALICE"
note "bob=$BOB"

admin -X POST "$BASE/v1/admin/fund" -H 'content-type: application/json' \
  -d "{\"accountId\":\"$ALICE\",\"amountMinor\":\"250000\"}" >/dev/null
note "funded alice with 250000 minor units from the INR treasury"

TRANSFER=$(customer -X POST "$BASE/v1/transfers" -H 'content-type: application/json' \
  -H "idempotency-key: demo-transfer-$$" \
  -d "{\"sourceAccountId\":\"$ALICE\",\"destinationAccountId\":\"$BOB\",\"amountMinor\":\"75000\"}")
note "transfer: $(echo "$TRANSFER" | json id) amount=$(echo "$TRANSFER" | json amountMinor)"
note "alice balance: $(customer "$BASE/v1/accounts/$ALICE" | json balanceMinor)"
note "bob   balance: $(customer "$BASE/v1/accounts/$BOB" | json balanceMinor)"
note "journal debits == credits for that transaction: $(sql "SELECT sum(CASE WHEN direction='debit' THEN amount_minor ELSE -amount_minor END) = 0 FROM journal_entries WHERE transaction_id = '$(echo "$TRANSFER" | json id)'")"

# ---------------------------------------------------------------------------
bold "2. 50 concurrent duplicates, one key  [invariant 3: one key, one result]"
BEFORE=$(admin "$BASE/v1/admin/metrics" | json transfers.completed)
KEY="demo-storm-$$"
RESULTS="$(mktemp -d -t pulseledger-storm)"
storm_pids=()
for i in $(seq 1 50); do
  curl -s -o /dev/null -w '%{http_code}\n' -X POST "$BASE/v1/transfers" \
    -H 'content-type: application/json' -H "authorization: Bearer $CUSTOMER_KEY" \
    -H "idempotency-key: $KEY" \
    -d "{\"sourceAccountId\":\"$ALICE\",\"destinationAccountId\":\"$BOB\",\"amountMinor\":\"1000\"}" \
    >"$RESULTS/$i" &
  storm_pids+=("$!")
done
# Wait for the 50 duplicates only -- a bare `wait` would also wait for the server process.
wait "${storm_pids[@]}"
AFTER=$(admin "$BASE/v1/admin/metrics" | json transfers.completed)
note "responses: $(cat "$RESULTS"/* | sort | uniq -c | tr -s ' \n' ' ')"
note "  201 = the original response, replayed; 409 = arrived while the original was still in flight"
note "transfers actually posted: $((AFTER - BEFORE))  (expected exactly 1)"
note "rows in transfers for that amount: $(sql "SELECT count(*) FROM transfers WHERE source_account_id='$ALICE' AND amount_minor=1000")"
rm -rf "$RESULTS"

# ---------------------------------------------------------------------------
bold "2b. Another principal cannot touch those accounts  [ownership]"
INTRUDER=$(admin -X POST "$BASE/v1/admin/principals" -H 'content-type: application/json' \
  -d '{"name":"intruder"}' | json id)
INTRUDER_KEY=$(admin -X POST "$BASE/v1/admin/principals/$INTRUDER/api-keys" | json key)
note "read alice's account      -> HTTP $(curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer $INTRUDER_KEY" "$BASE/v1/accounts/$ALICE")  (404: not 403, so it leaks nothing)"
note "read alice's entries      -> HTTP $(curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer $INTRUDER_KEY" "$BASE/v1/accounts/$ALICE/entries")"
# Built here rather than inline: inside "$( ... )" bash brace-expands a literal {a,b} into two
# arguments, which would send a malformed body and prove nothing about authorization.
INTRUDER_PAYLOAD="{\"sourceAccountId\":\"$ALICE\",\"destinationAccountId\":\"$BOB\",\"amountMinor\":\"1000\"}"
INTRUDER_SPEND=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/transfers" \
  -H 'content-type: application/json' -H "authorization: Bearer $INTRUDER_KEY" -d "$INTRUDER_PAYLOAD")
note "spend from alice's account-> HTTP $INTRUDER_SPEND"
note "alice balance unchanged:   $(customer "$BASE/v1/accounts/$ALICE" | json balanceMinor)"

# ---------------------------------------------------------------------------
bold "3. Kill the process mid-flight, restart  [invariant 4: at-least-once delivery, one effect]"
CRASH_TRANSFER=$(customer -X POST "$BASE/v1/transfers" -H 'content-type: application/json' \
  -d "{\"sourceAccountId\":\"$ALICE\",\"destinationAccountId\":\"$BOB\",\"amountMinor\":\"500\"}" | json id)
stop_server KILL
note "SIGKILLed the process (no graceful shutdown) right after the transfer committed"
note "outbox status for that event: $(sql "SELECT status FROM outbox_events WHERE aggregate_id='$CRASH_TRANSFER'")"
note "audit effects so far:         $(sql "SELECT count(*) FROM audit_effects WHERE aggregate_id='$CRASH_TRANSFER'")"

start_server "$FAST_POLL_MS"
note "restarted with the default ${FAST_POLL_MS} ms poll interval; waiting for the worker..."
for _ in $(seq 1 60); do
  [ "$(sql "SELECT count(*) FROM audit_effects WHERE aggregate_id='$CRASH_TRANSFER'")" = "1" ] && break
  sleep 1
done
note "outbox status now: $(sql "SELECT status FROM outbox_events WHERE aggregate_id='$CRASH_TRANSFER'")"
note "audit effects now: $(sql "SELECT count(*) FROM audit_effects WHERE aggregate_id='$CRASH_TRANSFER'")  (recovered without losing the event)"

note "forcing a redelivery of the same event (simulating an expired claim lease)..."
sql "UPDATE outbox_events SET status='pending', next_attempt_at=NULL WHERE aggregate_id='$CRASH_TRANSFER'" >/dev/null
for _ in $(seq 1 60); do
  [ "$(sql "SELECT status FROM outbox_events WHERE aggregate_id='$CRASH_TRANSFER'")" = "processed" ] && break
  sleep 1
done
note "redelivered, and audit effects still: $(sql "SELECT count(*) FROM audit_effects WHERE aggregate_id='$CRASH_TRANSFER'")  (consumer inbox deduped it)"

# ---------------------------------------------------------------------------
bold "4. Reconciliation  [invariant 2: the journal is the source of truth]"
REPORT=$(admin -X POST "$BASE/v1/admin/reconcile")
note "$REPORT"
note "ok=$(echo "$REPORT" | json ok) over $(echo "$REPORT" | json accountsChecked) accounts, recomputed from journal_entries alone"

# ---------------------------------------------------------------------------
bold "5. Measured load (from benchmarks/k6/RESULTS.md, not re-run here)"
note "normal-transfer:        4,129 requests, 134.4 req/s, p95 269.7 ms"
note "duplicate-storm:        50 concurrent identical requests -> exactly 1 transfer"
note "hot-account-contention: 21.5% bounded TRANSFER_RETRY_EXHAUSTED, zero overdrafts"
note "bottleneck: SERIALIZABLE conflict retries competing for a 2-vCPU Postgres container"

bold "Done. Server log: $SERVER_LOG"
