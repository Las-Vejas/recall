// Recall deck JSON: a simple format for people and AI agents to create decks.
// See docs/json-format.md. Validation errors carry a path ("decks[0].cards[3].front") so an agent can fix them.
import { db } from './db.js';
import { newFsrsCard } from './scheduler.js';
import { ensureFolderPath } from './folders.js';
import { clozeNumbers, createClozeNote } from './cloze.js';

const MAX_CARDS = 10_000;
const MAX_TEXT = 20_000;
const HEX = /^#[0-9a-f]{6}$/i;
const PALETTE = ['#e5484d', '#ff7a45', '#f5a524', '#3dd68c', '#22c3a6', '#52a9ff', '#8e6cff', '#ff6b9a'];

class FormatError extends Error {
  constructor(errors) {
    super(`Invalid deck JSON:\n${errors.slice(0, 20).map((e) => `- ${e}`).join('\n')}${errors.length > 20 ? `\n- …and ${errors.length - 20} more` : ''}`);
    this.errors = errors;
  }
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : v == null ? '' : null);

function normTags(v, path, errors) {
  if (v == null) return '';
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[\s,]+/) : null;
  if (!list || list.some((t) => typeof t !== 'string')) { errors.push(`${path}: tags must be a list of strings or a space-separated string`); return ''; }
  return list.map((t) => t.trim().replace(/\s+/g, '_')).filter(Boolean).join(' ');
}

function normCard(c, path, errors) {
  if (Array.isArray(c)) {
    if (c.length < 1 || c.length > 2 || c.some((x) => typeof x !== 'string')) { errors.push(`${path}: a short card must be ["front", "back"]`); return null; }
    c = { front: c[0], back: c[1] ?? '' };
  }
  if (!isObj(c)) { errors.push(`${path}: must be an object like {"front": "...", "back": "..."} or {"cloze": "..."}`); return null; }
  const tags = normTags(c.tags, path, errors);
  const tooLong = (s, field) => { if (s.length > MAX_TEXT) { errors.push(`${path}.${field}: longer than ${MAX_TEXT} characters`); return true; } return false; };

  if (c.cloze != null || c.type === 'cloze') {
    const text = str(c.cloze ?? c.text ?? c.front);
    const extra = str(c.extra ?? c.back) ?? null;
    if (!text?.trim()) { errors.push(`${path}.cloze: required, e.g. "The {{c1::answer}} is…"`); return null; }
    if (!clozeNumbers(text).length) { errors.push(`${path}.cloze: needs at least one {{c1::answer}}`); return null; }
    if (extra === null) { errors.push(`${path}.extra: must be a string`); return null; }
    if (tooLong(text, 'cloze') || tooLong(extra, 'extra')) return null;
    return { kind: 'cloze', front: text, back: extra, tags };
  }
  const front = str(c.front), back = str(c.back);
  if (!front?.trim()) { errors.push(`${path}.front: required`); return null; }
  if (back === null) { errors.push(`${path}.back: must be a string`); return null; }
  if (tooLong(front, 'front') || tooLong(back, 'back')) return null;
  return { kind: 'basic', front, back, tags };
}

function normDeck(d, path, errors) {
  if (!isObj(d)) { errors.push(`${path}: must be an object`); return null; }
  const name = str(d.deck ?? d.name);
  if (!name?.trim()) errors.push(`${path}.deck: deck name is required`);
  let folder = d.folder ?? [];
  if (typeof folder === 'string') folder = folder.split('/');
  if (!Array.isArray(folder) || folder.some((f) => typeof f !== 'string')) { errors.push(`${path}.folder: use "Parent/Child" or ["Parent", "Child"]`); folder = []; }
  if (d.color != null && !(typeof d.color === 'string' && HEX.test(d.color))) errors.push(`${path}.color: use a hex colour like "#e5484d"`);
  const npd = d.newPerDay ?? d.new_per_day;
  if (npd != null && !(Number.isInteger(npd) && npd >= 0 && npd <= 9999)) errors.push(`${path}.newPerDay: whole number 0–9999`);
  if (!Array.isArray(d.cards)) { errors.push(`${path}.cards: must be a list`); return null; }
  const cards = d.cards.map((c, i) => normCard(c, `${path}.cards[${i}]`, errors)).filter(Boolean);
  return {
    name: name?.trim() ?? '',
    folder: folder.map((f) => f.trim()).filter(Boolean),
    description: str(d.description) ?? '',
    color: d.color, newPerDay: npd, cards,
  };
}

