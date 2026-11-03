import { useEffect, useState } from 'react';
import { formatMinor } from '../../lib/money';
import { CheckIcon } from './icons';

/**
 * A self-running illustration of one transfer's life. Everything here is demo data and is labelled
 * as such on screen; the arithmetic is still real (integer minor units, balances conserved).
 */
interface DemoAccount {
  name: string;
  code: string;
  balanceMinor: bigint;
}

interface DemoPayment {
  from: number;
  to: number;
  amountMinor: bigint;
  reference: string;
}

type Phase = 'authorizing' | 'posting' | 'completed';

interface Row extends DemoPayment {
  id: number;
  phase: Phase;
}

const initialAccounts: DemoAccount[] = [
  { name: 'Operating', code: 'ACC-1001', balanceMinor: 482_000_000n },
  { name: 'Payroll', code: 'ACC-2040', balanceMinor: 125_000_000n },
  { name: 'Vendor escrow', code: 'ACC-3310', balanceMinor: 78_050_000n },
];

const script: DemoPayment[] = [
  { from: 0, to: 1, amountMinor: 24_000_000n, reference: 'payroll-2026-11' },
  { from: 1, to: 2, amountMinor: 1_875_000n, reference: 'inv-4471' },
  { from: 2, to: 0, amountMinor: 6_230_000n, reference: 'refund-0932' },
  { from: 0, to: 2, amountMinor: 10_500_000n, reference: 'po-2210' },
];

const seedRows: Row[] = [
  { id: -1, from: 2, to: 0, amountMinor: 3_120_000n, reference: 'refund-0918', phase: 'completed' },
  { id: -2, from: 0, to: 1, amountMinor: 9_900_000n, reference: 'bonus-q3', phase: 'completed' },
  { id: -3, from: 1, to: 2, amountMinor: 845_000n, reference: 'inv-4402', phase: 'completed' },
];

const phaseMs: Record<Phase, number> = { authorizing: 900, posting: 1400, completed: 2600 };
const inr = (minor: bigint) => formatMinor(minor.toString(), 'INR');

