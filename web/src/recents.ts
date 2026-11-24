import type { Deck } from './api';

/* Recently used decks for the sidebar. "Used" is the later of two times: when the deck was last
   studied (from the server, so it follows you across devices) and when it was last opened on
   this device (kept in localStorage, so a deck you just created or browsed shows up too). */

const KEY = 'recall-recent-decks';
const KEEP = 30;

function opened(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { return {}; }
}

export function markDeckOpened(id: number) {
  if (!Number.isFinite(id)) return;
  try {
    const all: Record<string, number> = { ...opened(), [id]: Date.now() };
    const kept = Object.entries(all).sort((a, b) => b[1] - a[1]).slice(0, KEEP);
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch { /* storage off: recents fall back to study history */ }
}

export function recentDecks(decks: Deck[], limit = 5): Deck[] {
  const o = opened();
  return decks
    .map((d) => ({ d, t: Math.max(d.last_studied ?? 0, o[d.id] ?? 0) }))
    .filter((x) => x.t > 0)
    .sort((a, b) => b.t - a.t)
    .slice(0, limit)
    .map((x) => x.d);
}