/** Accepts one deck object, {"decks": [...]}, or a bare array of decks. Throws FormatError with every problem found. */
export function parseDeckJson(input) {
  let data = input;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch (e) { throw new FormatError([`not valid JSON (${e.message})`]); }
  }
  const errors = [];
  let decks;
  if (Array.isArray(data)) decks = data.map((d, i) => normDeck(d, `[${i}]`, errors));
  else if (isObj(data) && Array.isArray(data.decks)) decks = data.decks.map((d, i) => normDeck(d, `decks[${i}]`, errors));
  else if (isObj(data)) decks = [normDeck(data, 'deck', errors)];
  else errors.push('top level must be a deck object, {"decks": [...]}, or a list of decks');
  const total = (decks || []).reduce((a, d) => a + (d?.cards.length || 0), 0);
  if (total > MAX_CARDS) errors.push(`too many cards (${total}); the limit is ${MAX_CARDS} per import`);
  if (!errors.length && !total) errors.push('no cards to import');
  if (errors.length) throw new FormatError(errors);
  return decks;
}

/** Imports parsed decks. Existing decks (same name in the same folder) get only the cards they don't have yet.
 *  A deck with `deckId` adds to that deck (the caller must have checked it belongs to userId). */
export async function importDecks(decks, userId) {
  const results = [];
  const existingCount = (await db.get('SELECT COUNT(*) AS n FROM decks WHERE user_id = ?', userId)).n;
  await db.tx(async () => {
    for (const d of decks) {
      // d.deckId (set by callers that already know the deck, e.g. the MCP add_cards tool) skips the name lookup
      const folderId = d.deckId ? null : d.folder.length ? await ensureFolderPath(d.folder, null, userId) : null;
      let deckId = d.deckId ?? (await db.get('SELECT id FROM decks WHERE name = ? AND folder_id IS ? AND user_id = ?', d.name, folderId, userId))?.id;
      const created = !deckId;
      if (!deckId) {
        const color = d.color ?? PALETTE[(existingCount + results.length) % PALETTE.length];
        deckId = await db.insert('INSERT INTO decks (name, description, color, new_per_day, folder_id, user_id, created_at) VALUES (?,?,?,?,?,?,?)',
          d.name, d.description, color, d.newPerDay ?? 20, folderId, userId, Date.now());
      }
      // duplicate check: same front text (or same cloze text) already in this deck
      const have = new Set((await db.all('SELECT front FROM cards WHERE deck_id = ?', deckId)).map((r) => r.front.trim()));
      let added = 0, skipped = 0;
      const now = Date.now();
      for (const c of d.cards) {
        if (have.has(c.front.trim())) { skipped++; continue; }
        have.add(c.front.trim());
        if (c.kind === 'cloze') added += (await createClozeNote(deckId, c)).ids.length;
        else {
          await db.run(`INSERT INTO cards (deck_id, front, back, format, tags, state, due, fsrs, created_at, updated_at)
            VALUES (?,?,?,'md',?,0,?,?,?,?)`, deckId, c.front, c.back, c.tags, now, newFsrsCard(), now, now);
          added++;
        }
      }
      results.push({ deckId: Number(deckId), deck: d.name, folder: d.folder.join('/') || null, created, added, skipped });
    }
  });
  return { decks: results, added: results.reduce((a, r) => a + r.added, 0), skipped: results.reduce((a, r) => a + r.skipped, 0) };
}
