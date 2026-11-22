import { fsrs, generatorParameters, createEmptyCard, Rating, State } from 'ts-fsrs';
import { db } from './db.js';

const retention = Number(process.env.DESIRED_RETENTION || 0.9);
export const scheduler = fsrs(generatorParameters({ enable_fuzz: true, request_retention: retention }));

const LEARN_AHEAD_MS = 20 * 60 * 1000;

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

export function newRemaining(deckId) {
  const f = deckFilter(deckId, 'id');
  const decks = db.prepare(`SELECT id, new_per_day FROM decks WHERE 1 ${f.sql}`).all(...f.args);
  const today = startOfToday();
  const introduced = db.prepare(
    `SELECT COUNT(*) n FROM reviews WHERE deck_id = ? AND prev_state = 0 AND reviewed_at >= ?`);
  const available = db.prepare(
    `SELECT COUNT(*) n FROM cards WHERE deck_id = ? AND state = 0 AND suspended = 0`);
  let total = 0;
  const perDeck = new Map();
  for (const d of decks) {
    const left = Math.max(0, d.new_per_day - introduced.get(d.id, today).n);
    const n = Math.min(left, available.get(d.id).n);
    perDeck.set(d.id, n);
    total += n;
  }
  return { total, perDeck };
}

export function counts(deckId) {
  const f = deckFilter(deckId);
  const now = Date.now();
  const row = db.prepare(`
    SELECT
      SUM(CASE WHEN state IN (1,3) AND due <= ? THEN 1 ELSE 0 END) learn,
      SUM(CASE WHEN state = 2 AND due <= ? THEN 1 ELSE 0 END) review
    FROM cards c WHERE suspended = 0 ${f.sql}`).get(now + LEARN_AHEAD_MS, now, ...f.args);
  return { new: newRemaining(deckId).total, learn: row.learn || 0, review: row.review || 0 };
}

/** Picks the next card to study, Anki-style: due learning > due review > new > learn-ahead. */
export function nextCard(deckId, excludeId) {
  const f = deckFilter(deckId);
  const now = Date.now();
  const ex = excludeId ? 'AND c.id != ?' : '';
  const exArgs = excludeId ? [excludeId] : [];
  const base = `SELECT c.*, d.name deck_name, d.color deck_color FROM cards c JOIN decks d ON d.id = c.deck_id
                WHERE c.suspended = 0 ${f.sql} ${ex}`;

  let card = db.prepare(`${base} AND c.state IN (1,3) AND c.due <= ? ORDER BY c.due LIMIT 1`).get(...f.args, ...exArgs, now);
  if (!card) card = db.prepare(`${base} AND c.state = 2 AND c.due <= ? ORDER BY c.due LIMIT 1`).get(...f.args, ...exArgs, now);
  if (!card) {
    const { perDeck } = newRemaining(deckId);
    const ids = [...perDeck].filter(([, n]) => n > 0).map(([id]) => id);
    if (ids.length) {
      card = db.prepare(`SELECT c.*, d.name deck_name, d.color deck_color FROM cards c JOIN decks d ON d.id = c.deck_id
        WHERE c.suspended = 0 AND c.state = 0 AND c.deck_id IN (${ids.map(() => '?').join(',')}) ${ex}
        ORDER BY c.id LIMIT 1`).get(...ids, ...exArgs);
    }
  }
  if (!card) card = db.prepare(`${base} AND c.state IN (1,3) AND c.due <= ? ORDER BY c.due LIMIT 1`).get(...f.args, ...exArgs, now + LEARN_AHEAD_MS);
  // if the only remaining card is the excluded one, allow it
  if (!card && excludeId) return nextCard(deckId, null);
  return withPreview(card);
}

export function getStudyCard(id) {
  return withPreview(db.prepare(`SELECT c.*, d.name deck_name, d.color deck_color FROM cards c
    JOIN decks d ON d.id = c.deck_id WHERE c.id = ?`).get(id));
}

function withPreview(card) {
  if (!card) return null;
  const now = Date.now();
  const fc = deserialize(card.fsrs);
  const preview = scheduler.repeat(fc, new Date());
  const intervals = {};
  for (const r of [Rating.Again, Rating.Hard, Rating.Good, Rating.Easy]) {
    intervals[r] = preview[r].card.due.getTime() - now;
  }
  delete card.fsrs;
  return { ...card, intervals, stability: fc.stability, reps: fc.reps, lapses: fc.lapses };
}