export function HeroDashboard() {
  const [accounts, setAccounts] = useState(initialAccounts);
  const [rows, setRows] = useState(seedRows);
  const [step, setStep] = useState(0);
  const [phase, setPhase] = useState<Phase>('authorizing');

  const payment = script[step % script.length]!;

  useEffect(() => {
    const timer = setTimeout(() => {
      if (phase === 'authorizing') {
        setPhase('posting');
        setRows((current) =>
          current.map((row) => (row.id === step ? { ...row, phase: 'posting' } : row)),
        );
      } else if (phase === 'posting') {
        setPhase('completed');
        setAccounts((current) =>
          current.map((account, index) =>
            index === payment.from
              ? { ...account, balanceMinor: account.balanceMinor - payment.amountMinor }
              : index === payment.to
                ? { ...account, balanceMinor: account.balanceMinor + payment.amountMinor }
                : account,
          ),
        );
        setRows((current) =>
          current.map((row) => (row.id === step ? { ...row, phase: 'completed' } : row)),
        );
      } else {
        setStep((value) => value + 1);
        setPhase('authorizing');
      }
    }, phaseMs[phase]);
    return () => clearTimeout(timer);
  }, [phase, step, payment]);

  // A new script step enters the feed as "pending" the moment it starts.
  useEffect(() => {
    // Filtered first so a re-run of this effect (React StrictMode does that in dev) cannot
    // insert the same row twice.
    setRows((current) =>
      [
        { ...payment, id: step, phase: 'authorizing' as Phase },
        ...current.filter((row) => row.id !== step),
      ].slice(0, 4),
    );
  }, [step, payment]);

  const total = accounts.reduce((sum, account) => sum + account.balanceMinor, 0n);
  const from = accounts[payment.from]!;
  const to = accounts[payment.to]!;

  return (
    <div
      className="relative rounded-2xl border border-white/[0.08] bg-ink-900/80 p-4 shadow-2xl shadow-black/40 backdrop-blur sm:p-5"
      role="img"
      aria-label="Demo dashboard: a payment moves between two accounts, is recorded as balanced ledger entries, and is reconciled."
    >
      {/* Window chrome */}
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full bg-white/10" />
          <span className="h-2.5 w-2.5 rounded-full bg-white/10" />
          <span className="h-2.5 w-2.5 rounded-full bg-white/10" />
          <span className="ml-2 font-mono text-[11px] text-slate-500">ledger / treasury</span>
        </div>
        <span className="rounded-full border border-amber-300/20 bg-amber-300/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-200">
          Demo data
        </span>
      </div>

      {/* Balances */}
      <div className="grid grid-cols-3 gap-2">
        {accounts.map((account, index) => {
          const active =
            phase !== 'authorizing' && (index === payment.from || index === payment.to);
          return (
            <div
              key={account.code}
              className={`rounded-xl border p-3 transition-colors duration-500 ${
                active
                  ? 'border-pulse-400/30 bg-pulse-400/[0.06]'
                  : 'border-white/[0.06] bg-white/[0.02]'
              }`}
            >
              <div className="truncate text-[11px] text-slate-400">{account.name}</div>
              <div className="mt-1 truncate font-mono text-[13px] font-medium tabular-nums text-white sm:text-sm">
                {inr(account.balanceMinor)}
              </div>
              <div className="mt-1 font-mono text-[10px] text-slate-600">{account.code}</div>
            </div>
          );
        })}
      </div>

      {/* Transfer rail */}
      <div className="mt-4 rounded-xl border border-white/[0.06] bg-ink-950/60 p-3.5">
        <div className="flex items-center justify-between text-[11px] text-slate-400">
          <span>
            Transfer <span className="font-mono text-slate-300">{payment.reference}</span>
          </span>
          <PhaseBadge phase={phase} />
        </div>
        <div className="mt-3 flex items-center gap-3">
          <span className="w-20 truncate text-xs font-medium text-slate-200 sm:w-24">
            {from.name}
          </span>
          <div className="relative h-px flex-1 bg-gradient-to-r from-white/10 via-pulse-400/40 to-white/10">
            {phase === 'posting' && (
              <span
                key={step}
                className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 animate-travel rounded-full bg-pulse-300 shadow-[0_0_16px_4px_rgb(56_213_245_/_0.55)]"
              />
            )}
          </div>
          <span className="w-20 truncate text-right text-xs font-medium text-slate-200 sm:w-24">
            {to.name}
          </span>
        </div>
        <div className="mt-3 text-center font-mono text-lg font-semibold tabular-nums text-white">
          {inr(payment.amountMinor)}
        </div>

        {/* The two journal entries this transfer writes */}
        <div
          className={`mt-3 grid grid-cols-[auto_1fr_auto] gap-x-3 gap-y-1 border-t border-dashed border-white/10 pt-3 font-mono text-[11px] transition-opacity duration-500 ${
            phase === 'authorizing' ? 'opacity-30' : 'opacity-100'
          }`}
        >
          <span className="text-emerald-300">DR</span>
          <span className="truncate text-slate-300">
            {to.code} {to.name}
          </span>
          <span className="tabular-nums text-slate-200">{inr(payment.amountMinor)}</span>
          <span className="text-sky-300">CR</span>
          <span className="truncate text-slate-300">
            {from.code} {from.name}
          </span>
          <span className="tabular-nums text-slate-200">{inr(payment.amountMinor)}</span>
          <span className="col-span-2 text-slate-500">Σ debits − Σ credits</span>
          <span className="text-right text-emerald-300">0.00</span>
        </div>
      </div>

      {/* Feed */}
      <div className="mt-4">
        <div className="mb-1.5 flex items-center justify-between px-1 text-[11px] uppercase tracking-wider text-slate-500">
          <span>Recent transactions</span>
          <span>Status</span>
        </div>
        <ul className="divide-y divide-white/[0.05]">
          {rows.map((row) => (
            <li
              key={row.id}
              className="flex animate-row-in items-center justify-between gap-3 rounded-md px-1 py-2"
            >
              <div className="min-w-0">
                <div className="truncate font-mono text-xs text-slate-200">{row.reference}</div>
                <div className="truncate text-[11px] text-slate-500">
                  {accounts[row.from]!.name} → {accounts[row.to]!.name}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <span className="font-mono text-xs tabular-nums text-slate-300">
                  {inr(row.amountMinor)}
                </span>
                <StatusDot phase={row.phase} />
              </div>
            </li>
          ))}
        </ul>
      </div>

      {/* Reconciliation */}
      {/* Reconciliation runs on demand (admin console or `npm run reconcile`), not per transfer:
          this panel shows the last report, plus the invariant every transfer preserves. */}
      <div className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-emerald-400/15 bg-emerald-400/[0.05] px-3.5 py-2.5">
        <div className="flex items-center gap-2.5">
          <span className="flex h-6 w-6 animate-ring items-center justify-center rounded-full bg-emerald-400/15 text-emerald-300">
            <CheckIcon className="h-3.5 w-3.5" />
          </span>
          <div>
            <div className="text-xs font-medium text-slate-100">
              Reconciliation <span className="font-mono text-emerald-300">ok: true</span>
            </div>
            <div className="text-[11px] text-slate-500">
              {accounts.length} balances recomputed from the journal · 0 issues
            </div>
          </div>
        </div>
        <div className="hidden text-right sm:block">
          <div className="text-[10px] uppercase tracking-wider text-slate-500">
            Total held · conserved
          </div>
          <div className="font-mono text-xs tabular-nums text-slate-300">{inr(total)}</div>
        </div>
      </div>
    </div>
  );
}

function PhaseBadge({ phase }: { phase: Phase }) {
  const map = {
    authorizing: ['Auth · idempotency claim', 'text-slate-300 bg-white/5 border-white/10'],
    posting: ['Posting · SERIALIZABLE', 'text-pulse-300 bg-pulse-400/10 border-pulse-400/20'],
    completed: ['Committed', 'text-emerald-300 bg-emerald-400/10 border-emerald-400/20'],
  } as const;
  const [label, tone] = map[phase];
  return (
    <span className={`rounded-full border px-2 py-0.5 font-mono text-[10px] ${tone}`}>{label}</span>
  );
}

function StatusDot({ phase }: { phase: Phase }) {
  const map = {
    authorizing: ['In flight', 'bg-slate-400'],
    posting: ['Posting', 'bg-pulse-400 animate-pulse'],
    completed: ['Committed', 'bg-emerald-400'],
  } as const;
  const [label, dot] = map[phase];
  return (
    <span className="flex w-20 items-center gap-1.5 text-[11px] text-slate-400">
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      {label}
    </span>
  );
}
