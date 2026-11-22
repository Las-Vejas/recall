// Single-user auth.
//
// Three modes, in priority order:
//   DISABLE_AUTH=true   -> no login at all (only for trusted LANs)
//   APP_PASSWORD=...    -> password comes from the environment
//   (neither)           -> first visit shows a setup screen; the password is stored hashed in the DB
//
// Sessions are an HMAC cookie. The signing key is SESSION_SECRET or a random key generated once and
// stored in the DB. The token is bound to the current password, so changing it logs out other devices.
import crypto from 'node:crypto';
import { db } from './db.js';

// Settings are a handful of keys: cached in memory (single process), written through to the database.
const settings = new Map();
export async function loadSettings() {
  settings.clear();
  for (const r of await db.all('SELECT key, value FROM settings')) settings.set(r.key, r.value);
  if (!process.env.SESSION_SECRET && !settings.get('session_secret')) await setSetting('session_secret', crypto.randomBytes(32).toString('hex'));
}
const getSetting = (k) => settings.get(k);
async function setSetting(k, v) {
  await db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, v);
  settings.set(k, v);
}
async function deleteSettings(...keys) {
  for (const k of keys) { await db.run('DELETE FROM settings WHERE key = ?', k); settings.delete(k); }
}

const ENV_PASSWORD = process.env.APP_PASSWORD || '';
const DISABLED = /^(1|true|yes)$/i.test(process.env.DISABLE_AUTH || '');
export const MIN_PASSWORD = 8;

const secret = () => process.env.SESSION_SECRET || getSetting('session_secret');

const sha = (s) => crypto.createHash('sha256').update(s).digest();
const safeEq = (a, b) => a.length === b.length && crypto.timingSafeEqual(a, b);

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 64);
  return `scrypt:${salt.toString('hex')}:${key.toString('hex')}`;
}
function checkHash(pw, stored) {
  const [, saltHex, keyHex] = stored.split(':');
  const key = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64);
  return safeEq(key, Buffer.from(keyHex, 'hex'));
}

export function mode() {
  if (DISABLED) return 'disabled';
  if (ENV_PASSWORD) return 'env';
  return getSetting('password_hash') ? 'stored' : 'setup';
}

/** Something that changes whenever the password changes, so old cookies stop working. */
function fingerprint() {
  const m = mode();
  if (m === 'env') return sha(ENV_PASSWORD).toString('hex');
  if (m === 'stored') return getSetting('password_hash');
  return 'none';
}

export const sessionToken = () => crypto.createHmac('sha256', secret()).update(`recall-session-v2:${fingerprint()}`).digest('hex');

export function isAuthed(cookie) {
  const m = mode();
  if (m === 'disabled') return true;
  if (m === 'setup' || !cookie) return false;
  return safeEq(Buffer.from(String(cookie)), Buffer.from(sessionToken()));
}

export function verifyPassword(pw) {
  const m = mode();
  if (m === 'env') return safeEq(sha(String(pw)), sha(ENV_PASSWORD));
  if (m === 'stored') return checkHash(String(pw), getSetting('password_hash'));
  return false;
}

export async function setPassword(pw) {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD) throw new Error(`Password must be at least ${MIN_PASSWORD} characters`);
  if (mode() === 'env') throw new Error('Password is set by APP_PASSWORD; change it there');
  await setSetting('password_hash', hashPassword(pw));
}

// ---- API token for AI agents / scripts ----
// One token at a time, stored as a SHA-256 hash; shown to the user only when created.
// It only unlocks the routes in AGENT_ROUTES (see index.js), never the whole API.
export async function createApiToken() {
  const token = `rk_${crypto.randomBytes(24).toString('base64url')}`;
  await setSetting('api_token_hash', sha(token).toString('hex'));
  await setSetting('api_token_created', String(Date.now()));
  return token;
}
export async function revokeApiToken() {
  await deleteSettings('api_token_hash', 'api_token_created');
}
export function apiTokenInfo() {
  const created = getSetting('api_token_created');
  return { exists: !!getSetting('api_token_hash'), created: created ? Number(created) : null };
}
export function checkBearer(header) {
  const stored = getSetting('api_token_hash');
  const m = /^Bearer\s+(\S+)$/i.exec(header || '');
  if (!stored || !m) return false;
  return safeEq(sha(m[1]), Buffer.from(stored, 'hex'));
}
