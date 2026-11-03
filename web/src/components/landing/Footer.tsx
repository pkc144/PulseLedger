import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { docsLinks } from './docs-links';
import { Logo } from './Logo';

const productLinks = [
  { href: '#features', label: 'Features' },
  { href: '#how-it-works', label: 'How It Works' },
  { href: '#security', label: 'Security' },
  { href: '#operations', label: 'Operations' },
];

const linkClass =
  'rounded text-sm text-slate-400 transition hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pulse-400';

function Column({ id, title, children }: { id?: string; title: string; children: ReactNode }) {
  return (
    <div id={id} className="scroll-mt-24">
      <h2 className="font-mono text-[11px] uppercase tracking-[0.16em] text-slate-500">{title}</h2>
      <ul className="mt-4 space-y-2.5">{children}</ul>
    </div>
  );
}

export function Footer() {
  return (
    <footer className="border-t border-white/[0.06] bg-ink-900/40 pt-16 pb-10">
      <div className="mx-auto grid max-w-7xl gap-12 px-5 sm:px-8 md:grid-cols-[1.4fr_1fr_1fr_1fr]">
        <div className="max-w-xs">
          <Logo />
          <p className="mt-4 text-sm leading-relaxed text-slate-500">
            A correctness-first double-entry payment ledger. Money as integers, history as fact.
          </p>
        </div>

        <Column title="Product">
          {productLinks.map((link) => (
            <li key={link.href}>
              <a href={link.href} className={linkClass}>
                {link.label}
              </a>
            </li>
          ))}
        </Column>

        {/* Target of the navbar's "Documentation" link and the hero's "View Documentation". */}
        <Column id="documentation" title="Documentation">
          {docsLinks.map((link) => (
            <li key={link.href}>
              <a href={link.href} target="_blank" rel="noreferrer" className={linkClass}>
                {link.label}
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            </li>
          ))}
        </Column>

        <Column title="Access">
          <li>
            <Link to="/login/user" className={linkClass}>
              User Login
            </Link>
          </li>
          <li>
            <Link to="/login/admin" className={linkClass}>
              Admin Login
            </Link>
          </li>
        </Column>
      </div>

      <p className="mx-auto mt-14 max-w-7xl border-t border-white/[0.05] px-5 pt-6 font-mono text-[11px] text-slate-600 sm:px-8">
        Dashboard figures on this page are demo data. Evidence figures are from the published
        release records.
      </p>
    </footer>
  );
}
