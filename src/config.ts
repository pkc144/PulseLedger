export type NodeEnvironment = 'development' | 'test' | 'production';

export interface AppConfig {
  databaseUrl: string;
  host: string;
  logLevel: string;
  nodeEnv: NodeEnvironment;
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

  return {
    databaseUrl,
    host: environment.HOST ?? '0.0.0.0',
    logLevel,
    nodeEnv: nodeEnv as NodeEnvironment,
    port: readPort(environment.PORT),
  };
}
