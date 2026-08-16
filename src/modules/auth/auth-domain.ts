export const principalStatuses = ['active', 'disabled'] as const;
export type PrincipalStatus = (typeof principalStatuses)[number];

export type AuthErrorCode = 'API_KEY_NOT_FOUND' | 'PRINCIPAL_NOT_FOUND' | 'UNAUTHORIZED';

export class AuthError extends Error {
  public constructor(
    public readonly code: AuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export interface Principal {
  createdAt: string;
  id: string;
  name: string;
  status: PrincipalStatus;
}

export interface ApiKeyRecord {
  createdAt: string;
  id: string;
  keyPrefix: string;
  principalId: string;
  revokedAt: string | null;
}

/**
 * An issued key including its secret. The secret exists in this shape exactly once — in the
 * response to the call that created it — because only its SHA-256 hash is stored.
 */
export interface IssuedApiKey extends ApiKeyRecord {
  key: string;
}

export interface ApiKeyCandidate {
  keyHash: string;
  keyId: string;
  principal: Principal;
}

export interface AuthStore {
  createPrincipal(name: string): Promise<Principal>;
  findPrincipalById(id: string): Promise<Principal | null>;
  /** Looks up a live key by its public prefix. Returns the stored hash for the caller to verify. */
  findKeyCandidateByPrefix(keyPrefix: string): Promise<ApiKeyCandidate | null>;
  insertApiKey(input: {
    keyHash: string;
    keyPrefix: string;
    principalId: string;
  }): Promise<ApiKeyRecord>;
  revokeApiKey(id: string): Promise<boolean>;
}

export interface AuthApplication {
  /** Resolves a bearer secret to its principal, or throws `UNAUTHORIZED`. */
  authenticate(secret: string): Promise<Principal>;
  createPrincipal(name: string): Promise<Principal>;
  issueApiKey(principalId: string): Promise<IssuedApiKey>;
  revokeApiKey(id: string): Promise<void>;
}

/**
 * Secrets are `pl_live_` plus 43 base64url characters (32 random bytes). The first
 * `apiKeyPrefixLength` characters after the tag are the public lookup handle: enough to find one
 * row, far too little to reconstruct the key.
 */
export const apiKeyTag = 'pl_live_';
export const apiKeyPrefixLength = 12;
export const apiKeySecretBytes = 32;

export function apiKeyPrefixOf(secret: string): string | null {
  if (!secret.startsWith(apiKeyTag)) return null;
  const body = secret.slice(apiKeyTag.length);
  if (body.length < apiKeyPrefixLength) return null;
  return body.slice(0, apiKeyPrefixLength);
}
