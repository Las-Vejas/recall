// Getting data out: decks as Recall JSON (the import format) or as an Anki package, and a full
// per-user export (every table row the user owns, plus media) as a zip.
import AdmZip from 'adm-zip';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import { marked } from 'marked';
import { db } from './db.js';
import { startOfToday } from './scheduler.js';

const DAY = 86_400_000;
const MEDIA_REF = /\/media\/([\w./%-]+)/g;

/** Folder path (names from the root) for every folder id the user owns. */
async function folderPaths(userId) {
  const rows = await db.all('SELECT id, name, parent_id FROM folders WHERE user_id = ?', userId);
  const byId = new Map(rows.map((f) => [f.id, f]));
  const pathOf = (id) => {
    const out = [];
    for (let f = byId.get(id), guard = 0; f && guard < 100; f = byId.get(f.parent_id), guard++) out.unshift(f.name);
    return out;
  };
  return (id) => (id == null ? [] : pathOf(id));
}

async function loadDecks(deckIds, userId) {
  if (!deckIds.length) return [];
  const decks = await db.all(`SELECT * FROM decks WHERE user_id = ? AND id IN (${deckIds.map(() => '?').join(',')}) ORDER BY id`, userId, ...deckIds);
  for (const d of decks) d.cards = await db.all('SELECT * FROM cards WHERE deck_id = ? ORDER BY id', d.id);
  return decks;
}

/** Cards grouped into notes: a cloze or occlusion note is one entry with all its cards. */
function notesOf(cards) {
  const notes = [];
  const byNote = new Map();
  for (const c of cards) {
    if (c.note_id && (c.kind === 'cloze' || c.kind === 'occlusion')) {
      let n = byNote.get(c.note_id);
      if (!n) { n = { kind: c.kind, cards: [] }; byNote.set(c.note_id, n); notes.push(n); }
      n.cards.push(c);
    } else notes.push({ kind: c.kind || 'basic', cards: [c] });
  }
  return notes;
}

const tagList = (s) => String(s || '').split(/\s+/).filter(Boolean);

// ---------------- Recall JSON ----------------

/** Decks in the Recall deck JSON format (docs/json-format.md), so the file imports straight back in. */
export async function exportJson(deckIds, userId) {
  const pathOf = await folderPaths(userId);
  const decks = await loadDecks(deckIds, userId);
  let skipped = 0;
  const out = decks.map((d) => {
    const cards = [];
    for (const n of notesOf(d.cards)) {
      const c = n.cards[0];
      const tags = tagList(c.tags);
      const extra = tags.length ? { tags } : {};
      if (n.kind === 'occlusion') { skipped += n.cards.length; continue; } // no JSON shape for image occlusion yet
      if (n.kind === 'cloze') cards.push({ cloze: c.front, extra: c.back, ...extra });
      else if (n.kind === 'typein') cards.push({ front: c.front, back: c.back, typeIn: true, ...extra });
      else cards.push({ front: c.front, back: c.back, ...extra });
    }
    const folder = pathOf(d.folder_id);
    return { deck: d.name, ...(folder.length ? { folder: folder.join('/') } : {}), description: d.description, color: d.color, newPerDay: d.new_per_day, cards };
  });
  return { decks: out, ...(skipped ? { notExported: { imageOcclusionCards: skipped, reason: 'The JSON format has no image occlusion cards yet; use the Anki export or the full data export.' } } : {}) };
}

// ---------------- Anki .apkg ----------------

