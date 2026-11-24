import { fsrs, generatorParameters, createEmptyCard, Rating, State } from 'ts-fsrs';
import { db } from './db.js';
import { DEFAULT_RETENTION, effectiveRetention, getPrefs } from './prefs.js';

// one FSRS instance per (parameters, retention, fuzz): people with fitted parameters or their own
// retention get their own; everyone on the defaults shares one
const schedulers = new Map();
export function schedulerFor(prefs, deckRetention = null, fuzz = true) {
  const retention = prefs ? effectiveRetention(prefs, deckRetention) : DEFAULT_RETENTION;
  const w = prefs?.params || null;
  const key = `${w ? w.join(',') : 'default'}|${retention}|${fuzz}`;
  let s = schedulers.get(key);
  if (!s) {
    s = fsrs(generatorParameters({ enable_fuzz: fuzz, request_retention: retention, ...(w ? { w } : {}) }));
    if (schedulers.size > 500) schedulers.clear();
    schedulers.set(key, s);
  }
  return s;
}
const replayScheduler = schedulerFor(null, null, false);

const LEARN_AHEAD_MS = 20 * 60 * 1000;
const DAY = 86_400_000;

/**
 * Rebuilds a card's FSRS memory state from its review history, oldest first.
 * `reviews` are { rating (1-4), at (ms) }, or { reset: true, at } where the card was reset to new.
 * Returns the final card and, for each review, the row values our reviews table stores.
 * No fuzz, so the same history always gives the same state.
 */
export function replayReviews(reviews, createdAt, sched = replayScheduler) {
  let card = createEmptyCard(new Date(createdAt));
  const log = [];
  for (const r of reviews) {
    const at = new Date(r.at);
    if (r.reset) { card = createEmptyCard(at); continue; }
    const prev = card;
    const { card: next } = sched.next(prev, at, r.rating);
    log.push({ ...r, prev_state: prev.state, prev_fsrs: serialize(prev), interval_ms: next.due.getTime() - at.getTime() });
    card = next;
  }
  return { card, log };
}

export function newFsrsCard(now = new Date()) {
  return serialize(createEmptyCard(now));
}

export function serialize(card) {
  return JSON.stringify(card);
}

export function deserialize(json) {
  const c = JSON.parse(json);
  c.due = new Date(c.due);
  c.last_review = c.last_review ? new Date(c.last_review) : undefined;
  return c;
}

export function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Scope: null = all decks, a deck id, or an array of deck ids (e.g. every deck in a folder). */
const toIds = (scope) => (scope == null ? null : Array.isArray(scope) ? scope : [scope]);
const inList = (ids) => (ids.length ? `IN (${ids.map(() => '?').join(',')})` : 'IN (NULL)');

function deckFilter(scope, col = 'c.deck_id') {
  const ids = toIds(scope);
  return ids == null ? { sql: '', args: [] } : { sql: `AND ${col} ${inList(ids)}`, args: ids };
}

/**
 * Custom study. `tags`: only cards with any of these tags. `mode`:
 *   'due' (default) the normal queue; 'forgotten' cards whose latest review today was Again, whenever they're due;
 *   'ahead' review cards due within `days` days, soonest first, to get ahead before a trip or an exam.
 */
export const STUDY_MODES = ['due', 'forgotten', 'ahead'];

function tagFilter(filter) {
  const tags = filter?.tags || [];
  if (!tags.length) return { sql: '', args: [] };
  return { sql: `AND (${tags.map(() => "(' ' || c.tags || ' ') LIKE ?").join(' OR ')})`, args: tags.map((t) => `% ${t} %`) };
}
const FORGOTTEN = `AND c.id IN (SELECT r.card_id FROM reviews r WHERE r.reviewed_at >= ? AND r.rating = 1
  AND NOT EXISTS (SELECT 1 FROM reviews r2 WHERE r2.card_id = r.card_id AND r2.id > r.id))`;

