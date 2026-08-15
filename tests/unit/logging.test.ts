import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { withRedaction } from '../../src/infrastructure/http/logging.js';

function capture(): { lines: unknown[]; stream: { write(chunk: string): void } } {
  const lines: unknown[] = [];
  return {
    lines,
    stream: {
      write(chunk: string) {
        lines.push(JSON.parse(chunk));
      },
    },
  };
}

describe('withRedaction', () => {
  it('redacts the admin API key header', () => {
    const { lines, stream } = capture();
    const logger = pino(withRedaction(), stream);

    logger.info({ req: { headers: { 'x-admin-api-key': 'super-secret-value' } } }, 'request');

    const logged = JSON.stringify(lines[0]);
    expect(logged).not.toContain('super-secret-value');
    expect(logged).toContain('[REDACTED]');
  });

  it('redacts the authorization and cookie headers', () => {
    const { lines, stream } = capture();
    const logger = pino(withRedaction(), stream);

    logger.info(
      {
        req: { headers: { authorization: 'Bearer secret-token', cookie: 'session=abc123' } },
      },
      'request',
    );

    const logged = JSON.stringify(lines[0]);
    expect(logged).not.toContain('secret-token');
    expect(logged).not.toContain('abc123');
  });

  it('does not redact unrelated fields, and preserves a supplied base config', () => {
    const { lines, stream } = capture();
    const logger = pino(withRedaction({ level: 'debug' }), stream);

    logger.debug({ req: { headers: { 'x-request-id': 'keep-me' } } }, 'request');

    expect(JSON.stringify(lines[0])).toContain('keep-me');
  });
});
