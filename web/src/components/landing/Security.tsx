import { CheckIcon } from './icons';
import { Section, SectionHeader } from './Section';

const controls = [
  {
    title: 'Secrets are never stored',
    body: 'API keys are shown once. Only a SHA-256 hash and a 12-character lookup prefix are kept, so a database leak reveals no usable key. Revocation applies on the next request.',
  },
  {
    title: 'Verified sign-in',
    body: 'Google and email sign-ins are checked against Google’s published signing keys for this project only, and email accounts must be verified first.',
  },
  {
    title: 'Ownership enforced in SQL',
    body: 'Every query is scoped to its owner. Another customer’s account or transfer answers exactly like one that does not exist.',
  },
  {
    title: 'Rules live in the database',
    body: 'Balanced entries, non-negative balances, immutable history, and fixed ownership are PostgreSQL constraints and triggers — a raw SQL session can’t break them either.',
  },
  {
    title: 'Separate operator access',
    body: 'Admin routes take their own static key, compared in constant time. A customer credential can never reach them, and the admin key is not a customer login.',
  },
  {
    title: 'Nothing leaks before auth',
    body: 'Unauthenticated callers are refused before input is validated, and every rejection uses one generic message, so probing reveals nothing.',
  },
];

/** From docs/TRADEOFFS.md: published so nobody discovers them by surprise. */
const limits = [
  'One shared admin key — no operator roles or per-person audit trail yet',
  'API keys have no scopes or expiry; they last until revoked',
  'No built-in rate limiting; TLS must be terminated in front of the API',
  'INR and USD only, with no FX — cross-currency transfers are rejected',
];

const evidence = [
  {
    value: '171',
    label: 'automated tests on real PostgreSQL',
    note: 'unit · property · integration',
  },
  {
    value: '7,369',
    label: 'concurrent transfer attempts',
    note: 'zero overdrafts or lost updates',
  },
  { value: '50 → 1', label: 'simultaneous duplicate requests', note: 'exactly one payment posted' },
  {
    value: 'SIGKILL',
    label: 'process killed mid-transaction',
    note: 'event delivered once after restart',
  },
  { value: '707', label: 'accounts reconciled after load', note: '0 issues · ok: true' },
];

export function Security() {
  return (
    <Section id="security">
      <div className="grid gap-14 lg:grid-cols-[1.2fr_1fr] lg:gap-16">
        <div>
          <SectionHeader eyebrow="Security" title="Built so the wrong thing can’t happen.">
            Defense in depth for money: identity, ownership, and accounting rules are each enforced
            at more than one layer.
          </SectionHeader>
          <ul className="mt-12 grid gap-x-8 gap-y-8 sm:grid-cols-2">
            {controls.map((control) => (
              <li key={control.title} className="flex gap-3.5">
                <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-400/10 text-emerald-300">
                  <CheckIcon className="h-3.5 w-3.5" />
                </span>
                <div>
                  <h3 className="text-[15px] font-semibold text-white">{control.title}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-slate-400">{control.body}</p>
                </div>
              </li>
            ))}
          </ul>

          <div className="mt-12 rounded-xl border border-white/[0.07] bg-white/[0.015] p-5">
            <h3 className="text-sm font-semibold text-white">Scope, stated plainly</h3>
            <ul className="mt-3 grid gap-x-6 gap-y-2 text-sm text-slate-400 sm:grid-cols-2">
              {limits.map((limit) => (
                <li key={limit} className="flex gap-2">
                  <span
                    aria-hidden="true"
                    className="mt-2 h-1 w-1 shrink-0 rounded-full bg-slate-500"
                  />
                  {limit}
                </li>
              ))}
            </ul>
          </div>
        </div>

        <aside
          aria-labelledby="evidence-heading"
          className="self-start rounded-2xl border border-white/[0.07] bg-gradient-to-b from-ink-850 to-ink-900 p-6 sm:p-8"
        >
          <div className="flex items-center justify-between">
            <h3 id="evidence-heading" className="text-sm font-semibold text-white">
              Proof, not claims
            </h3>
            <span className="font-mono text-[11px] text-slate-500">release record v1.2.0</span>
          </div>
          <dl className="mt-6 divide-y divide-white/[0.06]">
            {evidence.map((item) => (
              <div
                key={item.label}
                className="grid grid-cols-[6.5rem_1fr] items-baseline gap-4 py-4 first:pt-0 last:pb-0"
              >
                <dt className="font-mono text-xl font-semibold tabular-nums text-pulse-300">
                  {item.value}
                </dt>
                <dd>
                  <span className="block text-sm text-slate-200">{item.label}</span>
                  <span className="block text-xs text-slate-500">{item.note}</span>
                </dd>
              </div>
            ))}
          </dl>
          <p className="mt-6 border-t border-white/[0.06] pt-4 text-xs leading-relaxed text-slate-500">
            Load figures measured on v1.1.0; the transfer path is unchanged since. Raw k6 output and
            methodology are published with the source.
          </p>
        </aside>
      </div>
    </Section>
  );
}
