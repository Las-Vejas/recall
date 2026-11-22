import express from 'express';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { db, MEDIA_DIR } from './db.js';
import { nextCard, getStudyCard, counts, answer, undoLast, redoLast, forgetCard, newFsrsCard, startOfToday } from './scheduler.js';
import { importApkg } from './apkg.js';
import { createClozeNote, updateClozeNote } from './cloze.js';
import { mode, isAuthed, verifyPassword, setPassword, sessionToken, MIN_PASSWORD, createApiToken, revokeApiToken, apiTokenInfo, checkBearer } from './auth.js';
import { parseDeckJson, importDecks } from './jsonImport.js';
import { folderDeckIds, deleteFolder, wouldCycle, migrateAnkiNames } from './folders.js';

migrateAnkiNames();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);

const app = express();
// X-Forwarded-* headers are ignored unless TRUST_PROXY is set (e.g. TRUST_PROXY=1 behind one reverse proxy).
// Trusting them by default would let clients fake their IP and dodge the login rate limit.
if (process.env.TRUST_PROXY) app.set('trust proxy', /^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY);
app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());

// ---------- auth ----------
const COOKIE = { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 24 * 180 };
const startSession = (req, res) => res.cookie('recall', sessionToken(), { ...COOKIE, secure: req.secure || req.get('x-forwarded-proto') === 'https' });
const failures = new Map();
const throttled = (req, res) => {
  const f = failures.get(req.ip);
  if (f && Date.now() < f.until) { res.status(429).json({ error: 'Too many attempts, wait a bit' }); return true; }
  return false;
};
const fail = (req) => {
  const f = failures.get(req.ip) || { n: 0, until: 0 };
  f.n++; f.until = Date.now() + Math.min(60_000, 500 * 2 ** f.n);
  failures.set(req.ip, f);
};

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.get('/api/me', (req, res) => {
  const m = mode();
  res.json({ authed: isAuthed(req.cookies.recall), mode: m, passwordRequired: m === 'env' || m === 'stored', needsSetup: m === 'setup', minPassword: MIN_PASSWORD });
});
app.post('/api/setup', (req, res) => {
  if (mode() !== 'setup') return res.status(409).json({ error: 'Already set up' });
  try { setPassword(req.body?.password); } catch (e) { return res.status(400).json({ error: e.message }); }
  console.log('Password set via first-run setup');
  startSession(req, res);
  res.json({ ok: true });
});
app.post('/api/login', (req, res) => {
  if (throttled(req, res)) return;
  if (verifyPassword(req.body?.password || '')) {
    failures.delete(req.ip);
    startSession(req, res);
    return res.json({ ok: true });
  }
  fail(req);
  res.status(401).json({ error: 'Wrong password' });
});
app.post('/api/logout', (req, res) => { res.clearCookie('recall'); res.json({ ok: true }); });

// What an API token (Authorization: Bearer rk_...) may do: add decks and look at the library. Nothing destructive.
const AGENT_ROUTES = [['POST', '/api/import/json'], ['GET', '/api/decks'], ['GET', '/api/folders']];
const agentAllowed = (req) => AGENT_ROUTES.some(([m, p]) => req.method === m && req.originalUrl.split('?')[0] === p);

app.use(['/api', '/media'], (req, res, next) => {
  if (isAuthed(req.cookies.recall)) return next();
  if (req.headers.authorization && agentAllowed(req) && checkBearer(req.headers.authorization)) { req.viaToken = true; return next(); }
  res.status(401).json({ error: 'unauthorized' });
});

// ---------- API token management (browser session only) ----------
app.get('/api/token', (req, res) => res.json(apiTokenInfo()));
app.post('/api/token', (req, res) => res.json({ token: createApiToken(), ...apiTokenInfo() }));
app.delete('/api/token', (req, res) => { revokeApiToken(); res.json(apiTokenInfo()); });

// ---------- JSON deck import (UI and AI agents) ----------
app.post('/api/import/json', (req, res) => {
  try {
    const result = importDecks(parseDeckJson(req.body));
    if (req.viaToken) console.log(`API token import: ${result.added} cards into ${result.decks.map((d) => d.deck).join(', ')}`);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message, errors: e.errors });
  }
});

