import express from 'express';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { db, initDb } from './db.js';
import { nextCard, getStudyCard, counts, answer, undoLast, redoLast, forgetCard, newFsrsCard } from './scheduler.js';
import { importApkg } from './apkg.js';
import { NOTE_KINDS, createNote, updateNote } from './cloze.js';
import * as auth from './auth.js';
import * as oauth from './oauth.js';
import { parseDeckJson, importDecks } from './jsonImport.js';
import { folderDeckIds, deleteFolder, wouldCycle, migrateAnkiNames } from './folders.js';
import { serveMedia, putMedia } from './media.js';
import crypto from 'node:crypto';
import { userStats, userReviewLog } from './stats.js';
import { mcpRouter, mcpErrors } from './mcp.js';
import * as mcpAuth from './mcpAuth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');

// ---------- database ----------
try {
  await initDb();
  await auth.loadSettings();
  await migrateAnkiNames();
} catch (e) {
  console.error(`\nCould not open the database (${db.describe()}):\n  ${e.message}\n`);
  if (db.dialect === 'pg') console.error('Check DATABASE_URL, e.g. postgres://user:password@host:5432/recall (add ?sslmode=require for hosted Postgres).\n');
  process.exit(1);
}
for (const legacy of ['APP_PASSWORD', 'DISABLE_AUTH']) {
  if (process.env[legacy]) console.warn(`${legacy} is no longer used: Recall has accounts now. Sign in with the claim link, a passkey, a provider or a password.`);
}

const app = express();
// X-Forwarded-* headers are ignored unless TRUST_PROXY is set (e.g. TRUST_PROXY=1 behind one reverse proxy).
// Trusting them by default would let clients fake their IP and dodge the login rate limit.
if (process.env.TRUST_PROXY) app.set('trust proxy', /^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY);
app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());

/** The public origin, used for passkeys (relying party) and OAuth redirect URLs. Set PUBLIC_URL in production. */
const originOf = (req) => PUBLIC_URL || `${String(req.get('x-forwarded-proto') || req.protocol).split(',')[0].trim()}://${req.get('host')}`;

/** Async route helper: returns JSON, turns thrown errors into { error }. */
const wrap = (fn) => (req, res, next) => {
  Promise.resolve()
    .then(() => fn(req, res, next))
    .then((out) => { if (out !== undefined && !res.headersSent) res.json(out); })
    .catch((e) => {
      if (!e.expected) console.error(e);
      if (!res.headersSent) res.status(e.status || 400).json({ error: e.message, ...(e.errors ? { errors: e.errors } : {}) });
    });
};
const fail = auth.userError;

// ---------- rate limiting for anything that checks a secret ----------
const failures = new Map();
function guard(req) {
  const f = failures.get(req.ip);
  if (f && Date.now() < f.until) throw fail('Too many attempts, wait a bit', 429);
}
function strike(req) {
  const f = failures.get(req.ip) || { n: 0, until: 0 };
  f.n++; f.until = Date.now() + Math.min(60_000, 500 * 2 ** f.n);
  failures.set(req.ip, f);
}

// ---------- who is this? ----------
// What an API token (Authorization: Bearer rk_...) may do: add decks, look at the library, rename a deck and
// flag a card. Nothing destructive; the two PATCH routes take only those fields from a token (TOKEN_FIELDS).
const AGENT_ROUTES = [
  ['POST', /^\/api\/import\/json$/], ['GET', /^\/api\/decks$/], ['GET', /^\/api\/folders$/],
  ['GET', /^\/api\/decks\/\d+\/cards$/], ['PATCH', /^\/api\/decks\/\d+$/], ['PATCH', /^\/api\/cards\/\d+$/],
];
const agentAllowed = (req) => AGENT_ROUTES.some(([m, p]) => req.method === m && p.test(req.originalUrl.split('?')[0]));
/** With an API token, a PATCH may only change these fields. */
function tokenFields(req, allowed) {
  if (!req.viaToken) return;
  const extra = Object.keys(req.body || {}).filter((k) => !allowed.includes(k));
  if (extra.length) throw fail(`An API token can only change ${allowed.join(', ')} here (not ${extra.join(', ')})`, 403);
}

