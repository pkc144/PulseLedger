# ADR-001: Double-entry accounting with integer minor units

- Status: Accepted
- Date: 2026-08-03

## Context

PulseLedger must preserve value exactly while Node.js, JSON, and PostgreSQL use different numeric representations. It must also reject partial, mixed-currency, mutable, or unbalanced financial records even if application validation is bypassed.

## Decision

Money is represented as a strictly positive integer count of currency minor units. HTTP requests and responses use canonical decimal strings, domain logic uses JavaScript `bigint`, and PostgreSQL uses `bigint`. The supported range is `1` through `9223372036854775807`; JavaScript `number` values and floating-point syntax are rejected.

Each business posting creates one `ledger_transactions` row and at least one debit plus one credit in `journal_entries`. All entries use the transaction currency. Under the asset-account convention used here:

- debit increases `accounts.balance_minor`;
- credit decreases `accounts.balance_minor`;
- treasury funding debits the customer and credits the treasury.

The application service validates amounts, currencies, and equal totals before calling its store port. PostgreSQL independently protects the same invariants with positive-amount and direction checks, composite currency foreign keys, and deferred constraint triggers that require equal debit and credit totals at commit.

The posting database function locks account rows in deterministic UUID order, inserts the transaction and entries, applies signed cached-balance deltas, and finalizes the transaction in one statement. Finalized transactions reject new entries. Ledger transaction and journal-entry updates or deletes are rejected by triggers. Corrections must be represented by new reversing postings rather than mutation.

## Consequences

- Decimal rounding and JavaScript safe-integer loss cannot affect stored money.
- The journal is authoritative and auditable; cached balances remain an atomic read optimization.
- Treasury balances may be negative so a closed demo system conserves its total value while funding zero-balance customers.
- PostgreSQL performs some deliberate invariant checks already performed by TypeScript, adding defense in depth.
- `bigint` arithmetic and decimal-string API fields require explicit conversion at boundaries.
- Transfers reuse the posting model with serializable isolation, insufficient-funds enforcement, and bounded retries as defined by ADR-002.

## Alternatives considered

- Floating-point money was rejected because binary floating point cannot represent many decimal values exactly.
- PostgreSQL `numeric` was not chosen for v1 because currencies use fixed minor units and bounded `bigint` arithmetic is simpler to validate and serialize.
- Application-only balance validation was rejected because direct SQL or a future code defect could otherwise commit invalid financial state.
- Mutable journal rows were rejected because they erase the audit trail; reversal postings preserve history.