app.post('/api/password', (req, res) => {
  if (throttled(req, res)) return;
  if (mode() === 'disabled') return res.status(400).json({ error: 'Auth is disabled (DISABLE_AUTH)' });
  if (!verifyPassword(req.body?.current || '')) { fail(req); return res.status(401).json({ error: 'Current password is wrong' }); }
  try { setPassword(req.body?.next); } catch (e) { return res.status(400).json({ error: e.message }); }
  startSession(req, res); // old cookies on other devices are now invalid
  res.json({ ok: true });
});
app.use('/media', express.static(MEDIA_DIR, { maxAge: '30d', fallthrough: false }));

const wrap = (fn) => (req, res) => {
  try { const out = fn(req, res); if (out !== undefined) res.json(out); }
  catch (e) { console.error(e); res.status(400).json({ error: e.message }); }
};
// study scope from URL: "all", a deck id, or "f<folderId>" for every deck in a folder (recursively)
const deckParam = (v) => (v === 'all' ? null : v.startsWith('f') ? folderDeckIds(Number(v.slice(1))) : Number(v));

// ---------- decks ----------
app.get('/api/decks', wrap(() => {
  const decks = db.prepare(`SELECT d.*, COUNT(c.id) total,
      SUM(CASE WHEN c.state = 0 THEN 1 ELSE 0 END) unseen,
      SUM(CASE WHEN c.state = 2 AND json_extract(c.fsrs,'$.stability') >= 21 THEN 1 ELSE 0 END) mature
    FROM decks d LEFT JOIN cards c ON c.deck_id = d.id GROUP BY d.id ORDER BY d.name COLLATE NOCASE`).all();
  return decks.map((d) => ({ ...d, counts: counts(d.id) }));
}));
app.post('/api/decks', wrap((req) => {
  const { name, description = '', color = '#7c5cff', folder_id = null } = req.body;
  if (!name?.trim()) throw new Error('Name required');
  const id = db.prepare('INSERT INTO decks (name, description, color, folder_id, created_at) VALUES (?,?,?,?,?)')
    .run(name.trim(), description, color, folder_id, Date.now()).lastInsertRowid;
  return db.prepare('SELECT * FROM decks WHERE id = ?').get(id);
}));
app.get('/api/decks/:id', wrap((req) => {
  const d = db.prepare(`SELECT d.*, COUNT(c.id) total,
      SUM(CASE WHEN c.state = 2 AND json_extract(c.fsrs,'$.stability') >= 21 THEN 1 ELSE 0 END) mature
    FROM decks d LEFT JOIN cards c ON c.deck_id = d.id WHERE d.id = ? GROUP BY d.id`).get(req.params.id);
  if (d) d.mature ??= 0;
  if (!d) throw new Error('Deck not found');
  return { ...d, counts: counts(d.id) };
}));
app.patch('/api/decks/:id', wrap((req) => {
  const allowed = ['name', 'description', 'color', 'new_per_day', 'folder_id'];
  for (const k of allowed) if (k in req.body) db.prepare(`UPDATE decks SET ${k} = ? WHERE id = ?`).run(req.body[k], req.params.id);
  return db.prepare('SELECT * FROM decks WHERE id = ?').get(req.params.id);
}));
app.delete('/api/decks/:id', wrap((req) => { db.prepare('DELETE FROM decks WHERE id = ?').run(req.params.id); return { ok: true }; }));

// ---------- folders ----------
app.get('/api/folders', wrap(() => db.prepare('SELECT * FROM folders ORDER BY name COLLATE NOCASE').all()));
app.post('/api/folders', wrap((req) => {
  const { name, parent_id = null } = req.body;
  if (!name?.trim()) throw new Error('Name required');
  const id = db.prepare('INSERT INTO folders (name, parent_id, created_at) VALUES (?,?,?)').run(name.trim(), parent_id, Date.now()).lastInsertRowid;
  return db.prepare('SELECT * FROM folders WHERE id = ?').get(id);
}));
app.patch('/api/folders/:id', wrap((req) => {
  const { id } = req.params;
  if ('name' in req.body) {
    if (!String(req.body.name).trim()) throw new Error('Name required');
    db.prepare('UPDATE folders SET name = ? WHERE id = ?').run(String(req.body.name).trim(), id);
  }
  if ('parent_id' in req.body) {
    if (wouldCycle(Number(id), req.body.parent_id)) throw new Error("Can't move a folder into itself");
    db.prepare('UPDATE folders SET parent_id = ? WHERE id = ?').run(req.body.parent_id, id);
  }
  return db.prepare('SELECT * FROM folders WHERE id = ?').get(id);
}));
app.delete('/api/folders/:id', wrap((req) => { deleteFolder(Number(req.params.id)); return { ok: true }; }));

