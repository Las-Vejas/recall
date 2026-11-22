import express from 'express';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { db, initDb } from './db.js';
import { nextCard, getStudyCard, counts, answer, undoLast, redoLast, forgetCard, newFsrsCard, startOfToday } from './scheduler.js';
import { importApkg } from './apkg.js';
import { createClozeNote, updateClozeNote } from './cloze.js';
import { loadSettings, mode, isAuthed, verifyPassword, setPassword, sessionToken, MIN_PASSWORD, createApiToken, revokeApiToken, apiTokenInfo, checkBearer } from './auth.js';
import { parseDeckJson, importDecks } from './jsonImport.js';
import { folderDeckIds, deleteFolder, wouldCycle, migrateAnkiNames } from './folders.js';
import { serveMedia } from './media.js';

// ---------- database ----------
try {
  await initDb();
  await loadSettings();
  await migrateAnkiNames();
} catch (e) {
  console.error(`\nCould not open the database (${db.describe()}):\n  ${e.message}\n`);
  if (db.dialect === 'pg') console.error('Check DATABASE_URL, e.g. postgres://user:password@host:5432/recall (add ?sslmode=require for hosted Postgres).\n');
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);

const app = express();
// X-Forwarded-* headers are ignored unless TRUST_PROXY is set (e.g. TRUST_PROXY=1 behind one reverse proxy).
// Trusting them by default would let clients fake their IP and dodge the login rate limit.
if (process.env.TRUST_PROXY) app.set('trust proxy', /^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY);
app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());

/** Async route helper: returns JSON, turns thrown errors into 400 { error }. */
const wrap = (fn) => (req, res) => {
  Promise.resolve()
    .then(() => fn(req, res))
    .then((out) => { if (out !== undefined && !res.headersSent) res.json(out); })
    .catch((e) => {
      if (!e.expected) console.error(e);
      if (!res.headersSent) res.status(e.status || 400).json({ error: e.message, ...(e.errors ? { errors: e.errors } : {}) });
    });
};
/** An error that is the user's (or agent's) to fix, not a server bug: no stack trace in the logs. */
const fail400 = (message, status = 400) => Object.assign(new Error(message), { expected: true, status });

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
app.post('/api/setup', wrap(async (req, res) => {
  if (mode() !== 'setup') throw fail400('Already set up', 409);
  try { await setPassword(req.body?.password); } catch (e) { throw fail400(e.message); }
  console.log('Password set via first-run setup');
  startSession(req, res);
  return { ok: true };
}));
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
app.post('/api/token', wrap(async () => ({ token: await createApiToken(), ...apiTokenInfo() })));
app.delete('/api/token', wrap(async () => { await revokeApiToken(); return apiTokenInfo(); }));

// ---------- JSON deck import (UI and AI agents) ----------
app.post('/api/import/json', wrap(async (req) => {
  let decks;
  try { decks = parseDeckJson(req.body); } catch (e) { throw Object.assign(fail400(e.message), { errors: e.errors }); }
  const result = await importDecks(decks);
  if (req.viaToken) console.log(`API token import: ${result.added} cards into ${result.decks.map((d) => d.deck).join(', ')}`);
  return result;
}));

app.post('/api/password', wrap(async (req, res) => {
  if (throttled(req, res)) return;
  if (mode() === 'disabled') throw fail400('Auth is disabled (DISABLE_AUTH)');
  if (!verifyPassword(req.body?.current || '')) { fail(req); throw fail400('Current password is wrong', 401); }
  try { await setPassword(req.body?.next); } catch (e) { throw fail400(e.message); }
  startSession(req, res); // old cookies on other devices are now invalid
  return { ok: true };
}));
app.use('/media', wrap(serveMedia));

// study scope from URL: "all", a deck id, or "f<folderId>" for every deck in a folder (recursively)
const deckParam = async (v) => (v === 'all' ? null : v.startsWith('f') ? folderDeckIds(Number(v.slice(1))) : Number(v));
const withCounts = async (decks) => Promise.all(decks.map(async (d) => ({ ...d, counts: await counts(d.id) })));

