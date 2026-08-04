# PulseLedger

PulseLedger is a correctness-first payment ledger designed to remain safe under concurrent transfers, request retries, and worker failures.

This repository has completed **Week 3: serializable transfers and concurrency**. The detailed execution plan is in [PROJECT_PLAN.md](./PROJECT_PLAN.md), and all implementation work follows [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md).

## Requirements

- Node.js 22 LTS or later
- npm
- Docker with Docker Compose

## Local setup

```bash
cp .env.example .env
npm install
docker compose up -d postgres
npm run db:migrate
npm run dev
```

The service listens on `http://localhost:3000` by default.

## Current API

Check liveness:

```bash
curl http://localhost:3000/health/live
```

Check PostgreSQL readiness:

```bash
curl http://localhost:3000/health/ready
```

Create a zero-balance customer account:

```bash
curl -X POST http://localhost:3000/v1/accounts \
  -H 'content-type: application/json' \
  -H 'x-request-id: local-example' \
  -d '{"currency":"INR"}'
```

Retrieve an account:

```bash
curl http://localhost:3000/v1/accounts/ACCOUNT_ID
```

Fund a demo account from its currency treasury:

```bash
curl -X POST http://localhost:3000/v1/admin/fund \
  -H 'content-type: application/json' \
  -d '{"accountId":"ACCOUNT_ID","amountMinor":"10000"}'
```

Transfer funds between two active accounts with the same currency:

```bash
curl -X POST http://localhost:3000/v1/transfers \
  -H 'content-type: application/json' \
  -d '{"sourceAccountId":"SOURCE_ID","destinationAccountId":"DESTINATION_ID","amountMinor":"2500"}'
```

Retrieve the stable transfer result:

```bash
curl http://localhost:3000/v1/transfers/TRANSFER_ID
```

Supported demo currencies are `INR` and `USD`. The migration seeds a hidden treasury account for each currency. Funding debits the customer asset account and credits the matching treasury in one balanced posting.

Balances are serialized as decimal strings because JavaScript numbers cannot safely represent every PostgreSQL `bigint` value.

## Development commands

```bash
npm run dev               # Start with file watching
npm run db:migrate        # Apply pending SQL migrations
npm run architecture:check # Enforce module dependency boundaries
npm run format:check      # Check formatting
npm run lint              # Run ESLint
npm run typecheck         # Run strict TypeScript checks
npm run test:unit         # Run tests without PostgreSQL
npm run test:integration  # Run real PostgreSQL tests
npm test                  # Run the complete test suite
npm run build             # Compile production JavaScript
npm run check             # Run the main local verification gate
```

Integration tests use `TEST_DATABASE_URL` when supplied. Otherwise, Testcontainers starts an isolated PostgreSQL 17 container.

## Current guarantees

- Configuration is validated before the server starts.
- Accounts have UUID identities, fixed ISO currency, status, and integer minor-unit balances.
- Customer accounts start at zero and cannot have a negative cached balance.
- Account identity, currency, and treasury designation are immutable in PostgreSQL.
- Money accepts only positive integer minor units up to the PostgreSQL `bigint` maximum.
- Every committed ledger transaction has equal debits and credits in one currency.
- Journal entries and finalized ledger transactions are append-only.
- Demo funding updates the journal and both cached balances atomically.
- Transfers run at `SERIALIZABLE` isolation and lock accounts in deterministic UUID order.
- Concurrent withdrawals cannot overdraw a customer account or create partial postings.
- Serialization and deadlock failures use a bounded 12-attempt retry policy with capped jittered backoff.
- Errors use stable machine codes and include a request ID.
- Liveness is independent of PostgreSQL; readiness verifies a live query.

Request idempotency, the transactional outbox, reconciliation, and benchmarks are delivered in later weekly gates defined by the project plan.
