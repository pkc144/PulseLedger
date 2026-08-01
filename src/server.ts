import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './infrastructure/database/pool.js';

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const app = await buildApp({ database: pool, logger: { level: config.logLevel } });

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await pool.end();
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.fatal({ err: error }, 'server failed to start');
  await pool.end();
  process.exitCode = 1;
}