const ANKI_SCHEMA = `
CREATE TABLE col (id integer primary key, crt integer not null, mod integer not null, scm integer not null, ver integer not null,
  dty integer not null, usn integer not null, ls integer not null, conf text not null, models text not null, decks text not null,
  dconf text not null, tags text not null);
CREATE TABLE notes (id integer primary key, guid text not null, mid integer not null, mod integer not null, usn integer not null,
  tags text not null, flds text not null, sfld integer not null, csum integer not null, flags integer not null, data text not null);
CREATE TABLE cards (id integer primary key, nid integer not null, did integer not null, ord integer not null, mod integer not null,
  usn integer not null, type integer not null, queue integer not null, due integer not null, ivl integer not null, factor integer not null,
  reps integer not null, lapses integer not null, left integer not null, odue integer not null, odid integer not null, flags integer not null,
  data text not null);
CREATE TABLE revlog (id integer primary key, cid integer not null, usn integer not null, ease integer not null, ivl integer not null,
  lastIvl integer not null, factor integer not null, time integer not null, type integer not null);
CREATE TABLE graves (usn integer not null, oid integer not null, type integer not null);
CREATE INDEX ix_notes_csum on notes (csum);
CREATE INDEX ix_cards_nid on cards (nid);
CREATE INDEX ix_cards_sched on cards (did, queue, due);
CREATE INDEX ix_revlog_cid on revlog (cid);
`;

const BASE_CSS = '.card { font-family: arial; font-size: 20px; text-align: center; color: black; background-color: white; }\n.cloze { font-weight: bold; color: blue; }\n.occ { position: relative; display: inline-block; }\n.occ img { display: block; max-width: 100%; }\n.occ div { position: absolute; box-sizing: border-box; border-radius: 4px; }\n.occ .target { background: #e5484d; color: #fff; display: flex; align-items: center; justify-content: center; font-weight: bold; }\n.occ .other { background: #f5a524; }\n.occ .revealed { border: 3px solid #e5484d; }';
const stripHtml = (s) => s.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const checksum = (s) => parseInt(crypto.createHash('sha1').update(stripHtml(s)).digest('hex').slice(0, 8), 16);
const guid = () => crypto.randomBytes(8).toString('base64url');

/** Our card text → the HTML Anki shows. Markdown is rendered; imported Anki HTML is passed through. */
const toHtml = (text, format) => (format === 'html' ? text : marked.parse(String(text || ''), { async: false, breaks: true, gfm: true }));

function occlusionHtml(front, ord, side) {
  let o;
  try { o = JSON.parse(front); } catch { return ''; }
  const pct = (v) => `${(v * 100).toFixed(3)}%`;
  const masks = (o.masks || []).map((m) => {
    const target = m.n === ord;
    if (!target && o.mode !== 'all') return '';
    const cls = !target ? 'other' : side === 'q' ? 'target' : 'revealed';
    return `<div class="${cls}" style="left:${pct(m.x)};top:${pct(m.y)};width:${pct(m.w)};height:${pct(m.h)}">${target && side === 'q' ? '?' : ''}</div>`;
  }).join('');
  return `<div class="occ"><img src="${o.image}">${masks}</div>`;
}

/** Anki scheduling fields for one of our cards (FSRS state → Anki's card columns). */
function ankiSchedule(c, todayIdx, crtSec, newPos) {
  let f = {};
  try { f = JSON.parse(c.fsrs); } catch { /* new card */ }
  const queueOf = (q) => (c.suspended ? -1 : q);
  const flags = c.flagged ? 1 : 0;
  const reps = f.reps || 0, lapses = f.lapses || 0;
  if (c.state === 0) return { type: 0, queue: queueOf(0), due: newPos, ivl: 0, reps: 0, lapses: 0, left: 0, flags, data: '{}' };
  const memory = JSON.stringify({ s: Number(f.stability?.toFixed?.(4) ?? 0), d: Number(f.difficulty?.toFixed?.(4) ?? 5) });
  if (c.state === 2) {
    const due = todayIdx + Math.floor((Number(c.due) - startOfToday()) / DAY);
    return { type: 2, queue: queueOf(2), due, ivl: Math.max(1, Math.round(f.scheduled_days || 1)), reps, lapses, left: 0, flags, data: memory };
  }
  // learning (1) or relearning (3): due is a timestamp in seconds; one step left
  return { type: c.state === 3 ? 3 : 1, queue: queueOf(1), due: Math.max(crtSec, Math.floor(Number(c.due) / 1000)), ivl: 0, reps, lapses, left: 1001, flags, data: memory };
}

