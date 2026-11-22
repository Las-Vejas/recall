// Accounts and sign-in, modelled on Orchard:
//   - A fresh instance has no users. A one-time *claim link* (printed in the logs, valid 24h) creates the
//     first account, which is the superadmin. `node server/cli.js claim` prints a new one.
//   - People sign in with a passkey, a connected identity provider (see oauth.js), or a password.
//   - New accounts come from invite links (or open sign-up, if a superadmin turns it on).
//   - Sessions are random tokens in an httpOnly cookie, stored hashed, listed as "devices".
//   - API tokens are per user and only reach the routes listed in index.js (import + read).
import crypto from 'node:crypto';
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { db } from './db.js';

export const MIN_PASSWORD = 8;
const DAY = 86_400_000;
const SESSION_TTL = 30 * DAY;
const CLAIM_TTL = DAY;
const LOGIN_LINK_TTL = 10 * 60_000;
const INVITE_TTL = 7 * DAY;

const now = () => Date.now();
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const safeEq = (a, b) => a.length === b.length && crypto.timingSafeEqual(a, b);

/** An error meant for the person using the app (shown as-is, no stack trace in the logs). */
export const userError = (message, status = 400) => Object.assign(new Error(message), { expected: true, status });

// ---------------- settings (tiny key/value store, cached in memory) ----------------
const settings = new Map();
export async function loadSettings() {
  settings.clear();
  for (const r of await db.all('SELECT key, value FROM settings')) settings.set(r.key, r.value);
  if (!settings.get('session_secret')) await setSetting('session_secret', crypto.randomBytes(32).toString('hex'));
}
export const getSetting = (k) => settings.get(k);
export async function setSetting(k, v) {
  await db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, String(v));
  settings.set(k, String(v));
}
async function deleteSettings(...keys) {
  for (const k of keys) { await db.run('DELETE FROM settings WHERE key = ?', k); settings.delete(k); }
}
const secretKey = () => process.env.SESSION_SECRET || getSetting('session_secret');
/** Signs small values kept in cookies (passkey challenges, OAuth state). */
export function sign(value) {
  const body = Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${body}.${crypto.createHmac('sha256', secretKey()).update(body).digest('base64url')}`;
}
export function unsign(signed) {
  const [body, mac] = String(signed || '').split('.');
  if (!body || !mac) return null;
  const expected = crypto.createHmac('sha256', secretKey()).update(body).digest('base64url');
  if (!safeEq(Buffer.from(mac), Buffer.from(expected))) return null;
  try { const v = JSON.parse(Buffer.from(body, 'base64url').toString()); return v.exp && v.exp < now() ? null : v; } catch { return null; }
}

export const openSignup = () => getSetting('open_signup') === 'true';

// ---------------- passwords ----------------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `scrypt:${salt.toString('hex')}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}
function checkHash(pw, stored) {
  if (!stored?.startsWith('scrypt:')) return false;
  const [, salt, key] = stored.split(':');
  return safeEq(crypto.scryptSync(String(pw), Buffer.from(salt, 'hex'), 64), Buffer.from(key, 'hex'));
}
function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD) throw userError(`Password must be at least ${MIN_PASSWORD} characters`);
}

// ---------------- users ----------------
const USERNAME = /^[a-z0-9](?:[a-z0-9_-]{0,30}[a-z0-9])?$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const publicUser = (u) => u && ({ id: u.id, username: u.username, email: u.email, name: u.name, isAdmin: !!u.is_admin, hasPassword: !!u.password_hash, createdAt: u.created_at, lastLoginAt: u.last_login_at });

export const userCount = async () => (await db.get('SELECT COUNT(*) AS n FROM users')).n;
export const getUser = (id) => db.get('SELECT * FROM users WHERE id = ?', id);
export const findUserByLogin = (login) => db.get('SELECT * FROM users WHERE lower(username) = lower(?) OR lower(email) = lower(?)', login, login);

/** Turns a provider name like "Ada Lovelace" or "ada.l" into a free username. */
export async function freeUsername(base) {
  let stem = String(base || 'user').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '').slice(0, 24) || 'user';
  if (stem.length < 2) stem = `${stem}user`;
  for (let i = 0; i < 1000; i++) {
    const candidate = i ? `${stem}${i + 1}` : stem;
    if (!(await db.get('SELECT 1 AS x FROM users WHERE username = ?', candidate))) return candidate;
  }
  return `${stem}-${crypto.randomBytes(3).toString('hex')}`;
}

