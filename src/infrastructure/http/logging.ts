/**
 * Header paths that must never reach a log line unredacted. Applied regardless of whether
 * Fastify's own request logging currently serializes headers, so a future call that logs
 * `request.headers` (or `{ req: request }`) directly stays safe by construction.
 */
export const sensitiveHeaderRedactPaths = [
  'req.headers.authorization',
  'req.headers["x-admin-api-key"]',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
];

export function withRedaction(base: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...base,
    redact: { paths: sensitiveHeaderRedactPaths, censor: '[REDACTED]' },
  };
}
