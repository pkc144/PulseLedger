import { Section, SectionHeader } from './Section';

/** What an operator actually gets from the backend today — every command and endpoint is real. */
const tools = [
  {
    title: 'Health & readiness',
    body: 'Liveness never touches the database. Readiness runs a real query and reports the outbox backlog, answering 503 when PostgreSQL is unreachable.',
    command: 'GET /health/ready',
  },
  {
    title: 'Prometheus metrics',
    body: 'Completed transfers, serialization retries, retries exhausted, and outbox depth by status — behind the admin key, ready to scrape.',
    command: 'GET /metrics',
  },
  {
    title: 'Dead-letter replay',
    body: 'An event that fails 12 deliveries is parked, not lost. Operators can inspect it and replay it with a fresh budget; its last error is kept.',
    command: 'npm run outbox replay <event-id>',
  },
  {
    title: 'Retention sweeps',
    body: 'Processed events (30 days) and idempotency records (7 days) are swept in bounded batches. The audit trail cannot be deleted — the database refuses.',
    command: 'npm run retention -- --dry-run',
  },
  {
    title: 'Reconciliation in a cron job',
    body: 'The same check as the admin console, from the command line. It exits non-zero on any drift, so a scheduled job fails loudly.',
    command: 'npm run reconcile',
  },
  {
    title: 'Traceable errors',
    body: 'Every error has one shape and carries a request ID you can supply yourself. Credentials are redacted from every log line.',
    command: 'x-request-id',
  },
];

export function Operations() {
  return (
    <Section id="operations" className="border-t border-white/[0.05]">
      <SectionHeader eyebrow="Operations" title="Built to be run, not just demoed.">
        A worker, an outbox, and a handful of operator tools — all in one process against one
        PostgreSQL. No broker, no extra infrastructure.
      </SectionHeader>
      <ul className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {tools.map((tool) => (
          <li
            key={tool.title}
            className="flex flex-col rounded-2xl border border-white/[0.07] bg-ink-900/60 p-6 transition-colors hover:border-white/[0.14]"
          >
            <h3 className="text-[15px] font-semibold text-white">{tool.title}</h3>
            <p className="mt-2 flex-1 text-sm leading-relaxed text-slate-400">{tool.body}</p>
            <code className="mt-5 block truncate rounded-lg border border-white/[0.06] bg-ink-950 px-3 py-2 font-mono text-[12px] text-pulse-300">
              <span className="select-none text-slate-600">› </span>
              {tool.command}
            </code>
          </li>
        ))}
      </ul>
    </Section>
  );
}
