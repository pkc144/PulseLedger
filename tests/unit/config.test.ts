import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';

const validAdminApiKey = 'test-admin-api-key-0123456789';
const baseEnvironment = {
  DATABASE_URL: 'postgresql://localhost/pulseledger',
  ADMIN_API_KEY: validAdminApiKey,
};

describe('loadConfig', () => {
  it('loads valid configuration with defaults', () => {
    expect(loadConfig(baseEnvironment)).toEqual({
      adminApiKey: validAdminApiKey,
      databaseUrl: 'postgresql://localhost/pulseledger',
      host: '0.0.0.0',
      logLevel: 'info',
      nodeEnv: 'development',
      outbox: { batchSize: 10, claimLeaseSeconds: 300, maxAttempts: 12, pollIntervalMs: 1000 },
      port: 3000,
      requestLimits: {
        bodyLimitBytes: 16 * 1024,
        connectionTimeoutMs: 10_000,
        keepAliveTimeoutMs: 5_000,
        requestTimeoutMs: 30_000,
      },
    });
  });

  it('rejects a missing database URL', () => {
    expect(() => loadConfig({ ADMIN_API_KEY: validAdminApiKey })).toThrow(
      'DATABASE_URL is required',
    );
  });

  it('rejects a missing admin API key', () => {
    expect(() => loadConfig({ DATABASE_URL: baseEnvironment.DATABASE_URL })).toThrow(
      'ADMIN_API_KEY is required',
    );
  });

  it('rejects an admin API key shorter than 16 characters', () => {
    expect(() => loadConfig({ ...baseEnvironment, ADMIN_API_KEY: 'too-short' })).toThrow(
      'ADMIN_API_KEY is required',
    );
  });

  it.each(['0', '65536', 'abc', '1.5'])('rejects invalid port %s', (port) => {
    expect(() => loadConfig({ ...baseEnvironment, PORT: port })).toThrow(
      'PORT must be an integer between 1 and 65535',
    );
  });

  it('reads request limits from the environment', () => {
    const config = loadConfig({
      ...baseEnvironment,
      REQUEST_BODY_LIMIT_BYTES: '2048',
      CONNECTION_TIMEOUT_MS: '1000',
      KEEP_ALIVE_TIMEOUT_MS: '2000',
      REQUEST_TIMEOUT_MS: '3000',
    });
    expect(config.requestLimits).toEqual({
      bodyLimitBytes: 2048,
      connectionTimeoutMs: 1000,
      keepAliveTimeoutMs: 2000,
      requestTimeoutMs: 3000,
    });
  });

  it('rejects a non-positive-integer request limit', () => {
    expect(() => loadConfig({ ...baseEnvironment, REQUEST_BODY_LIMIT_BYTES: '0' })).toThrow(
      'REQUEST_BODY_LIMIT_BYTES must be a positive integer',
    );
  });
});