export async function createUser({ username, email, name = '', password, isAdmin = false }) {
  username = String(username || '').trim().toLowerCase();
  email = String(email || '').trim().toLowerCase();
  if (!USERNAME.test(username)) throw userError('Usernames are 1–32 characters: lowercase letters, numbers, - and _');
  if (!EMAIL.test(email)) throw userError('Enter a valid email address');
  if (await db.get('SELECT 1 AS x FROM users WHERE username = ?', username)) throw userError('That username is taken');
  if (await db.get('SELECT 1 AS x FROM users WHERE email = ?', email)) throw userError('An account with that email already exists');
  if (password) validatePassword(password);
  const id = await db.insert('INSERT INTO users (username, email, name, password_hash, is_admin, created_at) VALUES (?,?,?,?,?,?)',
    username, email, String(name || '').trim().slice(0, 80), password ? hashPassword(password) : null, isAdmin ? 1 : 0, now());
  return getUser(id);
}

export async function updateProfile(userId, { username, email, name }) {
  const u = await getUser(userId);
  if (username !== undefined && username !== u.username) {
    username = String(username).trim().toLowerCase();
    if (!USERNAME.test(username)) throw userError('Usernames are 1–32 characters: lowercase letters, numbers, - and _');
    if (await db.get('SELECT 1 AS x FROM users WHERE username = ? AND id != ?', username, userId)) throw userError('That username is taken');
    await db.run('UPDATE users SET username = ? WHERE id = ?', username, userId);
  }
  if (email !== undefined && email !== u.email) {
    email = String(email).trim().toLowerCase();
    if (!EMAIL.test(email)) throw userError('Enter a valid email address');
    if (await db.get('SELECT 1 AS x FROM users WHERE email = ? AND id != ?', email, userId)) throw userError('An account with that email already exists');
    await db.run('UPDATE users SET email = ? WHERE id = ?', email, userId);
  }
  if (name !== undefined) await db.run('UPDATE users SET name = ? WHERE id = ?', String(name).trim().slice(0, 80), userId);
  return getUser(userId);
}

/** How many ways a user can still sign in (so they can't remove the last one). */
export async function signInMethodCount(userId) {
  const u = await getUser(userId);
  const pk = (await db.get('SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?', userId)).n;
  const ids = (await db.get('SELECT COUNT(*) AS n FROM identities WHERE user_id = ?', userId)).n;
  return (u.password_hash ? 1 : 0) + pk + ids;
}

export async function setPassword(userId, { current, next }) {
  const u = await getUser(userId);
  if (u.password_hash && !checkHash(current || '', u.password_hash)) throw userError('Current password is wrong', 401);
  validatePassword(next);
  await db.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(next), userId);
}
export async function removePassword(userId) {
  if ((await signInMethodCount(userId)) <= 1) throw userError('Add a passkey or connect a provider before removing your password');
  await db.run('UPDATE users SET password_hash = NULL WHERE id = ?', userId);
}
const DUMMY_HASH = `scrypt:${'0'.repeat(32)}:${'0'.repeat(128)}`;
export async function verifyPasswordLogin(login, password) {
  const u = await findUserByLogin(String(login || '').trim());
  // always do the hashing work, so response time doesn't reveal whether the account exists
  const ok = checkHash(password || '', u?.password_hash || DUMMY_HASH);
  return ok && u ? u : null;
}

// ---------------- sessions ----------------
export const SESSION_COOKIE = 'recall_session';
export const cookieSecure = (req) => req.secure || req.get('x-forwarded-proto') === 'https';
export async function createSession(req, res, userId, method) {
  const token = randomToken();
  const t = now();
  await db.run(`INSERT INTO sessions (id, user_id, token_hash, method, user_agent, ip, created_at, last_seen_at, expires_at)
    VALUES (?,?,?,?,?,?,?,?,?)`, crypto.randomUUID(), userId, sha(token), method,
  String(req.get('user-agent') || '').slice(0, 300), String(req.ip || ''), t, t, t + SESSION_TTL);
  await db.run('UPDATE users SET last_login_at = ? WHERE id = ?', t, userId);
  res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', maxAge: SESSION_TTL, path: '/', secure: cookieSecure(req) });
}

/** Resolves the session cookie to { user, session }, sliding the expiry forward. */
export async function sessionFromRequest(req) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return null;
  const s = await db.get('SELECT * FROM sessions WHERE token_hash = ?', sha(token));
  if (!s || s.expires_at < now()) return null;
  const user = await getUser(s.user_id);
  if (!user) return null;
  if (now() - s.last_seen_at > 5 * 60_000) {
    await db.run('UPDATE sessions SET last_seen_at = ?, expires_at = ?, ip = ? WHERE id = ?', now(), now() + SESSION_TTL, String(req.ip || ''), s.id);
  }
  return { user, session: s };
}
export async function endSession(req, res) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) await db.run('DELETE FROM sessions WHERE token_hash = ?', sha(token));
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}
export const listSessions = (userId) => db.all('SELECT id, method, user_agent, ip, created_at, last_seen_at FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_seen_at DESC', userId, now());
export const revokeSession = (userId, id) => db.run('DELETE FROM sessions WHERE user_id = ? AND id = ?', userId, id);
/** Signs out every other device and, like Orchard, deletes the account's API tokens too. */
export async function revokeOtherSessions(userId, keepId) {
  await db.run('DELETE FROM sessions WHERE user_id = ? AND id != ?', userId, keepId);
  await db.run('DELETE FROM api_tokens WHERE user_id = ?', userId);
}

