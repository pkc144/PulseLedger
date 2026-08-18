# Architecture decision records

Six decisions shaped PulseLedger. All are **accepted** and reflect the code as shipped; where
later work confirmed or extended a decision, the ADR carries an update section rather than being
quietly rewritten.

| ADR                                                      | Decision                                                         | Status   | The question it settles                                                     |
| -------------------------------------------------------- | ---------------------------------------------------------------- | -------- | --------------------------------------------------------------------------- |
| [001](./001-double-entry-integer-accounting.md)          | Double-entry accounting with integer minor units                 | Accepted | How is value represented, and what stops an invalid financial record?       |
| [002](./002-serializable-locking-retries.md)             | `SERIALIZABLE` transfers, deterministic locking, bounded retries | Accepted | How do concurrent transfers avoid overdraft and deadlock, and at what cost? |
| [003](./003-transactional-outbox.md)                     | Transactional outbox instead of a dual write                     | Accepted | How does a committed transfer reliably produce a downstream effect?         |
| [004](./004-modular-monolith-database-worker.md)         | Modular monolith with a database-backed worker                   | Accepted | Why one process and one database instead of services and a broker?          |
| [005](./005-api-key-authentication-account-ownership.md) | API-key authentication with database-enforced account ownership  | Accepted | Who is asking, and what are they allowed to touch? (v1.1)                   |
| [006](./006-retention-boundaries-and-operator-replay.md) | Retention boundaries and operator replay                         | Accepted | What may be deleted, what never may, and who replays a parked event? (v1.2) |

Read them in order: 001 defines what a correct record is, 002 defends it under concurrency, 003
carries the intent past the commit boundary, 004 explains why none of that needs another piece of
infrastructure, 005 answers the question the first four take for granted — whose money is it — and
006 covers what happens to all the bookkeeping afterwards.

Consequences and known gaps are collected in [../TRADEOFFS.md](../TRADEOFFS.md).
