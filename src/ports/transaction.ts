import type { Database, TransactionalDatabase } from './database.js';

export interface TransactionOptions {
  /** The statement that opens the transaction, e.g. to choose an isolation level. */
  begin?: string;
}

/**
 * Runs `work` on one connection inside BEGIN/COMMIT, rolling back if it throws. The single home
 * for transaction lifecycle, so every caller gets the same two guarantees:
 *
 * - the original failure always wins: a ROLLBACK that itself fails never replaces it;
 * - a connection whose ROLLBACK failed is in an unknown state, so it is released *with* the
 *   error, which tells the pool to destroy it rather than hand it to the next caller mid-
 *   transaction.
 *
 * Technology-neutral: it needs only the database port, so it lives beside it.
 */
export async function withTransaction<T>(
  database: TransactionalDatabase,
  work: (connection: Database) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const connection = await database.connect();
  let brokenConnection: Error | undefined;
  try {
    await connection.query(options.begin ?? 'BEGIN');
    const result = await work(connection);
    await connection.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await connection.query('ROLLBACK');
    } catch (rollbackError) {
      brokenConnection =
        rollbackError instanceof Error ? rollbackError : new Error('ROLLBACK failed');
    }
    throw error;
  } finally {
    connection.release(brokenConnection);
  }
}
