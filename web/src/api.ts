export type Counts = { new: number; learn: number; review: number };

export type Deck = {
  id: number;
  name: string;
  description: string;
  color: string;
  new_per_day: number;
  folder_id: number | null;
  total: number;
  unseen: number;
  mature: number;
  counts: Counts;
};

export type Folder = { id: number; name: string; parent_id: number | null };

export type Card = {
  id: number;
  deck_id: number;
  front: string;
  back: string;
  format: 'md' | 'html';
  tags: string;
  css: string;
  kind?: 'basic' | 'cloze';
  cloze_ord?: number | null;
  note_id?: string | null;
  suspended: number;
  state: number;
  due: number;
  stability?: number;
  reps?: number;
  lapses?: number;
};

export type StudyCard = Card & {
  deck_name: string;
  deck_color: string;
  intervals: Record<1 | 2 | 3 | 4, number>;
};

export type Stats = {
  heat: { date: number; n: number; ms: number }[];
  forecast: { day: number; n: number }[];
  states: { state: number; n: number }[];
  streak: number;
  today: { reviews: number; ms: number; again: number };
  retention: number | null;
  totalReviews: number;
};

export type Me = { authed: boolean; mode: 'disabled' | 'env' | 'stored' | 'setup'; passwordRequired: boolean; needsSetup: boolean; minPassword: number };

export type JsonImportResult = { decks: { deckId: number; deck: string; folder: string | null; created: boolean; added: number; skipped: number }[]; added: number; skipped: number };
export type TokenInfo = { exists: boolean; created: number | null };

export class Unauthorized extends Error {}

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const isForm = body instanceof FormData;
  const res = await fetch(url, {
    method,
    headers: body && !isForm ? { 'content-type': 'application/json' } : undefined,
    body: isForm ? body : body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  if (res.status === 401 && !/\/(login|setup|password)$/.test(url)) {
    window.dispatchEvent(new Event('recall:unauthorized'));
    throw new Unauthorized();
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data as T;
}

export const api = {
  me: () => req<Me>('GET', '/api/me'),
  login: (password: string) => req('POST', '/api/login', { password }),
  setup: (password: string) => req('POST', '/api/setup', { password }),
  changePassword: (current: string, next: string) => req('POST', '/api/password', { current, next }),
  logout: () => req('POST', '/api/logout'),

  decks: () => req<Deck[]>('GET', '/api/decks'),
  deck: (id: number) => req<Deck>('GET', `/api/decks/${id}`),
  createDeck: (d: Partial<Deck>) => req<Deck>('POST', '/api/decks', d),
  updateDeck: (id: number, d: Partial<Deck>) => req<Deck>('PATCH', `/api/decks/${id}`, d),
  deleteDeck: (id: number) => req('DELETE', `/api/decks/${id}`),

  folders: () => req<Folder[]>('GET', '/api/folders'),
  createFolder: (name: string, parent_id: number | null) => req<Folder>('POST', '/api/folders', { name, parent_id }),
  updateFolder: (id: number, f: Partial<Folder>) => req<Folder>('PATCH', `/api/folders/${id}`, f),
  deleteFolder: (id: number) => req('DELETE', `/api/folders/${id}`),

  cards: (deckId: number, q = '') => req<Card[]>('GET', `/api/decks/${deckId}/cards?q=${encodeURIComponent(q)}`),
  addCard: (deckId: number, c: { front: string; back: string; tags?: string; kind?: 'basic' | 'cloze' }) => req<{ id?: number; ids?: number[] }>('POST', `/api/decks/${deckId}/cards`, c),
  bulkAdd: (deckId: number, text: string, separator: string) => req<{ imported: number }>('POST', `/api/decks/${deckId}/cards/bulk`, { text, separator }),
  updateCard: (id: number, c: Partial<Card>) => req<{ ok: boolean; added?: number; removed?: number }>('PATCH', `/api/cards/${id}`, c),
  deleteCard: (id: number) => req<{ deleted: number }>('DELETE', `/api/cards/${id}`),
  forgetCard: (id: number) => req('POST', `/api/cards/${id}/forget`),

  study: (deck: string) => req<{ card: StudyCard | null; counts: Counts }>('GET', `/api/study/${deck}`),
  answer: (deck: string, cardId: number, rating: number, durationMs: number) =>
    req<{ card: StudyCard | null; counts: Counts }>('POST', `/api/study/${deck}/answer`, { cardId, rating, durationMs }),
  undo: (deck: string) => req<{ card: StudyCard | null; counts: Counts }>('POST', `/api/study/${deck}/undo`),
  redo: (deck: string) => req<{ card: StudyCard | null; counts: Counts }>('POST', `/api/study/${deck}/redo`),

  stats: () => req<Stats>('GET', '/api/stats'),
  importJson: (data: unknown) => req<JsonImportResult>('POST', '/api/import/json', data),
  tokenInfo: () => req<TokenInfo>('GET', '/api/token'),
  createToken: () => req<TokenInfo & { token: string }>('POST', '/api/token'),
  revokeToken: () => req<TokenInfo>('DELETE', '/api/token'),
  importFile: (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return req<{ imported: number; skipped: number; decks: number; media: number }>('POST', '/api/import', fd);
  },
};

export function fmtInterval(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return '<1m';
  const m = s / 60;
  if (m < 60) return `${Math.round(m)}m`;
  const h = m / 60;
  if (h < 24) return `${Math.round(h)}h`;
  const d = h / 24;
  if (d < 30) return `${Math.round(d)}d`;
  const mo = d / 30.4;
  if (mo < 12) return `${mo.toFixed(mo < 3 ? 1 : 0)}mo`;
  return `${(d / 365).toFixed(1)}y`;
}

export function fmtDuration(ms: number): string {
  const m = Math.round(ms / 60000);
  if (m < 1) return `${Math.round(ms / 1000)}s`;
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

