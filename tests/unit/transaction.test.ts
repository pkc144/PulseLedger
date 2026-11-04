import { describe, expect, it } from 'vitest';
import type { DatabaseConnection, TransactionalDatabase } from '../../src/ports/database.js';
import { withTransaction } from '../../src/ports/transaction.js';

class FakeConnection implements DatabaseConnection {
  public readonly statements: string[] = [];
  public released: { error: Error | undefined } | undefined;

  public constructor(private readonly failOn: string | undefined = undefined) {}

  public async query<Row extends Record<string, unknown>>(text: string) {
    this.statements.push(text);
    if (text === this.failOn) throw new Error(`${text} failed`);
    return { rows: [] as Row[], rowCount: 0 };
  }

  public release(error?: Error): void {
    this.released = { error };
  }
}

function databaseWith(connection: FakeConnection): TransactionalDatabase {
  return {
    connect: async () => connection,
    query: async () => ({ rows: [], rowCount: 0 }),
  };
}

describe('withTransaction', () => {
  it('commits and releases the connection normally on success', async () => {
    const connection = new FakeConnection();
    const result = await withTransaction(databaseWith(connection), async (db) => {
      await db.query('INSERT 1');
      return 42;
    });

    expect(result).toBe(42);
    expect(connection.statements).toEqual(['BEGIN', 'INSERT 1', 'COMMIT']);
    expect(connection.released).toEqual({ error: undefined });
  });

  it('honours a custom BEGIN statement', async () => {
    const connection = new FakeConnection();
    await withTransaction(databaseWith(connection), async () => undefined, {
      begin: 'BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE',
    });
    expect(connection.statements[0]).toBe('BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE');
  });

  it('rolls back, rethrows the original error, and keeps a healthy connection', async () => {
    const connection = new FakeConnection();
    await expect(
      withTransaction(databaseWith(connection), async () => {
        throw new Error('work failed');
      }),
    ).rejects.toThrow('work failed');

    expect(connection.statements).toEqual(['BEGIN', 'ROLLBACK']);
    expect(connection.released).toEqual({ error: undefined });
  });

  it('keeps the original error and destroys the connection when ROLLBACK also fails', async () => {
    const connection = new FakeConnection('ROLLBACK');
    await expect(
      withTransaction(databaseWith(connection), async () => {
        throw new Error('work failed');
      }),
    ).rejects.toThrow('work failed');

    // Released *with* an error: the pool discards a connection in an unknown state instead of
    // handing it, possibly mid-transaction, to the next caller.
    expect(connection.released?.error).toBeInstanceOf(Error);
    expect(connection.released?.error?.message).toBe('ROLLBACK failed');
  });
});
