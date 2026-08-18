/**
 * Dead-letter inspection and replay for the outbox.
 *
 * An event that exhausts its attempt budget is parked (`status = 'failed'`,
 * `next_attempt_at = 'infinity'`) rather than dropped, precisely so a human can look at it. This
 * is that human's tool.
 *
 *   npm run outbox list [--limit N]   parked events, oldest first
 *   npm run outbox show <id>          one event in full, including its payload and last error
 *   npm run outbox replay <id>        return one parked event to the queue with a fresh budget
 *   npm run outbox replay --all       return every parked event
 *
 * Exits non-zero when a requested event does not exist or is not parked, so it composes with
 * shell scripts and CI checks.
 */
import { loadConfig } from '../../config.js';
import { createPool } from '../../infrastructure/database/pool.js';
import { outboxDefaultListLimit, type OutboxRecord } from './outbox-domain.js';
import { OutboxAdminService } from './outbox-admin-service.js';
import { PostgresOutboxAdminStore } from './outbox-repository.js';

const usage = `Usage:
  npm run outbox list [--limit N]
  npm run outbox show <event-id>
  npm run outbox replay <event-id>
  npm run outbox replay --all`;

function readLimit(args: readonly string[]): number {
  const index = args.indexOf('--limit');
  if (index === -1) return outboxDefaultListLimit;
  const value = Number(args[index + 1]);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error('--limit must be a positive integer');
  }
  return value;
}

function summarize(event: OutboxRecord): string {
  const error = event.lastError ? event.lastError.split('\n')[0] : '(no error recorded)';
  return `${event.id}  ${event.eventType}  aggregate=${event.aggregateId}  attempts=${event.attempts}\n    created ${event.createdAt}\n    last error: ${error}`;
}

const [command, ...args] = process.argv.slice(2);
const config = loadConfig();
const pool = createPool(config.databaseUrl);
const outbox = new OutboxAdminService(new PostgresOutboxAdminStore(pool));

try {
  switch (command) {
    case 'list': {
      const events = await outbox.listParked(readLimit(args));
      const total = await outbox.countParked();
      if (events.length === 0) {
        console.log('No parked events. The outbox has nothing waiting on a human.');
        break;
      }
      console.log(`${total} parked event(s); showing ${events.length}:\n`);
      for (const event of events) console.log(summarize(event), '\n');
      console.log('Replay one with:  npm run outbox replay <event-id>');
      break;
    }

    case 'show': {
      const id = args[0];
      if (!id) throw new Error('show requires an event id');
      const event = await outbox.findById(id);
      if (!event) {
        console.error(`No outbox event with id ${id}`);
        process.exitCode = 1;
        break;
      }
      console.log(JSON.stringify(event, null, 2));
      break;
    }

    case 'replay': {
      if (args[0] === '--all') {
        const replayed = await outbox.replayAllParked();
        console.log(`Returned ${replayed} parked event(s) to the queue.`);
        break;
      }

      const id = args[0];
      if (!id) throw new Error('replay requires an event id, or --all');
      if (await outbox.replay(id)) {
        console.log(`Event ${id} is pending again with a fresh attempt budget.`);
        break;
      }

      // Distinguish the two ways this fails, because they need different responses from an
      // operator: a typo, versus an event the worker is already handling.
      const event = await outbox.findById(id);
      console.error(
        event
          ? `Event ${id} is '${event.status}', not parked. Only an event that exhausted its attempts can be replayed.`
          : `No outbox event with id ${id}`,
      );
      process.exitCode = 1;
      break;
    }

    default:
      console.error(usage);
      process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'outbox command failed');
  console.error(`\n${usage}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
