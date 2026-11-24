import type { ReactNode } from 'react';

type Ask = {
  title: string;
  body?: ReactNode;
  /** Label of the confirming button (default "Continue"). */
  confirm?: string;
  /** Red confirm button, and Cancel gets focus so a stray Enter doesn't destroy anything. */
  danger?: boolean;
};
type Pending = Ask & { resolve: (ok: boolean) => void };

let pending: Pending | null = null;
const listeners = new Set<() => void>();
export const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const current = () => pending;
const emit = () => listeners.forEach((l) => l());

/**
 * In-app replacement for window.confirm: `if (await ask({ title: 'Delete deck?', danger: true })) …`.
 * Needs <ConfirmHost /> (Confirm.tsx) mounted once at the root.
 */
export function ask(a: Ask): Promise<boolean> {
  pending?.resolve(false); // a new question replaces one still open
  return new Promise((resolve) => { pending = { ...a, resolve }; emit(); });
}

export function answer(ok: boolean) {
  const p = pending;
  pending = null;
  emit();
  p?.resolve(ok);
}
