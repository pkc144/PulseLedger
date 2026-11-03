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

const recordColumns = `key, operation, request_fingerprint, status, response_status_code,
       response_body, created_at, completed_at`;

const maxClaimAttempts = 3;

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
    // A record can disappear between the conflicting INSERT and the follow-up read (a failed
    // request releasing its claim, or a retention sweep). That is not an error, just a lost race
    // for an empty slot, so the claim is simply attempted again. Bounded so it cannot spin.
    for (let attempt = 1; attempt <= maxClaimAttempts; attempt += 1) {
      const result = await this.tryClaim(params);
      if (result) return result;
    }
    throw new IdempotencyError(
      'IDEMPOTENCY_IN_PROGRESS',
      'A request with this idempotency key is already in progress',
    );
  }

  private async tryClaim(params: {
    fingerprint: string;
    key: string;
    operation: string;
    principalId: string;
    staleTimeoutMs: number;
  }): Promise<ClaimResult | null> {
    const { fingerprint, key, operation, principalId, staleTimeoutMs } = params;

    const inserted = await this.database.query<IdempotencyRow>(
      `INSERT INTO idempotency_records
         (principal_id, key, operation, request_fingerprint, status)
       VALUES ($4, $1, $2, $3, 'in_progress')
       ON CONFLICT (principal_id, key, operation) DO NOTHING
       RETURNING ${recordColumns}`,
      [key, operation, fingerprint, principalId],
    );

    if (inserted.rows[0]) {
      return { action: 'proceed', record: toRecord(inserted.rows[0]) };
    }

    const existing = await this.findRecord(key, operation, principalId);
    if (!existing) return null;

    if (existing.requestFingerprint !== fingerprint) {
      throw new IdempotencyError(
        'IDEMPOTENCY_CONFLICT',
        'Duplicate idempotency key with a different request body',
      );
    }

    if (existing.status === 'completed') {
      return { action: 'replay', record: existing, response: toResponse(existing) };
    }

    const staleThreshold = new Date(Date.now() - staleTimeoutMs);
    if (new Date(existing.createdAt) < staleThreshold) {
      // The conditional UPDATE is the whole reclaim: only the caller whose UPDATE actually moved
      // the row owns the claim. Reading the row afterwards and proceeding on `in_progress` would
      // let every concurrent reclaimer proceed -- the one that won *and* the ones that lost --
      // and each would post its own transfer under the same key.
      const reclaimed = await this.database.query<IdempotencyRow>(
        `UPDATE idempotency_records
         SET created_at = now(), completed_at = NULL
         WHERE key = $1 AND operation = $2 AND principal_id = $3 AND status = 'in_progress'
           AND request_fingerprint = $4 AND created_at < $5
         RETURNING ${recordColumns}`,
        [key, operation, principalId, fingerprint, staleThreshold.toISOString()],
      );
      if (reclaimed.rows[0]) {
        return { action: 'proceed', record: toRecord(reclaimed.rows[0]) };
      }

      // Lost the reclaim. Whoever won may already have finished, in which case its stored
      // response is the answer; otherwise it is still running.
      const current = await this.findRecord(key, operation, principalId);
      if (!current) return null;
      if (current.status === 'completed') {
        return { action: 'replay', record: current, response: toResponse(current) };
      }
    }

    throw new IdempotencyError(
      'IDEMPOTENCY_IN_PROGRESS',
      'A request with this idempotency key is already in progress',
    );
  }

  private async findRecord(
    key: string,
    operation: string,
    principalId: string,
  ): Promise<IdempotencyRecord | null> {
    const result = await this.database.query<IdempotencyRow>(
      `SELECT ${recordColumns}
       FROM idempotency_records
       WHERE key = $1 AND operation = $2 AND principal_id = $3`,
      [key, operation, principalId],
    );
    const row = result.rows[0];
    return row ? toRecord(row) : null;
  }

  public async release(params: {
    key: string;
    operation: string;
    principalId: string;
  }): Promise<void> {
    // Only an unfinished claim is released. A completed record is a promise already made to the
    // client and is never withdrawn here.
    await this.database.query(
      `DELETE FROM idempotency_records
       WHERE key = $1 AND operation = $2 AND principal_id = $3 AND status = 'in_progress'`,
      [params.key, params.operation, params.principalId],
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

  public async purgeCompletedBefore(cutoff: Date, batchSize: number): Promise<number> {
    // A completed record's only remaining job is to replay a response to a client that retries.
    // Past the retention window that replay is no longer expected, and the row is dead weight --
    // but deleting an `in_progress` row would hand a duplicate request a clean claim, so those
    // are never eligible regardless of age.
    let removed = 0;
    for (;;) {
      const result = await this.database.query(
        `DELETE FROM idempotency_records
         WHERE ctid IN (
           SELECT ctid FROM idempotency_records
           WHERE status = 'completed' AND completed_at < $1
           ORDER BY completed_at
           LIMIT $2
         )`,
        [cutoff.toISOString(), batchSize],
      );
      const deleted = result.rowCount ?? 0;
      removed += deleted;
      if (deleted < batchSize) return removed;
    }
  }
}
