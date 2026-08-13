export type NodeEnvironment = 'development' | 'test' | 'production';

export interface OutboxConfig {
  batchSize: number;
  claimLeaseSeconds: number;
  maxAttempts: number;
  pollIntervalMs: number;
}

export interface AppConfig {
  databaseUrl: string;
  host: string;
  logLevel: string;
  nodeEnv: NodeEnvironment;
  outbox: OutboxConfig;
  port: number;
}

const validNodeEnvironments = new Set<NodeEnvironment>(['development', 'test', 'production']);
const validLogLevels = new Set(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);

function readPort(rawPort: string | undefined): number {
  const port = Number(rawPort ?? '3000');
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  return port;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const databaseUrl = environment.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }

  const nodeEnv = environment.NODE_ENV ?? 'development';
  if (!validNodeEnvironments.has(nodeEnv as NodeEnvironment)) {
    throw new Error('NODE_ENV must be development, test, or production');
  }

  const logLevel = environment.LOG_LEVEL ?? 'info';
  if (!validLogLevels.has(logLevel)) {
    throw new Error('LOG_LEVEL is invalid');
  }

  const outboxBatchSize = readPositiveInt(environment.OUTBOX_BATCH_SIZE, 10);
  const outboxClaimLeaseSeconds = readPositiveInt(environment.OUTBOX_CLAIM_LEASE_SECONDS, 300);
  const outboxMaxAttempts = readPositiveInt(environment.OUTBOX_MAX_ATTEMPTS, 12);
  const outboxPollIntervalMs = readPositiveInt(environment.OUTBOX_POLL_INTERVAL_MS, 1_000);

  return {
    databaseUrl,
    host: environment.HOST ?? '0.0.0.0',
    logLevel,
    nodeEnv: nodeEnv as NodeEnvironment,
    outbox: {
      batchSize: outboxBatchSize,
      claimLeaseSeconds: outboxClaimLeaseSeconds,
      maxAttempts: outboxMaxAttempts,
      pollIntervalMs: outboxPollIntervalMs,
    },
    port: readPort(environment.PORT),
  };
}

function readPositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error('outbox configuration must be a positive integer');
  }
  return value;
}
