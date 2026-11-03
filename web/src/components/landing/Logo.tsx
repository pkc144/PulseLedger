import { Link } from 'react-router';

/**
 * The mark: a debit line and a credit line, offset like two sides of a journal, joined by a
 * single pulse. Two entries, one transaction, always balanced.
 */
export function LogoMark({ className = 'h-8 w-8' }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="pl-mark" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#7ee7fb" />
          <stop offset="1" stopColor="#0b8fd0" />
        </linearGradient>
      </defs>
      <rect
        x="1"
        y="1"
        width="30"
        height="30"
        rx="8"
        fill="#0e1628"
        stroke="url(#pl-mark)"
        strokeOpacity="0.5"
      />
      <path d="M7 11.5h8" stroke="#7ee7fb" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M17 20.5h8" stroke="#14b8e6" strokeWidth="2.2" strokeLinecap="round" />
      <path
        d="M7 16h5l2-4.5 4 9 2-4.5h5"
        fill="none"
        stroke="url(#pl-mark)"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Logo({ tone = 'dark' }: { tone?: 'dark' | 'light' }) {
  return (
    <Link
      to="/"
      className="flex items-center gap-2.5 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-pulse-400"
      aria-label="PulseLedger home"
    >
      <LogoMark />
      <span
        className={`font-display text-[17px] font-semibold tracking-tight ${tone === 'dark' ? 'text-white' : 'text-slate-900'}`}
      >
        Pulse<span className="text-pulse-400">Ledger</span>
      </span>
    </Link>
  );
}
