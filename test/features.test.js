// Data export/import round trips, per-user scheduling, leeches, custom study and reminders.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';
import Database from 'better-sqlite3';
import { claim, startServer } from './helpers.js';

let server, ada;
before(async () => { server = await startServer(); ada = await claim(server); });
after(async () => { await server?.stop(); });

const deckByName = async (name) => (await ada.get('/api/decks')).body.find((d) => d.name === name);

describe('export', () => {
  let deckId;
  before(async () => {
    await ada.post('/api/import/json', { deck: 'Capitals', folder: 'Geo', cards: [
      { front: 'France', back: '**Paris**', tags: ['europe'] },
      { front: 'Peru', back: 'Lima', typeIn: true },
      { cloze: 'The {{c1::Danube}} flows through {{c2::Vienna}}', extra: 'rivers' },
    ] });
    deckId = (await deckByName('Capitals')).id;
    const first = await ada.get(`/api/study/${deckId}`);
    await ada.post(`/api/study/${deckId}/answer`, { cardId: first.body.card.id, rating: 3 });
  });

  it('exports a deck as Recall JSON that imports straight back', async () => {
    const r = await ada.download(`/api/export/${deckId}?format=json`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-disposition'), /attachment; filename="Capitals.json"/);
    const json = JSON.parse(r.buf.toString('utf8'));
    assert.equal(json.decks[0].folder, 'Geo');
    assert.equal(json.decks[0].cards.length, 3, 'the cloze note is one entry, not one per card');
    assert.deepEqual(json.decks[0].cards.find((c) => c.typeIn), { front: 'Peru', back: 'Lima', typeIn: true });
    json.decks[0].deck = 'Capitals copy';
    const back = await ada.post('/api/import/json', json);
    assert.equal(back.status, 200);
    assert.equal(back.body.added, 4, 'two basic cards and the cloze note’s two cards');
  });

  it('exports an Anki package with notes, scheduling and review history', async () => {
    const r = await ada.download(`/api/export/${deckId}?format=apkg`);
    assert.equal(r.status, 200);
    const zip = new AdmZip(r.buf);
    const col = new Database(zip.getEntry('collection.anki2').getData(), { readonly: true });
    assert.equal(col.prepare('SELECT COUNT(*) AS n FROM notes').get().n, 3);
    assert.equal(col.prepare('SELECT COUNT(*) AS n FROM cards').get().n, 4);
    assert.equal(col.prepare('SELECT COUNT(*) AS n FROM revlog').get().n, 1);
    const decks = Object.values(JSON.parse(col.prepare('SELECT decks FROM col').get().decks)).map((d) => d.name);
    assert.ok(decks.includes('Geo::Capitals'));
    const paris = col.prepare("SELECT flds FROM notes WHERE flds LIKE '%France%'").get().flds;
    assert.match(paris, /<strong>Paris<\/strong>/, 'Markdown is rendered to HTML for Anki');
    col.close();
  });

  it('re-imports its own Anki package', async () => {
    const r = await ada.download(`/api/export/${deckId}?format=apkg`);
    const up = await ada.upload('/api/import', r.buf, 'roundtrip.apkg', 'application/octet-stream');
    assert.equal(up.status, 200);
    assert.equal(up.body.imported, 4);
    assert.equal(up.body.reviews, 1, 'the review history comes along');
    assert.equal(up.body.scheduled, 1, 'the studied card is not new again');
    const copy = (await ada.get('/api/decks')).body.filter((d) => d.name === 'Capitals').find((d) => d.id !== deckId);
    const cards = (await ada.get(`/api/decks/${copy.id}/cards`)).body;
    const studied = cards.filter((c) => c.state !== 0);
    assert.equal(studied.length, 1);
    assert.equal(studied[0].reps, 1);
    const original = (await ada.get(`/api/decks/${deckId}/cards`)).body.find((c) => c.state !== 0);
    assert.ok(Math.abs(studied[0].due - original.due) < 1000, 'due date survives the round trip');
    // imported history isn't undoable
    const undo = await ada.post(`/api/study/${copy.id}/undo`);
    assert.equal(undo.status, 400);
  });

  it('exports all of a person’s data as a zip', async () => {
    const r = await ada.download('/api/account/export');
    assert.equal(r.status, 200);
    const data = JSON.parse(new AdmZip(r.buf).getEntry('recall-export.json').getData().toString('utf8'));
    assert.equal(data.format, 'recall-export');
    assert.equal(data.account.username, 'ada');
    assert.ok(data.cards.length >= 4);
    assert.ok(data.reviews.length >= 1);
  });

  it('keeps other people’s decks out', async () => {
    const r = await ada.download('/api/export/999999?format=json');
    assert.equal(r.status, 404);
  });
});

/** A minimal Anki collection (schema 11) with `n` basic cards, each with a review history. */
function ankiPackage({ n = 120, reviewsPerCard = 9, deck = 'History' } = {}) {
  const col = new Database(':memory:');
  col.exec(`CREATE TABLE col (id integer primary key, crt integer, mod integer, scm integer, ver integer, dty integer, usn integer, ls integer, conf text, models text, decks text, dconf text, tags text);
    CREATE TABLE notes (id integer primary key, guid text, mid integer, mod integer, usn integer, tags text, flds text, sfld text, csum integer, flags integer, data text);
    CREATE TABLE cards (id integer primary key, nid integer, did integer, ord integer, mod integer, usn integer, type integer, queue integer, due integer, ivl integer, factor integer, reps integer, lapses integer, left integer, odue integer, odid integer, flags integer, data text);
    CREATE TABLE revlog (id integer primary key, cid integer, usn integer, ease integer, ivl integer, lastIvl integer, factor integer, time integer, type integer);`);
  const DAY = 86_400_000;
  const crt = Math.floor((Date.now() - 400 * DAY) / 1000);
  const models = { 1: { id: 1, name: 'Basic', type: 0, flds: [{ name: 'Front', ord: 0 }, { name: 'Back', ord: 1 }], tmpls: [{ ord: 0, qfmt: '{{Front}}', afmt: '{{Back}}' }], css: '' } };
  col.prepare('INSERT INTO col VALUES (1,?,0,0,11,0,0,0,?,?,?,?,?)').run(crt, '{}', JSON.stringify(models), JSON.stringify({ 2: { id: 2, name: deck } }), '{}', '{}');
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 1; i <= n; i++) {
    col.prepare('INSERT INTO notes VALUES (?,?,1,0,0,\'\',?,?,0,0,\'\')').run(i, `g${i}`, `Q${i}\x1fA${i}`, `Q${i}`);
    let t = Date.now() - 380 * DAY + i * 60_000, ivl = 1, lapses = 0;
    for (let k = 0; k < reviewsPerCard; k++) {
      const ease = k === 0 ? 3 : rnd() < 0.85 ? 3 : 1;
      if (ease === 1) lapses++;
      col.prepare('INSERT INTO revlog VALUES (?,?,0,?,?,0,2500,6000,?)').run(t, i, ease, ivl, k === 0 ? 0 : 1);
      ivl = ease === 1 ? 1 : Math.ceil(ivl * 2.2);
      t += ivl * DAY;
    }
    const dueDay = Math.floor((t - crt * 1000) / DAY);
    col.prepare('INSERT INTO cards VALUES (?,?,2,0,0,0,2,2,?,?,2500,?,?,0,0,0,0,\'\')').run(i, i, dueDay, ivl, reviewsPerCard, lapses);
  }
  const zip = new AdmZip();
  zip.addFile('collection.anki2', col.serialize());
  zip.addFile('media', Buffer.from('{}'));
  col.close();
  return zip.toBuffer();
}