// ---------- decks ----------
const MATURE = `SUM(CASE WHEN c.state = 2 AND ${db.json('c.fsrs', 'stability')} >= 21 THEN 1 ELSE 0 END)`;
app.get('/api/decks', wrap(async () => {
  const decks = await db.all(`SELECT d.*, COUNT(c.id) AS total,
      SUM(CASE WHEN c.state = 0 THEN 1 ELSE 0 END) AS unseen, ${MATURE} AS mature
    FROM decks d LEFT JOIN cards c ON c.deck_id = d.id GROUP BY d.id ORDER BY d.name COLLATE NOCASE`);
  return withCounts(decks.map((d) => ({ ...d, unseen: d.unseen || 0, mature: d.mature || 0 })));
}));
app.post('/api/decks', wrap(async (req) => {
  const { name, description = '', color = '#7c5cff', folder_id = null } = req.body;
  if (!name?.trim()) throw fail400('Name required');
  const id = await db.insert('INSERT INTO decks (name, description, color, folder_id, created_at) VALUES (?,?,?,?,?)',
    name.trim(), description, color, folder_id, Date.now());
  return db.get('SELECT * FROM decks WHERE id = ?', id);
}));
app.get('/api/decks/:id', wrap(async (req) => {
  const d = await db.get(`SELECT d.*, COUNT(c.id) AS total, ${MATURE} AS mature
    FROM decks d LEFT JOIN cards c ON c.deck_id = d.id WHERE d.id = ? GROUP BY d.id`, req.params.id);
  if (!d) throw fail400('Deck not found', 404);
  return { ...d, mature: d.mature || 0, counts: await counts(d.id) };
}));
app.patch('/api/decks/:id', wrap(async (req) => {
  for (const k of ['name', 'description', 'color', 'new_per_day', 'folder_id'])
    if (k in req.body) await db.run(`UPDATE decks SET ${k} = ? WHERE id = ?`, req.body[k], req.params.id);
  return db.get('SELECT * FROM decks WHERE id = ?', req.params.id);
}));
app.delete('/api/decks/:id', wrap(async (req) => { await db.run('DELETE FROM decks WHERE id = ?', req.params.id); return { ok: true }; }));

// ---------- folders ----------
app.get('/api/folders', wrap(() => db.all('SELECT * FROM folders ORDER BY name COLLATE NOCASE')));
app.post('/api/folders', wrap(async (req) => {
  const { name, parent_id = null } = req.body;
  if (!name?.trim()) throw fail400('Name required');
  const id = await db.insert('INSERT INTO folders (name, parent_id, created_at) VALUES (?,?,?)', name.trim(), parent_id, Date.now());
  return db.get('SELECT * FROM folders WHERE id = ?', id);
}));
app.patch('/api/folders/:id', wrap(async (req) => {
  const { id } = req.params;
  if ('name' in req.body) {
    if (!String(req.body.name).trim()) throw fail400('Name required');
    await db.run('UPDATE folders SET name = ? WHERE id = ?', String(req.body.name).trim(), id);
  }
  if ('parent_id' in req.body) {
    if (await wouldCycle(Number(id), req.body.parent_id)) throw fail400("Can't move a folder into itself");
    await db.run('UPDATE folders SET parent_id = ? WHERE id = ?', req.body.parent_id, id);
  }
  return db.get('SELECT * FROM folders WHERE id = ?', id);
}));
app.delete('/api/folders/:id', wrap(async (req) => { await deleteFolder(Number(req.params.id)); return { ok: true }; }));

// ---------- cards ----------
app.get('/api/decks/:id/cards', wrap((req) => {
  const q = `%${req.query.q || ''}%`;
  return db.all(`SELECT id, deck_id, front, back, format, tags, suspended, state, due, css, kind, cloze_ord, note_id,
      ${db.json('fsrs', 'stability')} AS stability, ${db.json('fsrs', 'reps')} AS reps, ${db.json('fsrs', 'lapses')} AS lapses
    FROM cards WHERE deck_id = ? AND (front LIKE ? OR back LIKE ? OR tags LIKE ?) ORDER BY id DESC LIMIT 2000`,
  req.params.id, q, q, q);
}));
const INSERT_CARD = `INSERT INTO cards (deck_id, front, back, format, tags, state, due, fsrs, created_at, updated_at)
  VALUES (?,?,?,?,?,0,?,?,?,?)`;
app.post('/api/decks/:id/cards', wrap(async (req) => {
  const { front, back = '', tags = '', format = 'md', kind = 'basic' } = req.body;
  if (!front?.trim()) throw fail400('Front required');
  if (kind === 'cloze') {
    try { return await createClozeNote(req.params.id, { front, back, tags }); } catch (e) { throw fail400(e.message); }
  }
  const now = Date.now();
  return { id: await db.insert(INSERT_CARD, req.params.id, front, back, format, tags, now, newFsrsCard(), now, now) };
}));
app.post('/api/decks/:id/cards/bulk', wrap(async (req) => {
  const { text = '', separator = '\t' } = req.body;
  const now = Date.now();
  let n = 0;
  await db.tx(async () => {
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const [front, ...rest] = line.split(separator);
      if (!front.trim()) continue;
      await db.run(INSERT_CARD, req.params.id, front.trim(), rest.join(separator).trim(), 'md', '', now, newFsrsCard(), now, now);
      n++;
    }
  });
  return { imported: n };
}));
app.patch('/api/cards/:id', wrap(async (req) => {
  const card = await db.get('SELECT kind, note_id FROM cards WHERE id = ?', req.params.id);
  if (!card) throw fail400('Card not found', 404);
  if (card.kind === 'cloze' && card.note_id) {
    // text/extra/tags/deck belong to the whole note; suspension stays per card
    const { suspended, ...noteChanges } = req.body;
    let result = { added: 0, removed: 0 };
    if (Object.keys(noteChanges).length) {
      try { result = await updateClozeNote(card.note_id, noteChanges); } catch (e) { throw fail400(e.message); }
    }
    if (suspended !== undefined) await db.run('UPDATE cards SET suspended = ?, updated_at = ? WHERE id = ?', suspended, Date.now(), req.params.id);
    return { ok: true, ...result };
  }
  for (const k of ['front', 'back', 'tags', 'suspended', 'deck_id'])
    if (k in req.body) await db.run(`UPDATE cards SET ${k} = ?, updated_at = ? WHERE id = ?`, req.body[k], Date.now(), req.params.id);
  return { ok: true };
}));
app.delete('/api/cards/:id', wrap(async (req) => {
  // deleting a cloze card deletes its whole note (otherwise the next edit would bring it back)
  const card = await db.get('SELECT note_id FROM cards WHERE id = ?', req.params.id);
  const r = card?.note_id
    ? await db.run('DELETE FROM cards WHERE note_id = ?', card.note_id)
    : await db.run('DELETE FROM cards WHERE id = ?', req.params.id);
  return { ok: true, deleted: r.changes };
}));
app.post('/api/cards/:id/forget', wrap(async (req) => { await forgetCard(Number(req.params.id)); return { ok: true }; }));