// ---------- cards ----------
app.get('/api/decks/:id/cards', wrap((req) => {
  const q = `%${req.query.q || ''}%`;
  return db.prepare(`SELECT id, deck_id, front, back, format, tags, suspended, state, due, css, kind, cloze_ord, note_id,
      json_extract(fsrs,'$.stability') stability, json_extract(fsrs,'$.reps') reps, json_extract(fsrs,'$.lapses') lapses
    FROM cards WHERE deck_id = ? AND (front LIKE ? OR back LIKE ? OR tags LIKE ?) ORDER BY id DESC LIMIT 2000`)
    .all(req.params.id, q, q, q);
}));
const insertCard = db.prepare(`INSERT INTO cards (deck_id, front, back, format, tags, state, due, fsrs, created_at, updated_at)
  VALUES (?,?,?,?,?,0,?,?,?,?)`);
app.post('/api/decks/:id/cards', wrap((req) => {
  const { front, back = '', tags = '', format = 'md', kind = 'basic' } = req.body;
  if (!front?.trim()) throw new Error('Front required');
  if (kind === 'cloze') return createClozeNote(req.params.id, { front, back, tags });
  const now = Date.now();
  const id = insertCard.run(req.params.id, front, back, format, tags, now, newFsrsCard(), now, now).lastInsertRowid;
  return { id };
}));
app.post('/api/decks/:id/cards/bulk', wrap((req) => {
  const { text = '', separator = '\t' } = req.body;
  const now = Date.now();
  let n = 0;
  db.transaction(() => {
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const [front, ...rest] = line.split(separator);
      if (!front.trim()) continue;
      insertCard.run(req.params.id, front.trim(), rest.join(separator).trim(), 'md', '', now, newFsrsCard(), now, now);
      n++;
    }
  })();
  return { imported: n };
}));
app.patch('/api/cards/:id', wrap((req) => {
  const card = db.prepare('SELECT kind, note_id FROM cards WHERE id = ?').get(req.params.id);
  if (!card) throw new Error('Card not found');
  if (card.kind === 'cloze' && card.note_id) {
    // text/extra/tags/deck belong to the whole note; suspension stays per card
    const { suspended, ...noteChanges } = req.body;
    const result = Object.keys(noteChanges).length ? updateClozeNote(card.note_id, noteChanges) : { added: 0, removed: 0 };
    if (suspended !== undefined) db.prepare('UPDATE cards SET suspended = ?, updated_at = ? WHERE id = ?').run(suspended, Date.now(), req.params.id);
    return { ok: true, ...result };
  }
  for (const k of ['front', 'back', 'tags', 'suspended', 'deck_id'])
    if (k in req.body) db.prepare(`UPDATE cards SET ${k} = ?, updated_at = ? WHERE id = ?`).run(req.body[k], Date.now(), req.params.id);
  return { ok: true };
}));
app.delete('/api/cards/:id', wrap((req) => {
  // deleting a cloze card deletes its whole note (otherwise the next edit would bring it back)
  const card = db.prepare('SELECT note_id FROM cards WHERE id = ?').get(req.params.id);
  const n = card?.note_id
    ? db.prepare('DELETE FROM cards WHERE note_id = ?').run(card.note_id).changes
    : db.prepare('DELETE FROM cards WHERE id = ?').run(req.params.id).changes;
  return { ok: true, deleted: n };
}));
app.post('/api/cards/:id/forget', wrap((req) => { forgetCard(Number(req.params.id)); return { ok: true }; }));

