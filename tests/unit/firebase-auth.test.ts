import { errors, generateKeyPair, SignJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../../src/errors.js';
import {
  createFirebaseTokenVerifier,
  type FirebaseTokenVerifier,
} from '../../src/infrastructure/http/firebase-id-token.js';
import type { AuthStore, ExternalIdentity, Principal } from '../../src/modules/auth/auth-domain.js';
import { AuthService } from '../../src/modules/auth/auth-service.js';
import {
  createTestFirebaseSigner,
  testFirebaseProjectId,
  type TestFirebaseSigner,
} from '../helpers/firebase.js';

let signer: TestFirebaseSigner;
let verify: FirebaseTokenVerifier;

beforeAll(async () => {
  signer = await createTestFirebaseSigner();
  verify = createFirebaseTokenVerifier({ keys: signer.keys, projectId: testFirebaseProjectId });
});

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(AppError);
  return error as AppError;
}

describe('Firebase ID token verification', () => {
  it('accepts a correctly signed token and returns the identity claims', async () => {
    const token = await signer.sign({ name: 'Ada Lovelace' });
    await expect(verify(token)).resolves.toEqual({
      displayName: 'Ada Lovelace',
      email: 'ada@example.com',
      emailVerified: true,
      provider: 'firebase',
      subject: 'firebase-uid-ada',
    });
  });

  it('reports an unverified email rather than rejecting the token', async () => {
    const identity = await verify(await signer.sign({ email_verified: false }));
    expect(identity.emailVerified).toBe(false);
  });

  it.each([
    ['another project’s audience', { aud: 'someone-elses-project' }],
    ['another project’s issuer', { iss: 'https://securetoken.google.com/someone-elses-project' }],
    ['an expired token', { exp: Math.floor(Date.now() / 1000) - 60 }],
    ['an auth_time in the future', { auth_time: Math.floor(Date.now() / 1000) + 600 }],
    ['an empty subject', { sub: '' }],
    ['an oversized subject', { sub: 'x'.repeat(129) }],
    ['a missing auth_time', { auth_time: undefined }],
    ['an iat in the future', { iat: Math.floor(Date.now() / 1000) + 600 }],
  ])('rejects %s with one generic 401', async (_label, claims) => {
    const error = await rejection(verify(await signer.sign(claims)));
    expect(error).toMatchObject({
      code: 'UNAUTHORIZED',
      statusCode: 401,
      message: 'Invalid or expired ID token',
    });
  });

  it('rejects a token signed by a key Google did not publish', async () => {
    const { privateKey } = await generateKeyPair('RS256');
    const error = await rejection(verify(await signer.sign({}, { key: privateKey })));
    expect(error.statusCode).toBe(401);
  });

  it('rejects a symmetric (HS256) token even with a matching kid', async () => {
    const forged = await new SignJWT({ sub: 'firebase-uid-ada', auth_time: 1 })
      .setProtectedHeader({ alg: 'HS256', kid: 'test-key' })
      .setIssuer(`https://securetoken.google.com/${testFirebaseProjectId}`)
      .setAudience(testFirebaseProjectId)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode('a-shared-secret-anyone-could-guess'));
    expect((await rejection(verify(forged))).statusCode).toBe(401);
  });

  it('rejects garbage', async () => {
    expect((await rejection(verify('not-a-jwt'))).statusCode).toBe(401);
  });

  it('answers 503, not 401, when Google’s signing keys cannot be fetched', async () => {
    const offline = createFirebaseTokenVerifier({
      keys: async () => {
        throw new TypeError('fetch failed');
      },
      projectId: testFirebaseProjectId,
    });
    const error = await rejection(offline(await signer.sign()));
    expect(error).toMatchObject({ code: 'AUTH_PROVIDER_UNAVAILABLE', statusCode: 503 });
  });

  // jose reports a non-200 key-set response as a bare JOSEError and a malformed one as
  // JWKSInvalid. Both say nothing about the caller's token, so neither may become a 401.
  it.each([
    ['a non-200 key-set response', () => new errors.JOSEError('Expected 200 OK')],
    ['a malformed key set', () => new errors.JWKSInvalid('JSON Web Key Set malformed')],
    ['a key-set timeout', () => new errors.JWKSTimeout()],
  ])('answers 503 for %s', async (_label, failure) => {
    const broken = createFirebaseTokenVerifier({
      keys: async () => {
        throw failure();
      },
      projectId: testFirebaseProjectId,
    });
    const error = await rejection(broken(await signer.sign()));
    expect(error).toMatchObject({ code: 'AUTH_PROVIDER_UNAVAILABLE', statusCode: 503 });
  });
});

