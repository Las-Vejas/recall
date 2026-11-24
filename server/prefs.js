// Per-person settings that change how Recall behaves for them: FSRS target retention and fitted parameters,
// what happens to leeches, their timezone, and study reminders. Stored as JSON in users.prefs.
import { db } from './db.js';

export const RETENTION_RANGE = [0.7, 0.97];
export const DEFAULT_RETENTION = clampRetention(Number(process.env.DESIRED_RETENTION || 0.9)) ?? 0.9;
export const LEECH_ACTIONS = ['flag', 'suspend', 'off'];

function clampRetention(v) {
  return Number.isFinite(v) ? Math.min(RETENTION_RANGE[1], Math.max(RETENTION_RANGE[0], Math.round(v * 1000) / 1000)) : null;
}

const DEFAULTS = {
  retention: null, // null = the server default
  params: null, // fitted FSRS weights (21 numbers), null = FSRS defaults
  optimized: null, // { at, reviews } when params were last fitted
  leech: { threshold: 8, action: 'flag' },
  timezone: null, // IANA name, reported by the browser
  reminder: { enabled: false, time: '18:00', slackUser: null, lastSent: null },
};

const cache = new Map();

/** Settings for a user, with defaults filled in. */
export async function getPrefs(userId) {
  if (cache.has(userId)) return cache.get(userId);
  const row = await db.get('SELECT prefs FROM users WHERE id = ?', userId);
  let stored = {};
  try { stored = row?.prefs ? JSON.parse(row.prefs) : {}; } catch { /* corrupt: fall back to defaults */ }
  const prefs = {
    ...DEFAULTS, ...stored,
    leech: { ...DEFAULTS.leech, ...stored.leech },
    reminder: { ...DEFAULTS.reminder, ...stored.reminder },
  };
  cache.set(userId, prefs);
  return prefs;
}

const isTimezone = (tz) => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } };
const fail = (msg) => Object.assign(new Error(msg), { status: 400, expected: true });

/**
 * Applies a partial change from the API, validating each field. Unknown fields are refused.
 * Server-owned fields (params from the optimizer, lastSent) go through setInternal instead.
 */
export async function updatePrefs(userId, patch) {
  const cur = await getPrefs(userId);
  const next = structuredClone(cur);
  for (const [k, v] of Object.entries(patch || {})) {
    if (k === 'retention') {
      if (v === null) next.retention = null;
      else { const r = clampRetention(Number(v)); if (r == null) throw fail('Retention must be a number like 0.9'); next.retention = r; }
    } else if (k === 'params') {
      if (v !== null) throw fail('Parameters can only be reset (null) here; use Optimize to fit them');
      next.params = null; next.optimized = null;
    } else if (k === 'leech') {
      const t = v?.threshold ?? cur.leech.threshold;
      if (!Number.isInteger(t) || t < 2 || t > 99) throw fail('Leech threshold must be a whole number from 2 to 99');
      const a = v?.action ?? cur.leech.action;
      if (!LEECH_ACTIONS.includes(a)) throw fail(`Leech action must be one of ${LEECH_ACTIONS.join(', ')}`);
      next.leech = { threshold: t, action: a };
    } else if (k === 'timezone') {
      if (v !== null && (typeof v !== 'string' || !isTimezone(v))) throw fail('Unknown timezone');
      next.timezone = v;
    } else if (k === 'reminder') {
      const r = { ...cur.reminder };
      if ('enabled' in v) r.enabled = !!v.enabled;
      if ('time' in v) { if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(v.time)) throw fail('Reminder time must be HH:MM'); r.time = v.time; }
      next.reminder = r;
    } else throw fail(`Unknown setting: ${k}`);
  }
  await save(userId, next);
  return next;
}

/** For the server itself: optimizer results, Slack link, last reminder date. No validation. */
export async function setInternal(userId, fn) {
  const next = structuredClone(await getPrefs(userId));
  fn(next);
  await save(userId, next);
  return next;
}

async function save(userId, prefs) {
  await db.run('UPDATE users SET prefs = ? WHERE id = ?', JSON.stringify(prefs), userId);
  cache.set(userId, prefs);
}

/** Retention that applies to a deck: its own override, else the person's, else the server default. */
export const effectiveRetention = (prefs, deckRetention) => (deckRetention != null ? Number(deckRetention) : prefs.retention ?? DEFAULT_RETENTION);

export function forgetCachedPrefs(userId) { cache.delete(userId); }
