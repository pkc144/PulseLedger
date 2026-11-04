import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { AppError } from '../../errors.js';

/** Google's published signing keys for Firebase Authentication ID tokens (rotated, cached). */
export const firebaseSigningKeysUrl =
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

export interface VerifiedFirebaseToken {
  displayName: string | null;
  email: string | null;
  emailVerified: boolean;
  provider: 'firebase';
  subject: string;
}

export type FirebaseTokenVerifier = (token: string) => Promise<VerifiedFirebaseToken>;

export interface FirebaseTokenVerifierOptions {
  projectId: string;
  /** Signing keys; defaults to Google's JWKS endpoint. Tests supply a local key set. */
  keys?: JWTVerifyGetKey;
  /** Seconds of clock skew tolerated on `exp`, `iat`, and `auth_time`. */
  clockToleranceSeconds?: number;
}

const maxSubjectLength = 128; // Firebase's documented UID limit, and the column's CHECK.

/**
 * Verifies a Firebase Authentication ID token the way Firebase documents it, without the Admin SDK
 * or a service-account credential: RS256 signature against Google's public keys, issuer and
 * audience bound to this project, unexpired, issued and authenticated in the past, with a
 * non-empty subject. Everything about *who may act* is left to the auth module.
 *
 * Failures are deliberately coarse: any token problem is one 401 message, so a caller learns
 * nothing about which check it failed. Failing to fetch Google's keys is a 503 instead -- the
 * caller's credential may be perfectly good, and telling a client to sign in again would be wrong.
 */
export function createFirebaseTokenVerifier(
  options: FirebaseTokenVerifierOptions,
): FirebaseTokenVerifier {
  const keys = options.keys ?? createRemoteJWKSet(new URL(firebaseSigningKeysUrl));
  const clockTolerance = options.clockToleranceSeconds ?? 5;

  return async function verifyFirebaseToken(token) {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, keys, {
        algorithms: ['RS256'],
        audience: options.projectId,
        clockTolerance,
        issuer: `https://securetoken.google.com/${options.projectId}`,
        requiredClaims: ['sub', 'iat', 'exp', 'auth_time'],
      }));
    } catch (error) {
      // Only errors that describe the *token* are the caller's fault. Everything else -- a JWKS
      // timeout, a non-200 or malformed key-set response (jose raises those as a generic
      // JOSEError / JWKSInvalid), or a network failure -- means the keys could not be obtained,
      // and the caller's credential may be perfectly good.
      if (isTokenError(error)) throw invalidToken();
      throw new AppError(
        'AUTH_PROVIDER_UNAVAILABLE',
        503,
        'Identity provider keys are unavailable; retry shortly',
      );
    }

    // jose checks `iat` against the clock only when `maxTokenAge` is set, so "issued in the
    // past" is enforced here, alongside `auth_time`.
    const nowSeconds = Math.floor(Date.now() / 1000);
    for (const claim of [payload.iat, payload.auth_time]) {
      if (typeof claim !== 'number' || claim > nowSeconds + clockTolerance) {
        throw invalidToken();
      }
    }
    const subject = payload.sub;
    if (typeof subject !== 'string' || subject.length === 0 || subject.length > maxSubjectLength) {
      throw invalidToken();
    }

    return {
      displayName: typeof payload.name === 'string' ? payload.name : null,
      email: typeof payload.email === 'string' ? payload.email : null,
      emailVerified: payload.email_verified === true,
      provider: 'firebase',
      subject,
    };
  };
}

/** jose errors raised by the token itself: its shape, its claims, its algorithm, its signature. */
const tokenErrorTypes = [
  errors.JOSEAlgNotAllowed,
  errors.JOSENotSupported,
  errors.JWKSMultipleMatchingKeys,
  errors.JWKSNoMatchingKey,
  errors.JWSInvalid,
  errors.JWSSignatureVerificationFailed,
  errors.JWTClaimValidationFailed,
  errors.JWTExpired,
  errors.JWTInvalid,
];

function isTokenError(error: unknown): boolean {
  return tokenErrorTypes.some((type) => error instanceof type);
}

function invalidToken(): AppError {
  return new AppError('UNAUTHORIZED', 401, 'Invalid or expired ID token');
}
