# PulseLedger

PulseLedger is a correctness-first payment ledger designed to remain safe under concurrent transfers, request retries, and worker failures.

This repository is currently in **Week 1: foundation**. The detailed execution plan is in [PROJECT_PLAN.md](./PROJECT_PLAN.md), and all implementation work follows [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md).

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

## Week 1 API

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

Supported demo currencies are `INR` and `USD`. The migration seeds a hidden treasury account for each currency; the Week 2 ledger will use those accounts for balanced demo funding.

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
- Errors use stable machine codes and include a request ID.
- Liveness is independent of PostgreSQL; readiness verifies a live query.

Double-entry posting, transfers, idempotency, the transactional outbox, reconciliation, and benchmarks are delivered in later weekly gates defined by the project plan.
