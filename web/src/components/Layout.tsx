import { NavLink, Outlet } from 'react-router';
import { Logo } from './landing/Logo';
import { api } from '../lib/api';
import { useAsync } from '../lib/use-async';
import { useEffect } from 'react';

function HealthBadge() {
  const { data, error, reload } = useAsync(() => api.ready(), []);
  useEffect(() => {
    const timer = setInterval(reload, 10_000);
    return () => clearInterval(timer);
  }, [reload]);

  const ready = data?.status === 'ready';
  const label = error
    ? 'API unreachable'
    : !data
      ? 'checking…'
      : ready
        ? 'API ready'
        : 'DB unavailable';
  const outbox = data?.outbox;
  return (
    <span
      className="flex items-center gap-2 text-xs text-slate-400"
      title={
        outbox
          ? `outbox — pending ${outbox.pending}, processing ${outbox.processing}, failed ${outbox.failed}`
          : ''
      }
    >
      <span
        className={`h-2 w-2 rounded-full ${ready ? 'bg-emerald-500' : data || error ? 'bg-rose-500' : 'bg-slate-300'}`}
      />
      {label}
      {outbox && outbox.failed > 0 && (
        <span className="rounded bg-rose-50 px-1.5 text-rose-700">
          {outbox.failed} failed events
        </span>
      )}
    </span>
  );
}

export function Layout() {
  const link = ({ isActive }: { isActive: boolean }) =>
    `rounded-md px-3 py-1.5 text-sm font-medium transition focus-visible:outline-2 focus-visible:outline-pulse-400 ${
      isActive ? 'bg-white/10 text-white' : 'text-slate-400 hover:text-white'
    }`;
  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-white/[0.06] bg-ink-950">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-3">
          <div className="flex items-center gap-6">
            <Logo />
            <nav aria-label="App" className="flex gap-1">
              <NavLink to="/app" end className={link}>
                Accounts
              </NavLink>
              <NavLink to="/admin" className={link}>
                Admin
              </NavLink>
            </nav>
          </div>
          <HealthBadge />
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-8">
        <Outlet />
      </main>
    </div>
  );
}
