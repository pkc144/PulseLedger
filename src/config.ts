export type NodeEnvironment = 'development' | 'test' | 'production';

export interface OutboxConfig {
  batchSize: number;
  claimLeaseSeconds: number;
  maxAttempts: number;
  pollIntervalMs: number;
}

export interface RequestLimitsConfig {
  /** Maximum accepted JSON request body size. Every current payload is a few short fields. */
  bodyLimitBytes: number;
  /** How long a new socket may take to send its first byte before Fastify closes it. */
  connectionTimeoutMs: number;
  /** How long an idle keep-alive socket is held open before the server closes it. */
  keepAliveTimeoutMs: number;
  /** Upper bound on how long a request may take end to end (Node's http.Server#requestTimeout). */
  requestTimeoutMs: number;
}

export interface AppConfig {
  adminApiKey: string;
  databaseUrl: string;
  host: string;
  logLevel: string;
  nodeEnv: NodeEnvironment;
  outbox: OutboxConfig;
  port: number;
  requestLimits: RequestLimitsConfig;
}

const validNodeEnvironments = new Set<NodeEnvironment>(['development', 'test', 'production']);
const validLogLevels = new Set(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);
const minimumAdminApiKeyLength = 16;

function readPort(rawPort: string | undefined): number {
  const port = Number(rawPort ?? '3000');
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  return port;
}

function readPositiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const databaseUrl = environment.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }

  const adminApiKey = environment.ADMIN_API_KEY;
  if (!adminApiKey || adminApiKey.length < minimumAdminApiKeyLength) {
    throw new Error(
      `ADMIN_API_KEY is required and must be at least ${minimumAdminApiKeyLength} characters`,
    );
  }

  const nodeEnv = environment.NODE_ENV ?? 'development';
  if (!validNodeEnvironments.has(nodeEnv as NodeEnvironment)) {
    throw new Error('NODE_ENV must be development, test, or production');
  }

  const logLevel = environment.LOG_LEVEL ?? 'info';
  if (!validLogLevels.has(logLevel)) {
    throw new Error('LOG_LEVEL is invalid');
  }

  const outboxBatchSize = readPositiveInt(environment.OUTBOX_BATCH_SIZE, 10, 'OUTBOX_BATCH_SIZE');
  const outboxClaimLeaseSeconds = readPositiveInt(
    environment.OUTBOX_CLAIM_LEASE_SECONDS,
    300,
    'OUTBOX_CLAIM_LEASE_SECONDS',
  );
  const outboxMaxAttempts = readPositiveInt(
    environment.OUTBOX_MAX_ATTEMPTS,
    12,
    'OUTBOX_MAX_ATTEMPTS',
  );
  const outboxPollIntervalMs = readPositiveInt(
    environment.OUTBOX_POLL_INTERVAL_MS,
    1_000,
    'OUTBOX_POLL_INTERVAL_MS',
  );

  const bodyLimitBytes = readPositiveInt(
    environment.REQUEST_BODY_LIMIT_BYTES,
    16 * 1024,
    'REQUEST_BODY_LIMIT_BYTES',
  );
  const connectionTimeoutMs = readPositiveInt(
    environment.CONNECTION_TIMEOUT_MS,
    10_000,
    'CONNECTION_TIMEOUT_MS',
  );
  const keepAliveTimeoutMs = readPositiveInt(
    environment.KEEP_ALIVE_TIMEOUT_MS,
    5_000,
    'KEEP_ALIVE_TIMEOUT_MS',
  );
  const requestTimeoutMs = readPositiveInt(
    environment.REQUEST_TIMEOUT_MS,
    30_000,
    'REQUEST_TIMEOUT_MS',
  );

  return {
    adminApiKey,
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
    requestLimits: {
      bodyLimitBytes,
      connectionTimeoutMs,
      keepAliveTimeoutMs,
      requestTimeoutMs,
    },
  };
}
