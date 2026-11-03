import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { AuthShell } from '../components/auth/AuthShell';
import { Alert, SecretField, SubmitButton } from '../components/auth/fields';
import { ApiError, api } from '../lib/api';
import { useCredential, writeCredential } from '../lib/session';

/**
 * The backend has exactly one admin credential: the static ADMIN_API_KEY, sent as the
 * `x-admin-api-key` header. There is no admin username or session endpoint, so this page asks for
 * that key and proves it with a harmless admin read before entering the console.
 */
export function AdminLogin() {
  const navigate = useNavigate();
  const existing = useCredential('adminKey');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  if (existing) return <Navigate to="/admin" replace />;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const candidate = key.trim();
    if (!candidate) {
      setError('Enter the admin API key.');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      // Verified first, stored only on success: storing it up front would trigger this page's
      // "already signed in" redirect before the server had answered.
      await api.verifyAdminKey(candidate);
      writeCredential('adminKey', candidate);
      void navigate('/admin', { replace: true });
    } catch (caught) {
      setError(describe(caught));
      setBusy(false);
    }
  }

  return (
    <AuthShell
      title="Admin login"
      subtitle="Operator access to onboarding, funding, reconciliation, and metrics."
      aside={{
        heading: 'The operator console.',
        points: [
          'Onboard customers and issue API keys, shown exactly once',
          'Fund accounts through balanced treasury postings',
          'Reconcile every balance against the immutable journal',
        ],
      }}
    >
      <form onSubmit={(event) => void submit(event)} noValidate className="space-y-5">
        <SecretField
          label="Admin API key"
          name="admin-key"
          autoComplete="current-password"
          placeholder="••••••••••••••••"
          value={key}
          onChange={(event) => {
            setKey(event.target.value);
            setError(undefined);
          }}
          error={error && !key.trim() ? error : undefined}
          hint="The ADMIN_API_KEY value from the server’s .env file."
          disabled={busy}
          autoFocus
        />
        {error && key.trim() && <Alert tone="error">{error}</Alert>}
        <SubmitButton busy={busy} busyLabel="Verifying key…">
          Log in to console
        </SubmitButton>
      </form>

      <p className="mt-8 border-t border-white/[0.06] pt-5 text-xs leading-relaxed text-slate-500">
        The key is held in this tab’s session storage only — never in source code or local storage —
        and is cleared when the tab closes or you sign out.
      </p>
    </AuthShell>
  );
}

function describe(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401)
      return 'That admin key was rejected. Check it matches ADMIN_API_KEY on the server.';
    if (error.code === 'NETWORK_ERROR')
      return 'Cannot reach the ledger API. Is the server running on port 3000?';
    return `${error.message} (${error.code})`;
  }
  return 'Something went wrong. Try again.';
}