/** An Anki package (.apkg, legacy schema 11, which every Anki version imports) with scheduling and review history. */
export async function exportApkg(deckIds, userId) {
  const pathOf = await folderPaths(userId);
  const decks = await loadDecks(deckIds, userId);
  const col = new Database(':memory:');
  col.exec(ANKI_SCHEMA);

  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  // collection "created" ten years ago, so review due days are positive day numbers
  const crtSec = Math.floor(startOfToday() / 1000) - 3650 * 86_400;
  const todayIdx = 3650;
  let nextId = nowMs; // note and card ids are millisecond timestamps in Anki; any unique increasing number works
  const id = () => nextId++;

  // note types: one per (kind, css) so imported Anki styling survives the round trip
  const models = {};
  const modelFor = (kind, css) => {
    const key = `${kind}|${css}`;
    if (models[key]) return models[key];
    const mid = id();
    const cloze = kind === 'cloze';
    const fields = cloze ? ['Text', 'Back Extra'] : ['Front', 'Back'];
    const tmpl = cloze
      ? { name: 'Cloze', qfmt: '{{cloze:Text}}', afmt: '{{cloze:Text}}<br>\n{{Back Extra}}' }
      : kind === 'typein'
        ? { name: 'Card 1', qfmt: '{{Front}}\n\n{{type:Back}}', afmt: '{{Front}}\n\n<hr id=answer>\n\n{{type:Back}}' }
        : { name: 'Card 1', qfmt: '{{Front}}', afmt: '{{FrontSide}}\n\n<hr id=answer>\n\n{{Back}}' };
    const label = { basic: 'Basic', typein: 'Basic (type in the answer)', cloze: 'Cloze', occlusion: 'Image occlusion' }[kind] || 'Basic';
    const n = Object.keys(models).filter((k) => k.startsWith(`${kind}|`)).length;
    models[key] = {
      id: mid, name: `Recall ${label}${n ? ` ${n + 1}` : ''}`, type: cloze ? 1 : 0, mod: nowSec, usn: -1, sortf: 0, did: 1,
      tmpls: [{ ...tmpl, ord: 0, did: null, bqfmt: '', bafmt: '' }],
      flds: fields.map((name, ord) => ({ name, ord, sticky: false, rtl: false, font: 'Arial', size: 20, media: [] })),
      css: css ? `${BASE_CSS}\n${css}` : BASE_CSS,
      latexPre: '\\documentclass[12pt]{article}\n\\special{papersize=3in,5in}\n\\usepackage[utf8]{inputenc}\n\\usepackage{amssymb,amsmath}\n\\pagestyle{empty}\n\\setlength{\\parindent}{0in}\n\\begin{document}\n',
      latexPost: '\\end{document}', req: [[0, 'any', [0]]], tags: [], vers: [],
    };
    return models[key];
  };

  // media: our /media/<key> URLs become plain file names inside the package
  const mediaKeys = new Map(); // key -> file name in the package
  const fileName = (key) => {
    let name = mediaKeys.get(key);
    if (!name) { name = decodeURIComponent(key).replace(/[/\\]/g, '_'); mediaKeys.set(key, name); }
    return name;
  };
  const rewrite = (html) => html.replace(MEDIA_REF, (_, key) => fileName(key));

  const ankiDecks = {
    1: { id: 1, name: 'Default', desc: '', mod: nowSec, usn: -1, collapsed: false, newToday: [0, 0], revToday: [0, 0], lrnToday: [0, 0], timeToday: [0, 0], dyn: 0, conf: 1, extendNew: 10, extendRev: 50 },
  };
  const insNote = col.prepare('INSERT INTO notes VALUES (?,?,?,?,?,?,?,?,?,0,\'\')');
  const insCard = col.prepare('INSERT INTO cards VALUES (?,?,?,?,?,-1,?,?,?,?,2500,?,?,?,0,0,?,?)');
  const insRev = col.prepare('INSERT OR IGNORE INTO revlog VALUES (?,?,-1,?,?,0,?,?,?)');
  const cardIdMap = new Map(); // our id -> anki id
  let newPos = 1, notesOut = 0, cardsOut = 0;

  for (const d of decks) {
    const did = id();
    ankiDecks[did] = { ...ankiDecks[1], id: did, name: [...pathOf(d.folder_id), d.name].join('::'), desc: d.description || '' };
    for (const n of notesOf(d.cards)) {
      const first = n.cards[0];
      const tags = tagList(first.tags).join(' ');
      const tagField = tags ? ` ${tags} ` : '';
      if (n.kind === 'occlusion') {
        // Anki's own image occlusion type is version-specific; each box becomes a plain front/back card instead
        for (const c of n.cards) {
          const q = rewrite(occlusionHtml(c.front, c.cloze_ord, 'q'));
          const a = rewrite(occlusionHtml(c.front, c.cloze_ord, 'a')) + (c.back ? `<br>${rewrite(toHtml(c.back, 'md'))}` : '');
          const m = modelFor('occlusion', '');
          const nid = id();
          insNote.run(nid, guid(), m.id, nowSec, -1, tagField, `${q}\x1f${a}`, stripHtml(q) || '[image]', checksum(q));
          writeCard(c, nid, did, 0);
          notesOut++;
        }
        continue;
      }
      const m = modelFor(n.kind === 'cloze' ? 'cloze' : n.kind === 'typein' ? 'typein' : 'basic', first.format === 'html' ? first.css : '');
      const front = rewrite(toHtml(first.front, first.format));
      const back = n.kind === 'typein' ? first.back : rewrite(toHtml(first.back, first.format)); // {{type:Back}} compares plain text
      const nid = id();
      insNote.run(nid, guid(), m.id, nowSec, -1, tagField, `${front}\x1f${back}`, stripHtml(front), checksum(front));
      notesOut++;
      for (const c of n.cards) writeCard(c, nid, did, n.kind === 'cloze' ? Math.max(0, (c.cloze_ord || 1) - 1) : 0);
    }
  }

  function writeCard(c, nid, did, ord) {
    const s = ankiSchedule(c, todayIdx, crtSec, newPos);
    if (c.state === 0) newPos++;
    const cid = id();
    cardIdMap.set(c.id, cid);
    insCard.run(cid, nid, did, ord, nowSec, s.type, s.queue, s.due, s.ivl, s.reps, s.lapses, s.left, s.flags, s.data);
    cardsOut++;
  }

  // review history: Anki's revlog id is the review time in ms, so nudge duplicates forward by a millisecond
  let reviewsOut = 0;
  if (cardIdMap.size) {
    const ids = [...cardIdMap.keys()];
    const seen = new Set();
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const rows = await db.all(`SELECT card_id, rating, prev_state, interval_ms, duration_ms, reviewed_at FROM reviews
        WHERE card_id IN (${chunk.map(() => '?').join(',')}) ORDER BY reviewed_at`, ...chunk);
      for (const r of rows) {
        let rid = Number(r.reviewed_at);
        while (seen.has(rid)) rid++;
        seen.add(rid);
        const ivlMs = Number(r.interval_ms);
        const ivl = ivlMs >= DAY ? Math.round(ivlMs / DAY) : -Math.max(1, Math.round(ivlMs / 1000));
        const type = r.prev_state === 2 ? 1 : r.prev_state === 3 ? 2 : 0;
        insRev.run(rid, cardIdMap.get(r.card_id), r.rating, ivl, 2500, Math.min(Number(r.duration_ms) || 0, 60_000), type);
        reviewsOut++;
      }
    }
  }

  const dconf = { 1: {
    id: 1, name: 'Default', mod: 0, usn: 0, maxTaken: 60, autoplay: true, timer: 0, replayq: true, dyn: false,
    new: { delays: [1, 10], ints: [1, 4, 7], initialFactor: 2500, perDay: 20, order: 1, bury: true, separate: true },
    rev: { perDay: 200, ease4: 1.3, fuzz: 0.05, maxIvl: 36500, ivlFct: 1, bury: true, hardFactor: 1.2 },
    lapse: { delays: [10], mult: 0, minInt: 1, leechFails: 8, leechAction: 0 },
  } };
  const modelsById = Object.fromEntries(Object.values(models).map((m) => [m.id, m]));
  const firstModel = Object.values(models)[0]?.id ?? 1;
  const conf = { nextPos: newPos, estTimes: true, activeDecks: [1], sortType: 'noteFld', timeLim: 0, sortBackwards: false, addToCur: true, curDeck: 1, newBury: true, newSpread: 0, dueCounts: true, curModel: String(firstModel), collapseTime: 1200 };
  col.prepare('INSERT INTO col VALUES (1,?,?,?,11,0,0,0,?,?,?,?,?)').run(crtSec, nowMs, nowMs, JSON.stringify(conf), JSON.stringify(modelsById), JSON.stringify(ankiDecks), JSON.stringify(dconf), '{}');

  const zip = new AdmZip();
  zip.addFile('collection.anki2', col.serialize());
  col.close();
  const mediaMap = {};
  let i = 0;
  for (const [key, name] of mediaKeys) {
    const row = await db.get('SELECT data FROM media WHERE path = ? AND user_id = ?', decodeURIComponent(key), userId);
    if (!row) continue;
    zip.addFile(String(i), Buffer.from(row.data));
    mediaMap[i] = name;
    i++;
  }
  zip.addFile('media', Buffer.from(JSON.stringify(mediaMap)));
  return { buffer: zip.toBuffer(), notes: notesOut, cards: cardsOut, reviews: reviewsOut, media: i };
}

