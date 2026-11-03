import { useState } from 'react';
import type { User } from 'firebase/auth';
import { Button, Card } from '../components/ui';
import {
  firebaseErrorMessage,
  firebaseSignOut,
  refreshVerification,
  resendVerification,
} from '../lib/firebase';

/** The API refuses unverified email/password users (403 EMAIL_NOT_VERIFIED), so the UI stops here. */
export function VerifyEmail({ user, onVerified }: { user: User; onVerified: () => void }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string }>();

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setMessage(undefined);
    try {
      await action();
    } catch (caught) {
      setMessage({ tone: 'error', text: firebaseErrorMessage(caught) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-md">
      <Card title="Verify your email">
        <p className="text-sm text-slate-600">
          We sent a verification link to{' '}
          <span className="font-medium text-slate-900">{user.email}</span>. Click it, then come back
          here.
        </p>
        {message && (
          <p
            className={`mt-3 rounded-lg px-3 py-2 text-sm ${message.tone === 'ok' ? 'bg-emerald-50 text-emerald-800' : 'bg-rose-50 text-rose-800'}`}
          >
            {message.text}
          </p>
        )}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                if (await refreshVerification()) onVerified();
                else
                  setMessage({
                    tone: 'error',
                    text: 'Not verified yet. Check your inbox (and spam folder).',
                  });
              })
            }
          >
            I’ve verified my email
          </Button>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await resendVerification();
                setMessage({ tone: 'ok', text: 'Sent another link.' });
              })
            }
          >
            Resend link
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => void firebaseSignOut()}>
            Use another account
          </Button>
        </div>
      </Card>
    </div>
  );
}