app.use(wrap(async (req, res, next) => {
  const s = await auth.sessionFromRequest(req);
  if (s) { req.user = s.user; req.session = s.session; }
  else if (req.headers.authorization && agentAllowed(req)) {
    const u = await auth.userFromBearer(req.headers.authorization);
    if (u) { req.user = u; req.viaToken = true; }
  }
  next();
}));
const requireUser = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Sign in to continue' }));
const requireSession = (req, res, next) => (req.session ? next() : res.status(401).json({ error: 'Sign in to continue' }));
const requireAdmin = (req, res, next) => (req.session && req.user?.is_admin ? next() : res.status(403).json({ error: 'Superadmins only' }));

// ================= public auth routes =================
app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/me', wrap(async (req) => ({
  user: req.session ? auth.publicUser(req.user) : null,
  needsClaim: (await auth.userCount()) === 0,
  openSignup: auth.openSignup(),
  minPassword: auth.MIN_PASSWORD,
  passkeys: originOf(req).startsWith('https://') || /^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(originOf(req)),
  providers: (await oauth.listProviders()).map((p) => ({ id: p.id, name: p.name, type: p.type })),
})));

app.get('/api/claim/:token', wrap(async (req) => ({ valid: await auth.claimLinkValid(req.params.token), legacyPassword: auth.hasLegacyPassword() })));
// claim/invite/link tokens are 144–256 random bits, so they need no rate limit; passwords and passkeys do
app.post('/api/claim/:token', wrap(async (req, res) => {
  const user = await auth.claimInstance(req.params.token, req.body || {});
  console.log(`Instance claimed by @${user.username} (superadmin)`);
  await auth.createSession(req, res, user.id, 'Claim link');
  return { user: auth.publicUser(user) };
}));

app.get('/api/invite/:token', wrap(async (req) => {
  const i = await auth.inviteByToken(req.params.token);
  return { valid: !!i, isAdmin: !!i?.is_admin, note: i?.note || '' };
}));
app.post('/api/register', wrap(async (req, res) => {
  const user = await auth.register(req.body || {});
  await auth.createSession(req, res, user.id, 'New account');
  return { user: auth.publicUser(user) };
}));

app.post('/api/login/password', wrap(async (req, res) => {
  guard(req);
  const user = await auth.verifyPasswordLogin(req.body?.login, req.body?.password);
  if (!user) { strike(req); throw fail('Wrong username, email or password', 401); }
  failures.delete(req.ip);
  await auth.createSession(req, res, user.id, 'Password');
  return { user: auth.publicUser(user) };
}));

const FLOW = 'recall_passkey';
const setChallenge = (req, res, challenge) => res.cookie(FLOW, auth.sign({ challenge, exp: Date.now() + 5 * 60_000 }),
  { httpOnly: true, sameSite: 'strict', maxAge: 5 * 60_000, path: '/api', secure: auth.cookieSecure(req) });
const takeChallenge = (req, res) => {
  const v = auth.unsign(req.cookies?.[FLOW]);
  res.clearCookie(FLOW, { path: '/api' });
  if (!v?.challenge) throw fail('The passkey prompt expired. Try again.');
  return v.challenge;
};
app.post('/api/login/passkey/options', wrap(async (req, res) => {
  const options = await auth.passkeyLoginOptions(originOf(req));
  setChallenge(req, res, options.challenge);
  return options;
}));
app.post('/api/login/passkey', wrap(async (req, res) => {
  guard(req);
  const user = await auth.verifyPasskeyLogin(req.body?.response, takeChallenge(req, res), originOf(req)).catch((e) => { strike(req); throw e; });
  await auth.createSession(req, res, user.id, 'Passkey');
  return { user: auth.publicUser(user) };
}));