// ---------------- API tokens ----------------
export async function createApiToken(userId, name) {
  const token = `rk_${randomToken(24)}`;
  const id = await db.insert('INSERT INTO api_tokens (user_id, name, token_hash, created_at) VALUES (?,?,?,?)',
    userId, String(name || '').trim().slice(0, 60) || 'Token', sha(token), now());
  return { id, token };
}
export const listApiTokens = (userId) => db.all('SELECT id, name, created_at, last_used_at FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC', userId);
export const deleteApiToken = (userId, id) => db.run('DELETE FROM api_tokens WHERE user_id = ? AND id = ?', userId, id);
export async function userFromBearer(header) {
  const m = /^Bearer\s+(rk_\S+)$/i.exec(header || '');
  if (!m) return null;
  const t = await db.get('SELECT * FROM api_tokens WHERE token_hash = ?', sha(m[1]));
  if (!t) return null;
  await db.run('UPDATE api_tokens SET last_used_at = ? WHERE id = ?', now(), t.id);
  return getUser(t.user_id);
}

// ---------------- one-time links: claim (first superadmin) and login (recovery) ----------------
export async function mintLink(kind, userId = null) {
  const token = randomToken();
  if (kind === 'claim') await db.run("DELETE FROM auth_links WHERE kind = 'claim'"); // only the newest claim link works
  await db.run('INSERT INTO auth_links (token_hash, kind, user_id, expires_at) VALUES (?,?,?,?)',
    sha(token), kind, userId, now() + (kind === 'claim' ? CLAIM_TTL : LOGIN_LINK_TTL));
  return token;
}
async function liveLink(kind, token) {
  const l = token && await db.get('SELECT * FROM auth_links WHERE token_hash = ? AND kind = ?', sha(token), kind);
  return l && !l.used_at && l.expires_at > now() ? l : null;
}
export const claimLinkValid = async (token) => !!(await liveLink('claim', token)) && (await userCount()) === 0;
/** Instances from before accounts had one shared password; the claimer can keep it. */
export const hasLegacyPassword = () => !!getSetting('password_hash');

/** Redeems the claim link: creates the superadmin and gives them everything made before accounts existed. */
export async function claimInstance(token, { username, email, name, password }) {
  return db.tx(async () => {
    if (!(await liveLink('claim', token)) || (await userCount()) > 0) {
      throw userError('This claim link was already used or has expired. Run `node server/cli.js claim` for a new one.', 410);
    }
    const legacyPassword = getSetting('password_hash');
    if (!password && !legacyPassword) throw userError('Choose a password. You can add a passkey right after.');
    const user = await createUser({ username, email, name, password, isAdmin: true });
    if (!password && legacyPassword) await db.run('UPDATE users SET password_hash = ? WHERE id = ?', legacyPassword, user.id);
    for (const t of ['decks', 'folders', 'reviews', 'redo_stack', 'media']) await db.run(`UPDATE ${t} SET user_id = ? WHERE user_id IS NULL`, user.id);
    const legacyToken = getSetting('api_token_hash');
    if (legacyToken) await db.run('INSERT INTO api_tokens (user_id, name, token_hash, created_at) VALUES (?,?,?,?)', user.id, 'Imported token', legacyToken, now());
    await db.run("UPDATE auth_links SET used_at = ? WHERE kind = 'claim'", now());
    await deleteSettings('password_hash', 'api_token_hash', 'api_token_created');
    return getUser(user.id);
  });
}

export async function redeemLoginLink(token) {
  const link = await liveLink('login', token);
  if (!link) return null;
  await db.run('UPDATE auth_links SET used_at = ? WHERE token_hash = ?', now(), sha(token));
  return getUser(link.user_id);
}

/** On start: an instance with no accounts gets a fresh claim link, printed for the operator. */
export async function announceClaimLink(baseUrl) {
  if ((await userCount()) > 0) return;
  const token = await mintLink('claim');
  console.log([
    '', '┌──────────────────────────────────────────────────────────────────────────────',
    '│ Claim this Recall instance (creates the superadmin account; works once, 24h):',
    `│   ${baseUrl}/claim/${token}`,
    '│ Lost it? Run: node server/cli.js claim',
    '└──────────────────────────────────────────────────────────────────────────────', '',
  ].join('\n'));
}