export async function newRemaining(deckId, filter = null) {
  const f = deckFilter(deckId, 'id');
  const t = tagFilter(filter);
  const decks = await db.all(`SELECT id, new_per_day FROM decks WHERE 1 ${f.sql}`, ...f.args);
  const today = startOfToday();
  let total = 0;
  const perDeck = new Map();
  for (const d of decks) {
    const introduced = (await db.get('SELECT COUNT(*) AS n FROM reviews WHERE deck_id = ? AND prev_state = 0 AND reviewed_at >= ?', d.id, today)).n;
    const available = (await db.get(`SELECT COUNT(*) AS n FROM cards c WHERE c.deck_id = ? AND c.state = 0 AND c.suspended = 0 ${t.sql}`, d.id, ...t.args)).n;
    const n = Math.min(Math.max(0, d.new_per_day - introduced), available);
    perDeck.set(d.id, n);
    total += n;
  }
  return { total, perDeck };
}

export async function counts(deckId, filter = null) {
  const f = deckFilter(deckId);
  const t = tagFilter(filter);
  const now = Date.now();
  const mode = filter?.mode || 'due';
  if (mode === 'forgotten') {
    const row = await db.get(`SELECT COUNT(*) AS n FROM cards c WHERE c.suspended = 0 ${f.sql} ${t.sql} ${FORGOTTEN}`, ...f.args, ...t.args, startOfToday());
    return { new: 0, learn: row?.n || 0, review: 0 };
  }
  if (mode === 'ahead') {
    const until = now + (filter.days || 1) * DAY;
    const row = await db.get(`SELECT
        SUM(CASE WHEN c.state IN (1,3) THEN 1 ELSE 0 END) AS learn, SUM(CASE WHEN c.state = 2 THEN 1 ELSE 0 END) AS review
      FROM cards c WHERE c.suspended = 0 AND c.state != 0 AND c.due <= ? ${f.sql} ${t.sql}`, until, ...f.args, ...t.args);
    return { new: 0, learn: row?.learn || 0, review: row?.review || 0 };
  }
  const row = await db.get(`
    SELECT
      SUM(CASE WHEN state IN (1,3) AND due <= ? THEN 1 ELSE 0 END) AS learn,
      SUM(CASE WHEN state = 2 AND due <= ? THEN 1 ELSE 0 END) AS review
    FROM cards c WHERE suspended = 0 ${f.sql} ${t.sql}`, now + LEARN_AHEAD_MS, now, ...f.args, ...t.args);
  return { new: (await newRemaining(deckId, filter)).total, learn: row?.learn || 0, review: row?.review || 0 };
}

const CARD_SELECT = 'SELECT c.*, d.name AS deck_name, d.color AS deck_color, d.user_id AS owner_id, d.retention AS deck_retention FROM cards c JOIN decks d ON d.id = c.deck_id';

/** Picks the next card to study, Anki-style: due learning > due review > new > learn-ahead (or a custom session's order). */
export async function nextCard(deckId, excludeId, filter = null) {
  const f = deckFilter(deckId);
  const t = tagFilter(filter);
  const now = Date.now();
  const ex = excludeId ? 'AND c.id != ?' : '';
  const exArgs = excludeId ? [excludeId] : [];
  const base = `${CARD_SELECT} WHERE c.suspended = 0 ${f.sql} ${t.sql} ${ex}`;
  const baseArgs = [...f.args, ...t.args, ...exArgs];
  const mode = filter?.mode || 'due';

  let card;
  if (mode === 'forgotten') {
    card = await db.get(`${base} ${FORGOTTEN} ORDER BY c.due LIMIT 1`, ...baseArgs, startOfToday());
  } else if (mode === 'ahead') {
    card = await db.get(`${base} AND c.state != 0 AND c.due <= ? ORDER BY c.due LIMIT 1`, ...baseArgs, now + (filter.days || 1) * DAY);
  } else {
    card = await db.get(`${base} AND c.state IN (1,3) AND c.due <= ? ORDER BY c.due LIMIT 1`, ...baseArgs, now);
    if (!card) card = await db.get(`${base} AND c.state = 2 AND c.due <= ? ORDER BY c.due LIMIT 1`, ...baseArgs, now);
    if (!card) {
      const { perDeck } = await newRemaining(deckId, filter);
      const ids = [...perDeck].filter(([, n]) => n > 0).map(([id]) => id);
      if (ids.length) {
        card = await db.get(`${CARD_SELECT} WHERE c.suspended = 0 AND c.state = 0 AND c.deck_id IN (${ids.map(() => '?').join(',')}) ${t.sql} ${ex}
          ORDER BY c.id LIMIT 1`, ...ids, ...t.args, ...exArgs);
      }
    }
    if (!card) card = await db.get(`${base} AND c.state IN (1,3) AND c.due <= ? ORDER BY c.due LIMIT 1`, ...baseArgs, now + LEARN_AHEAD_MS);
  }
  // if the only remaining card is the excluded one, allow it
  if (!card && excludeId) return nextCard(deckId, null, filter);
  return withPreview(card);
}