// identity providers: /api/auth/oauth/<id>/start?mode=login|link&invite=<token>
app.get('/api/auth/oauth/:id/start', wrap(async (req, res) => {
  const mode = req.query.mode === 'link' ? 'link' : 'login';
  if (mode === 'link' && !req.session) return res.redirect('/login');
  await oauth.startFlow(req, res, originOf(req), { providerId: req.params.id, mode, inviteToken: req.query.invite, userId: req.user?.id });
}));
app.get('/api/auth/oauth/:id/callback', wrap(async (req, res) => {
  res.redirect(await oauth.finishFlow(req, res, originOf(req), req.params.id, req.session ? req.user : null));
}));

// one-time sign-in links printed by `node server/cli.js login <user>`
app.get('/auth/link/:token', wrap(async (req, res) => {
  const user = await auth.redeemLoginLink(req.params.token);
  if (!user) { return res.redirect('/login?error=' + encodeURIComponent('That sign-in link was already used or has expired')); }
  await auth.createSession(req, res, user.id, 'One-time link');
  res.redirect('/account/security');
}));

app.post('/api/logout', wrap(async (req, res) => { await auth.endSession(req, res); return { ok: true }; }));

// ---------- MCP server for AI assistants (API token or OAuth, see server/mcp.js and server/mcpAuth.js) ----------
app.use(mcpAuth.oauthRouter(originOf));
app.use('/mcp', mcpRouter({ resourceMetadata: (req) => `${originOf(req)}/.well-known/oauth-protected-resource/mcp` }), mcpErrors);

// the consent page at /oauth/authorize (web app) uses these with the browser session
const OAUTH_PARAMS = ['client_id', 'redirect_uri', 'response_type', 'state', 'code_challenge', 'code_challenge_method', 'scope', 'resource'];
const oauthParams = (src) => Object.fromEntries(OAUTH_PARAMS.map((k) => [k, typeof src?.[k] === 'string' ? src[k] : '']));
app.get('/api/oauth/authorize', requireSession, wrap(async (req) => {
  const { client } = await mcpAuth.checkAuthorizeRequest(oauthParams(req.query));
  return { name: client.name, redirectHost: new URL(req.query.redirect_uri).host || req.query.redirect_uri };
}));
app.post('/api/oauth/authorize', requireSession, wrap(async (req) => {
  const q = oauthParams(req.body);
  if (!req.body?.allow) { await mcpAuth.checkAuthorizeRequest(q); return { redirect: mcpAuth.denyUrl(q) }; }
  return { redirect: await mcpAuth.approve(req.user.id, q) };
}));

// ================= everything below needs an account =================
app.use(['/api', '/media'], requireUser);
app.use('/media', wrap(serveMedia));

// ---------- account (browser sessions only, never API tokens) ----------
const account = express.Router();
account.use(requireSession);
account.get('/', wrap(async (req) => {
  const uid = req.user.id;
  const count = async (t) => (await db.get(`SELECT COUNT(*) AS n FROM ${t} WHERE user_id = ?`, uid)).n;
  return {
    user: auth.publicUser(req.user),
    counts: { passkeys: await count('passkeys'), devices: (await auth.listSessions(uid)).length, identities: await count('identities'), tokens: await count('api_tokens') },
  };
}));
account.patch('/', wrap(async (req) => ({ user: auth.publicUser(await auth.updateProfile(req.user.id, req.body || {})) })));
account.post('/password', wrap(async (req) => {
  guard(req);
  await auth.setPassword(req.user.id, req.body || {}).catch((e) => { if (e.status === 401) strike(req); throw e; });
  return { ok: true };
}));
account.delete('/password', wrap(async (req) => { await auth.removePassword(req.user.id); return { ok: true }; }));

account.get('/passkeys', wrap((req) => auth.listPasskeys(req.user.id)));
account.post('/passkeys/options', wrap(async (req, res) => {
  const options = await auth.passkeyRegistrationOptions(req.user, originOf(req));
  setChallenge(req, res, options.challenge);
  return options;
}));
account.post('/passkeys', wrap(async (req, res) => {
  await auth.verifyPasskeyRegistration(req.user, req.body?.response, takeChallenge(req, res), originOf(req), req.body?.name);
  return auth.listPasskeys(req.user.id);
}));
account.patch('/passkeys/:id', wrap(async (req) => { await auth.renamePasskey(req.user.id, req.params.id, req.body?.name); return { ok: true }; }));
account.delete('/passkeys/:id', wrap(async (req) => { await auth.removePasskey(req.user.id, req.params.id); return { ok: true }; }));

