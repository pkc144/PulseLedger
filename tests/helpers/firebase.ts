import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type JWTVerifyGetKey,
} from 'jose';

export const testFirebaseProjectId = 'pulseledger-test';

export interface TestFirebaseSigner {
  /** A local stand-in for Google's JWKS endpoint, holding only this signer's public key. */
  keys: JWTVerifyGetKey;
  sign(
    claims?: Record<string, unknown>,
    options?: { kid?: string; key?: CryptoKey },
  ): Promise<string>;
}

/**
 * Mints ID tokens shaped exactly like Firebase's -- RS256, `kid` header, issuer/audience bound to
 * the project -- signed by a key generated per test file. Tests override any claim to break it.
 */
export async function createTestFirebaseSigner(): Promise<TestFirebaseSigner> {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), alg: 'RS256', kid: 'test-key', use: 'sig' };
  const keys = createLocalJWKSet({ keys: [jwk] });

  return {
    keys,
    async sign(claims = {}, options = {}) {
      const now = Math.floor(Date.now() / 1000);
      const payload = {
        auth_time: now - 10,
        email: 'ada@example.com',
        email_verified: true,
        firebase: { sign_in_provider: 'password' },
        iat: now - 10,
        exp: now + 3600,
        iss: `https://securetoken.google.com/${testFirebaseProjectId}`,
        aud: testFirebaseProjectId,
        sub: 'firebase-uid-ada',
        ...claims,
      };
      return await new SignJWT(payload)
        .setProtectedHeader({ alg: 'RS256', kid: options.kid ?? 'test-key', typ: 'JWT' })
        .sign(options.key ?? privateKey);
    },
  };
}
