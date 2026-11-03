import { initializeApp } from 'firebase/app';
import {
  GoogleAuthProvider,
  createUserWithEmailAndPassword,
  getAuth,
  onAuthStateChanged,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  type Auth,
  type User,
} from 'firebase/auth';
import { useEffect, useState } from 'react';

const env = import.meta.env;

/** Firebase sign-in is offered only when the web config is present (see web/.env.example). */
export const auth: Auth | null = env.VITE_FIREBASE_API_KEY
  ? getAuth(
      initializeApp({
        apiKey: env.VITE_FIREBASE_API_KEY,
        authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
        projectId: env.VITE_FIREBASE_PROJECT_ID,
        appId: env.VITE_FIREBASE_APP_ID,
      }),
    )
  : null;

/** `undefined` while Firebase restores a persisted session; then the user or `null`. */
export function useFirebaseUser(): User | null | undefined {
  const [user, setUser] = useState<User | null | undefined>(auth ? undefined : null);
  useEffect(() => (auth ? onAuthStateChanged(auth, setUser) : undefined), []);
  return user;
}

function requireAuth(): Auth {
  if (!auth) throw new Error('Firebase is not configured');
  return auth;
}

export async function signInWithGoogle(): Promise<void> {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  await signInWithPopup(requireAuth(), provider);
}

export async function signInWithEmail(email: string, password: string): Promise<void> {
  await signInWithEmailAndPassword(requireAuth(), email, password);
}

/** Creates the account and immediately sends the verification link the ledger requires. */
export async function signUpWithEmail(email: string, password: string): Promise<void> {
  const { user } = await createUserWithEmailAndPassword(requireAuth(), email, password);
  await sendEmailVerification(user);
}

export async function resendVerification(): Promise<void> {
  const user = requireAuth().currentUser;
  if (user) await sendEmailVerification(user);
}

export async function resetPassword(email: string): Promise<void> {
  await sendPasswordResetEmail(requireAuth(), email);
}

/**
 * After the user clicks the link, the cached ID token still says `email_verified: false` until it
 * is refreshed -- and that claim is what the API checks. Reload the profile, then force a new token.
 */
export async function refreshVerification(): Promise<boolean> {
  const user = requireAuth().currentUser;
  if (!user) return false;
  await user.reload();
  if (user.emailVerified) await user.getIdToken(true);
  return user.emailVerified;
}

export async function firebaseSignOut(): Promise<void> {
  if (auth) await signOut(auth);
}

/** A fresh-enough ID token (the SDK refreshes it before its one-hour expiry), or null. */
export async function currentIdToken(): Promise<string | null> {
  return (await auth?.currentUser?.getIdToken()) ?? null;
}

const friendlyMessages: Record<string, string> = {
  'auth/email-already-in-use': 'An account with this email already exists. Sign in instead.',
  'auth/invalid-credential': 'Email or password is incorrect.',
  'auth/invalid-email': 'That doesn’t look like a valid email address.',
  'auth/missing-password': 'Enter your password.',
  'auth/weak-password': 'Choose a password of at least 6 characters.',
  'auth/too-many-requests': 'Too many attempts. Wait a moment and try again.',
  'auth/popup-closed-by-user': 'The Google sign-in window was closed before finishing.',
  'auth/popup-blocked': 'Your browser blocked the Google sign-in popup. Allow popups and retry.',
  'auth/account-exists-with-different-credential':
    'This email is already registered with another sign-in method.',
  'auth/network-request-failed': 'Network error reaching Firebase. Check your connection.',
  'auth/operation-not-allowed': 'This sign-in method is not enabled in the Firebase console.',
  'auth/unauthorized-domain': 'This domain is not authorized in Firebase Authentication settings.',
};

export function firebaseErrorMessage(error: unknown): string {
  const code = (error as { code?: string })?.code;
  if (code && friendlyMessages[code]) return friendlyMessages[code];
  return error instanceof Error ? error.message : String(error);
}
