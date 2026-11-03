import { Link } from 'react-router';
import { api } from '../../lib/api';
import { useAsync } from '../../lib/use-async';
import { HeroDashboard } from './HeroDashboard';
import { ArrowRightIcon } from './icons';

export function Hero() {
  return (
    <section className="relative overflow-hidden pt-28 pb-20 sm:pt-36 lg:pb-28">
      {/* Background: ruled ledger lines, one soft cyan glow. Nothing else. */}
      <div
        aria-hidden="true"
        className="ledger-rule absolute inset-0 [mask-image:linear-gradient(to_bottom,black,transparent_85%)]"
      />
      <div
        aria-hidden="true"
        className="absolute -top-40 right-[-10%] h-[560px] w-[760px] rounded-full bg-pulse-500/[0.13] blur-[120px]"
      />

      <div className="relative mx-auto grid max-w-7xl items-center gap-14 px-5 sm:px-8 lg:grid-cols-[1.05fr_1fr] lg:gap-12">
        <div className="animate-fade-up">
          <p className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-xs text-slate-300">
            <span className="h-1.5 w-1.5 rounded-full bg-pulse-400" />
            Double-entry payment ledger
          </p>
          <h1 className="mt-6 font-display text-[2.6rem] font-semibold leading-[1.05] tracking-[-0.03em] text-white sm:text-6xl lg:text-[4.1rem]">
            Every Transaction.
            <br />
            <span className="bg-gradient-to-r from-pulse-300 to-pulse-500 bg-clip-text text-transparent">
              Accounted For.
            </span>
          </h1>
          <p className="mt-6 max-w-xl text-lg leading-relaxed text-slate-400">
            A payment ledger built for absolute financial correctness. Prevent duplicate payments,
            eliminate balance drift, and prove every transaction.
          </p>

          <div className="mt-9 flex flex-col gap-3 sm:flex-row">
            <a
              href="#features"
              className="group inline-flex items-center justify-center gap-2 rounded-xl bg-pulse-400 px-5 py-3 text-sm font-semibold text-ink-950 shadow-[0_0_0_1px_rgb(126_231_251_/_0.5),0_10px_30px_-10px_rgb(56_213_245_/_0.6)] transition hover:bg-pulse-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pulse-300"
            >
              Explore the Platform
              <ArrowRightIcon className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
            </a>
            <a
              href="#documentation"
              className="inline-flex items-center justify-center rounded-xl border border-white/12 bg-white/[0.03] px-5 py-3 text-sm font-semibold text-white transition hover:border-white/25 hover:bg-white/[0.06] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pulse-400"
            >
              View Documentation
            </a>
          </div>

          <LiveStatus />

          <dl className="mt-10 grid max-w-lg grid-cols-3 gap-6 border-t border-white/[0.07] pt-6">
            {[
              ['0', 'overdrafts across 7,369 concurrent attempts'],
              ['1', 'payment from 50 simultaneous duplicates'],
              ['0', 'balance drift after load, every account'],
            ].map(([value, label]) => (
              <div key={label}>
                <dt className="sr-only">{label}</dt>
                <dd className="font-display text-3xl font-semibold tabular-nums text-white">
                  {value}
                </dd>
                <dd className="mt-1 text-xs leading-snug text-slate-500">{label}</dd>
              </div>
            ))}
          </dl>
        </div>

        <div className="animate-fade-up [animation-delay:150ms]">
          <HeroDashboard />
        </div>
      </div>
    </section>
  );
}

/** The one live element on the page: the real readiness probe of whichever API this UI fronts. */
function LiveStatus() {
  const { data, error, loading } = useAsync(() => api.ready(), []);
  const ready = data?.status === 'ready';
  return (
    <div className="mt-6 flex items-center gap-2 text-xs text-slate-500" aria-live="polite">
      <span
        className={`h-1.5 w-1.5 rounded-full ${loading ? 'bg-slate-600' : ready ? 'bg-emerald-400' : 'bg-rose-400'}`}
      />
      {loading
        ? 'Checking ledger API…'
        : ready
          ? `Live ledger API connected · outbox ${data.outbox?.pending ?? 0} pending`
          : error
            ? 'Ledger API offline — the dashboard shows demo data only'
            : 'Ledger API reachable, database unavailable'}
      {ready && (
        <Link to="/login/user" className="ml-1 text-pulse-400 hover:underline">
          Sign in →
        </Link>
      )}
    </div>
  );
}
