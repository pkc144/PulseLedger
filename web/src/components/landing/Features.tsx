import type { ComponentType, SVGProps } from 'react';
import {
  AtomicIcon,
  ConcurrencyIcon,
  DoubleEntryIcon,
  IdempotentIcon,
  ImmutableIcon,
  OutboxIcon,
  OwnershipIcon,
  ReconcileIcon,
} from './icons';
import { Section, SectionHeader } from './Section';

interface Feature {
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
  title: string;
  body: string;
  mechanism: string;
}

const features: Feature[] = [
  {
    Icon: DoubleEntryIcon,
    title: 'Double-entry accounting',
    body: 'Every payment is written twice — out of one account, into another — in whole paise or cents, never floating point. If the two sides don’t match, the database refuses to commit.',
    mechanism: 'deferred balance trigger · bigint',
  },
  {
    Icon: AtomicIcon,
    title: 'Atomic transactions',
    body: 'The ledger entries, the transfer record, its event, and the stored response commit together or not at all. There is no half-finished payment.',
    mechanism: 'one SERIALIZABLE transaction',
  },
  {
    Icon: IdempotentIcon,
    title: 'Idempotent payments',
    body: 'Retry a timed-out request with the same key and you get the original answer back, not a second charge. A duplicate still in flight is refused instantly.',
    mechanism: 'Idempotency-Key · 409 in progress',
  },
  {
    Icon: ConcurrencyIcon,
    title: 'Concurrent transfer safety',
    body: 'Balances can’t go negative and no update is lost, however many transfers collide. Under heavy contention a request is refused with a safe, retryable 503 — never a wrong balance.',
    mechanism: 'SERIALIZABLE · locks by ID · 12 retries',
  },
  {
    Icon: ImmutableIcon,
    title: 'Immutable history',
    body: 'Journal entries can never be edited or deleted — the database rejects it, even from a raw SQL session. Corrections are new, visible entries.',
    mechanism: 'UPDATE / DELETE rejected by trigger',
  },
  {
    Icon: ReconcileIcon,
    title: 'On-demand reconciliation',
    body: 'Recompute every balance from the full history and compare it with the stored value. Drift is reported to the cent and never auto-repaired; the CLI fails a scheduled job when it finds any.',
    mechanism: 'POST /v1/admin/reconcile · exit 1',
  },
  {
    Icon: OutboxIcon,
    title: 'Crash-safe event delivery',
    body: 'Each payment’s event is saved in the same commit as the money, then delivered by a worker. Kill the server mid-flight and it is delivered after restart, with exactly one effect.',
    mechanism: 'outbox → idempotent audit inbox',
  },
  {
    Icon: OwnershipIcon,
    title: 'Secure account ownership',
    body: 'You can only see and spend from your own accounts. Someone else’s account answers exactly like one that doesn’t exist — and ownership can never change hands.',
    mechanism: '404, never 403 · immutable owner',
  },
];

export function Features() {
  return (
    <Section id="features">
      <SectionHeader eyebrow="Features" title="Correctness is the feature.">
        Eight guarantees, each with a named automated test. The core accounting rules are PostgreSQL
        constraints and triggers, so even a bug in application code cannot commit an invalid
        balance.
      </SectionHeader>

      <ul className="mt-14 grid gap-px overflow-hidden rounded-2xl border border-white/[0.07] bg-white/[0.07] sm:grid-cols-2 lg:grid-cols-4">
        {features.map(({ Icon, title, body, mechanism }) => (
          <li
            key={title}
            className="group flex flex-col bg-ink-950 p-6 transition-colors hover:bg-ink-900"
          >
            <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-pulse-400/20 bg-pulse-400/[0.07] text-pulse-400 transition group-hover:border-pulse-400/40">
              <Icon className="h-5 w-5" />
            </span>
            <h3 className="mt-5 text-[15px] font-semibold text-white">{title}</h3>
            <p className="mt-2 flex-1 text-sm leading-relaxed text-slate-400">{body}</p>
            <p className="mt-5 font-mono text-[11px] text-slate-500 group-hover:text-pulse-300/80">
              {mechanism}
            </p>
          </li>
        ))}
      </ul>
    </Section>
  );
}
