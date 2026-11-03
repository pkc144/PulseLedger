import { useSyncExternalStore } from 'react';

/**
 * Credentials live in sessionStorage, not localStorage: they survive a reload but die with the
 * tab, so a customer secret is never left sitting in the browser profile indefinitely.
 */
type Slot = 'customerKey' | 'adminKey';

const listeners = new Set<() => void>();
const storageKey = (slot: Slot) => `pulseledger.${slot}`;

export function readCredential(slot: Slot): string | null {
  return sessionStorage.getItem(storageKey(slot));
}

export function writeCredential(slot: Slot, value: string | null): void {
  if (value) sessionStorage.setItem(storageKey(slot), value);
  else sessionStorage.removeItem(storageKey(slot));
  listeners.forEach((listener) => listener());
}

export function useCredential(slot: Slot): string | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => readCredential(slot),
  );
}