// ---------- study ----------
app.get('/api/study/:deck', wrap(async (req) => {
  const deck = await deckParam(req.params.deck);
  return { card: await nextCard(deck, Number(req.query.exclude) || null), counts: await counts(deck) };
}));
app.post('/api/study/:deck/answer', wrap(async (req) => {
  const { cardId, rating, durationMs } = req.body;
  if (![1, 2, 3, 4].includes(rating)) throw fail400('Bad rating');
  const result = await answer(cardId, rating, durationMs);
  const deck = await deckParam(req.params.deck);
  return { result, card: await nextCard(deck, cardId), counts: await counts(deck) };
}));
app.post('/api/study/:deck/undo', wrap(async (req) => {
  const deck = await deckParam(req.params.deck);
  const cardId = await undoLast(deck);
  if (!cardId) throw fail400('Nothing to undo');
  return { card: await getStudyCard(cardId), counts: await counts(deck) };
}));
app.post('/api/study/:deck/redo', wrap(async (req) => {
  const deck = await deckParam(req.params.deck);
  const r = await redoLast(deck);
  if (!r) throw fail400('Nothing to redo');
  if (r.stale) throw fail400('That card changed since the undo, so it can’t be redone');
  return { card: await nextCard(deck, r), counts: await counts(deck) };
}));

// ---------- stats ----------
app.get('/api/stats', wrap(async () => {
  const DAY = 86_400_000;
  const tzOffset = new Date().getTimezoneOffset() * 60_000;
  const since = startOfToday() - 364 * DAY;
  const heat = await db.all(`SELECT CAST((reviewed_at - ?) / ? AS INTEGER) AS day, COUNT(*) AS n, SUM(duration_ms) AS ms
    FROM reviews WHERE reviewed_at >= ? GROUP BY day`, tzOffset, DAY, since);
  const today = startOfToday();
  const forecast = await db.all(`SELECT CAST((due - ?) / ? AS INTEGER) AS day, COUNT(*) AS n FROM cards
    WHERE state != 0 AND suspended = 0 AND due < ? GROUP BY day`, today, DAY, today + 30 * DAY);
  const states = await db.all('SELECT state, COUNT(*) AS n FROM cards GROUP BY state');
  const todayRow = await db.get('SELECT COUNT(*) AS n, SUM(duration_ms) AS ms, SUM(CASE WHEN rating = 1 THEN 1 ELSE 0 END) AS again FROM reviews WHERE reviewed_at >= ?', today);
  const ret = await db.get(`SELECT COUNT(*) AS n, SUM(CASE WHEN rating > 1 THEN 1 ELSE 0 END) AS ok FROM reviews
    WHERE prev_state = 2 AND reviewed_at >= ?`, today - 30 * DAY);
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
    totalReviews: (await db.get('SELECT COUNT(*) AS n FROM reviews')).n,
  };
}));

// ---------- import ----------
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 * 1024 } });
app.post('/api/import', upload.single('file'), wrap(async (req) => {
  if (!req.file) throw fail400('No file');
  try { return await importApkg(req.file.buffer, { originalName: req.file.originalname }); }
  catch (e) { if (/Not an Anki package|zip/i.test(e.message)) throw fail400(e.message); throw e; }
}));

// ---------- frontend ----------
const dist = path.join(__dirname, '..', 'web', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist, { index: false, maxAge: '1h' }));
  app.get(/^(?!\/api|\/media).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
}

const server = app.listen(PORT, () => {
  const note = { disabled: 'auth DISABLED', env: 'password from APP_PASSWORD', stored: 'password set', setup: 'open it in a browser to choose a password' }[mode()];
  console.log(`Recall listening on http://localhost:${PORT} (${note}; database: ${db.describe()})`);
});

// clean shutdown on `docker stop` / Ctrl-C: finish requests, then close the database (SQLite checkpoints its WAL)
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.close(async () => { await db.close(); process.exit(0); });
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
