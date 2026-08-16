import type { Database } from '../../ports/database.js';
import {
  IdempotencyError,
  type ClaimResult,
  type IdempotencyRecord,
  type IdempotencyStore,
} from './idempotency-domain.js';

interface IdempotencyRow extends Record<string, unknown> {
  completed_at: Date | null;
  created_at: Date;
  key: string;
  operation: string;
  request_fingerprint: string;
  response_body: unknown;
  response_status_code: number | null;
  status: IdempotencyRecord['status'];
}

function toRecord(row: IdempotencyRow): IdempotencyRecord {
  return {
    completedAt: row.completed_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    key: row.key,
    operation: row.operation,
    requestFingerprint: row.request_fingerprint,
    responseBody: row.response_body ?? null,
    responseStatus: row.response_status_code ?? null,
    status: row.status,
  };
}

function toResponse(record: IdempotencyRecord) {
  return { body: record.responseBody, status: record.responseStatus! };
}

export class PostgresIdempotencyStore implements IdempotencyStore {
  public constructor(private readonly database: Database) {}

  public async claim(params: {
    fingerprint: string;
    key: string;
    operation: string;
    principalId: string;
    staleTimeoutMs: number;
  }): Promise<ClaimResult> {
    const { fingerprint, key, operation, principalId, staleTimeoutMs } = params;

    const inserted = await this.database.query<IdempotencyRow>(
      `INSERT INTO idempotency_records
         (principal_id, key, operation, request_fingerprint, status)
       VALUES ($4, $1, $2, $3, 'in_progress')
       ON CONFLICT (principal_id, key, operation) DO NOTHING
       RETURNING key, operation, request_fingerprint, status, response_status_code,
                 response_body, created_at, completed_at`,
      [key, operation, fingerprint, principalId],
    );

    if (inserted.rows[0]) {
      return { action: 'proceed', record: toRecord(inserted.rows[0]) };
    }

    const existing = await this.database.query<IdempotencyRow>(
      `SELECT key, operation, request_fingerprint, status, response_status_code,
              response_body, created_at, completed_at
       FROM idempotency_records
       WHERE key = $1 AND operation = $2 AND principal_id = $3`,
      [key, operation, principalId],
    );

    const record = toRecord(existing.rows[0]!);

    if (record.status === 'completed') {
      if (record.requestFingerprint !== fingerprint) {
        throw new IdempotencyError(
          'IDEMPOTENCY_CONFLICT',
          'Duplicate idempotency key with a different request body',
        );
      }
      return { action: 'replay', record, response: toResponse(record) };
    }

    if (record.requestFingerprint !== fingerprint) {
      throw new IdempotencyError(
        'IDEMPOTENCY_CONFLICT',
        'Duplicate idempotency key with a different request body',
      );
    }

    const staleThreshold = new Date(Date.now() - staleTimeoutMs);
    if (new Date(record.createdAt) < staleThreshold) {
      await this.database.query(
        `UPDATE idempotency_records
         SET request_fingerprint = $3, created_at = now(), completed_at = NULL
         WHERE key = $1 AND operation = $2 AND principal_id = $5 AND status = 'in_progress'
           AND created_at < $4`,
        [key, operation, fingerprint, staleThreshold.toISOString(), principalId],
      );

      const reclaimed = await this.database.query<IdempotencyRow>(
        `SELECT key, operation, request_fingerprint, status, response_status_code,
                response_body, created_at, completed_at
         FROM idempotency_records
         WHERE key = $1 AND operation = $2 AND principal_id = $3`,
        [key, operation, principalId],
      );

      if (reclaimed.rows[0] && reclaimed.rows[0].status === 'in_progress') {
        return { action: 'proceed', record: toRecord(reclaimed.rows[0]) };
      }

      if (reclaimed.rows[0] && reclaimed.rows[0].status === 'completed') {
        const completedRecord = toRecord(reclaimed.rows[0]);
        return { action: 'replay', record: completedRecord, response: toResponse(completedRecord) };
      }
    }

    throw new IdempotencyError(
      'IDEMPOTENCY_IN_PROGRESS',
      'A request with this idempotency key is already in progress',
    );
  }

  public async complete(params: {
    key: string;
    operation: string;
    principalId: string;
    responseBody: unknown;
    responseStatus: number;
  }): Promise<void> {
    await this.database.query(
      `UPDATE idempotency_records
       SET status = 'completed',
           response_status_code = $3,
           response_body = $4,
           completed_at = now()
       WHERE key = $1 AND operation = $2 AND principal_id = $5 AND status = 'in_progress'`,
      [
        params.key,
        params.operation,
        params.responseStatus,
        params.responseBody,
        params.principalId,
      ],
    );
  }
}
