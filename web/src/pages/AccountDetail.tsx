import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import {
  Button,
  Card,
  CopyText,
  ErrorBanner,
  Field,
  Money,
  Select,
  StatusPill,
  formatTime,
} from '../components/ui';
import { ApiError, api, type Account, type JournalEntry, type Transfer } from '../lib/api';
import { parseMajorToMinor } from '../lib/money';
import { useAsync } from '../lib/use-async';

export function AccountDetail() {
  const { id = '' } = useParams();
  const account = useAsync(() => api.getAccount(id), [id]);
  const owned = useAsync(() => api.listAccounts(), []);
  const [historyVersion, setHistoryVersion] = useState(0);

  if (account.error) {
    return (
      <div className="space-y-4">
        <BackLink />
        <ErrorBanner error={account.error} />
      </div>
    );
  }
  if (!account.data) return <p className="text-sm text-slate-500">Loading…</p>;

  const current = account.data;
  return (
    <div className="space-y-6">
      <BackLink />
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-sm text-slate-500">
            {current.currency} account <StatusPill status={current.status} />
          </div>
          <Money
            amountMinor={current.balanceMinor}
            currency={current.currency}
            className="mt-1 block text-4xl font-bold tracking-tight"
          />
          <div className="mt-1">
            <CopyText value={current.id} />
          </div>
        </div>
        <Button variant="secondary" onClick={account.reload}>
          Refresh
        </Button>
      </div>

      <div className="grid gap-6 lg:grid-cols-5">
        <div className="lg:col-span-2">
          <SendMoney
            source={current}
            ownAccounts={owned.data?.accounts ?? []}
            onSent={() => {
              account.reload();
              owned.reload();
              setHistoryVersion((v) => v + 1);
            }}
          />
        </div>
        <div className="lg:col-span-3">
          <History accountId={current.id} currency={current.currency} version={historyVersion} />
        </div>
      </div>
    </div>
  );
}

function BackLink() {
  return (
    <Link to="/app" className="text-sm text-indigo-600 hover:underline">
      ← All accounts
    </Link>
  );
}

/**
 * One idempotency key per *intent*: it is created when the form values change and kept across
 * retries of that same submission, so a timeout or a 503 can be retried without paying twice.
 * A successful send (or any edit to the form) starts a new intent with a new key.
 */
