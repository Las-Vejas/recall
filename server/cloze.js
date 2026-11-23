// Notes: one piece of content that becomes several cards, all sharing a note_id.
// - cloze: text like "{{c1::Paris}} is the capital of {{c2::France::country}}", one card per number.
//   front = the cloze text, back = optional extra, cloze_ord = which number this card hides.
// - occlusion: an image with boxes drawn over it, one card per box number (boxes can share a number to be
//   tested together). front = JSON {image, mode, masks: [{x, y, w, h, n}]} with coordinates as fractions
//   of the image (0–1), back = optional extra, cloze_ord = which box number this card hides.
import crypto from 'node:crypto';
import { db } from './db.js';
import { newFsrsCard } from './scheduler.js';

export const NOTE_KINDS = ['cloze', 'occlusion'];

export function clozeNumbers(text) {
  const nums = new Set();
  for (const m of String(text).matchAll(/\{\{c(\d+)::/g)) if (Number(m[1]) > 0) nums.add(Number(m[1]));
  return [...nums].sort((a, b) => a - b);
}

const MAX_MASKS = 200;
const fraction = (v) => Math.round(Math.min(1, Math.max(0, v)) * 10_000) / 10_000;

/** Validates and normalises image occlusion data (object or JSON string). Throws with a readable message. */
export function parseOcclusion(src) {
  let o = src;
  if (typeof o === 'string') {
    try { o = JSON.parse(o); } catch { throw new Error('Image occlusion data is not valid JSON'); }
  }
  if (!o || typeof o !== 'object') throw new Error('Image occlusion data must be an object');
  // only images uploaded to this Recall: no hotlinking (which would leak who studies what, and when)
  if (typeof o.image !== 'string' || !/^\/media\/[\w./-]+$/.test(o.image) || o.image.includes('..')) {
    throw new Error('Image occlusion needs an image uploaded to Recall');
  }
  if (!Array.isArray(o.masks) || !o.masks.length) throw new Error('Draw at least one box over the image');
  if (o.masks.length > MAX_MASKS) throw new Error(`At most ${MAX_MASKS} boxes per image`);
  const masks = o.masks.map((m, i) => {
    const nums = [m?.x, m?.y, m?.w, m?.h];
    if (!nums.every((v) => typeof v === 'number' && Number.isFinite(v))) throw new Error(`Box ${i + 1} needs numeric x, y, w and h`);
    const x = fraction(m.x), y = fraction(m.y);
    const w = fraction(Math.min(m.w, 1 - x)), h = fraction(Math.min(m.h, 1 - y));
    if (w <= 0 || h <= 0) throw new Error(`Box ${i + 1} has no size`);
    return { x, y, w, h, n: Number.isInteger(m.n) && m.n > 0 ? m.n : i + 1 };
  });
  return { image: o.image, mode: o.mode === 'all' ? 'all' : 'one', masks };
}

export const occlusionNumbers = (front) => [...new Set(parseOcclusion(front).masks.map((m) => m.n))].sort((a, b) => a - b);

/** The card numbers a note produces, and its front as stored. Throws if the note can't make any cards. */
function prepare(kind, front) {
  if (kind === 'occlusion') {
    const data = parseOcclusion(front);
    return { front: JSON.stringify(data), nums: [...new Set(data.masks.map((m) => m.n))].sort((a, b) => a - b) };
  }
  const nums = clozeNumbers(front);
  if (!nums.length) throw new Error('Add at least one cloze, e.g. {{c1::answer}}');
  return { front, nums };
}

const INSERT = `INSERT INTO cards (deck_id, front, back, format, tags, kind, cloze_ord, note_id, state, due, fsrs, created_at, updated_at)
  VALUES (?,?,?,'md',?,?,?,?,0,?,?,?,?)`;

export async function createNote(kind, deckId, { front, back = '', tags = '' }) {
  if (!NOTE_KINDS.includes(kind)) throw new Error(`Unknown note kind: ${kind}`);
  const p = prepare(kind, front);
  const noteId = crypto.randomUUID();
  const now = Date.now();
  const ids = await db.tx(async () => {
    const out = [];
    for (const n of p.nums) out.push(await db.insert(INSERT, deckId, p.front, back, tags, kind, n, noteId, now, newFsrsCard(), now, now));
    return out;
  });
  return { ids, noteId };
}
export const createClozeNote = (deckId, fields) => createNote('cloze', deckId, fields);

/** Updates every card of the note, adds cards for new numbers and deletes cards whose number disappeared. */
export async function updateNote(noteId, changes) {
  return db.tx(async () => {
    const cards = await db.all('SELECT * FROM cards WHERE note_id = ?', noteId);
    if (!cards.length) throw new Error('Note not found');
    const base = cards[0];
    const p = prepare(base.kind, changes.front ?? base.front);
    const back = changes.back ?? base.back;
    const tags = changes.tags ?? base.tags;
    const deckId = changes.deck_id ?? base.deck_id;
    const now = Date.now();
    let added = 0, removed = 0;
    await db.run('UPDATE cards SET front = ?, back = ?, tags = ?, deck_id = ?, updated_at = ? WHERE note_id = ?', p.front, back, tags, deckId, now, noteId);
    const have = new Set(cards.map((c) => c.cloze_ord));
    for (const n of p.nums) if (!have.has(n)) { await db.run(INSERT, deckId, p.front, back, tags, base.kind, n, noteId, now, newFsrsCard(), now, now); added++; }
    for (const c of cards) if (!p.nums.includes(c.cloze_ord)) { await db.run('DELETE FROM cards WHERE id = ?', c.id); removed++; }
    return { added, removed };
  });
}
export const updateClozeNote = updateNote;
