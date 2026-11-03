import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import { ChevronDownIcon, CloseIcon, MenuIcon, ShieldKeyIcon, UserIcon } from './icons';
import { Logo } from './Logo';

export const sections = [
  { href: '#features', label: 'Features' },
  { href: '#how-it-works', label: 'How It Works' },
  { href: '#security', label: 'Security' },
  { href: '#operations', label: 'Operations' },
];

const loginOptions = [
  {
    to: '/login/user',
    label: 'User Login',
    detail: 'Google, email, or API key',
    Icon: UserIcon,
  },
  {
    to: '/login/admin',
    label: 'Admin Login',
    detail: 'Operator console',
    Icon: ShieldKeyIcon,
  },
];

const focusRing =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pulse-400';

export function Navbar() {
  const [scrolled, setScrolled] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <header
      className={`fixed inset-x-0 top-0 z-50 transition-colors duration-300 ${
        mobileOpen
          ? 'border-b border-white/[0.06] bg-ink-950'
          : scrolled
            ? 'border-b border-white/[0.06] bg-ink-950/85 backdrop-blur-xl'
            : 'border-b border-transparent'
      }`}
    >
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-3 focus:rounded-md focus:bg-pulse-400 focus:px-3 focus:py-1.5 focus:text-sm focus:font-medium focus:text-ink-950"
      >
        Skip to content
      </a>
      <nav
        aria-label="Primary"
        className="mx-auto flex h-16 max-w-7xl items-center justify-between px-5 sm:px-8"
      >
        <Logo />

        <ul className="hidden items-center gap-1 md:flex">
          {sections.map((section) => (
            <li key={section.href}>
              <a
                href={section.href}
                className={`rounded-md px-3 py-2 text-sm text-slate-300 transition hover:text-white ${focusRing}`}
              >
                {section.label}
              </a>
            </li>
          ))}
        </ul>

        <div className="flex items-center gap-2">
          <div className="hidden md:block">
            <LoginMenu />
          </div>
          <button
            type="button"
            className={`rounded-md p-2 text-slate-300 hover:text-white md:hidden ${focusRing}`}
            aria-expanded={mobileOpen}
            aria-controls="mobile-menu"
            aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
            onClick={() => setMobileOpen((open) => !open)}
          >
            {mobileOpen ? <CloseIcon className="h-6 w-6" /> : <MenuIcon className="h-6 w-6" />}
          </button>
        </div>
      </nav>

      {mobileOpen && (
        <div id="mobile-menu" className="border-t border-white/[0.06] px-5 pb-6 pt-2 md:hidden">
          <ul className="space-y-1">
            {sections.map((section) => (
              <li key={section.href}>
                <a
                  href={section.href}
                  onClick={() => setMobileOpen(false)}
                  className={`block rounded-lg px-3 py-3 text-base text-slate-200 hover:bg-white/5 ${focusRing}`}
                >
                  {section.label}
                </a>
              </li>
            ))}
          </ul>
          <div className="mt-4 grid gap-2 border-t border-white/[0.06] pt-4">
            {loginOptions.map(({ to, label, detail, Icon }) => (
              <Link
                key={to}
                to={to}
                className={`flex items-center gap-3 rounded-lg border border-white/10 px-3 py-3 text-slate-100 hover:bg-white/5 ${focusRing}`}
              >
                <Icon className="h-5 w-5 text-pulse-400" />
                <span>
                  <span className="block text-sm font-medium">{label}</span>
                  <span className="block text-xs text-slate-400">{detail}</span>
                </span>
              </Link>
            ))}
          </div>
        </div>
      )}
    </header>
  );
}

/** WAI-ARIA menu button: arrow keys move between items, Escape closes and restores focus. */
function LoginMenu() {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLAnchorElement | null)[]>([]);

  useEffect(() => {
    if (!open) return;
    itemRefs.current[0]?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  function close(restoreFocus: boolean) {
    setOpen(false);
    if (restoreFocus) buttonRef.current?.focus();
  }

  function onMenuKeyDown(event: React.KeyboardEvent) {
    const items = itemRefs.current.filter((item): item is HTMLAnchorElement => item !== null);
    const index = items.indexOf(document.activeElement as HTMLAnchorElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      items[(index + step + items.length) % items.length]?.focus();
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      items[event.key === 'Home' ? 0 : items.length - 1]?.focus();
    } else if (event.key === 'Tab') {
      close(false);
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setOpen(true);
          }
        }}
        className={`flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-medium text-white transition hover:border-pulse-400/40 hover:bg-white/[0.07] ${focusRing}`}
      >
        Login
        <ChevronDownIcon
          className={`h-4 w-4 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label="Login options"
          onKeyDown={onMenuKeyDown}
          className="absolute right-0 mt-2 w-64 origin-top-right animate-fade-up rounded-xl border border-white/10 bg-ink-850/95 p-1.5 shadow-2xl shadow-black/50 backdrop-blur-xl [animation-duration:180ms]"
        >
          {loginOptions.map(({ to, label, detail, Icon }, index) => (
            <Link
              key={to}
              to={to}
              role="menuitem"
              ref={(element) => {
                itemRefs.current[index] = element;
              }}
              onClick={() => setOpen(false)}
              className="flex items-start gap-3 rounded-lg px-3 py-2.5 outline-none transition hover:bg-white/[0.06] focus-visible:bg-white/[0.08]"
            >
              <span className="mt-0.5 flex h-8 w-8 items-center justify-center rounded-lg bg-pulse-400/10 text-pulse-400">
                <Icon className="h-[18px] w-[18px]" />
              </span>
              <span>
                <span className="block text-sm font-medium text-white">{label}</span>
                <span className="block text-xs text-slate-400">{detail}</span>
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