function SendMoney({
  source,
  ownAccounts,
  onSent,
}: {
  source: Account;
  ownAccounts: Account[];
  onSent: () => void;
}) {
  const [destinationMode, setDestinationMode] = useState<'own' | 'other'>('own');
  const [destination, setDestination] = useState('');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [receipt, setReceipt] = useState<{ transfer: Transfer; key: string }>();
  const intentKey = useRef(crypto.randomUUID());

  const candidates = useMemo(
    () => ownAccounts.filter((a) => a.id !== source.id && a.currency === source.currency),
    [ownAccounts, source],
  );
  useEffect(() => {
    if (destinationMode === 'own' && !candidates.some((a) => a.id === destination)) {
      setDestination(candidates[0]?.id ?? '');
    }
  }, [candidates, destination, destinationMode]);

  const amountMinor = parseMajorToMinor(amount);

  function edit(apply: () => void) {
    apply();
    intentKey.current = crypto.randomUUID();
    setError(undefined);
  }

  async function send(event?: React.FormEvent) {
    event?.preventDefault();
    if (!amountMinor || !destination) return;
    setBusy(true);
    setError(undefined);
    const key = intentKey.current;
    try {
      const transfer = await api.createTransfer(
        { sourceAccountId: source.id, destinationAccountId: destination.trim(), amountMinor },
        key,
      );
      setReceipt({ transfer, key });
      setAmount('');
      intentKey.current = crypto.randomUUID();
      onSent();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  const retryable = error instanceof ApiError && error.retryable;

  return (
    <Card title="Send money">
      <form onSubmit={(event) => void send(event)} className="space-y-4">
        <div className="flex gap-1 rounded-lg bg-slate-100 p-1 text-sm">
          {(['own', 'other'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() =>
                edit(() => {
                  setDestinationMode(mode);
                  setDestination('');
                })
              }
              className={`flex-1 rounded-md py-1.5 font-medium ${destinationMode === mode ? 'bg-white shadow-sm' : 'text-slate-500'}`}
            >
              {mode === 'own' ? 'My account' : 'Someone else'}
            </button>
          ))}
        </div>

        {destinationMode === 'own' ? (
          candidates.length === 0 ? (
            <p className="text-sm text-slate-500">
              You have no other {source.currency} account. Open one on the Accounts page.
            </p>
          ) : (
            <Select
              label="To"
              value={destination}
              onChange={(event) => edit(() => setDestination(event.target.value))}
            >
              {candidates.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.id.slice(0, 8)}… — {a.currency}
                </option>
              ))}
            </Select>
          )
        ) : (
          <Field
            label="Destination account ID"
            placeholder="00000000-0000-4000-8000-000000000000"
            value={destination}
            onChange={(event) => edit(() => setDestination(event.target.value))}
            spellCheck={false}
          />
        )}

        <Field
          label={`Amount (${source.currency})`}
          inputMode="decimal"
          placeholder="0.00"
          value={amount}
          onChange={(event) => edit(() => setAmount(event.target.value))}
          hint={
            amount && !amountMinor ? 'Enter a positive amount with up to two decimals.' : undefined
          }
        />

        <ErrorBanner error={error} />
        {retryable ? (
          <Button type="button" onClick={() => void send()} disabled={busy} className="w-full">
            {busy ? 'Retrying…' : 'Retry safely (same idempotency key)'}
          </Button>
        ) : (
          <Button type="submit" disabled={busy || !amountMinor || !destination} className="w-full">
            {busy ? 'Sending…' : 'Send'}
          </Button>
        )}
        <p className="text-xs text-slate-400">
          Idempotency key: <span className="font-mono">{intentKey.current.slice(0, 8)}…</span> —
          retrying this exact request can never post it twice.
        </p>
      </form>

      {receipt && (
        <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
          <div className="font-medium">
            Sent{' '}
            <Money
              amountMinor={receipt.transfer.amountMinor}
              currency={receipt.transfer.currency}
            />
          </div>
          <div className="mt-1 text-xs">
            transfer <CopyText value={receipt.transfer.id} short /> ·{' '}
            {formatTime(receipt.transfer.createdAt)}
          </div>
        </div>
      )}
    </Card>
  );
}

function History({
  accountId,
  currency,
  version,
}: {
  accountId: string;
  currency: string;
  version: number;
}) {
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.listEntries(accountId).then(
      (page) => {
        if (cancelled) return;
        setEntries(page.entries);
        setCursor(page.nextCursor);
        setLoading(false);
      },
      (caught: unknown) => !cancelled && (setError(caught), setLoading(false)),
    );
    return () => {
      cancelled = true;
    };
  }, [accountId, version]);

  async function loadMore() {
    if (!cursor) return;
    setLoading(true);
    try {
      const page = await api.listEntries(accountId, cursor);
      setEntries((previous) => [...previous, ...page.entries]);
      setCursor(page.nextCursor);
    } catch (caught) {
      setError(caught);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card title="Ledger history">
      <ErrorBanner error={error} />
      {entries.length === 0 && !loading ? (
        <p className="text-sm text-slate-500">No entries yet.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
              <th className="py-2 font-medium">When</th>
              <th className="py-2 font-medium">Transaction</th>
              <th className="py-2 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => {
              // Asset-account convention (ADR-001): a debit increases this balance, a credit decreases it.
              const incoming = entry.direction === 'debit';
              return (
                <tr key={entry.id} className="border-b border-slate-100 last:border-0">
                  <td className="py-2 text-slate-600">{formatTime(entry.createdAt)}</td>
                  <td className="py-2">
                    <CopyText value={entry.transactionId} short />
                    <span className="ml-1 text-xs text-slate-400">{entry.direction}</span>
                  </td>
                  <td
                    className={`py-2 text-right font-medium ${incoming ? 'text-emerald-700' : 'text-slate-900'}`}
                  >
                    {incoming ? '+' : '−'}
                    <Money amountMinor={entry.amountMinor} currency={currency} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {loading && <p className="mt-2 text-sm text-slate-500">Loading…</p>}
      {cursor && !loading && (
        <Button variant="secondary" onClick={() => void loadMore()} className="mt-3 w-full">
          Load more entries
        </Button>
      )}
    </Card>
  );
}
