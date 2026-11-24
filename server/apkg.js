// Importer for Anki .apkg / .colpkg packages (legacy schema 11 and modern schema 18 / zstd).
import AdmZip from 'adm-zip';
import Database from 'better-sqlite3';
import { decompress } from 'fzstd';
import crypto from 'node:crypto';
import { db } from './db.js';
import { putMedia } from './media.js';
import { newFsrsCard, replayReviews, serialize } from './scheduler.js';
import { ensureFolderPath, splitAnkiName } from './folders.js';

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
const isZstd = (b) => b.length > 4 && ZSTD_MAGIC.every((v, i) => b[i] === v);
const unz = (b) => (isZstd(b) ? Buffer.from(decompress(new Uint8Array(b))) : b);

// ---- minimal protobuf reader (enough for Anki's config blobs) ----
function readVarint(buf, pos) {
  let result = 0n, shift = 0n, b;
  do {
    b = buf[pos++];
    result |= BigInt(b & 0x7f) << shift;
    shift += 7n;
  } while (b & 0x80);
  return [Number(result), pos];
}
function pbFields(buf) {
  const out = {};
  let pos = 0;
  while (pos < buf.length) {
    let key;
    [key, pos] = readVarint(buf, pos);
    const field = key >>> 3, wire = key & 7;
    let val;
    if (wire === 0) [val, pos] = readVarint(buf, pos);
    else if (wire === 2) {
      let len;
      [len, pos] = readVarint(buf, pos);
      val = buf.subarray(pos, pos + len);
      pos += len;
    } else if (wire === 1) { val = buf.subarray(pos, pos + 8); pos += 8; }
    else if (wire === 5) { val = buf.subarray(pos, pos + 4); pos += 4; }
    else break;
    (out[field] ||= []).push(val);
  }
  return out;
}
const pbStr = (f, n) => (f[n]?.[0] ? Buffer.from(f[n][0]).toString('utf8') : '');

// ---- template rendering ----
const stripHtml = (s) => s.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ');

function renderCloze(text, ord, side) {
  const n = ord + 1;
  return text.replace(/\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g, (_, num, body, hint) => {
    if (Number(num) !== n) return body;
    if (side === 'q') return `<span class="cloze">[${hint || '…'}]</span>`;
    return `<span class="cloze">${body}</span>`;
  });
}