export async function getStudyCard(id) {
  return withPreview(await db.get(`${CARD_SELECT} WHERE c.id = ?`, id));
}

async function withPreview(card) {
  if (!card) return null;
  const now = Date.now();
  const fc = deserialize(card.fsrs);
  const sched = schedulerFor(await getPrefs(card.owner_id), card.deck_retention);
  const preview = sched.repeat(fc, new Date());
  const intervals = {};
  for (const r of [Rating.Again, Rating.Hard, Rating.Good, Rating.Easy]) {
    intervals[r] = preview[r].card.due.getTime() - now;
  }
  delete card.fsrs; delete card.owner_id; delete card.deck_retention;
  return { ...card, intervals, stability: fc.stability, reps: fc.reps, lapses: fc.lapses };
}

const hasTag = (tags, t) => String(tags || '').split(/\s+/).includes(t);

/**
 * Leech rule (like Anki): a card becomes a leech on its Nth lapse, and again every N/2 lapses after,
 * so a card that keeps failing keeps getting caught.
 */
export function isLeechLapse(lapses, threshold) {
  if (lapses < threshold) return false;
  return (lapses - threshold) % Math.max(1, Math.ceil(threshold / 2)) === 0;
}

/** What a leech does to the card: always tagged "leech", then flagged or suspended per the person's setting. */
function leechChange(card, action) {
  const before = { flagged: card.flagged ? 1 : 0, suspended: card.suspended ? 1 : 0, tags: card.tags || '' };
  const after = { ...before, tags: hasTag(before.tags, 'leech') ? before.tags : `${before.tags} leech`.trim() };
  if (action === 'flag') after.flagged = 1;
  if (action === 'suspend') after.suspended = 1;
  return { action, before, after };
}
const applyLeech = (cardId, v) => db.run('UPDATE cards SET flagged = ?, suspended = ?, tags = ? WHERE id = ?', v.flagged, v.suspended, v.tags, cardId);

export async function answer(userId, cardId, rating, durationMs = 0) {
  return db.tx(async () => {
    const card = await db.get('SELECT c.*, d.retention AS deck_retention FROM cards c JOIN decks d ON d.id = c.deck_id WHERE c.id = ?', cardId);
    if (!card) throw new Error('card not found');
    const now = new Date();
    const prefs = await getPrefs(userId);
    const prevLapses = deserialize(card.fsrs).lapses || 0;
    const { card: next } = schedulerFor(prefs, card.deck_retention).next(deserialize(card.fsrs), now, rating);
    const leech = prefs.leech.action !== 'off' && next.lapses > prevLapses && isLeechLapse(next.lapses, prefs.leech.threshold)
      ? leechChange(card, prefs.leech.action) : null;
    await db.run('DELETE FROM redo_stack WHERE user_id = ?', userId); // a new rating makes earlier undos final, like any editor
    await db.run(`INSERT INTO reviews (user_id, card_id, deck_id, rating, prev_state, prev_fsrs, interval_ms, duration_ms, reviewed_at, leech)
                  VALUES (?,?,?,?,?,?,?,?,?,?)`,
      userId, card.id, card.deck_id, rating, card.state, card.fsrs, next.due.getTime() - now.getTime(),
      Math.min(Math.round(durationMs) || 0, 5 * 60_000), now.getTime(), leech ? JSON.stringify(leech) : null);
    await db.run('UPDATE cards SET fsrs = ?, state = ?, due = ?, updated_at = ? WHERE id = ?',
      serialize(next), next.state, next.due.getTime(), now.getTime(), card.id);
    if (leech) await applyLeech(card.id, leech.after);
    return { state: next.state, due: next.due.getTime(), leech: leech ? { action: leech.action, lapses: next.lapses } : null };
  });
}