account.get('/sessions', wrap(async (req) => (await auth.listSessions(req.user.id)).map((s) => ({ ...s, current: s.id === req.session.id }))));
account.delete('/sessions/:id', wrap(async (req) => { await auth.revokeSession(req.user.id, req.params.id); return { ok: true }; }));
account.post('/sessions/revoke-others', wrap(async (req) => { await auth.revokeOtherSessions(req.user.id, req.session.id); return { ok: true }; }));

account.get('/identities', wrap(async (req) => ({
  linked: await oauth.listIdentities(req.user.id),
  providers: (await oauth.listProviders()).map((p) => ({ id: p.id, name: p.name, type: p.type })),
})));
account.delete('/identities/:id', wrap(async (req) => {
  await oauth.unlinkIdentity(req.user.id, req.params.id, await auth.signInMethodCount(req.user.id));
  return { ok: true };
}));

account.get('/tokens', wrap((req) => auth.listApiTokens(req.user.id)));
account.post('/tokens', wrap((req) => auth.createApiToken(req.user.id, req.body?.name)));
account.delete('/tokens/:id', wrap(async (req) => { await auth.deleteApiToken(req.user.id, req.params.id); return { ok: true }; }));
app.use('/api/account', account);

// ---------- instance admin (superadmins) ----------
const admin = express.Router();
admin.use(requireAdmin);
admin.get('/overview', wrap(async (req) => {
  const n = async (sql, ...a) => (await db.get(sql, ...a)).n;
  const providers = await oauth.listProviders({ includeDisabled: true });
  return {
    counts: { users: await n('SELECT COUNT(*) AS n FROM users'), decks: await n('SELECT COUNT(*) AS n FROM decks'), cards: await n('SELECT COUNT(*) AS n FROM cards'), reviews: await n('SELECT COUNT(*) AS n FROM reviews') },
    checklist: {
      publicUrl: !!PUBLIC_URL,
      https: originOf(req).startsWith('https://'),
      postgres: db.dialect === 'pg',
      provider: providers.some((p) => p.enabled),
      passkey: (await n('SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?', req.user.id)) > 0,
    },
    origin: originOf(req), database: db.describe(),
  };
}));
admin.get('/users', wrap(async () => db.all(`SELECT u.id, u.username, u.email, u.name, u.is_admin, u.created_at, u.last_login_at,
    (SELECT COUNT(*) FROM decks d WHERE d.user_id = u.id) AS decks,
    (SELECT COUNT(*) FROM passkeys p WHERE p.user_id = u.id) AS passkeys
  FROM users u ORDER BY u.created_at`)));
admin.patch('/users/:id', wrap(async (req) => {
  const id = Number(req.params.id);
  if ('isAdmin' in req.body) {
    if (id === req.user.id && !req.body.isAdmin) throw fail("You can't remove your own superadmin role");
    await db.run('UPDATE users SET is_admin = ? WHERE id = ?', req.body.isAdmin ? 1 : 0, id);
  }
  if ('name' in req.body) await auth.updateProfile(id, { name: req.body.name });
  return { ok: true };
}));
admin.delete('/users/:id', wrap(async (req) => {
  const id = Number(req.params.id);
  if (id === req.user.id) throw fail("You can't delete your own account here");
  // children first, so this works the same on databases without cascading foreign keys
  await db.tx(async () => {
    await db.run('DELETE FROM cards WHERE deck_id IN (SELECT id FROM decks WHERE user_id = ?)', id);
    for (const t of ['reviews', 'redo_stack', 'media', 'decks', 'sessions', 'passkeys', 'identities', 'api_tokens']) await db.run(`DELETE FROM ${t} WHERE user_id = ?`, id);
    await db.run('UPDATE folders SET parent_id = NULL WHERE user_id = ?', id);
    await db.run('DELETE FROM folders WHERE user_id = ?', id);
    await db.run('DELETE FROM users WHERE id = ?', id);
  });
  return { ok: true };
}));
admin.get('/invites', wrap(async () => db.all(`SELECT i.id, i.note, i.is_admin, i.created_at, i.expires_at, i.used_at, u.username AS used_by_username
  FROM invites i LEFT JOIN users u ON u.id = i.used_by ORDER BY i.created_at DESC LIMIT 100`)));