// ---------------- invites ----------------
export async function createInvite(createdBy, { note = '', isAdmin = false } = {}) {
  const token = randomToken(18);
  const id = await db.insert('INSERT INTO invites (token_hash, note, is_admin, created_by, created_at, expires_at) VALUES (?,?,?,?,?,?)',
    sha(token), String(note).slice(0, 120), isAdmin ? 1 : 0, createdBy, now(), now() + INVITE_TTL);
  return { id, token };
}
export async function inviteByToken(token) {
  const i = token && await db.get('SELECT * FROM invites WHERE token_hash = ?', sha(token));
  return i && !i.used_at && i.expires_at > now() ? i : null;
}
export const useInvite = (inviteId, userId) => db.run('UPDATE invites SET used_at = ?, used_by = ? WHERE id = ?', now(), userId, inviteId);

/** Creates an account from an invite or open sign-up. */
export async function register({ inviteToken, username, email, name, password }) {
  return db.tx(async () => {
    const invite = await inviteByToken(inviteToken);
    if (!invite && !openSignup()) throw userError('You need an invite link to create an account here', 403);
    if (!password) throw userError('Choose a password, or continue with a sign-in provider. You can add a passkey right after.');
    const user = await createUser({ username, email, name, password, isAdmin: !!invite?.is_admin });
    if (invite) await useInvite(invite.id, user.id);
    return user;
  });
}

// ---------------- passkeys (WebAuthn) ----------------
const rpID = (origin) => new URL(origin).hostname;

export async function passkeyRegistrationOptions(user, origin) {
  const existing = await db.all('SELECT id, transports FROM passkeys WHERE user_id = ?', user.id);
  return generateRegistrationOptions({
    rpName: 'Recall', rpID: rpID(origin),
    userName: user.username,
    userDisplayName: user.name || user.username,
    userID: new TextEncoder().encode(`recall-user-${user.id}`),
    attestationType: 'none',
    excludeCredentials: existing.map((p) => ({ id: p.id, transports: p.transports ? p.transports.split(',') : undefined })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
  });
}

export async function verifyPasskeyRegistration(user, response, challenge, origin, name) {
  let v;
  try {
    v = await verifyRegistrationResponse({ response, expectedChallenge: challenge, expectedOrigin: origin, expectedRPID: rpID(origin) });
  } catch (e) { throw userError(`Passkey was not accepted: ${e.message}`); }
  if (!v.verified) throw userError('Passkey was not accepted');
  const { credential, passkeyProviderMetadata } = v.registrationInfo;
  const names = passkeyProviderMetadata?.friendlyNames || {};
  const label = String(name || '').trim() || names.en || names['en-US'] || Object.values(names)[0] || 'Passkey';
  await db.run('INSERT INTO passkeys (id, user_id, public_key, counter, transports, name, created_at) VALUES (?,?,?,?,?,?,?)',
    credential.id, user.id, Buffer.from(credential.publicKey), credential.counter, (credential.transports || []).join(','), String(label).slice(0, 60), now());
}

export const passkeyLoginOptions = (origin) => generateAuthenticationOptions({ rpID: rpID(origin), userVerification: 'preferred' }); // discoverable

export async function verifyPasskeyLogin(response, challenge, origin) {
  const pk = await db.get('SELECT * FROM passkeys WHERE id = ?', String(response?.id || ''));
  if (!pk) throw userError('That passkey is not registered here. It may have been removed.', 401);
  let v;
  try {
    v = await verifyAuthenticationResponse({
      response, expectedChallenge: challenge, expectedOrigin: origin, expectedRPID: rpID(origin),
      credential: { id: pk.id, publicKey: new Uint8Array(pk.public_key), counter: Number(pk.counter), transports: pk.transports ? pk.transports.split(',') : undefined },
    });
  } catch (e) { throw userError(`Passkey sign-in failed: ${e.message}`, 401); }
  if (!v.verified) throw userError('Passkey sign-in failed', 401);
  await db.run('UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?', v.authenticationInfo.newCounter, now(), pk.id);
  return getUser(pk.user_id);
}

export const listPasskeys = (userId) => db.all('SELECT id, name, created_at, last_used_at FROM passkeys WHERE user_id = ? ORDER BY created_at', userId);
export const renamePasskey = (userId, id, name) => db.run('UPDATE passkeys SET name = ? WHERE user_id = ? AND id = ?', String(name || '').trim().slice(0, 60) || 'Passkey', userId, id);
export async function removePasskey(userId, id) {
  if ((await signInMethodCount(userId)) <= 1) throw userError('This is your only way to sign in. Add another passkey, a password or a provider first.');
  await db.run('DELETE FROM passkeys WHERE user_id = ? AND id = ?', userId, id);
}
