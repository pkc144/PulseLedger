import { loadConfig } from '../../config.js';
import { createPool } from './pool.js';
import { runMigrations } from './migrate.js';

const config = loadConfig();
const pool = createPool(config.databaseUrl);

try {
  await runMigrations(pool);
  console.log('Database migrations completed');
} finally {
  await pool.end();
}