admin.post('/invites', wrap(async (req) => {
  const { id, token } = await auth.createInvite(req.user.id, { note: req.body?.note, isAdmin: !!req.body?.isAdmin });
  return { id, url: `${originOf(req)}/invite/${token}` };
}));
admin.delete('/invites/:id', wrap(async (req) => { await db.run('DELETE FROM invites WHERE id = ?', req.params.id); return { ok: true }; }));
admin.get('/signin', wrap(async (req) => ({
  openSignup: auth.openSignup(),
  types: oauth.PROVIDER_TYPES,
  providers: (await oauth.listProviders({ includeDisabled: true })).map((p) => ({ ...oauth.publicProvider(p), callbackUrl: oauth.callbackUrl(originOf(req), p.id) })),
  callbackBase: `${originOf(req)}/api/auth/oauth`,
})));
admin.patch('/signin', wrap(async (req) => {
  if ('openSignup' in req.body) await auth.setSetting('open_signup', req.body.openSignup ? 'true' : 'false');
  return { openSignup: auth.openSignup() };
}));
admin.post('/providers', wrap(async (req) => oauth.publicProvider(await oauth.saveProvider(req.body || {}))));
admin.patch('/providers/:id', wrap(async (req) => oauth.publicProvider(await oauth.saveProvider(req.body || {}, req.params.id))));
admin.delete('/providers/:id', wrap(async (req) => { await oauth.deleteProvider(req.params.id); return { ok: true }; }));
app.use('/api/admin', admin);

// ================= library (always scoped to req.user) =================
const uid = (req) => req.user.id;
async function ownDeck(req, id) {
  const d = await db.get('SELECT * FROM decks WHERE id = ? AND user_id = ?', id, uid(req));
  if (!d) throw fail('Deck not found', 404);
  return d;
}
async function ownFolder(req, id) {
  if (id == null) return null;
  const f = await db.get('SELECT * FROM folders WHERE id = ? AND user_id = ?', id, uid(req));
  if (!f) throw fail('Folder not found', 404);
  return f;
}
async function ownCard(req, id) {
  const c = await db.get('SELECT c.* FROM cards c JOIN decks d ON d.id = c.deck_id WHERE c.id = ? AND d.user_id = ?', id, uid(req));
  if (!c) throw fail('Card not found', 404);
  return c;
}
const userDeckIds = async (req) => (await db.all('SELECT id FROM decks WHERE user_id = ?', uid(req))).map((r) => r.id);

// study scope from URL: "all", a deck id, or "f<folderId>" for every deck in a folder (recursively)
async function deckParam(req, v) {
  if (v === 'all') return userDeckIds(req);
  if (v.startsWith('f')) { const f = await ownFolder(req, Number(v.slice(1))); return folderDeckIds(f.id, uid(req)); }
  return [(await ownDeck(req, Number(v))).id];
}
const withCounts = async (decks) => Promise.all(decks.map(async (d) => ({ ...d, counts: await counts(d.id) })));

// ---------- JSON deck import (UI and AI agents) ----------
app.post('/api/import/json', wrap(async (req) => {
  let decks;
  try { decks = parseDeckJson(req.body); } catch (e) { throw Object.assign(fail(e.message), { errors: e.errors }); }
  const result = await importDecks(decks, uid(req));
  if (req.viaToken) console.log(`API token import by @${req.user.username}: ${result.added} cards into ${result.decks.map((d) => d.deck).join(', ')}`);
  return result;
}));

