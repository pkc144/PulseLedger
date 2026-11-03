import { useEffect, useState, type ComponentType, type SVGProps } from 'react';
import {
  DatabaseIcon,
  IdempotentIcon,
  KeyIcon,
  LedgerIcon,
  ReconcileIcon,
  RequestIcon,
} from './icons';
import { Section, SectionHeader } from './Section';

interface Step {
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
  title: string;
  body: string;
  tag: string;
}

const steps: Step[] = [
  {
    Icon: RequestIcon,
    title: 'Customer request',
    body: 'A client asks to move money, with an Idempotency-Key and the amount as an integer string.',
    tag: 'POST /v1/transfers',
  },
  {
    Icon: KeyIcon,
    title: 'Authentication',
    body: 'An API key or Firebase token is verified before the request body is even read.',
    tag: '401 before 400',
  },
  {
    Icon: IdempotentIcon,
    title: 'Idempotency check',
    body: 'The key is claimed. A retry gets the stored answer; a duplicate still in flight gets 409.',
    tag: 'Idempotency-Key',
  },
  {
    Icon: DatabaseIcon,
    title: 'Database transaction',
    body: 'Both accounts are locked in ID order and funds checked. Conflicts retry, up to 12 times.',
    tag: 'SERIALIZABLE',
  },
  {
    Icon: LedgerIcon,
    title: 'Ledger entries',
    body: 'Debit, credit, transfer record, outbox event and stored response commit as one.',
    tag: 'Σ DR = Σ CR',
  },
  {
    Icon: ReconcileIcon,
    title: 'Reconciliation',
    body: 'Run any time, not per request: every balance is recomputed from the journal and compared.',
    tag: 'ok: true',
  },
];

/** Steps 1-5 run on every request; the last one is an independent check run on demand. */
const requestSteps = steps.length - 1;

export function HowItWorks() {
  const [active, setActive] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setActive((index) => (index + 1) % steps.length), 1800);
    return () => clearInterval(timer);
  }, []);

  return (
    <Section id="how-it-works" className="border-y border-white/[0.05] bg-ink-900/40">
      <SectionHeader eyebrow="How it works" title="The life of a single payment.">
        Five stages run on every request, in order — a payment that fails any of them leaves no
        trace in the ledger. A sixth, independent check proves the books afterwards.
      </SectionHeader>

      <ol className="relative mt-14 grid gap-4 lg:grid-cols-6 lg:gap-3">
        {/* Desktop connector with progress */}
        <div aria-hidden="true" className="absolute left-0 right-0 top-[27px] hidden lg:block">
          {/* Solid track for the request path; dashed into the out-of-band check. */}
          <div className="absolute left-0 h-px w-[80%] bg-white/[0.08]">
            <div
              className="h-px bg-gradient-to-r from-pulse-500 to-pulse-300 transition-[width] duration-700 ease-out"
              style={{
                width: `${(Math.min(active, requestSteps - 1) / (requestSteps - 1)) * 100}%`,
              }}
            />
          </div>
          <div className="absolute right-0 w-[20%] border-t border-dashed border-white/15" />
        </div>

        {steps.map(({ Icon, title, body, tag }, index) => {
          const reached = index <= active;
          const current = index === active;
          const outOfBand = index === requestSteps;
          return (
            <li key={title} className="relative flex gap-4 lg:flex-col lg:gap-0">
              {/* Mobile connector */}
              {index < steps.length - 1 && (
                <span
                  aria-hidden="true"
                  className={`absolute left-[27px] top-14 h-[calc(100%-2rem)] lg:hidden ${
                    index === requestSteps - 1
                      ? 'border-l border-dashed border-white/15'
                      : 'w-px bg-white/[0.08]'
                  }`}
                />
              )}
              <span
                className={`relative z-10 flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border transition-all duration-500 ${
                  outOfBand ? 'border-dashed ' : ''
                }${
                  current
                    ? 'border-pulse-400/60 bg-ink-800 text-pulse-300 shadow-[0_0_30px_-4px_rgb(56_213_245_/_0.45)]'
                    : reached
                      ? 'border-pulse-400/25 bg-ink-850 text-pulse-400'
                      : 'border-white/[0.08] bg-ink-900 text-slate-500'
                }`}
              >
                <Icon className="h-6 w-6" />
              </span>
              <div className="pb-6 lg:mt-5 lg:pb-0 lg:pr-2">
                <div className="font-mono text-[11px] text-slate-600">
                  {outOfBand ? 'any time' : `0${index + 1}`}
                </div>
                <h3
                  className={`mt-1 text-[15px] font-semibold transition-colors ${reached ? 'text-white' : 'text-slate-400'}`}
                >
                  {title}
                </h3>
                <p className="mt-1.5 text-sm leading-relaxed text-slate-400">{body}</p>
                <span
                  className={`mt-3 inline-block rounded-md border px-2 py-0.5 font-mono text-[11px] transition-colors ${
                    current
                      ? 'border-pulse-400/30 text-pulse-300'
                      : 'border-white/[0.08] text-slate-500'
                  }`}
                >
                  {tag}
                </span>
              </div>
            </li>
          );
        })}
      </ol>
    </Section>
  );
}
