import { describe, expect, it } from 'vitest';
import { createPool } from '../../src/infrastructure/database/pool.js';

const unreachableUrl = 'postgresql://pulseledger:pulseledger@127.0.0.1:1/pulseledger_unused';

describe('database pool', () => {
  it('survives an error reported for an idle client', async () => {
    const pool = createPool(unreachableUrl);
    try {
      // `error` on an EventEmitter with no listener is an unhandled exception. PostgreSQL emits
      // exactly this (SQLSTATE 57P01) when it restarts, fails over, or an administrator
      // terminates a backend -- so without a listener a healthy ledger process would die because
      // one *idle* connection went away.
      expect(() => pool.emit('error', new Error('terminating connection'))).not.toThrow();
    } finally {
      await pool.end();
    }
  });

  it('reports that error to the caller so it can be logged', async () => {
    const seen: Error[] = [];
    const pool = createPool(unreachableUrl, {
      onIdleClientError: (error) => seen.push(error),
    });
    try {
      pool.emit('error', new Error('terminating connection due to administrator command'));
      expect(seen).toHaveLength(1);
      expect(seen[0]?.message).toContain('administrator command');
    } finally {
      await pool.end();
    }
  });
});