function renderTemplate(tmpl, fields, { ord, side, frontSide }) {
  let out = tmpl;
  // sections: {{#Field}}..{{/Field}} and {{^Field}}..{{/Field}} (repeat for nesting)
  for (let i = 0; i < 5; i++) {
    const before = out;
    out = out.replace(/\{\{([#^])([^}]+)\}\}([\s\S]*?)\{\{\/\2\}\}/g, (_, kind, name, inner) => {
      const key = name.trim().split(':').pop();
      const v = fields[key] ?? '';
      const present = stripHtml(v).trim().length > 0;
      return (kind === '#' ? present : !present) ? inner : '';
    });
    if (out === before) break;
  }
  out = out.replace(/\{\{([^}]+)\}\}/g, (_, raw) => {
    const spec = raw.trim();
    if (spec === 'FrontSide') return frontSide || '';
    if (spec.startsWith('tts') || spec.startsWith('type:')) return '';
    const parts = spec.split(':');
    const name = parts.pop();
    const filters = parts;
    let v = fields[name] ?? '';
    if (filters.includes('cloze')) v = renderCloze(v, ord, side);
    if (filters.includes('text')) v = stripHtml(v);
    if (filters.includes('hint')) v = `<details class="hint"><summary>Hint</summary>${v}</details>`;
    if (filters.includes('furigana') || filters.includes('kanji'))
      v = v.replace(/ ?([^ >]+?)\[(.+?)\]/g, '<ruby>$1<rt>$2</rt></ruby>');
    return v;
  });
  return out;
}

function rewriteMedia(html, mediaPrefix, available) {
  const url = (name) => `/media/${mediaPrefix}/${encodeURIComponent(name)}`;
  html = html.replace(/(<(?:img|audio|video|source)[^>]*?\ssrc=)(["']?)([^"'\s>]+)\2/gi, (m, pre, q, src) => {
    if (/^(https?:|data:|\/)/i.test(src)) return m;
    const name = decodeURIComponent(src);
    return available.has(name) ? `${pre}"${url(name)}"` : m;
  });
  html = html.replace(/\[sound:([^\]]+)\]/g, (_, name) =>
    available.has(name) ? `<audio controls preload="none" src="${url(name)}"></audio>` : '');
  return html;
}

// ---- reading the collection ----
function loadNotetypes(col) {
  const types = new Map();
  const hasNotetypesTable = col.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='notetypes'`).get();
  if (hasNotetypesTable) {
    for (const nt of col.prepare('SELECT id, name, config FROM notetypes').all()) {
      const cfg = pbFields(nt.config);
      types.set(String(nt.id), {
        name: nt.name,
        cloze: (cfg[1]?.[0] ?? 0) === 1,
        css: pbStr(cfg, 3),
        fields: col.prepare('SELECT name FROM fields WHERE ntid = ? ORDER BY ord').all(nt.id).map((f) => f.name),
        templates: col.prepare('SELECT ord, name, config FROM templates WHERE ntid = ? ORDER BY ord').all(nt.id)
          .map((t) => { const c = pbFields(t.config); return { ord: t.ord, qfmt: pbStr(c, 1), afmt: pbStr(c, 2) }; }),
      });
    }
  }
  if (!types.size) {
    const models = JSON.parse(col.prepare('SELECT models FROM col').get().models || '{}');
    for (const [id, m] of Object.entries(models)) {
      types.set(String(id), {
        name: m.name,
        cloze: m.type === 1,
        css: m.css || '',
        fields: [...m.flds].sort((a, b) => a.ord - b.ord).map((f) => f.name),
        templates: m.tmpls.map((t) => ({ ord: t.ord, qfmt: t.qfmt, afmt: t.afmt })),
      });
    }
  }
  return types;
}

function loadDeckNames(col) {
  const names = new Map();
  const hasDecks = col.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='decks'`).get();
  if (hasDecks) {
    for (const d of col.prepare('SELECT id, name FROM decks').all()) names.set(String(d.id), d.name.replaceAll('\x1f', '::'));
  }
  if (!names.size) {
    const decks = JSON.parse(col.prepare('SELECT decks FROM col').get().decks || '{}');
    for (const [id, d] of Object.entries(decks)) names.set(String(id), d.name);
  }
  return names;
}

function loadMediaMap(zip) {
  const entry = zip.getEntry('media');
  if (!entry) return [];
  const raw = unz(entry.getData());
  const text = raw.toString('utf8').trim();
  if (text.startsWith('{')) return Object.entries(JSON.parse(text)).map(([zipName, name]) => ({ zipName, name }));
  // modern: protobuf MediaEntries { repeated MediaEntry entries = 1 { string name = 1; ... uint32 legacy_zip_filename = 255 } }
  const top = pbFields(raw);
  return (top[1] || []).map((e, i) => {
    const f = pbFields(e);
    return { zipName: String(f[255]?.[0] ?? i), name: pbStr(f, 1) };
  });
}

const DAY = 86_400_000;

/** Review history per Anki card id, oldest first, as replayReviews() input. Skips manual reschedules. */
function loadRevlog(col) {
  const hasRevlog = col.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='revlog'`).get();
  const byCard = new Map();
  if (!hasRevlog) return byCard;
  for (const r of col.prepare('SELECT id, cid, ease, ivl, time, type FROM revlog ORDER BY id').all()) {
    let entry;
    if (r.type === 4 || r.ease === 0) {
      // "manual": a reschedule or a reset. ivl 0 means the card went back to new.
      if (r.ivl !== 0) continue;
      entry = { reset: true, at: r.id };
    } else if (r.ease >= 1 && r.ease <= 4) {
      entry = { rating: r.ease, at: r.id, duration_ms: Math.min(Math.max(0, r.time || 0), 5 * 60_000) };
    } else continue;
    let list = byCard.get(r.cid);
    if (!list) byCard.set(r.cid, (list = []));
    list.push(entry);
  }
  return byCard;
}

/**
 * The FSRS card for an imported Anki card: memory state replayed from its reviews, due date as Anki has it
 * (so nothing suddenly falls due or disappears), and Anki's type for learning/review.
 */
function scheduleFromAnki(c, reviews, crtSec, now) {
  const created = reviews.length ? reviews[0].at : now;
  const { card, log } = replayReviews(reviews, created);
  if (c.type === 0) return { fsrs: newFsrsCard(new Date(now)), state: 0, due: now, log };
  let due;
  if (c.type === 2) due = (crtSec * 1000) + c.due * DAY; // review: day number since the collection was created
  else due = c.due > 1e9 ? c.due * 1000 : (crtSec * 1000) + c.due * DAY; // learning: a timestamp, or a day for day-learning
  const state = c.type === 3 ? 3 : c.type === 1 ? 1 : 2;
  if (!log.length) {
    // scheduled but no history in the package: estimate memory from the current interval
    const ivl = Math.max(1, c.ivl || 1);
    Object.assign(card, { stability: ivl, difficulty: 5, reps: c.reps || 1, lapses: c.lapses || 0, last_review: new Date(due - ivl * DAY) });
  }
  Object.assign(card, { state, due: new Date(due), scheduled_days: state === 2 ? Math.max(1, c.ivl || 1) : 0 });
  if (card.stability <= 0) card.stability = 0.5;
  return { fsrs: serialize(card), state, due, log };
}

const PALETTE = ['#7c5cff', '#ff6b9a', '#22c3a6', '#ffb020', '#4aa8ff', '#ff7a45', '#a3e635'];

export async function importApkg(buffer, { originalName = 'import', userId } = {}) {
  const zip = new AdmZip(buffer);
  const colEntry = ['collection.anki21b', 'collection.anki21', 'collection.anki2'].map((n) => zip.getEntry(n)).find(Boolean);
  if (!colEntry) throw new Error('Not an Anki package: no collection file found');
  const col = new Database(unz(colEntry.getData()), { readonly: true });

  const notetypes = loadNotetypes(col);
  const deckNames = loadDeckNames(col);

  // media: stored in the database under <prefix>/<name>
  const mediaPrefix = crypto.randomBytes(6).toString('hex');
  const available = new Set();
  for (const { zipName, name } of loadMediaMap(zip)) {
    const e = zip.getEntry(zipName);
    if (!e || !name || name.includes('/') || name.includes('..')) continue;
    await putMedia(`${mediaPrefix}/${name}`, unz(e.getData()), userId);
    available.add(name);
  }

  const notes = new Map(col.prepare('SELECT id, mid, flds, tags FROM notes').all().map((n) => [n.id, n]));
  const cards = col.prepare('SELECT id, nid, did, ord, queue, type, due, ivl, reps, lapses, flags FROM cards ORDER BY type, due, nid, ord').all();
  const crtSec = col.prepare('SELECT crt FROM col').get()?.crt || Math.floor(Date.now() / 1000);
  const revlog = loadRevlog(col);

  const now = Date.now();
  const deckIdMap = new Map();
  const INS_CARD = `INSERT INTO cards (deck_id, front, back, format, tags, css, suspended, flagged, state, due, fsrs, created_at, updated_at)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`;
  const existingCount = (await db.get('SELECT COUNT(*) AS n FROM decks WHERE user_id = ?', userId)).n;
  let imported = 0, skipped = 0, scheduled = 0;
  const reviewRows = [];

  await db.tx(async () => {
    for (const c of cards) {
      const note = notes.get(c.nid);
      const nt = note && notetypes.get(String(note.mid));
      if (!nt) { skipped++; continue; }
      const values = note.flds.split('\x1f');
      const fields = Object.fromEntries(nt.fields.map((name, i) => [name, values[i] ?? '']));
      const tmpl = nt.cloze ? nt.templates[0] : nt.templates.find((t) => t.ord === c.ord);
      if (!tmpl) { skipped++; continue; }
      const q = renderTemplate(tmpl.qfmt, fields, { ord: c.ord, side: 'q' });
      if (!stripHtml(q).trim() && !/<img|\[sound:/i.test(q)) { skipped++; continue; } // empty card
      const a = renderTemplate(tmpl.afmt, fields, { ord: c.ord, side: 'a', frontSide: q });

      let deckId = deckIdMap.get(c.did);
      if (!deckId) {
        const fullName = deckNames.get(String(c.did)) || originalName.replace(/\.(apkg|colpkg)$/i, '');
        const { folders, deck: name } = splitAnkiName(fullName);
        const folderId = await ensureFolderPath(folders, null, userId);
        const color = PALETTE[(existingCount + deckIdMap.size) % PALETTE.length];
        deckId = await db.insert('INSERT INTO decks (name, description, color, folder_id, user_id, created_at) VALUES (?,?,?,?,?,?)',
          name, `Imported from ${originalName}`, color, folderId, userId, now);
        deckIdMap.set(c.did, deckId);
      }
      const s = scheduleFromAnki(c, revlog.get(c.id) || [], crtSec, now);
      const cardId = await db.insert(INS_CARD, deckId, rewriteMedia(q, mediaPrefix, available), rewriteMedia(a, mediaPrefix, available), 'html',
        note.tags.trim(), nt.css, c.queue === -1 ? 1 : 0, (c.flags & 7) ? 1 : 0, s.state, s.due, s.fsrs, now, now);
      for (const r of s.log) reviewRows.push([userId, cardId, deckId, r.rating, r.prev_state, r.prev_fsrs, r.interval_ms, r.duration_ms || 0, r.at]);
      if (s.state !== 0) scheduled++;
      imported++;
    }
    // review history, many rows per statement (a big collection has hundreds of thousands)
    for (let i = 0; i < reviewRows.length; i += 200) {
      const chunk = reviewRows.slice(i, i + 200);
      await db.run(`INSERT INTO reviews (user_id, card_id, deck_id, rating, prev_state, prev_fsrs, interval_ms, duration_ms, reviewed_at, imported)
        VALUES ${chunk.map(() => '(?,?,?,?,?,?,?,?,?,1)').join(',')}`, ...chunk.flat());
    }
  });
  col.close();
  return { imported, skipped, decks: deckIdMap.size, media: available.size, scheduled, reviews: reviewRows.length };
}