class MemoryAuthStore implements Pick<
  AuthStore,
  'findPrincipalByIdentity' | 'createPrincipalForIdentity'
> {
  public readonly principals = new Map<string, Principal>();
  public calls = 0;

  public async findPrincipalByIdentity(_provider: string, subject: string) {
    this.calls += 1;
    return this.principals.get(subject) ?? null;
  }

  public async createPrincipalForIdentity(identity: ExternalIdentity, name: string) {
    this.calls += 1;
    const principal: Principal = {
      createdAt: new Date().toISOString(),
      id: `principal-${this.principals.size + 1}`,
      name,
      status: 'active',
    };
    this.principals.set(identity.subject, principal);
    return principal;
  }
}

describe('AuthService.authenticateIdentity', () => {
  const identity: ExternalIdentity = {
    displayName: null,
    email: 'ada@example.com',
    emailVerified: true,
    provider: 'firebase',
    subject: 'uid-1',
  };

  function service(store: MemoryAuthStore) {
    return new AuthService(store as unknown as AuthStore);
  }

  it('provisions a principal on first sign-in and reuses it afterwards', async () => {
    const store = new MemoryAuthStore();
    const first = await service(store).authenticateIdentity(identity);
    const second = await service(store).authenticateIdentity(identity);
    expect(second.id).toBe(first.id);
    expect(first.name).toBe('ada@example.com');
    expect(store.principals.size).toBe(1);
  });

  it('refuses an unverified email before touching the store', async () => {
    const store = new MemoryAuthStore();
    await expect(
      service(store).authenticateIdentity({ ...identity, emailVerified: false }),
    ).rejects.toMatchObject({
      code: 'EMAIL_NOT_VERIFIED',
    });
    expect(store.calls).toBe(0);
  });

  it('refuses a disabled principal with the generic message', async () => {
    const store = new MemoryAuthStore();
    const principal = await service(store).authenticateIdentity(identity);
    store.principals.set(identity.subject, { ...principal, status: 'disabled' });
    await expect(service(store).authenticateIdentity(identity)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'Invalid credentials',
    });
  });

  it('prefers the display name and caps it at the column limit', async () => {
    const store = new MemoryAuthStore();
    const principal = await service(store).authenticateIdentity({
      ...identity,
      displayName: 'A'.repeat(300),
    });
    expect(principal.name).toHaveLength(128);
  });

  it('strips characters PostgreSQL cannot store from a display name', async () => {
    const store = new MemoryAuthStore();
    const principal = await service(store).authenticateIdentity({
      ...identity,
      displayName: 'Ada\u0000 Love\u0007lace',
    });
    expect(principal.name).toBe('Ada Lovelace');
  });

  it('never cuts a display name through the middle of an emoji', async () => {
    const store = new MemoryAuthStore();
    const principal = await service(store).authenticateIdentity({
      ...identity,
      displayName: `${'a'.repeat(127)}😀😀`,
    });
    expect(principal.name).toBe(`${'a'.repeat(127)}😀`);
    expect(principal.name).not.toMatch(/\p{Cs}/u);
  });

  it('falls back to the email when the display name is only unstorable characters', async () => {
    const store = new MemoryAuthStore();
    const principal = await service(store).authenticateIdentity({
      ...identity,
      displayName: '\u0000\u0000',
    });
    expect(principal.name).toBe('ada@example.com');
  });
});
