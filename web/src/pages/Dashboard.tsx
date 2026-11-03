import { useState } from 'react';
import { Link } from 'react-router';
import {
  Button,
  Card,
  CopyText,
  ErrorBanner,
  Money,
  Select,
  StatusPill,
  formatTime,
} from '../components/ui';
import { api, currencies, type Currency } from '../lib/api';
import { firebaseSignOut, useFirebaseUser } from '../lib/firebase';
import { useCredential, writeCredential } from '../lib/session';
import { useAsync } from '../lib/use-async';

export function Dashboard() {
  const { data, error, loading, reload } = useAsync(() => api.listAccounts(), []);
  const [currency, setCurrency] = useState<Currency>('INR');
  const [createError, setCreateError] = useState<unknown>();
  const [creating, setCreating] = useState(false);

  async function create() {
    setCreating(true);
    setCreateError(undefined);
    try {
      await api.createAccount(currency);
      reload();
    } catch (caught) {
      setCreateError(caught);
    } finally {
      setCreating(false);
    }
  }

  const accounts = data?.accounts ?? [];
  const user = useFirebaseUser();
  const usingApiKey = useCredential('customerKey') !== null;
  const who = usingApiKey ? 'API key' : (user?.displayName ?? user?.email);

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Your accounts</h1>
          <p className="text-sm text-slate-500">
            {who && (
              <>
                Signed in as <span className="font-medium text-slate-700">{who}</span> ·{' '}
              </>
            )}
            Balances are read straight from the ledger.
          </p>
        </div>
        <Button
          variant="secondary"
          onClick={() => {
            writeCredential('customerKey', null);
            void firebaseSignOut();
          }}
        >
          Sign out
        </Button>
      </div>

      <ErrorBanner error={error} />

      {loading && !data ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : accounts.length === 0 ? (
        <Card>
          <p className="text-sm text-slate-600">No accounts yet. Open one below to get started.</p>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {accounts.map((account) => (
            <Link
              key={account.id}
              to={`/app/accounts/${account.id}`}
              className="group rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-indigo-300 hover:shadow"
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold tracking-wide text-slate-500">
                  {account.currency}
                </span>
                <StatusPill status={account.status} />
              </div>
              <Money
                amountMinor={account.balanceMinor}
                currency={account.currency}
                className="mt-3 block text-2xl font-semibold"
              />
              <div className="mt-3 flex items-center justify-between text-xs text-slate-400">
                <span className="font-mono">{account.id.slice(0, 8)}…</span>
                <span>opened {formatTime(account.createdAt)}</span>
              </div>
            </Link>
          ))}
        </div>
      )}

      <Card title="Open a new account">
        <div className="flex items-end gap-3">
          <div className="w-40">
            <Select
              label="Currency"
              value={currency}
              onChange={(event) => setCurrency(event.target.value as Currency)}
            >
              {currencies.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </Select>
          </div>
          <Button onClick={() => void create()} disabled={creating}>
            {creating ? 'Opening…' : 'Open account'}
          </Button>
        </div>
        <p className="mt-3 text-xs text-slate-500">
          New accounts start at zero. Money only enters through a journaled treasury funding (Admin
          → Fund).
        </p>
        <div className="mt-2">
          <ErrorBanner error={createError} />
        </div>
      </Card>

      {accounts.length > 0 && (
        <Card title="Account IDs">
          <p className="mb-2 text-xs text-slate-500">
            Share an ID with someone so they can pay you.
          </p>
          <ul className="space-y-1">
            {accounts.map((account) => (
              <li key={account.id} className="flex items-center gap-2 text-sm">
                <span className="w-10 text-xs font-semibold text-slate-500">
                  {account.currency}
                </span>
                <CopyText value={account.id} />
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
