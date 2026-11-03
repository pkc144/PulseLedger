import type { SVGProps } from 'react';

/** 24px stroke icons drawn for this page: one weight, one corner style, no icon library. */
function Icon({ children, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

type P = SVGProps<SVGSVGElement>;

export const DoubleEntryIcon = (p: P) => (
  <Icon {...p}>
    <path d="M4 7h7M4 11h7M13 13h7M13 17h7" />
    <path d="M12 4v16" strokeDasharray="2 2.5" />
  </Icon>
);
export const AtomicIcon = (p: P) => (
  <Icon {...p}>
    <rect x="4" y="4" width="16" height="16" rx="3" />
    <path d="m8.5 12 2.5 2.5 4.5-5" />
  </Icon>
);
export const IdempotentIcon = (p: P) => (
  <Icon {...p}>
    <path d="M4 12a8 8 0 0 1 13.7-5.6L20 8.7" />
    <path d="M20 4v4.7h-4.7" />
    <path d="M20 12a8 8 0 0 1-13.7 5.6L4 15.3" />
    <path d="M4 20v-4.7h4.7" />
    <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
  </Icon>
);
export const ConcurrencyIcon = (p: P) => (
  <Icon {...p}>
    <path d="M4 7h10l-3-3M20 17H10l3 3" />
    <rect x="15" y="5" width="5" height="4" rx="1" />
    <rect x="4" y="15" width="5" height="4" rx="1" />
  </Icon>
);
export const ImmutableIcon = (p: P) => (
  <Icon {...p}>
    <rect x="5" y="10.5" width="14" height="9.5" rx="2" />
    <path d="M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3M9 15h6" />
  </Icon>
);
export const ReconcileIcon = (p: P) => (
  <Icon {...p}>
    <path d="M12 4v16M5 8h14" />
    <path d="m5 8-2.5 6a3 3 0 0 0 5 0L5 8ZM19 8l-2.5 6a3 3 0 0 0 5 0L19 8Z" />
    <path d="M8.5 20h7" />
  </Icon>
);
export const OutboxIcon = (p: P) => (
  <Icon {...p}>
    <path d="M4 13v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5" />
    <path d="M4 13h4l1.5 2.5h5L16 13h4" />
    <path d="M12 3v7m-3-3 3 3 3-3" />
  </Icon>
);
export const OwnershipIcon = (p: P) => (
  <Icon {...p}>
    <path d="M12 3.5 5 6v5.5c0 4.2 3 7.6 7 9 4-1.4 7-4.8 7-9V6l-7-2.5Z" />
    <circle cx="12" cy="10.5" r="2" />
    <path d="M8.8 15.5a3.6 3.6 0 0 1 6.4 0" />
  </Icon>
);
export const RequestIcon = (p: P) => (
  <Icon {...p}>
    <path d="M4 12h12m-4-4 4 4-4 4" />
    <path d="M20 5v14" />
  </Icon>
);
export const KeyIcon = (p: P) => (
  <Icon {...p}>
    <circle cx="8" cy="14" r="4" />
    <path d="m11 11 8-8m-3 3 2 2m-4 0 1.5 1.5" />
  </Icon>
);
export const DatabaseIcon = (p: P) => (
  <Icon {...p}>
    <ellipse cx="12" cy="6" rx="7" ry="2.5" />
    <path d="M5 6v6c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V6M5 12v6c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-6" />
  </Icon>
);
export const LedgerIcon = (p: P) => (
  <Icon {...p}>
    <rect x="4" y="3.5" width="16" height="17" rx="2" />
    <path d="M8 8h8M8 12h8M8 16h5M12 3.5v17" strokeOpacity={0.5} />
  </Icon>
);
export const CheckIcon = (p: P) => (
  <Icon {...p}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Icon>
);
export const ArrowRightIcon = (p: P) => (
  <Icon {...p}>
    <path d="M5 12h14m-5-5 5 5-5 5" />
  </Icon>
);
export const ChevronDownIcon = (p: P) => (
  <Icon {...p}>
    <path d="m6 9 6 6 6-6" />
  </Icon>
);
export const MenuIcon = (p: P) => (
  <Icon {...p}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Icon>
);
export const CloseIcon = (p: P) => (
  <Icon {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Icon>
);
export const EyeIcon = (p: P) => (
  <Icon {...p}>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
    <circle cx="12" cy="12" r="3" />
  </Icon>
);
export const EyeOffIcon = (p: P) => (
  <Icon {...p}>
    <path d="M10.6 5.6A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.7 3.4M6.6 6.6C3.9 8.3 2.5 12 2.5 12S6 18.5 12 18.5c1.7 0 3.2-.5 4.5-1.2" />
    <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2M3 3l18 18" />
  </Icon>
);
export const UserIcon = (p: P) => (
  <Icon {...p}>
    <circle cx="12" cy="8.5" r="3.5" />
    <path d="M5 20a7 7 0 0 1 14 0" />
  </Icon>
);
export const ShieldKeyIcon = (p: P) => (
  <Icon {...p}>
    <path d="M12 3.5 5 6v5.5c0 4.2 3 7.6 7 9 4-1.4 7-4.8 7-9V6l-7-2.5Z" />
    <circle cx="12" cy="10.5" r="2" />
    <path d="M12 12.5V16" />
  </Icon>
);
