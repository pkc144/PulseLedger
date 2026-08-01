import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type pg from 'pg';

const migrationFilePattern = /^\d+_[a-z0-9_]+\.sql$/;

export async function runMigrations(pool: pg.Pool, directory = path.resolve('migrations')) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(directory)).filter((file) => migrationFilePattern.test(file)).sort();
  const applied = await pool.query<{ name: string }>('SELECT name FROM schema_migrations');
  const appliedNames = new Set(applied.rows.map(({ name }) => name));

  for (const file of files) {
    if (appliedNames.has(file)) continue;

    const sql = await readFile(path.join(directory, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
