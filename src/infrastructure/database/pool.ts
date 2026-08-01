import pg from 'pg';

const { Pool } = pg;

export function createPool(databaseUrl: string): pg.Pool {
  return new Pool({
    connectionString: databaseUrl,
    max: 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });
}
