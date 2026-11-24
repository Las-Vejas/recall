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
