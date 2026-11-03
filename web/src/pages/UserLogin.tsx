import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { AuthShell } from '../components/auth/AuthShell';
import { Alert, SecretField, SubmitButton, TextField } from '../components/auth/fields';
import { ApiError, api } from '../lib/api';
import {
  auth,
  firebaseErrorMessage,
  resetPassword,
  signInWithEmail,
  signInWithGoogle,
  signUpWithEmail,
  useFirebaseUser,
} from '../lib/firebase';
import { useCredential, writeCredential } from '../lib/session';

type Method = 'email' | 'apikey';
type EmailMode = 'signin' | 'signup' | 'reset';

/**
 * Two real customer credentials exist in the backend, and both are offered here:
 *  - Firebase Authentication (Google or email/password), verified server-side when the API has
 *    FIREBASE_PROJECT_ID set;
 *  - a PulseLedger API key (`pl_live_…`) issued by an administrator.
 */
export function UserLogin() {
  const user = useFirebaseUser();
  const apiKey = useCredential('customerKey');
  const [method, setMethod] = useState<Method>(auth ? 'email' : 'apikey');

  if (apiKey || user) return <Navigate to="/app" replace />;

  return (
    <AuthShell
      title="Sign in"
      subtitle="Access your accounts, send payments, and see every ledger entry."
      aside={{
        heading: 'Your money, provably correct.',
        points: [
          'Every payment written as balanced debit and credit entries',
          'Retries are safe — one request is one payment',
          'Only you can see or spend from your accounts',
        ],
      }}
    >
      <div
        role="tablist"
        aria-label="Sign-in method"
        className="mb-6 grid grid-cols-2 gap-1 rounded-xl border border-white/[0.08] bg-ink-900 p-1"
      >
        {(
          [
            ['email', 'Email or Google'],
            ['apikey', 'API key'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            id={`tab-${value}`}
            aria-selected={method === value}
            aria-controls={method === value ? `panel-${value}` : undefined}
            tabIndex={method === value ? 0 : -1}
            onClick={() => setMethod(value)}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
              event.preventDefault();
              const next: Method = value === 'email' ? 'apikey' : 'email';
              setMethod(next);
              document.getElementById(`tab-${next}`)?.focus();
            }}
            className={`rounded-lg py-2 text-sm font-medium transition focus-visible:outline-2 focus-visible:outline-pulse-400 ${
              method === value
                ? 'bg-ink-700 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`panel-${method}`} aria-labelledby={`tab-${method}`}>
        {method === 'email' ? auth ? <EmailSignIn /> : <FirebaseUnavailable /> : <ApiKeySignIn />}
      </div>
    </AuthShell>
  );
}

function EmailSignIn() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<EmailMode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState<'google' | 'email' | null>(null);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  async function run(kind: 'google' | 'email', action: () => Promise<void>, after?: () => void) {
    setBusy(kind);
    setError(undefined);
    setNotice(undefined);
    try {
      writeCredential('customerKey', null);
      await action();
      if (after) after();
      else void navigate('/app', { replace: true });
    } catch (caught) {
      setError(firebaseErrorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!email.trim()) return setError('Enter your email address.');
    if (mode === 'reset') {
      void run(
        'email',
        () => resetPassword(email.trim()),
        () => {
          setNotice('If an account exists for that address, a reset link is on its way.');
          setMode('signin');
        },
      );
      return;
    }
    if (!password) return setError('Enter your password.');
    void run('email', () =>
      mode === 'signup'
        ? signUpWithEmail(email.trim(), password)
        : signInWithEmail(email.trim(), password),
    );
  }

  return (
    <div>
      {mode !== 'reset' && (
        <>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void run('google', signInWithGoogle)}
            className="flex w-full items-center justify-center gap-2.5 rounded-xl border border-white/12 bg-white/[0.04] px-4 py-3 text-sm font-semibold text-white transition hover:bg-white/[0.08] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pulse-400 disabled:opacity-50"
          >
            {busy === 'google' ? (
              <span
                aria-hidden="true"
                className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white"
              />
            ) : (
              <GoogleMark />
            )}
            {busy === 'google' ? 'Waiting for Google…' : 'Continue with Google'}
          </button>
          <div className="my-6 flex items-center gap-3 text-xs text-slate-500">
            <span className="h-px flex-1 bg-white/[0.08]" />
            or with email
            <span className="h-px flex-1 bg-white/[0.08]" />
          </div>
        </>
      )}

      <form onSubmit={submit} noValidate className="space-y-5">
        <TextField
          label="Email"
          type="email"
          name="email"
          autoComplete="email"
          inputMode="email"
          placeholder="you@company.com"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          disabled={busy !== null}
        />
        {mode !== 'reset' && (
          <SecretField
            label="Password"
            name="password"
            autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            hint={
              mode === 'signup'
                ? 'At least 6 characters. We’ll email you a verification link.'
                : undefined
            }
            disabled={busy !== null}
          />
        )}
        {mode === 'signin' && (
          <div className="-mt-2 text-right">
            <button
              type="button"
              onClick={() => setMode('reset')}
              className="text-xs text-slate-400 hover:text-pulse-300"
            >
              Forgot password?
            </button>
          </div>
        )}
        {error && <Alert tone="error">{error}</Alert>}
        {notice && <Alert tone="success">{notice}</Alert>}
        <SubmitButton busy={busy === 'email'} busyLabel="Please wait…" disabled={busy === 'google'}>
          {{ signin: 'Sign in', signup: 'Create account', reset: 'Send reset link' }[mode]}
        </SubmitButton>
      </form>

      <p className="mt-6 text-center text-sm text-slate-400">
        {mode === 'signin' ? (
          <>
            New to PulseLedger?{' '}
            <button
              type="button"
              onClick={() => setMode('signup')}
              className="font-medium text-pulse-400 hover:text-pulse-300"
            >
              Create an account
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setMode('signin')}
            className="font-medium text-pulse-400 hover:text-pulse-300"
          >
            ← Back to sign in
          </button>
        )}
      </p>
    </div>
  );
}

function ApiKeySignIn() {
  const navigate = useNavigate();
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const candidate = key.trim();
    if (!candidate.startsWith('pl_live_')) {
      setError('Customer API keys start with “pl_live_”.');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await api.verifyCustomerKey(candidate); // proven before it is stored anywhere
      writeCredential('customerKey', candidate);
      void navigate('/app', { replace: true });
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.status === 401
          ? 'That API key is invalid or has been revoked.'
          : caught instanceof ApiError && caught.code === 'NETWORK_ERROR'
            ? 'Cannot reach the ledger API. Is the server running?'
            : 'Something went wrong. Try again.',
      );
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} noValidate className="space-y-5">
      <SecretField
        label="Customer API key"
        name="api-key"
        autoComplete="off"
        placeholder="pl_live_…"
        value={key}
        onChange={(event) => {
          setKey(event.target.value);
          setError(undefined);
        }}
        hint="Issued by an administrator. Kept in this tab only."
        disabled={busy}
      />
      {error && <Alert tone="error">{error}</Alert>}
      <SubmitButton busy={busy} busyLabel="Verifying key…">
        Sign in with API key
      </SubmitButton>
    </form>
  );
}

function FirebaseUnavailable() {
  return (
    <Alert tone="info">
      Email and Google sign-in aren’t configured in this build. Add the Firebase web config to{' '}
      <code className="font-mono text-pulse-300">web/.env.local</code> and set{' '}
      <code className="font-mono text-pulse-300">FIREBASE_PROJECT_ID</code> on the API — or use the
      API key tab.
    </Alert>
  );
}

function GoogleMark() {
  return (
    <svg viewBox="0 0 48 48" className="h-4 w-4" aria-hidden="true">
      <path
        fill="#FFC107"
        d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"
      />
      <path
        fill="#FF3D00"
        d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"
      />
      <path
        fill="#4CAF50"
        d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"
      />
      <path
        fill="#1976D2"
        d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"
      />
    </svg>
  );
}
