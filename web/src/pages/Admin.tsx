import { useState } from 'react';
import { useNavigate } from 'react-router';
import {
  Button,
  Card,
  CopyText,
  ErrorBanner,
  Field,
  Money,
  StatusPill,
  formatTime,
} from '../components/ui';
import {
  api,
  type FundingResult,
  type IssuedApiKey,
  type Principal,
  type ReconciliationReport,
} from '../lib/api';
import { parseMajorToMinor } from '../lib/money';
import { writeCredential } from '../lib/session';
import { useAsync } from '../lib/use-async';

export function Admin() {
  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Admin console</h1>
          <p className="text-sm text-slate-500">
            Onboard customers, fund accounts, and verify the books.
          </p>
        </div>
        <Button variant="secondary" onClick={() => writeCredential('adminKey', null)}>
          Sign out
        </Button>
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Onboard />
        <Fund />
        <Reconcile />
        <Metrics />
        <Revoke />
      </div>
    </div>
  );
}

function Onboard() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [issued, setIssued] = useState<{ principal: Principal; key: IssuedApiKey }[]>([]);

  async function onboard(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const principal = await api.createPrincipal(name.trim());
      const key = await api.issueApiKey(principal.id);
      setIssued((previous) => [{ principal, key }, ...previous]);
      setName('');
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  async function issueAnother(principal: Principal) {
    setError(undefined);
    try {
      const key = await api.issueApiKey(principal.id);
      setIssued((previous) => [{ principal, key }, ...previous]);
    } catch (caught) {
      setError(caught);
    }
  }

  return (
    <Card title="Onboard a customer">
      <form onSubmit={(event) => void onboard(event)} className="flex items-end gap-3">
        <div className="flex-1">
          <Field
            label="Customer name"
            value={name}
            maxLength={128}
            onChange={(event) => setName(event.target.value)}
            required
          />
        </div>
        <Button type="submit" disabled={busy || !name.trim()}>
          {busy ? 'Creating…' : 'Create + issue key'}
        </Button>
      </form>
      <div className="mt-3">
        <ErrorBanner error={error} />
      </div>
      {issued.length > 0 && (
        <ul className="mt-4 space-y-3">
          {issued.map(({ principal, key }) => (
            <li key={key.id} className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="font-medium">{principal.name}</span>
                <span className="text-xs text-slate-500">
                  key id <CopyText value={key.id} short />
                </span>
              </div>
              <div className="mt-2 break-all rounded bg-white px-2 py-1">
                <CopyText value={key.key} />
              </div>
              <p className="mt-1 text-xs text-amber-800">
                Shown once — only its hash is stored. Copy it now or lose it.
              </p>
              <div className="mt-2 flex gap-2">
                <Button
                  onClick={() => {
                    writeCredential('customerKey', key.key);
                    void navigate('/app');
                  }}
                >
                  Open customer app as {principal.name}
                </Button>
                <Button variant="secondary" onClick={() => void issueAnother(principal)}>
                  Issue another key
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Fund() {
  const [accountId, setAccountId] = useState('');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [result, setResult] = useState<FundingResult>();
  const amountMinor = parseMajorToMinor(amount);

  async function fund(event: React.FormEvent) {
    event.preventDefault();
    if (!amountMinor) return;
    setBusy(true);
    setError(undefined);
    setResult(undefined);
    try {
      setResult(await api.fund(accountId.trim(), amountMinor));
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Fund an account">
      <form onSubmit={(event) => void fund(event)} className="space-y-3">
        <Field
          label="Account ID"
          value={accountId}
          onChange={(event) => setAccountId(event.target.value)}
          spellCheck={false}
          required
        />
        <Field
          label="Amount (major units)"
          inputMode="decimal"
          placeholder="2500.00"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          hint={
            amount && !amountMinor
              ? 'Enter a positive amount with up to two decimals.'
              : 'Posts debit customer / credit treasury, balanced.'
          }
        />
        <ErrorBanner error={error} />
        <Button type="submit" disabled={busy || !amountMinor || !accountId.trim()}>
          {busy ? 'Funding…' : 'Fund'}
        </Button>
      </form>
      {result && (
        <p className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
          Funded <Money amountMinor={result.amountMinor} currency={result.currency} /> · transaction{' '}
          <CopyText value={result.id} short />
        </p>
      )}
    </Card>
  );
}

function Reconcile() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [report, setReport] = useState<ReconciliationReport>();

  async function run() {
    setBusy(true);
    setError(undefined);
    try {
      setReport(await api.reconcile());
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="Reconciliation"
      actions={
        <Button onClick={() => void run()} disabled={busy}>
          {busy ? 'Checking…' : 'Run'}
        </Button>
      }
    >
      <p className="text-sm text-slate-500">
        Recomputes every balance from the immutable journal and compares it with the cached value.
        Read-only: it reports drift, never repairs it.
      </p>
      <div className="mt-3">
        <ErrorBanner error={error} />
      </div>
      {report && (
        <div className="mt-3 space-y-2 text-sm">
          <div className="flex items-center gap-2">
            <StatusPill status={report.ok ? 'ready' : 'drift'} />
            {report.accountsChecked} accounts checked · {formatTime(report.generatedAt)}
          </div>
          {report.issues.map((issue) => (
            <div
              key={issue.accountId}
              className="rounded border border-rose-200 bg-rose-50 p-2 text-xs text-rose-800"
            >
              <span className="font-semibold">{issue.type}</span>{' '}
              <CopyText value={issue.accountId} short /> cached {issue.cachedBalanceMinor ?? '—'} vs
              computed {issue.computedBalanceMinor ?? '—'} {issue.currency}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function Metrics() {
  const metrics = useAsync(() => api.metrics(), []);
  const ready = useAsync(() => api.ready(), []);
  const refresh = () => {
    metrics.reload();
    ready.reload();
  };
  const stat = (label: string, value: number | undefined, warn = false) => (
    <div className="rounded-lg bg-slate-50 p-3">
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`text-xl font-semibold tabular-nums ${warn && value ? 'text-rose-600' : ''}`}>
        {value ?? '—'}
      </div>
    </div>
  );
  return (
    <Card
      title="Metrics"
      actions={
        <Button variant="secondary" onClick={refresh}>
          Refresh
        </Button>
      }
    >
      <ErrorBanner error={metrics.error} />
      <div className="text-xs font-medium text-slate-500">Transfers since server start</div>
      <div className="mt-1 grid grid-cols-3 gap-2">
        {stat('Completed', metrics.data?.transfers.completed)}
        {stat('Serialization retries', metrics.data?.transfers.retries)}
        {stat('Retry exhausted (503)', metrics.data?.transfers.exhausted, true)}
      </div>
      <div className="mt-4 text-xs font-medium text-slate-500">Outbox</div>
      <div className="mt-1 grid grid-cols-3 gap-2">
        {stat('Pending', ready.data?.outbox?.pending)}
        {stat('Processing', ready.data?.outbox?.processing)}
        {stat('Failed (dead-letter)', ready.data?.outbox?.failed, true)}
      </div>
    </Card>
  );
}

function Revoke() {
  const [keyId, setKeyId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [done, setDone] = useState<string>();

  async function revoke(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    setDone(undefined);
    try {
      const result = await api.revokeApiKey(keyId.trim());
      setDone(result.id);
      setKeyId('');
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Revoke an API key">
      <form onSubmit={(event) => void revoke(event)} className="flex items-end gap-3">
        <div className="flex-1">
          <Field
            label="Key ID (not the secret)"
            value={keyId}
            onChange={(event) => setKeyId(event.target.value)}
            spellCheck={false}
            required
          />
        </div>
        <Button variant="danger" type="submit" disabled={busy || !keyId.trim()}>
          Revoke
        </Button>
      </form>
      <div className="mt-3 space-y-2">
        <ErrorBanner error={error} />
        {done && (
          <p className="text-sm text-emerald-700">
            Key {done.slice(0, 8)}… revoked. It stops working on the next request.
          </p>
        )}
      </div>
    </Card>
  );
}
