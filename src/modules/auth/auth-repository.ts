import type { TransactionalDatabase } from '../../ports/database.js';
import { withTransaction } from '../../ports/transaction.js';
import type {
  ApiKeyCandidate,
  ApiKeyRecord,
  AuthStore,
  ExternalIdentity,
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

/** Internal signal: a concurrent first sign-in already mapped this identity. */
class IdentityAlreadyMapped extends Error {}

export class PostgresAuthStore implements AuthStore {
  public constructor(private readonly database: TransactionalDatabase) {}

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

  public async findPrincipalByIdentity(
    provider: ExternalIdentity['provider'],
    subject: string,
  ): Promise<Principal | null> {
    const result = await this.database.query<PrincipalRow>(
      `SELECT principal.id, principal.name, principal.status, principal.created_at
       FROM principal_identities AS identity
       JOIN principals AS principal ON principal.id = identity.principal_id
       WHERE identity.provider = $1 AND identity.subject = $2`,
      [provider, subject],
    );
    const row = result.rows[0];
    return row ? toPrincipal(row) : null;
  }

  public async createPrincipalForIdentity(
    identity: ExternalIdentity,
    name: string,
  ): Promise<Principal> {
    // Principal and mapping commit together or not at all. A concurrent first sign-in for the same
    // identity blocks on the primary key until the other transaction commits, then inserts nothing;
    // this transaction rolls back its own principal and returns the winner's. No orphan principal
    // survives either way.
    let created: Principal | undefined;
    try {
      created = await withTransaction(this.database, async (connection) => {
        const principal = await connection.query<PrincipalRow>(
          `INSERT INTO principals (name) VALUES ($1)
         RETURNING id, name, status, created_at`,
          [name],
        );
        const mapping = await connection.query(
          `INSERT INTO principal_identities (provider, subject, principal_id, email)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (provider, subject) DO NOTHING
         RETURNING principal_id`,
          [identity.provider, identity.subject, principal.rows[0]!.id, identity.email],
        );
        // Lost the race: throwing rolls back this transaction's own principal row.
        if (mapping.rowCount !== 1) throw new IdentityAlreadyMapped();
        return toPrincipal(principal.rows[0]!);
      });
    } catch (error) {
      if (!(error instanceof IdentityAlreadyMapped)) throw error;
    }

    if (created) return created;
    const winner = await this.findPrincipalByIdentity(identity.provider, identity.subject);
    if (!winner) throw new Error('identity mapping vanished after a conflicting insert');
    return winner;
  }
}