export function answer(cardId, rating, durationMs = 0) {
  const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(cardId);
  if (!card) throw new Error('card not found');
  const now = new Date();
  const fc = deserialize(card.fsrs);
  const { card: next } = scheduler.next(fc, now, rating);
  const tx = db.transaction(() => {
    db.exec('DELETE FROM redo_stack'); // a new rating makes earlier undos final, like any editor
    db.prepare(`INSERT INTO reviews (card_id, deck_id, rating, prev_state, prev_fsrs, interval_ms, duration_ms, reviewed_at)
                VALUES (?,?,?,?,?,?,?,?)`)
      .run(card.id, card.deck_id, rating, card.state, card.fsrs, next.due.getTime() - now.getTime(),
        Math.min(durationMs, 5 * 60_000), now.getTime());
    db.prepare('UPDATE cards SET fsrs = ?, state = ?, due = ?, updated_at = ? WHERE id = ?')
      .run(serialize(next), next.state, next.due.getTime(), now.getTime(), card.id);
  });
  tx();
  return { state: next.state, due: next.due.getTime() };
}

export function undoLast(deckId) {
  const f = deckFilter(deckId, 'deck_id');
  const last = db.prepare(`SELECT * FROM reviews WHERE 1 ${f.sql} ORDER BY id DESC LIMIT 1`).get(...f.args);
  if (!last) return null;
  const prev = deserialize(last.prev_fsrs);
  const current = db.prepare('SELECT fsrs, state, due FROM cards WHERE id = ?').get(last.card_id);
  db.transaction(() => {
    if (current) {
      db.prepare('INSERT INTO redo_stack (card_id, deck_id, review, next_fsrs, next_state, next_due) VALUES (?,?,?,?,?,?)')
        .run(last.card_id, last.deck_id, JSON.stringify(last), current.fsrs, current.state, current.due);
    }
    db.prepare('UPDATE cards SET fsrs = ?, state = ?, due = ? WHERE id = ?')
      .run(last.prev_fsrs, last.prev_state, prev.due.getTime(), last.card_id);
    db.prepare('DELETE FROM reviews WHERE id = ?').run(last.id);
  })();
  return last.card_id;
}

/** Re-applies the most recent undo in scope, exactly as it was. Returns the card id, or null if nothing to redo. */
export function redoLast(deckId) {
  const f = deckFilter(deckId, 'deck_id');
  const entry = db.prepare(`SELECT * FROM redo_stack WHERE 1 ${f.sql} ORDER BY id DESC LIMIT 1`).get(...f.args);
  if (!entry) return null;
  const review = JSON.parse(entry.review);
  const card = db.prepare('SELECT fsrs FROM cards WHERE id = ?').get(entry.card_id);
  // only valid if the card is still exactly as the undo left it (not edited, reset or re-rated since)
  if (!card || card.fsrs !== review.prev_fsrs) {
    db.prepare('DELETE FROM redo_stack WHERE id = ?').run(entry.id);
    throw new Error('That card changed since the undo, so it can’t be redone');
  }
  db.transaction(() => {
    db.prepare(`INSERT INTO reviews (id, card_id, deck_id, rating, prev_state, prev_fsrs, interval_ms, duration_ms, reviewed_at)
                VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(review.id, review.card_id, review.deck_id, review.rating, review.prev_state, review.prev_fsrs, review.interval_ms, review.duration_ms, review.reviewed_at);
    db.prepare('UPDATE cards SET fsrs = ?, state = ?, due = ? WHERE id = ?').run(entry.next_fsrs, entry.next_state, entry.next_due, entry.card_id);
    db.prepare('DELETE FROM redo_stack WHERE id = ?').run(entry.id);
  })();
  return entry.card_id;
}

export function forgetCard(cardId) {
  const fsrsJson = newFsrsCard();
  db.prepare('UPDATE cards SET fsrs = ?, state = 0, due = ? WHERE id = ?').run(fsrsJson, Date.now(), cardId);
}

export { Rating, State };
