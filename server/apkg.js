// Importer for Anki .apkg / .colpkg packages (legacy schema 11 and modern schema 18 / zstd).
import AdmZip from 'adm-zip';
import Database from 'better-sqlite3';
import { decompress } from 'fzstd';
import crypto from 'node:crypto';
import { db } from './db.js';
import { putMedia } from './media.js';
import { newFsrsCard } from './scheduler.js';
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
  const cards = col.prepare('SELECT id, nid, did, ord, queue, type, due, flags FROM cards ORDER BY type, due, nid, ord').all();

  const now = Date.now();
  const deckIdMap = new Map();
  const INS_CARD = `INSERT INTO cards (deck_id, front, back, format, tags, css, suspended, flagged, state, due, fsrs, created_at, updated_at)
                    VALUES (?,?,?,?,?,?,?,?,0,?,?,?,?)`;
  const existingCount = (await db.get('SELECT COUNT(*) AS n FROM decks WHERE user_id = ?', userId)).n;
  let imported = 0, skipped = 0;

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
      await db.run(INS_CARD, deckId, rewriteMedia(q, mediaPrefix, available), rewriteMedia(a, mediaPrefix, available), 'html',
        note.tags.trim(), nt.css, c.queue === -1 ? 1 : 0, (c.flags & 7) ? 1 : 0, now, newFsrsCard(new Date(now)), now, now);
      imported++;
    }
  });
  col.close();
  return { imported, skipped, decks: deckIdMap.size, media: available.size };
}
