import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  apiKeyPrefixLength,
  apiKeyPrefixOf,
  apiKeySecretBytes,
  apiKeyTag,
  AuthError,
  principalNameMaxLength,
  type AuthApplication,
  type ExternalIdentity,
  type AuthStore,
  type IssuedApiKey,
  type Principal,
} from './auth-domain.js';

export function hashApiKey(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

export function generateApiKey(): { keyHash: string; keyPrefix: string; secret: string } {
  const secret = `${apiKeyTag}${randomBytes(apiKeySecretBytes).toString('base64url')}`;
  return {
    keyHash: hashApiKey(secret),
    keyPrefix: secret.slice(apiKeyTag.length, apiKeyTag.length + apiKeyPrefixLength),
    secret,
  };
}

function hashesMatch(left: string, right: string): boolean {
  // Both sides are fixed-length hex digests, so the length check below can only fail on a
  // corrupted row -- but timingSafeEqual throws on a length mismatch, so it stays.
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export class AuthService implements AuthApplication {
  public constructor(private readonly store: AuthStore) {}

  public async authenticate(secret: string): Promise<Principal> {
    const prefix = apiKeyPrefixOf(secret);
    if (!prefix) {
      throw new AuthError('UNAUTHORIZED', 'Invalid API key');
    }

    const candidate = await this.store.findKeyCandidateByPrefix(prefix);
    // One message and one code for every failure below: a caller learns that its key does not
    // work, never whether the prefix existed, was revoked, or belongs to a disabled principal.
    if (!candidate || !hashesMatch(candidate.keyHash, hashApiKey(secret))) {
      throw new AuthError('UNAUTHORIZED', 'Invalid API key');
    }
    if (candidate.principal.status !== 'active') {
      throw new AuthError('UNAUTHORIZED', 'Invalid API key');
    }

    return candidate.principal;
  }

  public async authenticateIdentity(identity: ExternalIdentity): Promise<Principal> {
    // Checked before any lookup or insert: an unverified email/password sign-up must not get as
    // far as creating a principal, or anyone could claim an address they do not control.
    if (!identity.emailVerified) {
      throw new AuthError('EMAIL_NOT_VERIFIED', 'Verify your email address before signing in');
    }

    const principal =
      (await this.store.findPrincipalByIdentity(identity.provider, identity.subject)) ??
      (await this.store.createPrincipalForIdentity(
        { ...identity, email: sanitizeProviderText(identity.email, identityEmailMaxLength) },
        principalNameFor(identity),
      ));

    // Same single message as a bad API key: disabling a principal locks out every way in.
    if (principal.status !== 'active') {
      throw new AuthError('UNAUTHORIZED', 'Invalid credentials');
    }
    return principal;
  }

  public async createPrincipal(name: string): Promise<Principal> {
    return await this.store.createPrincipal(name);
  }

  public async issueApiKey(principalId: string): Promise<IssuedApiKey> {
    const principal = await this.store.findPrincipalById(principalId);
    if (!principal) {
      throw new AuthError('PRINCIPAL_NOT_FOUND', 'Principal not found');
    }

    const { keyHash, keyPrefix, secret } = generateApiKey();
    const record = await this.store.insertApiKey({ keyHash, keyPrefix, principalId });
    return { ...record, key: secret };
  }

  public async revokeApiKey(id: string): Promise<void> {
    const revoked = await this.store.revokeApiKey(id);
    if (!revoked) {
      throw new AuthError('API_KEY_NOT_FOUND', 'API key not found');
    }
  }
}

/**
 * Makes provider-supplied text safe to store. A display name is whatever the user typed into
 * their Google/Firebase profile: control characters (NUL in particular, which PostgreSQL rejects
 * in `text`, failing every sign-in for that identity) and lone surrogates are dropped, and the
 * result is cut by code point, never through the middle of an emoji.
 */
export function sanitizeProviderText(value: string | null, maxLength: number): string | null {
  if (value === null) return null;
  const cleaned = Array.from(value.normalize('NFC'))
    .filter((char) => !/[\p{Cc}\p{Cs}]/u.test(char))
    .slice(0, maxLength)
    .join('')
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

/** Matches the `principal_identities.email` CHECK (RFC 5321's practical limit). */
const identityEmailMaxLength = 320;

function principalNameFor(identity: ExternalIdentity): string {
  return (
    sanitizeProviderText(identity.displayName, principalNameMaxLength) ??
    sanitizeProviderText(identity.email, principalNameMaxLength) ??
    `${identity.provider}:${identity.subject}`.slice(0, principalNameMaxLength)
  );
}
