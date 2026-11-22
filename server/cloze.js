// Cloze notes: text like "{{c1::Paris}} is the capital of {{c2::France::country}}" becomes one card per number.
// All cards of a note share note_id and the same front (cloze text) / back (extra); cloze_ord says which one is hidden.
import crypto from 'node:crypto';
import { db } from './db.js';
import { newFsrsCard } from './scheduler.js';

export function clozeNumbers(text) {
  const nums = new Set();
  for (const m of String(text).matchAll(/\{\{c(\d+)::/g)) if (Number(m[1]) > 0) nums.add(Number(m[1]));
  return [...nums].sort((a, b) => a - b);
}

const insert = db.prepare(`INSERT INTO cards (deck_id, front, back, format, tags, kind, cloze_ord, note_id, state, due, fsrs, created_at, updated_at)
  VALUES (?,?,?,'md',?,'cloze',?,?,0,?,?,?,?)`);

function requireClozes(text) {
  const nums = clozeNumbers(text);
  if (!nums.length) throw new Error('Add at least one cloze, e.g. {{c1::answer}}');
  return nums;
}

export function createClozeNote(deckId, { front, back = '', tags = '' }) {
  const nums = requireClozes(front);
  const noteId = crypto.randomUUID();
  const now = Date.now();
  const ids = db.transaction(() => nums.map((n) => insert.run(deckId, front, back, tags, n, noteId, now, newFsrsCard(), now, now).lastInsertRowid))();
  return { ids, noteId };
}

/** Updates every card of the note, adds cards for new cloze numbers and deletes cards whose number disappeared. */
export function updateClozeNote(noteId, changes) {
  const cards = db.prepare('SELECT * FROM cards WHERE note_id = ?').all(noteId);
  if (!cards.length) throw new Error('Note not found');
  const base = cards[0];
  const front = changes.front ?? base.front;
  const back = changes.back ?? base.back;
  const tags = changes.tags ?? base.tags;
  const deckId = changes.deck_id ?? base.deck_id;
  const nums = requireClozes(front);
  const now = Date.now();
  let added = 0, removed = 0;
  db.transaction(() => {
    db.prepare('UPDATE cards SET front = ?, back = ?, tags = ?, deck_id = ?, updated_at = ? WHERE note_id = ?').run(front, back, tags, deckId, now, noteId);
    const have = new Set(cards.map((c) => c.cloze_ord));
    for (const n of nums) if (!have.has(n)) { insert.run(deckId, front, back, tags, n, noteId, now, newFsrsCard(), now, now); added++; }
    for (const c of cards) if (!nums.includes(c.cloze_ord)) { db.prepare('DELETE FROM cards WHERE id = ?').run(c.id); removed++; }
  })();
  return { added, removed };
}
