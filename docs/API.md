# API reference

Every request and response below was captured from a real server
(`node dist/server.js`, PostgreSQL 17 in Docker) — none of it is illustrative. IDs and timestamps
are from that session, so the same account IDs recur across examples.

Base URL in all examples: `http://localhost:3000`. Set up a server first with the
[quick start](../README.md#quick-start).

## Conventions

| Concern       | Contract                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------- |
| Money         | Integer **minor units** as a decimal **string** (`"250000"` = ₹2,500.00). Never a JSON number.          |
| Amount range  | `1` … `9223372036854775807`. Zero, negative, fractional, and exponent forms are rejected.               |
| IDs           | UUID v4.                                                                                                |
| Timestamps    | RFC 3339 / ISO 8601 UTC.                                                                                |
| Request ID    | Send `x-request-id` to correlate logs; otherwise the server generates one. It is echoed in every error. |
| Idempotency   | `Idempotency-Key` header on `POST /v1/transfers`. Optional but strongly recommended.                    |
| Customer auth | `Authorization: Bearer pl_live_...` on every `/v1/accounts` and `/v1/transfers` route.                  |
| Admin auth    | `x-admin-api-key` header on `/v1/admin/*`. Compared in constant time.                                   |
| Ownership     | A principal sees and spends only its own accounts. Anything else answers `404`, never `403`.            |
| Currencies    | `INR`, `USD` (demo set; each has a seeded treasury account).                                            |
| Body limit    | 16 KiB by default (`REQUEST_BODY_LIMIT_BYTES`); larger bodies get `413 REQUEST_REJECTED`.               |

Errors always have the same shape:

```json
{
  "error": {
    "code": "INSUFFICIENT_FUNDS",
    "message": "Source account has insufficient funds",
    "requestId": "1978f0a2-f78f-48f9-9416-e2f37e3a5584"
  }
}
```

## Endpoints

| Method | Path                                | Auth     | Purpose                               |
| ------ | ----------------------------------- | -------- | ------------------------------------- |
| `POST` | `/v1/accounts`                      | Customer | Create a zero-balance account you own |
| `GET`  | `/v1/accounts/:id`                  | Customer | Read one of your accounts             |
| `GET`  | `/v1/accounts/:id/entries`          | Customer | Cursor-paginated journal entries      |
| `POST` | `/v1/transfers`                     | Customer | Move money from an account you own    |
| `GET`  | `/v1/transfers/:id`                 | Customer | Read a transfer you took part in      |
| `POST` | `/v1/admin/principals`              | Admin    | Create a customer identity            |
| `POST` | `/v1/admin/principals/:id/api-keys` | Admin    | Issue an API key (secret shown once)  |
| `POST` | `/v1/admin/api-keys/:id/revoke`     | Admin    | Revoke a key immediately              |
| `POST` | `/v1/admin/fund`                    | Admin    | Fund a demo account from its treasury |
| `POST` | `/v1/admin/reconcile`               | Admin    | Recompute balances from the journal   |
| `GET`  | `/v1/admin/metrics`                 | Admin    | In-process transfer counters          |
| `GET`  | `/health/live`                      | —        | Liveness (never touches PostgreSQL)   |
| `GET`  | `/health/ready`                     | —        | Readiness + outbox backlog            |

---

## Authentication

Health checks are the only unauthenticated routes. Everything else needs one of two credentials,
and they are not interchangeable: a customer key cannot reach `/v1/admin/*`, and the admin key is
not a customer credential.

Both guards run **before body validation**, so an anonymous caller gets `401` rather than schema
feedback.

### Getting a key

```bash
curl -X POST http://localhost:3000/v1/admin/principals \
  -H 'content-type: application/json' \
  -H "x-admin-api-key: $ADMIN_API_KEY" \
  -d '{"name":"acme-payments"}'
```

```json
{
  "id": "23a2ecc9-1a04-4d41-af25-b3e3ea84b7bf",
  "name": "acme-payments",
  "status": "active",
  "createdAt": "2026-08-16T16:55:02.426Z"
}
```

```bash
curl -X POST http://localhost:3000/v1/admin/principals/23a2ecc9-.../api-keys \
  -H "x-admin-api-key: $ADMIN_API_KEY"
```

```json
{
  "id": "b5ea5a09-7fa1-4078-aa05-af66ce7ead5b",
  "principalId": "9eb82ac7-788a-4061-8b69-efe4b3810006",
  "keyPrefix": "_2ZUdpDEGB79",
  "key": "pl_live__2ZUdpDEGB79i5fTShKycZMeEzuTC99IeLz7hFRKc_M",
  "createdAt": "2026-08-16T16:54:56.951Z",
  "revokedAt": null
}
```

`key` is the only time the secret exists outside the caller: the database stores its SHA-256 hash
and the 12-character `keyPrefix` used to find the row. Losing it means issuing a new one.

### Using a key

```bash
curl http://localhost:3000/v1/accounts/97a673f8-... \
  -H 'authorization: Bearer pl_live__2ZUdpDEGB79i5fTShKycZMeEzuTC99IeLz7hFRKc_M'
```

### Revoking a key

```bash
curl -X POST http://localhost:3000/v1/admin/api-keys/98dbf04a-.../revoke \
  -H "x-admin-api-key: $ADMIN_API_KEY"
```

```json
{ "id": "98dbf04a-b193-4b2a-94a8-9b5bad9b3ecd", "revoked": true }
```

Revocation takes effect on the next request — there is no token lifetime to wait out. Revoking an
already-revoked key succeeds and keeps the original timestamp.

### Rejections

Missing, malformed, or wrong-scheme headers:

```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Missing or malformed Authorization header",
    "requestId": "08f1ce4a-a221-4382-8929-0c343a42cc7a"
  }
}
```

An unknown, mistyped, revoked, or disabled-principal key — deliberately one message for all four,
so a caller cannot probe which of them it hit:

```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Invalid API key",
    "requestId": "73f5f62d-c7bb-4609-a810-9bbe0f20d08f"
  }
}
```

## Ownership

An account belongs to the principal that created it, permanently. Reading or spending from someone
else's account answers exactly as if it did not exist:

```bash
curl http://localhost:3000/v1/accounts/72ee4cff-... -H "authorization: Bearer $OTHER_KEY"
```

```json
{
  "error": {
    "code": "ACCOUNT_NOT_FOUND",
    "message": "Account not found",
    "requestId": "ea4df905-9891-442e-bf7b-8c2cc3039575"
  }
}
```

- **You may pay anyone.** Only the source account must be yours; the destination may belong to any
  principal.
- **A transfer is readable by both participants**, and by nobody else (`404 TRANSFER_NOT_FOUND`).
- **Idempotency keys are per principal.** Two callers may both use `order-42` without colliding, and
  neither can replay the other's response.

---

## `POST /v1/accounts`

```bash
curl -i -X POST http://localhost:3000/v1/accounts \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $CUSTOMER_KEY" \
  -H 'x-request-id: docs-create-account' \
  -d '{"currency":"INR"}'
```

```http
HTTP/1.1 201 Created
content-type: application/json; charset=utf-8

{
  "id": "f5214f9c-1659-40bc-856a-f20c1e9ccee2",
  "currency": "INR",
  "status": "active",
  "balanceMinor": "0",
  "createdAt": "2026-08-16T10:29:20.334Z"
}
```

New accounts always start at `"0"`. There is no API that sets a balance directly — money only
enters through a journaled treasury posting (`/v1/admin/fund`).

## `GET /v1/accounts/:id`

```bash
curl http://localhost:3000/v1/accounts/97a673f8-be2c-4226-a61e-6718e645b594 \
  -H "authorization: Bearer $CUSTOMER_KEY"
```

```json
{
  "id": "97a673f8-be2c-4226-a61e-6718e645b594",
  "currency": "INR",
  "status": "active",
  "balanceMinor": "250000",
  "createdAt": "2026-08-16T10:29:20.116Z"
}
```

`404 ACCOUNT_NOT_FOUND` for an unknown ID, for a treasury account (deliberately invisible to the
customer endpoint), and for an account owned by another principal.

## `GET /v1/accounts/:id/entries`

Keyset pagination over the immutable journal. `limit` defaults to 20 and is capped at 100.

```bash
curl "http://localhost:3000/v1/accounts/97a673f8-.../entries?limit=2" \
  -H "authorization: Bearer $CUSTOMER_KEY"
```

```json
{
  "entries": [
    {
      "id": "561b1567-34f9-49d9-a2e1-84cfd310cb92",
      "transactionId": "f07d950a-d6c6-4537-a315-a266c3377998",
      "direction": "debit",
      "amountMinor": "250000",
      "currency": "INR",
      "createdAt": "2026-08-16T10:29:20.700Z"
    },
    {
      "id": "20e3ebfd-b532-4d16-9c2b-fe077d06f7a2",
      "transactionId": "73c606e2-6a4e-4905-8fbc-846d8c918252",
      "direction": "credit",
      "amountMinor": "75000",
      "currency": "INR",
      "createdAt": "2026-08-16T10:29:20.883Z"
    }
  ],
  "nextCursor": "eyJjcmVhdGVkQXQiOiIyMDI2LTA4LTE2VDEwOjI5OjIwLjg4MzYyMFoiLCJpZCI6IjIwZTNlYmZkLWI1MzItNGQxNi05YzJiLWZlMDc3ZDA2ZjdhMiJ9"
}
```

Pass that opaque cursor back to get the next page; the last page returns `"nextCursor": null`:

```bash
curl "http://localhost:3000/v1/accounts/97a673f8-.../entries?limit=2&cursor=eyJjcmVhdGVkQXQiOi..."
```

```json
{
  "entries": [
    {
      "id": "8b374631-adcb-4048-8b1c-e3a45411de60",
      "transactionId": "b358b56b-2337-4ae1-bba7-516d2392045d",
      "direction": "credit",
      "amountMinor": "1000",
      "currency": "INR",
      "createdAt": "2026-08-16T10:29:21.124Z"
    }
  ],
  "nextCursor": null
}
```

A tampered or truncated cursor is rejected rather than silently reinterpreted:

```json
{
  "error": {
    "code": "INVALID_CURSOR",
    "message": "Cursor is malformed",
    "requestId": "fcfc5690-1e74-4ca4-a991-67560a6aa96d"
  }
}
```

Read `direction` with the asset-account convention: **debit increases** this account's balance,
**credit decreases** it (ADR-001).

## `POST /v1/admin/fund`

Demo-only. Posts a balanced funding transaction: debit the customer, credit the currency treasury.

```bash
curl -X POST http://localhost:3000/v1/admin/fund \
  -H 'content-type: application/json' \
  -H "x-admin-api-key: $ADMIN_API_KEY" \
  -d '{"accountId":"97a673f8-be2c-4226-a61e-6718e645b594","amountMinor":"250000"}'
```

```json
{
  "id": "f07d950a-d6c6-4537-a315-a266c3377998",
  "type": "funding",
  "reference": "funding:f07d950a-d6c6-4537-a315-a266c3377998",
  "currency": "INR",
  "createdAt": "2026-08-16T10:29:20.700Z",
  "amountMinor": "250000",
  "fundedAccountId": "97a673f8-be2c-4226-a61e-6718e645b594"
}
```

Without a valid key:

```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Missing admin API key",
    "requestId": "23f54ff4-..."
  }
}
```

```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Invalid admin API key",
    "requestId": "cc2475f9-..."
  }
}
```

Both are `401`. The treasury's balance goes negative by design — the demo system conserves total
value while funding zero-balance customers.

## `POST /v1/transfers`

```bash
curl -X POST http://localhost:3000/v1/transfers \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $CUSTOMER_KEY" \
  -H 'idempotency-key: docs-demo-key-1' \
  -d '{
        "sourceAccountId":"97a673f8-be2c-4226-a61e-6718e645b594",
        "destinationAccountId":"184714b5-4832-466d-9c03-9082bdeb384d",
        "amountMinor":"75000"
      }'
```

```http
HTTP/1.1 201 Created

{
  "id": "73c606e2-6a4e-4905-8fbc-846d8c918252",
  "sourceAccountId": "97a673f8-be2c-4226-a61e-6718e645b594",
  "destinationAccountId": "184714b5-4832-466d-9c03-9082bdeb384d",
  "amountMinor": "75000",
  "currency": "INR",
  "status": "completed",
  "reference": "transfer:73c606e2-6a4e-4905-8fbc-846d8c918252",
  "createdAt": "2026-08-16T10:29:20.883Z"
}
```

### Replay: same key, same body

Byte-for-byte the same response, including the original `id` and `createdAt`. No second transfer
exists, and no balance moved twice.

```http
HTTP/1.1 201 Created

{
  "id": "73c606e2-6a4e-4905-8fbc-846d8c918252",
  ...
  "createdAt": "2026-08-16T10:29:20.883Z"
}
```

### Conflict: same key, different body

```bash
# same idempotency-key, amountMinor changed to "1"
```

```http
HTTP/1.1 409 Conflict

{
  "error": {
    "code": "IDEMPOTENCY_CONFLICT",
    "message": "Duplicate idempotency key with a different request body",
    "requestId": "5a0d144f-403e-4424-a3c2-3574edee7451"
  }
}
```

### Race: same key, still in flight

A concurrent duplicate that arrives while the first request is still committing gets `409
IDEMPOTENCY_IN_PROGRESS` immediately rather than blocking. Retry it and you will get the replayed
`201`. A claim stuck `in_progress` for more than 30 seconds (a crashed request) is reclaimed by the
next retry.

### Failure responses

| Status | Code                       | Cause                                                   |
| -----: | -------------------------- | ------------------------------------------------------- |
|  `400` | `VALIDATION_ERROR`         | Schema violation — e.g. `"amountMinor":"10.50"`         |
|  `400` | `SELF_TRANSFER`            | Source and destination are the same account             |
|  `400` | `CURRENCY_MISMATCH`        | Accounts hold different currencies                      |
|  `400` | `INVALID_AMOUNT`           | Amount outside `1 … 9223372036854775807`                |
|  `404` | `ACCOUNT_NOT_FOUND`        | Unknown account, or a treasury account                  |
|  `409` | `ACCOUNT_NOT_ACTIVE`       | Either account is `frozen` or `closed`                  |
|  `409` | `INSUFFICIENT_FUNDS`       | Source balance below the amount — **nothing is posted** |
|  `409` | `IDEMPOTENCY_CONFLICT`     | Key reused with a different body                        |
|  `409` | `IDEMPOTENCY_IN_PROGRESS`  | Identical request still in flight                       |
|  `413` | `REQUEST_REJECTED`         | Body above `REQUEST_BODY_LIMIT_BYTES`                   |
|  `503` | `TRANSFER_RETRY_EXHAUSTED` | 12 serialization retries exhausted under contention     |

```json
{
  "error": {
    "code": "INSUFFICIENT_FUNDS",
    "message": "Source account has insufficient funds",
    "requestId": "1978f0a2-f78f-48f9-9416-e2f37e3a5584"
  }
}
```

`503 TRANSFER_RETRY_EXHAUSTED` is a **safe** failure: the transaction rolled back, so it is always
correct to retry it (with the same `Idempotency-Key`).

## `GET /v1/transfers/:id`

```bash
curl http://localhost:3000/v1/transfers/b358b56b-2337-4ae1-bba7-516d2392045d \
  -H "authorization: Bearer $CUSTOMER_KEY"
```

```json
{
  "id": "b358b56b-2337-4ae1-bba7-516d2392045d",
  "sourceAccountId": "97a673f8-be2c-4226-a61e-6718e645b594",
  "destinationAccountId": "184714b5-4832-466d-9c03-9082bdeb384d",
  "amountMinor": "1000",
  "currency": "INR",
  "status": "completed",
  "reference": "transfer:b358b56b-2337-4ae1-bba7-516d2392045d",
  "createdAt": "2026-08-16T10:29:21.124Z"
}
```

`reference` and `createdAt` are read from the immutable `ledger_transactions` row, not duplicated in
the projection — the lookup response is identical to the creation response. Readable by the owner of
either account involved; `404 TRANSFER_NOT_FOUND` for anyone else, and for an unknown ID.

## `POST /v1/admin/reconcile`

Recomputes every account's balance from `journal_entries` and compares it with the cached value.
Read-only: it reports drift, it never repairs it.

```bash
curl -X POST http://localhost:3000/v1/admin/reconcile -H "x-admin-api-key: $ADMIN_API_KEY"
```

```json
{
  "ok": true,
  "accountsChecked": 6,
  "generatedAt": "2026-08-16T10:29:22.164Z",
  "issues": []
}
```

With drift present, `ok` is `false` and each issue names the account and both numbers:

```json
{
  "ok": false,
  "accountsChecked": 6,
  "generatedAt": "2026-08-16T10:30:47.784Z",
  "issues": [
    {
      "accountId": "97a673f8-be2c-4226-a61e-6718e645b594",
      "type": "mismatched",
      "cachedBalanceMinor": "174001",
      "computedBalanceMinor": "174000",
      "currency": "INR"
    }
  ]
}
```

Issue types: `mismatched` (both sides exist and disagree), `missing` (nonzero cached balance with no
journal behind it), `unexpected` (journal entries for an account row that does not exist).

## `GET /v1/admin/metrics`

```bash
curl http://localhost:3000/v1/admin/metrics -H "x-admin-api-key: $ADMIN_API_KEY"
```

```json
{ "transfers": { "completed": 2, "retries": 0, "exhausted": 0 } }
```

In-process counters since start (not persisted): completed transfers, serialization retries, and
retry budgets exhausted. The benchmark report reads these before and after each scenario.

## `GET /health/live` and `GET /health/ready`

```bash
curl http://localhost:3000/health/live    # {"status":"ok"} — never queries PostgreSQL
curl http://localhost:3000/health/ready
```

```json
{ "status": "ready", "outbox": { "pending": 0, "processing": 0, "failed": 0 } }
```

Readiness runs a real `SELECT 1` and reports the outbox backlog, so a stuck worker is visible
without a database session. It returns `503 {"status":"unavailable"}` when PostgreSQL is unreachable.

## Unknown routes

```json
{
  "error": {
    "code": "ROUTE_NOT_FOUND",
    "message": "Route not found",
    "requestId": "e457de66-7c64-4fdb-83dd-23abdd0af529"
  }
}
```