export async function undoLast(deckId) {
  return db.tx(async () => {
    const f = deckFilter(deckId, 'deck_id');
    const last = await db.get(`SELECT * FROM reviews WHERE imported = 0 ${f.sql} ORDER BY id DESC LIMIT 1`, ...f.args);
    if (!last) return null;
    const prev = deserialize(last.prev_fsrs);
    const current = await db.get('SELECT fsrs, state, due FROM cards WHERE id = ?', last.card_id);
    if (current) {
      await db.run('INSERT INTO redo_stack (user_id, card_id, deck_id, review, next_fsrs, next_state, next_due) VALUES (?,?,?,?,?,?,?)',
        last.user_id, last.card_id, last.deck_id, JSON.stringify(last), current.fsrs, current.state, current.due);
    }
    await db.run('UPDATE cards SET fsrs = ?, state = ?, due = ? WHERE id = ?', last.prev_fsrs, last.prev_state, prev.due.getTime(), last.card_id);
    if (last.leech) { try { await applyLeech(last.card_id, JSON.parse(last.leech).before); } catch { /* bad JSON: leave the card */ } }
    await db.run('DELETE FROM reviews WHERE id = ?', last.id);
    return last.card_id;
  });
}

/** Re-applies the most recent undo in scope, exactly as it was. Returns the card id, or null if nothing to redo. */
export async function redoLast(deckId) {
  return db.tx(async () => {
    const f = deckFilter(deckId, 'deck_id');
    const entry = await db.get(`SELECT * FROM redo_stack WHERE 1 ${f.sql} ORDER BY id DESC LIMIT 1`, ...f.args);
    if (!entry) return null;
    const review = JSON.parse(entry.review);
    const card = await db.get('SELECT fsrs FROM cards WHERE id = ?', entry.card_id);
    // only valid if the card is still exactly as the undo left it (not edited, reset or re-rated since)
    if (!card || card.fsrs !== review.prev_fsrs) {
      await db.run('DELETE FROM redo_stack WHERE id = ?', entry.id);
      return { stale: true };
    }
    await db.run(`INSERT INTO reviews (id, user_id, card_id, deck_id, rating, prev_state, prev_fsrs, interval_ms, duration_ms, reviewed_at, leech)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      review.id, review.user_id ?? entry.user_id, review.card_id, review.deck_id, review.rating, review.prev_state, review.prev_fsrs, review.interval_ms, review.duration_ms, review.reviewed_at, review.leech ?? null);
    await db.run('UPDATE cards SET fsrs = ?, state = ?, due = ? WHERE id = ?', entry.next_fsrs, entry.next_state, entry.next_due, entry.card_id);
    if (review.leech) { try { await applyLeech(entry.card_id, JSON.parse(review.leech).after); } catch { /* ignore */ } }
    await db.run('DELETE FROM redo_stack WHERE id = ?', entry.id);
    return entry.card_id;
  });
}

export async function forgetCard(cardId) {
  await db.run('UPDATE cards SET fsrs = ?, state = 0, due = ? WHERE id = ?', newFsrsCard(), Date.now(), cardId);
}

export { Rating, State };
