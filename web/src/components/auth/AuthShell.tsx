import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { CheckIcon } from '../landing/icons';
import { Logo } from '../landing/Logo';

/** Split layout for both login pages: brand panel (desktop only) beside a focused form column. */
export function AuthShell({
  title,
  subtitle,
  aside,
  children,
}: {
  title: string;
  subtitle: ReactNode;
  aside: { heading: string; points: string[] };
  children: ReactNode;
}) {
  return (
    <div className="grid min-h-screen bg-ink-950 text-slate-200 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <aside className="relative hidden overflow-hidden border-r border-white/[0.06] bg-ink-900 lg:flex lg:flex-col lg:justify-between lg:p-12">
        <div aria-hidden="true" className="ledger-rule absolute inset-0 opacity-70" />
        <div
          aria-hidden="true"
          className="absolute -left-32 bottom-[-20%] h-[460px] w-[460px] rounded-full bg-pulse-500/10 blur-[110px]"
        />
        <div className="relative">
          <Logo />
        </div>
        <div className="relative max-w-sm">
          <h2 className="font-display text-3xl font-semibold leading-tight tracking-tight text-white">
            {aside.heading}
          </h2>
          <ul className="mt-8 space-y-4">
            {aside.points.map((point) => (
              <li key={point} className="flex gap-3 text-sm text-slate-300">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-pulse-400/10 text-pulse-400">
                  <CheckIcon className="h-3 w-3" />
                </span>
                {point}
              </li>
            ))}
          </ul>
        </div>
        <p className="relative font-mono text-[11px] text-slate-600">Σ debits − Σ credits = 0</p>
      </aside>

      <main className="flex flex-col px-5 py-8 sm:px-10">
        <div className="flex items-center justify-between">
          <span className="lg:hidden">
            <Logo />
          </span>
          <Link
            to="/"
            className="ml-auto rounded-md text-sm text-slate-400 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-pulse-400"
          >
            ← Back to home
          </Link>
        </div>
        <div className="mx-auto flex w-full max-w-[400px] flex-1 flex-col justify-center py-12">
          <h1 className="font-display text-[28px] font-semibold tracking-tight text-white">
            {title}
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-slate-400">{subtitle}</p>
          <div className="mt-8">{children}</div>
        </div>
      </main>
    </div>
  );
}
