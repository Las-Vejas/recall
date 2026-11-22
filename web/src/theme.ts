// Theme preference shared by the user menu and Account > Appearance.
import { useSyncExternalStore } from 'react';

export type Theme = 'system' | 'light' | 'dark';
const listeners = new Set<() => void>();
const read = (): Theme => { try { return (localStorage.getItem('recall-theme') as Theme) || 'system'; } catch { return 'system'; } };
let current = read();

function apply(t: Theme) {
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
}
apply(current);

export function setTheme(t: Theme) {
  current = t;
  try { localStorage.setItem('recall-theme', t); } catch { /* private mode */ }
  apply(t);
  listeners.forEach((l) => l());
}
export function useTheme(): Theme {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => current);
}
