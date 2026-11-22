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

export type User = { id: number; username: string; email: string; name: string; isAdmin: boolean; hasPassword: boolean; createdAt: number; lastLoginAt: number | null };
export type ProviderRef = { id: string; name: string; type: 'github' | 'google' | 'oidc' };
export type Me = { user: User | null; needsClaim: boolean; openSignup: boolean; minPassword: number; passkeys: boolean; providers: ProviderRef[] };
export type Passkey = { id: string; name: string; created_at: number; last_used_at: number | null };
export type Device = { id: string; method: string; user_agent: string; ip: string; created_at: number; last_seen_at: number; current: boolean };
export type Identity = { id: number; provider: string; providerName: string; providerType: string; email: string; username: string; created_at: number };
export type ApiToken = { id: number; name: string; created_at: number; last_used_at: number | null };
export type AdminUser = { id: number; username: string; email: string; name: string; is_admin: number; created_at: number; last_login_at: number | null; decks: number; passkeys: number };
export type Invite = { id: number; note: string; is_admin: number; created_at: number; expires_at: number; used_at: number | null; used_by_username: string | null };
export type Provider = { id: string; type: 'github' | 'google' | 'oidc'; name: string; issuer: string; scopes: string; clientId: string; allowSignup: boolean; enabled: boolean; fromEnv: boolean; hasSecret: boolean; callbackUrl: string };

export type JsonImportResult = { decks: { deckId: number; deck: string; folder: string | null; created: boolean; added: number; skipped: number }[]; added: number; skipped: number };

export class Unauthorized extends Error {}

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const isForm = body instanceof FormData;
  const res = await fetch(url, {
    method,
    headers: body && !isForm ? { 'content-type': 'application/json' } : undefined,
    body: isForm ? body : body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  if (res.status === 401 && !/^\/api\/(login|claim|register|account\/password)/.test(url)) {
    window.dispatchEvent(new Event('recall:unauthorized'));
    throw new Unauthorized();
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data as T;
}

export const api = {
  me: () => req<Me>('GET', '/api/me'),
  logout: () => req('POST', '/api/logout'),
  loginPassword: (login: string, password: string) => req<{ user: User }>('POST', '/api/login/password', { login, password }),
  passkeyLoginOptions: () => req<Record<string, unknown>>('POST', '/api/login/passkey/options'),
  loginPasskey: (response: unknown) => req<{ user: User }>('POST', '/api/login/passkey', { response }),
  claimInfo: (token: string) => req<{ valid: boolean; legacyPassword: boolean }>('GET', `/api/claim/${token}`),
  claim: (token: string, body: { username: string; email: string; name: string; password?: string }) => req<{ user: User }>('POST', `/api/claim/${token}`, body),
  inviteInfo: (token: string) => req<{ valid: boolean; isAdmin: boolean; note: string }>('GET', `/api/invite/${token}`),
  register: (body: { inviteToken?: string; username: string; email: string; name: string; password: string }) => req<{ user: User }>('POST', '/api/register', body),

  account: () => req<{ user: User; counts: { passkeys: number; devices: number; identities: number; tokens: number } }>('GET', '/api/account'),
  updateAccount: (b: Partial<Pick<User, 'username' | 'email' | 'name'>>) => req<{ user: User }>('PATCH', '/api/account', b),
  setPassword: (current: string, next: string) => req('POST', '/api/account/password', { current, next }),
  removePassword: () => req('DELETE', '/api/account/password'),
  passkeys: () => req<Passkey[]>('GET', '/api/account/passkeys'),
  passkeyRegisterOptions: () => req<Record<string, unknown>>('POST', '/api/account/passkeys/options'),
  addPasskey: (response: unknown, name: string) => req<Passkey[]>('POST', '/api/account/passkeys', { response, name }),
  renamePasskey: (id: string, name: string) => req('PATCH', `/api/account/passkeys/${encodeURIComponent(id)}`, { name }),
  removePasskey: (id: string) => req('DELETE', `/api/account/passkeys/${encodeURIComponent(id)}`),
  devices: () => req<Device[]>('GET', '/api/account/sessions'),
  signOutDevice: (id: string) => req('DELETE', `/api/account/sessions/${id}`),
  signOutOthers: () => req('POST', '/api/account/sessions/revoke-others'),
  identities: () => req<{ linked: Identity[]; providers: ProviderRef[] }>('GET', '/api/account/identities'),
  disconnect: (id: number) => req('DELETE', `/api/account/identities/${id}`),
  tokens: () => req<ApiToken[]>('GET', '/api/account/tokens'),
  createApiToken: (name: string) => req<{ id: number; token: string }>('POST', '/api/account/tokens', { name }),
  deleteApiToken: (id: number) => req('DELETE', `/api/account/tokens/${id}`),

  adminOverview: () => req<{ counts: Record<string, number>; checklist: Record<string, boolean>; origin: string; database: string }>('GET', '/api/admin/overview'),
  adminUsers: () => req<AdminUser[]>('GET', '/api/admin/users'),
  adminUpdateUser: (id: number, b: { isAdmin?: boolean; name?: string }) => req('PATCH', `/api/admin/users/${id}`, b),
  adminDeleteUser: (id: number) => req('DELETE', `/api/admin/users/${id}`),
  invites: () => req<Invite[]>('GET', '/api/admin/invites'),
  createInvite: (b: { note?: string; isAdmin?: boolean }) => req<{ id: number; url: string }>('POST', '/api/admin/invites', b),
  deleteInvite: (id: number) => req('DELETE', `/api/admin/invites/${id}`),
  signinSettings: () => req<{ openSignup: boolean; types: string[]; providers: Provider[]; callbackBase: string }>('GET', '/api/admin/signin'),
  setOpenSignup: (openSignup: boolean) => req('PATCH', '/api/admin/signin', { openSignup }),
  saveProvider: (b: Record<string, unknown>, id?: string) => req<Provider>(id ? 'PATCH' : 'POST', id ? `/api/admin/providers/${id}` : '/api/admin/providers', b),
  deleteProvider: (id: string) => req('DELETE', `/api/admin/providers/${id}`),

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


export function timeAgo(ms: number | null | undefined): string {
  if (!ms) return 'never';
  const d = Date.now() - ms;
  if (d < 60_000) return 'just now';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  if (d < 30 * 86_400_000) return `${Math.floor(d / 86_400_000)}d ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** "Chrome on macOS" from a user-agent string. */
export function deviceName(ua: string): string {
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /curl|node|python/i.test(ua) ? 'Script' : 'Browser';
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}