// ---------- study ----------
app.get('/api/study/:deck', wrap((req) => {
  const deck = deckParam(req.params.deck);
  return { card: nextCard(deck, Number(req.query.exclude) || null), counts: counts(deck) };
}));
app.post('/api/study/:deck/answer', wrap((req) => {
  const { cardId, rating, durationMs } = req.body;
  if (![1, 2, 3, 4].includes(rating)) throw new Error('Bad rating');
  const result = answer(cardId, rating, durationMs);
  const deck = deckParam(req.params.deck);
  return { result, card: nextCard(deck, cardId), counts: counts(deck) };
}));
app.post('/api/study/:deck/undo', wrap((req) => {
  const deck = deckParam(req.params.deck);
  const cardId = undoLast(deck);
  if (!cardId) throw new Error('Nothing to undo');
  return { card: getStudyCard(cardId), counts: counts(deck) };
}));
app.post('/api/study/:deck/redo', wrap((req) => {
  const deck = deckParam(req.params.deck);
  const cardId = redoLast(deck);
  if (!cardId) throw new Error('Nothing to redo');
  return { card: nextCard(deck, cardId), counts: counts(deck) };
}));

// ---------- stats ----------
app.get('/api/stats', wrap(() => {
  const DAY = 86_400_000;
  const tzOffset = new Date().getTimezoneOffset() * 60_000;
  const since = startOfToday() - 364 * DAY;
  const heat = db.prepare(`SELECT CAST((reviewed_at - ?) / ? AS INTEGER) day, COUNT(*) n, SUM(duration_ms) ms
    FROM reviews WHERE reviewed_at >= ? GROUP BY day`).all(tzOffset, DAY, since);
  const today = startOfToday();
  const forecast = db.prepare(`SELECT CAST((due - ?) / ? AS INTEGER) day, COUNT(*) n FROM cards
    WHERE state != 0 AND suspended = 0 AND due < ? GROUP BY day`).all(today, DAY, today + 30 * DAY);
  const states = db.prepare('SELECT state, COUNT(*) n FROM cards GROUP BY state').all();
  const todayRow = db.prepare('SELECT COUNT(*) n, SUM(duration_ms) ms, SUM(CASE WHEN rating = 1 THEN 1 ELSE 0 END) again FROM reviews WHERE reviewed_at >= ?').get(today);
  const ret = db.prepare(`SELECT COUNT(*) n, SUM(CASE WHEN rating > 1 THEN 1 ELSE 0 END) ok FROM reviews
    WHERE prev_state = 2 AND reviewed_at >= ?`).get(today - 30 * DAY);
  // streak
  const days = new Set(heat.map((h) => h.day));
  const todayIdx = Math.floor((Date.now() - tzOffset) / DAY);
  let streak = 0;
  for (let d = days.has(todayIdx) ? todayIdx : todayIdx - 1; days.has(d); d--) streak++;
  return {
    heat: heat.map((h) => ({ date: h.day * DAY, n: h.n, ms: h.ms })),
    forecast, states, streak,
    today: { reviews: todayRow.n || 0, ms: todayRow.ms || 0, again: todayRow.again || 0 },
    retention: ret.n ? ret.ok / ret.n : null,
    totalReviews: db.prepare('SELECT COUNT(*) n FROM reviews').get().n,
  };
}));

// ---------- import ----------
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 * 1024 } });
app.post('/api/import', upload.single('file'), wrap((req) => {
  if (!req.file) throw new Error('No file');
  return importApkg(req.file.buffer, { originalName: req.file.originalname });
}));

// ---------- frontend ----------
const dist = path.join(__dirname, '..', 'web', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist, { index: false, maxAge: '1h' }));
  app.get(/^(?!\/api|\/media).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
}

const server = app.listen(PORT, () => {
  const note = { disabled: 'auth DISABLED', env: 'password from APP_PASSWORD', stored: 'password set', setup: 'open it in a browser to choose a password' }[mode()];
  console.log(`Recall listening on http://localhost:${PORT} (${note})`);
});

// clean shutdown on `docker stop` / Ctrl-C: finish requests, then close SQLite so the WAL is checkpointed
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.close(() => { db.close(); process.exit(0); });
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
