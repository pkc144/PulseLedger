import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';

describe('loadConfig', () => {
  it('loads valid configuration with defaults', () => {
    expect(loadConfig({ DATABASE_URL: 'postgresql://localhost/pulseledger' })).toEqual({
      databaseUrl: 'postgresql://localhost/pulseledger',
      host: '0.0.0.0',
      logLevel: 'info',
      nodeEnv: 'development',
      port: 3000,
    });
  });

  it('rejects a missing database URL', () => {
    expect(() => loadConfig({})).toThrow('DATABASE_URL is required');
  });

  it.each(['0', '65536', 'abc', '1.5'])('rejects invalid port %s', (port) => {
    expect(() => loadConfig({ DATABASE_URL: 'postgresql://localhost/db', PORT: port })).toThrow(
      'PORT must be an integer between 1 and 65535',
    );
  });
});