// ---------------- full data export ----------------

/** Everything the user owns, as JSON rows plus media files: recall-export.json and media/<path>. */
export async function exportAccount(user) {
  const u = user.id;
  const decks = await db.all('SELECT * FROM decks WHERE user_id = ? ORDER BY id', u);
  const deckIds = decks.map((d) => d.id);
  const cards = [];
  for (const d of deckIds) cards.push(...(await db.all('SELECT * FROM cards WHERE deck_id = ? ORDER BY id', d)));
  const media = await db.all('SELECT path, mime FROM media WHERE user_id = ? ORDER BY path', u);
  const data = {
    format: 'recall-export',
    version: 1,
    exportedAt: new Date().toISOString(),
    account: { username: user.username, name: user.name, email: user.email, createdAt: Number(user.created_at) },
    folders: await db.all('SELECT * FROM folders WHERE user_id = ? ORDER BY id', u),
    decks,
    cards,
    reviews: await db.all('SELECT * FROM reviews WHERE user_id = ? ORDER BY id', u),
    media: media.map((m) => ({ ...m, file: `media/${m.path}` })),
  };
  const zip = new AdmZip();
  zip.addFile('recall-export.json', Buffer.from(JSON.stringify(data, null, 1)));
  zip.addFile('README.txt', Buffer.from([
    'Your Recall data.',
    '',
    'recall-export.json has every folder, deck, card (with its FSRS scheduling state in "fsrs") and review',
    'you own, as rows from Recall\'s database. Times are milliseconds since 1970 (UTC).',
    'Card media (images, audio) is in media/, at the path listed for each file.',
    '',
    'To move decks to another app, the Anki export (.apkg) from a deck\'s menu is usually easier.',
  ].join('\n')));
  for (const m of media) {
    const row = await db.get('SELECT data FROM media WHERE path = ? AND user_id = ?', m.path, u);
    if (row) zip.addFile(`media/${m.path}`, Buffer.from(row.data));
  }
  return zip.toBuffer();
}
