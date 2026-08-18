# ADR-006: Retention boundaries and operator replay

- Status: Accepted
- Date: 2026-08-19

## Context

Four tables grow with traffic and nothing removed rows from any of them: `outbox_events`,
`idempotency_records`, `consumer_inbox`, and `audit_effects`. A ledger that runs for a year
accumulates a row in each per transfer, and the first three are pure bookkeeping — they exist to
make delivery and retries safe, not to record what happened.

Deleting bookkeeping is not obviously safe, though. Each of these tables is load-bearing for one of
the system's invariants, and "old enough to delete" means something different in each case. A single
blanket retention policy would quietly break at least one of them.

Separately, an event that exhausts its 12 attempts is parked (`status = 'failed'`,
`next_attempt_at = 'infinity'`) rather than dropped — deliberately, so a human can decide. Until now
there was no way for that human to see or act on it short of writing SQL, which made the parked
state a dead end rather than a decision point.

## Decision

**Two tables are swept; two never are.**

| Table                 | Policy                                      | Why                                                                                                           |
| --------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `outbox_events`       | Delete `processed` rows older than N (30 d) | The event was delivered. Its remaining value is forensic, and the audit effect it produced is the real record |
| `idempotency_records` | Delete `completed` rows older than N (7 d)  | Past the window no client is still retrying, so no stored response is owed to anyone                          |
| `consumer_inbox`      | **Never**                                   | It _is_ the dedup boundary. Deleting a claim lets a redelivered event produce a second effect                 |
| `audit_effects`       | **Never**                                   | It is the audit trail — the thing all the bookkeeping exists to produce                                       |

Only terminal rows are eligible, never in-flight ones: a `pending`, `processing`, or `failed` outbox
event still has work owed to it however old it is, and an `in_progress` idempotency record may still
be reclaimed by a retrying caller. Age alone never retires a row that someone might still act on.

The two "never" rows are not merely policy — both tables carry the ledger's append-only trigger, so
a `DELETE` is rejected by PostgreSQL. A future maintainer who disagrees has to change a migration,
not just a flag.

Sweeps run as `npm run retention`, delete in bounded batches (default 1,000) so a first run over a
neglected table cannot hold locks or bloat WAL for minutes, and support `--dry-run` for previewing
counts with the same predicates the deletes use. Partial indexes on `(processed_at) WHERE status =
'processed'` and `(completed_at) WHERE status = 'completed'` keep each sweep an index scan, and stay
small because they only cover rows a sweep can ever touch.

**Parked events get a first-class operator tool.** `npm run outbox list` shows what is waiting on a
human, `show <id>` prints the event with its payload and last error, and `replay <id>` (or
`replay --all`) returns it to the queue. Replay resets `attempts` to 0 so the event gets a fresh
budget, but deliberately **keeps `last_error`**: it is the record of why someone had to intervene.

Only a parked event may be replayed. A `pending` or `processing` row already belongs to the worker,
and resetting it under the worker's feet would duplicate in-flight work; the CLI distinguishes "no
such event" from "not parked" because those need different responses from an operator.

## Consequences

- Growth is bounded by policy rather than by hope, and the policy is explicit per table instead of
  implicit in whatever a cleanup script happened to touch.
- Deleting processed outbox events while keeping `consumer_inbox` forever is intentional asymmetry:
  the inbox is a few dozen bytes per event and is the only thing standing between at-least-once
  delivery and a duplicated effect. Trading it for disk would trade away invariant 4.
- The parked state is now a workflow rather than a dead end, which also means "what happens after 12
  failures?" has an answer that does not involve `psql`.
- Retention is a CLI, not a background loop. Nothing runs it automatically; scheduling it (cron,
  Kubernetes CronJob) is a deployment concern, and the safe default for a demo system is that it
  only deletes when someone asks.
- A replayed event that fails again simply parks again, and the operator learns the failure is not
  transient — which is the information they actually needed.

## Alternatives considered

- **One retention setting for all four tables** was rejected because the correct answer differs per
  table; the single knob would have to be the most conservative one, which means never deleting
  anything.
- **Sweeping `consumer_inbox` alongside its outbox event** was rejected: it is safe only if no copy
  of that event can ever be redelivered, and an operator replay (or a restored backup) can
  reintroduce one. The inbox is cheap; the invariant is not.
- **`TRUNCATE`/partition-drop by time** would be faster at scale and is the right answer for a real
  deployment, but it needs partitioning introduced up front. Batched deletes work on the schema that
  exists and stay correct while the service is serving traffic.
- **Automatic replay of parked events** was rejected as a contradiction: the event is parked
  precisely because 12 automatic attempts already failed. The next attempt should follow a human
  understanding why.
- **Deleting parked events after some age** was rejected because it destroys evidence of an
  unresolved failure. They stay until a human replays them or removes them deliberately.
