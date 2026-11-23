// Appearance preferences shared by the user menu and Account > Appearance, saved on this device.
// - theme: light / dark / follow the system (sets data-theme on <html>, which sets color-scheme)
// - accent: the colour theme (sets data-accent on <html>; the palettes live in index.css)
// index.html applies both before first paint, so there's no flash.
import { useSyncExternalStore } from 'react';

export type Theme = 'system' | 'light' | 'dark';
export const ACCENTS = [
  { id: 'orchard', name: 'Orchard' },
  { id: 'sunset', name: 'Sunset' },
  { id: 'forest', name: 'Forest' },
  { id: 'lagoon', name: 'Lagoon' },
  { id: 'midnight', name: 'Midnight' },
  { id: 'orchid', name: 'Orchid' },
  { id: 'slate', name: 'Slate' },
  { id: 'mono', name: 'Mono' },
] as const;
export type Accent = (typeof ACCENTS)[number]['id'];

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const load = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
const save = (key: string, v: string) => { try { localStorage.setItem(key, v); } catch { /* private mode */ } };

let theme: Theme = (['light', 'dark'].includes(load('recall-theme') || '') ? load('recall-theme') : 'system') as Theme;
let accent: Accent = (ACCENTS.some((a) => a.id === load('recall-accent')) ? load('recall-accent') : 'orchard') as Accent;

function apply() {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', theme);
  root.setAttribute('data-accent', accent);
  syncChrome();
}

/** Browser tab icon and mobile toolbar colour follow the theme. */
function syncChrome() {
  const probe = document.createElement('span');
  probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--logo-ink);border:1px solid var(--logo-bg);background:var(--bg)';
  document.body?.appendChild(probe);
  if (!probe.isConnected) return;
  const cs = getComputedStyle(probe);
  const ink = cs.color, fill = cs.borderTopColor, bg = cs.backgroundColor;
  probe.remove();
  // same mark as the app logo (LogoMark) and scripts/build-icons.mjs, on the theme accent
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='15' fill='${fill}'/>`
    + `<g transform='translate(32 32) scale(1.12) translate(-30.5 -32.5)'><rect x='14' y='16' width='28' height='34' rx='6' fill='#fff' opacity='.45' transform='rotate(-10 28 33)'/>`
    + `<rect x='21' y='14' width='28' height='35' rx='6' fill='#fff'/><path d='M29 41V24h7a5 5 0 0 1 0 10h-4l7 7' fill='none' stroke='${ink}' stroke-width='4.6' stroke-linecap='round' stroke-linejoin='round'/></g></svg>`;
  const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (icon) icon.href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg);
}

apply();
if (typeof window !== 'undefined') {
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', syncChrome);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', syncChrome, { once: true });
}

export function setTheme(t: Theme) { theme = t; save('recall-theme', t); apply(); notify(); }
export function setAccent(a: Accent) { accent = a; save('recall-accent', a); apply(); notify(); }
export const useTheme = (): Theme => useSyncExternalStore(subscribe, () => theme);
export const useAccent = (): Accent => useSyncExternalStore(subscribe, () => accent);
