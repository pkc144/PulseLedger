# ADR-002: Serializable transfers, deterministic locking, and bounded retries

- Status: Accepted
- Date: 2026-08-03

## Context

Two valid requests can observe the same source balance concurrently and collectively spend more than is available. Opposing transfers can also deadlock if they lock the same accounts in different orders. PostgreSQL may abort serializable transactions even when application logic is correct, so callers need a safe, finite retry policy.

## Decision

Every customer transfer runs in an explicit PostgreSQL `SERIALIZABLE` transaction. Within each attempt, the transfer service:

1. locks both account rows with `SELECT ... ORDER BY id FOR UPDATE`;
2. validates that both accounts exist, are customers, are active, and use the same currency;
3. validates the source balance from the locked row;
4. posts an equal source credit and destination debit;
5. updates both cached balances and inserts the immutable transfer result;
6. commits once.

All workflows acquire account locks in ascending UUID order, regardless of transfer direction. The database's customer-balance check remains a second line of defense against negative balances.

Only SQLSTATE `40001` (serialization failure) and `40P01` (deadlock detected) are retried. Business errors and unknown database failures are returned immediately. The same generated transfer ID and reference are reused after a rollback.

The default retry policy permits at most 12 total attempts. Delay begins at 2 ms, doubles after each failure, caps at 50 ms, and applies 50–100% jitter. The maximum scheduled sleep is therefore bounded at 362 ms, excluding database execution and connection acquisition time. Exhaustion returns `TRANSFER_RETRY_EXHAUSTED` with HTTP 503.

Every retry logs the transfer ID, SQLSTATE, retry attempt, and selected delay. Completion logs retry attempts and elapsed milliseconds. In-process counters record completed transfers, retries, and exhausted budgets.

`transfers` is an immutable projection tied to the journal by a composite `(id, currency, ledger_type)` foreign key. Its fixed ledger type is `transfer`; reference and creation time remain owned by `ledger_transactions` and are joined during lookup rather than duplicated.

## Consequences

- Concurrent withdrawals cannot both commit from the same stale balance.
- Deterministic lock order removes application-created account-lock cycles.
- Serialization failures remain expected under contention, but retry count and backoff are finite and observable.
- Higher contention increases latency and may return a retry-exhausted response instead of waiting without bound.
- The complete transfer response is durable and can be retrieved by ID, but duplicate client requests are not yet idempotent; Week 4 adds that contract.

## Alternatives considered

- Read Committed with an application balance check was rejected because concurrent requests can both validate stale state.
- A single global ledger lock was rejected because it would serialize unrelated accounts and hide the intended contention behavior.
- Inconsistent source-then-destination locking was rejected because opposing transfers could deadlock.
- Unbounded retries were rejected because they create unpredictable latency and can overload a struggling database.
- Retrying every database error was rejected because constraint, validation, and programming errors are not transient serialization conflicts.
