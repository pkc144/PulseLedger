import pg from 'pg';

const { Pool } = pg;

export interface CreatePoolOptions {
  /**
   * Notified when the pool reports an error on an **idle** client — a failover, an administrator
   * terminating the backend, a network blip. The pool has already discarded that client by the
   * time this runs; the handler exists so the event is observable, not to repair anything.
   */
  onIdleClientError?: (error: Error) => void;
}

export function createPool(databaseUrl: string, options: CreatePoolOptions = {}): pg.Pool {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });

  // Not optional bookkeeping: `error` on an EventEmitter with no listener is an unhandled
  // exception, so without this a single idle connection dropped by PostgreSQL (SQLSTATE 57P01
  // during a restart or failover) would take the whole ledger process down — while every
  // in-flight transaction was perfectly healthy. Attached here rather than left to each caller so
  // no entrypoint can forget it.
  pool.on('error', (error: Error) => {
    options.onIdleClientError?.(error);
  });

  return pool;
}