// ---------- decks ----------
const MATURE = `SUM(CASE WHEN c.state = 2 AND ${db.json('c.fsrs', 'stability')} >= 21 THEN 1 ELSE 0 END)`;
app.get('/api/decks', wrap(async (req) => {
  const decks = await db.all(`SELECT d.*, COUNT(c.id) AS total,
      SUM(CASE WHEN c.state = 0 THEN 1 ELSE 0 END) AS unseen, ${MATURE} AS mature
    FROM decks d LEFT JOIN cards c ON c.deck_id = d.id WHERE d.user_id = ? GROUP BY d.id ORDER BY d.name COLLATE NOCASE`, uid(req));
  return withCounts(decks.map((d) => ({ ...d, unseen: d.unseen || 0, mature: d.mature || 0 })));
}));
app.post('/api/decks', wrap(async (req) => {
  const { name, description = '', color = '#7c5cff', folder_id = null } = req.body;
  if (!name?.trim()) throw fail('Name required');
  await ownFolder(req, folder_id);
  const id = await db.insert('INSERT INTO decks (name, description, color, folder_id, user_id, created_at) VALUES (?,?,?,?,?,?)',
    name.trim(), description, color, folder_id, uid(req), Date.now());
  return db.get('SELECT * FROM decks WHERE id = ?', id);
}));
app.get('/api/decks/:id', wrap(async (req) => {
  await ownDeck(req, req.params.id);
  const d = await db.get(`SELECT d.*, COUNT(c.id) AS total, ${MATURE} AS mature
    FROM decks d LEFT JOIN cards c ON c.deck_id = d.id WHERE d.id = ? GROUP BY d.id`, req.params.id);
  return { ...d, mature: d.mature || 0, counts: await counts(d.id) };
}));
app.patch('/api/decks/:id', wrap(async (req) => {
  await ownDeck(req, req.params.id);
  tokenFields(req, ['name']);
  if ('name' in req.body) {
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    if (!name) throw fail('Name required');
    if (name.length > 200) throw fail('Name is too long (200 characters max)');
    req.body.name = name;
  }
  if ('folder_id' in req.body) await ownFolder(req, req.body.folder_id);
  for (const k of ['name', 'description', 'color', 'new_per_day', 'folder_id'])
    if (k in req.body) await db.run(`UPDATE decks SET ${k} = ? WHERE id = ?`, req.body[k], req.params.id);
  return db.get('SELECT * FROM decks WHERE id = ?', req.params.id);
}));
app.delete('/api/decks/:id', wrap(async (req) => {
  await ownDeck(req, req.params.id);
  await db.run('DELETE FROM decks WHERE id = ?', req.params.id);
  return { ok: true };
}));

// ---------- folders ----------
app.get('/api/folders', wrap((req) => db.all('SELECT * FROM folders WHERE user_id = ? ORDER BY name COLLATE NOCASE', uid(req))));
app.post('/api/folders', wrap(async (req) => {
  const { name, parent_id = null } = req.body;
  if (!name?.trim()) throw fail('Name required');
  await ownFolder(req, parent_id);
  const id = await db.insert('INSERT INTO folders (name, parent_id, user_id, created_at) VALUES (?,?,?,?)', name.trim(), parent_id, uid(req), Date.now());
  return db.get('SELECT * FROM folders WHERE id = ?', id);
}));
app.patch('/api/folders/:id', wrap(async (req) => {
  const { id } = req.params;
  await ownFolder(req, id);
  if ('name' in req.body) {
    if (!String(req.body.name).trim()) throw fail('Name required');
    await db.run('UPDATE folders SET name = ? WHERE id = ?', String(req.body.name).trim(), id);
  }
  if ('parent_id' in req.body) {
    await ownFolder(req, req.body.parent_id);
    if (await wouldCycle(Number(id), req.body.parent_id)) throw fail("Can't move a folder into itself");
    await db.run('UPDATE folders SET parent_id = ? WHERE id = ?', req.body.parent_id, id);
  }
  return db.get('SELECT * FROM folders WHERE id = ?', id);
}));
app.delete('/api/folders/:id', wrap(async (req) => { await ownFolder(req, req.params.id); await deleteFolder(Number(req.params.id)); return { ok: true }; }));