describe('study settings and FSRS tuning', () => {
  let historyDeck;
  before(async () => {
    const up = await ada.upload('/api/import', ankiPackage(), 'history.apkg', 'application/octet-stream');
    assert.equal(up.status, 200);
    assert.equal(up.body.reviews, 1080);
    historyDeck = (await deckByName('History')).id;
  });

  it('starts on the server default retention and FSRS default parameters', async () => {
    const s = (await ada.get('/api/account/study')).body;
    assert.equal(s.retention, null);
    assert.equal(s.defaultRetention, 0.9);
    assert.equal(s.params, null);
    assert.ok(s.reviews >= 1080);
  });

  it('refuses nonsense settings', async () => {
    assert.equal((await ada.patch('/api/account/study', { leech: { threshold: 1 } })).status, 400);
    assert.equal((await ada.patch('/api/account/study', { timezone: 'Mars/Olympus' })).status, 400);
    assert.equal((await ada.patch('/api/account/study', { colour: 'red' })).status, 400);
  });

  it('gives shorter intervals at a higher retention, per person and per deck', async () => {
    const deck = (await ada.post('/api/decks', { name: 'Retention' })).body.id;
    await ada.post(`/api/decks/${deck}/cards`, { front: 'q', back: 'a' });
    const goodInterval = async () => (await ada.get(`/api/study/${deck}`)).body.card.intervals[4];
    const base = await goodInterval();
    await ada.patch('/api/account/study', { retention: 0.97 });
    const strict = await goodInterval();
    assert.ok(strict < base, `0.97 retention (${strict}) is stricter than 0.9 (${base})`);
    await ada.patch(`/api/decks/${deck}`, { retention: 0.8 });
    assert.ok((await goodInterval()) > base, 'a deck’s own retention wins');
    assert.equal((await ada.patch(`/api/decks/${deck}`, { retention: 0.5 })).status, 400);
    await ada.patch('/api/account/study', { retention: null });
  });

  it('fits parameters to the review history in the background', async () => {
    const start = await ada.post('/api/account/study/optimize');
    assert.equal(start.status, 200);
    let s = start.body;
    for (let i = 0; i < 100 && s.job?.running; i++) {
      await new Promise((r) => setTimeout(r, 200));
      s = (await ada.get('/api/account/study')).body;
    }
    assert.equal(s.job.error, null, s.job.error);
    assert.equal(s.params.length, 21);
    assert.ok(s.optimized.at > 0);
  });

  it('reschedules studied cards with the fitted parameters, and can go back to the defaults', async () => {
    const r = await ada.post('/api/account/study/reschedule');
    assert.equal(r.status, 200);
    assert.ok(r.body.rescheduled >= 120);
    const card = (await ada.get(`/api/decks/${historyDeck}/cards`)).body[0];
    assert.equal(card.state, 2);
    const reset = (await ada.patch('/api/account/study', { params: null })).body;
    assert.equal(reset.params, null);
  });
});
