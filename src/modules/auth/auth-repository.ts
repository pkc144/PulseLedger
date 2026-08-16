import type { Database } from '../../ports/database.js';
import type {
  ApiKeyCandidate,
  ApiKeyRecord,
  AuthStore,
  Principal,
  PrincipalStatus,
} from './auth-domain.js';

interface PrincipalRow extends Record<string, unknown> {
  created_at: Date;
  id: string;
  name: string;
  status: PrincipalStatus;
}

interface ApiKeyRow extends Record<string, unknown> {
  created_at: Date;
  id: string;
  key_prefix: string;
  principal_id: string;
  revoked_at: Date | null;
}

interface CandidateRow extends PrincipalRow {
  key_hash: string;
  key_id: string;
}

function toPrincipal(row: PrincipalRow): Principal {
  return {
    createdAt: row.created_at.toISOString(),
    id: row.id,
    name: row.name,
    status: row.status,
  };
}

function toApiKeyRecord(row: ApiKeyRow): ApiKeyRecord {
  return {
    createdAt: row.created_at.toISOString(),
    id: row.id,
    keyPrefix: row.key_prefix,
    principalId: row.principal_id,
    revokedAt: row.revoked_at?.toISOString() ?? null,
  };
}

export class PostgresAuthStore implements AuthStore {
  public constructor(private readonly database: Database) {}

  public async createPrincipal(name: string): Promise<Principal> {
    const result = await this.database.query<PrincipalRow>(
      `INSERT INTO principals (name)
       VALUES ($1)
       RETURNING id, name, status, created_at`,
      [name],
    );
    return toPrincipal(result.rows[0]!);
  }

  public async findPrincipalById(id: string): Promise<Principal | null> {
    const result = await this.database.query<PrincipalRow>(
      `SELECT id, name, status, created_at
       FROM principals
       WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row ? toPrincipal(row) : null;
  }

  public async findKeyCandidateByPrefix(keyPrefix: string): Promise<ApiKeyCandidate | null> {
    // Revoked keys are excluded here rather than after hashing, so a revoked secret takes the
    // same path as an unknown one.
    const result = await this.database.query<CandidateRow>(
      `SELECT api_key.id AS key_id, api_key.key_hash,
              principal.id, principal.name, principal.status, principal.created_at
       FROM api_keys AS api_key
       JOIN principals AS principal ON principal.id = api_key.principal_id
       WHERE api_key.key_prefix = $1 AND api_key.revoked_at IS NULL`,
      [keyPrefix],
    );
    const row = result.rows[0];
    if (!row) return null;
    return { keyHash: row.key_hash, keyId: row.key_id, principal: toPrincipal(row) };
  }

  public async insertApiKey(input: {
    keyHash: string;
    keyPrefix: string;
    principalId: string;
  }): Promise<ApiKeyRecord> {
    const result = await this.database.query<ApiKeyRow>(
      `INSERT INTO api_keys (principal_id, key_prefix, key_hash)
       VALUES ($1, $2, $3)
       RETURNING id, principal_id, key_prefix, created_at, revoked_at`,
      [input.principalId, input.keyPrefix, input.keyHash],
    );
    return toApiKeyRecord(result.rows[0]!);
  }

  public async revokeApiKey(id: string): Promise<boolean> {
    // Idempotent by construction: revoking an already-revoked key keeps the original timestamp
    // and still reports success, so a retried revocation is never an error.
    const result = await this.database.query(
      `UPDATE api_keys
       SET revoked_at = coalesce(revoked_at, now())
       WHERE id = $1`,
      [id],
    );
    return (result.rowCount ?? 0) > 0;
  }
}