// ---------- cards ----------
app.get('/api/decks/:id/cards', wrap(async (req) => {
  await ownDeck(req, req.params.id);
  const q = `%${req.query.q || ''}%`;
  const onlyFlagged = req.query.flagged === '1' || req.query.flagged === 'true';
  return db.all(`SELECT id, deck_id, front, back, format, tags, suspended, flagged, state, due, css, kind, cloze_ord, note_id,
      ${db.json('fsrs', 'stability')} AS stability, ${db.json('fsrs', 'reps')} AS reps, ${db.json('fsrs', 'lapses')} AS lapses
    FROM cards WHERE deck_id = ? AND (front LIKE ? OR back LIKE ? OR tags LIKE ?) ${onlyFlagged ? 'AND flagged = 1' : ''} ORDER BY id DESC LIMIT 2000`,
  req.params.id, q, q, q);
}));
const INSERT_CARD = `INSERT INTO cards (deck_id, front, back, format, tags, kind, state, due, fsrs, created_at, updated_at)
  VALUES (?,?,?,?,?,?,0,?,?,?,?)`;
// card kinds: basic, typein (type the answer), and the multi-card notes cloze and occlusion (server/cloze.js)
app.post('/api/decks/:id/cards', wrap(async (req) => {
  await ownDeck(req, req.params.id);
  const { front, back = '', tags = '', format = 'md', kind = 'basic' } = req.body;
  if (typeof front !== 'string' || !front.trim()) throw fail('Front required');
  if (NOTE_KINDS.includes(kind)) {
    try { return await createNote(kind, req.params.id, { front, back, tags }); } catch (e) { throw fail(e.message); }
  }
  if (kind === 'typein' && !String(back).trim()) throw fail('Type-in cards need the answer on the back');
  const now = Date.now();
  return { id: await db.insert(INSERT_CARD, req.params.id, front, back, format, tags, kind === 'typein' ? 'typein' : 'basic', now, newFsrsCard(), now, now) };
}));

// images for image occlusion (and anything else a card wants to show); served back at /media/upload/...
const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif' };
const imageUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
app.post('/api/media', imageUpload.single('file'), wrap(async (req) => {
  const ext = IMAGE_TYPES[req.file?.mimetype];
  if (!req.file) throw fail('No file');
  if (!ext) throw fail('Use a PNG, JPEG, GIF, WebP or AVIF image');
  const key = `upload/${crypto.randomUUID()}.${ext}`;
  await putMedia(key, req.file.buffer, uid(req));
  return { url: `/media/${key}` };
}));
app.post('/api/decks/:id/cards/bulk', wrap(async (req) => {
  await ownDeck(req, req.params.id);
  const { text = '', separator = '\t' } = req.body;
  const now = Date.now();
  let n = 0;
  await db.tx(async () => {
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const [front, ...rest] = line.split(separator);
      if (!front.trim()) continue;
      await db.run(INSERT_CARD, req.params.id, front.trim(), rest.join(separator).trim(), 'md', '', 'basic', now, newFsrsCard(), now, now);
      n++;
    }
  });
  return { imported: n };
}));
app.patch('/api/cards/:id', wrap(async (req) => {
  const card = await ownCard(req, req.params.id);
  tokenFields(req, ['flagged']);
  if ('flagged' in req.body) {
    await db.run('UPDATE cards SET flagged = ? WHERE id = ?', req.body.flagged ? 1 : 0, card.id);
    delete req.body.flagged;
  }
  if ('deck_id' in req.body) await ownDeck(req, req.body.deck_id);
  if (NOTE_KINDS.includes(card.kind) && card.note_id) {
    // text/image/extra/tags/deck belong to the whole note; suspension and flags stay per card
    const { suspended, ...noteChanges } = req.body;
    let result = { added: 0, removed: 0 };
    if (Object.keys(noteChanges).length) {
      try { result = await updateNote(card.note_id, noteChanges); } catch (e) { throw fail(e.message); }
    }
    if (suspended !== undefined) await db.run('UPDATE cards SET suspended = ?, updated_at = ? WHERE id = ?', suspended, Date.now(), req.params.id);
    return { ok: true, ...result };
  }
  for (const k of ['front', 'back', 'tags', 'suspended', 'deck_id'])
    if (k in req.body) await db.run(`UPDATE cards SET ${k} = ?, updated_at = ? WHERE id = ?`, req.body[k], Date.now(), req.params.id);
  return { ok: true };
}));
app.delete('/api/cards/:id', wrap(async (req) => {
  // deleting a cloze card deletes its whole note (otherwise the next edit would bring it back)
  const card = await ownCard(req, req.params.id);
  const r = card.note_id
    ? await db.run('DELETE FROM cards WHERE note_id = ? AND deck_id = ?', card.note_id, card.deck_id)
    : await db.run('DELETE FROM cards WHERE id = ?', card.id);
  return { ok: true, deleted: r.changes };
}));
app.post('/api/cards/:id/forget', wrap(async (req) => { await ownCard(req, req.params.id); await forgetCard(Number(req.params.id)); return { ok: true }; }));

// ---------- study ----------
app.get('/api/study/:deck', wrap(async (req) => {
  const deck = await deckParam(req, req.params.deck);
  return { card: await nextCard(deck, Number(req.query.exclude) || null), counts: await counts(deck) };
}));
app.post('/api/study/:deck/answer', wrap(async (req) => {
  const { cardId, rating, durationMs } = req.body;
  if (![1, 2, 3, 4].includes(rating)) throw fail('Bad rating');
  await ownCard(req, cardId);
  const result = await answer(uid(req), cardId, rating, durationMs);
  const deck = await deckParam(req, req.params.deck);
  return { result, card: await nextCard(deck, cardId), counts: await counts(deck) };
}));
app.post('/api/study/:deck/undo', wrap(async (req) => {
  const deck = await deckParam(req, req.params.deck);
  const cardId = await undoLast(deck);
  if (!cardId) throw fail('Nothing to undo');
  return { card: await getStudyCard(cardId), counts: await counts(deck) };
}));
app.post('/api/study/:deck/redo', wrap(async (req) => {
  const deck = await deckParam(req, req.params.deck);
  const r = await redoLast(deck);
  if (!r) throw fail('Nothing to redo');
  if (r.stale) throw fail('That card changed since the undo, so it can’t be redone');
  return { card: await nextCard(deck, r), counts: await counts(deck) };
}));

// ---------- stats ----------
app.get('/api/stats', wrap((req) => userStats(uid(req))));
app.get('/api/stats/log', wrap((req) => {
  const days = Math.max(0, Math.min(3650, parseInt(req.query.days, 10) || 0));
  return userReviewLog(uid(req), days);
}));

// ---------- Anki import ----------
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 * 1024 } });
app.post('/api/import', upload.single('file'), wrap(async (req) => {
  if (!req.file) throw fail('No file');
  try { return await importApkg(req.file.buffer, { originalName: req.file.originalname, userId: uid(req) }); }
  catch (e) { if (/Not an Anki package|zip/i.test(e.message)) throw fail(e.message); throw e; }
}));

// oversized or malformed uploads: a JSON error instead of Express's HTML page
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'That file is too large' : err.message });
  next(err);
});

// ---------- frontend ----------
const dist = path.join(__dirname, '..', 'web', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist, { index: false, maxAge: '1h' }));
  app.get(/^(?!\/api|\/media).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
}

const server = app.listen(PORT, async () => {
  const users = await auth.userCount();
  console.log(`Recall listening on http://localhost:${PORT} (${users ? `${users} account${users === 1 ? '' : 's'}` : 'not claimed yet'}; database: ${db.describe()})`);
  await auth.announceClaimLink(PUBLIC_URL || `http://localhost:${PORT}`);
  if (!PUBLIC_URL) console.log('Tip: set PUBLIC_URL (e.g. https://recall.example.com) so passkeys and sign-in providers use the right address.');
});

// clean shutdown on `docker stop` / Ctrl-C: finish requests, then close the database (SQLite checkpoints its WAL)
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.close(async () => { await db.close(); process.exit(0); });
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
