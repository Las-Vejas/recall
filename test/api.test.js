// End-to-end API tests against a real server: accounts, decks and cards, studying, imports,
// per-user privacy and what API tokens may do.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Client, claim, invitePerson, startServer } from './helpers.js';

let server, ada, bob;

before(async () => { server = await startServer(); });
after(async () => { await server?.stop(); });

describe('first start and accounts', () => {
  it('reports health', async () => {
    const r = await new Client(server.url).get('/api/health');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true });
  });

  it('asks for a claim until the first account exists', async () => {
    const r = await new Client(server.url).get('/api/me');
    assert.equal(r.body.needsClaim, true);
    assert.equal(r.body.user, null);
  });

  it('keeps everything behind sign-in', async () => {
    const r = await new Client(server.url).get('/api/decks');
    assert.equal(r.status, 401);
  });

  it('claims the instance as superadmin, once', async () => {
    ada = await claim(server);
    const me = await ada.get('/api/me');
    assert.equal(me.body.user.username, 'ada');
    assert.equal(me.body.user.name, 'Ada Lovelace');
    assert.equal(me.body.user.isAdmin, true);
    const again = await new Client(server.url).post(`/api/claim/${server.claimToken}`, { username: 'eve', email: 'eve@example.com', password: 'correct-horse-battery' });
    assert.equal(again.status, 410);
  });

  it('signs in with a password and rejects a wrong one', async () => {
    const ok = await new Client(server.url).post('/api/login/password', { login: 'ada', password: 'correct-horse-battery' });
    assert.equal(ok.status, 200);
    const bad = await new Client(server.url).post('/api/login/password', { login: 'ada', password: 'nope-nope-nope' });
    assert.equal(bad.status, 401);
    // a failed attempt briefly locks out further password tries from the same address
    const retry = await new Client(server.url).post('/api/login/password', { login: 'ada', password: 'correct-horse-battery' });
    assert.equal(retry.status, 429);
  });

  it('needs an invite to register', async () => {
    const r = await new Client(server.url).post('/api/register', { username: 'mallory', email: 'm@example.com', password: 'correct-horse-battery' });
    assert.equal(r.status, 403);
  });

  it('registers someone with an invite', async () => {
    bob = await invitePerson(ada, { username: 'bob', email: 'bob@example.com', name: 'Bob', password: 'correct-horse-battery' });
    const me = await bob.get('/api/me');
    assert.equal(me.body.user.username, 'bob');
    assert.equal(me.body.user.isAdmin, false);
  });

  it('keeps instance admin to superadmins', async () => {
    assert.equal((await bob.get('/api/admin/users')).status, 403);
    assert.equal((await ada.get('/api/admin/users')).status, 200);
  });
});

describe('decks, cards and studying', () => {
  let deckId, cardIds;

  it('creates a deck and adds cards', async () => {
    const d = await ada.post('/api/decks', { name: 'Capitals' });
    assert.equal(d.status, 200);
    deckId = d.body.id;
    cardIds = [];
    for (const [front, back] of [['France', 'Paris'], ['Japan', 'Tokyo'], ['Peru', 'Lima']]) {
      const c = await ada.post(`/api/decks/${deckId}/cards`, { front, back });
      assert.equal(c.status, 200);
      cardIds.push(c.body.id);
    }
    const list = await ada.get(`/api/decks/${deckId}/cards`);
    assert.equal(list.body.length, 3);
  });

  it('turns a cloze note into one card per number', async () => {
    const c = await ada.post(`/api/decks/${deckId}/cards`, { kind: 'cloze', front: '{{c1::Paris}} is the capital of {{c2::France}}' });
    assert.equal(c.status, 200);
    const list = await ada.get(`/api/decks/${deckId}/cards`);
    assert.equal(list.body.filter((x) => x.kind === 'cloze').length, 2);
  });

  it('studies: next card, rate it, undo it', async () => {
    const first = await ada.get(`/api/study/${deckId}`);
    assert.equal(first.status, 200);
    assert.ok(first.body.card, 'a card is due');
    const newBefore = first.body.counts.new;

    const ans = await ada.post(`/api/study/${deckId}/answer`, { cardId: first.body.card.id, rating: 3 });
    assert.equal(ans.status, 200);
    assert.equal(ans.body.counts.new, newBefore - 1);
    assert.notEqual(ans.body.card?.id, first.body.card.id, 'moves on to another card');

    const undo = await ada.post(`/api/study/${deckId}/undo`);
    assert.equal(undo.status, 200);
    assert.equal(undo.body.card.id, first.body.card.id);
    assert.equal(undo.body.counts.new, newBefore);
  });

  it('rejects a rating outside 1–4', async () => {
    const r = await ada.post(`/api/study/${deckId}/answer`, { cardId: cardIds[0], rating: 7 });
    assert.equal(r.status, 400);
  });

  it('counts reviews in stats', async () => {
    const card = (await ada.get(`/api/study/${deckId}`)).body.card;
    await ada.post(`/api/study/${deckId}/answer`, { cardId: card.id, rating: 3 });
    const s = await ada.get('/api/stats');
    assert.equal(s.status, 200);
    assert.equal(s.body.today.reviews, 1);
    assert.equal(s.body.streak, 1);
  });

  it("keeps each person's library private", async () => {
    assert.deepEqual((await bob.get('/api/decks')).body, []);
    assert.equal((await bob.get(`/api/decks/${deckId}`)).status, 404);
    assert.equal((await bob.get(`/api/decks/${deckId}/cards`)).status, 404);
    assert.equal((await bob.get(`/api/study/${deckId}`)).status, 404);
    assert.equal((await bob.post(`/api/study/all/answer`, { cardId: cardIds[0], rating: 1 })).status, 404);
    assert.equal((await bob.patch(`/api/cards/${cardIds[0]}`, { front: 'hacked' })).status, 404);
    assert.equal((await bob.del(`/api/decks/${deckId}`)).status, 404);
    assert.equal((await ada.get(`/api/decks/${deckId}`)).status, 200, 'still there for its owner');
  });
});

describe('type-in cards and image occlusion', () => {
  // a real 1×1 PNG
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  let deckId, image;

  before(async () => { deckId = (await ada.post('/api/decks', { name: 'Kinds' })).body.id; });

  it('creates type-in cards, which need an answer', async () => {
    const ok = await ada.post(`/api/decks/${deckId}/cards`, { kind: 'typein', front: 'Capital of Peru?', back: 'Lima' });
    assert.equal(ok.status, 200);
    const card = (await ada.get(`/api/decks/${deckId}/cards`)).body.find((c) => c.id === ok.body.id);
    assert.equal(card.kind, 'typein');
    assert.equal((await ada.post(`/api/decks/${deckId}/cards`, { kind: 'typein', front: 'Empty?', back: ' ' })).status, 400);
  });

  it('imports type-in cards from JSON', async () => {
    const r = await ada.post('/api/import/json', { deck: 'Kinds', cards: [{ front: 'Capital of Kenya?', back: 'Nairobi', typeIn: true }] });
    assert.equal(r.body.added, 1);
    const kinds = (await ada.get(`/api/decks/${deckId}/cards`)).body.map((c) => c.kind);
    assert.deepEqual(kinds.filter((k) => k === 'typein').length, 2);
  });

  it('uploads images, private to their owner', async () => {
    const r = await ada.upload('/api/media', PNG, 'diagram.png', 'image/png');
    assert.equal(r.status, 200);
    image = r.body.url;
    assert.match(image, /^\/media\/upload\/[\w-]+\.png$/);
    const own = await ada.get(image);
    assert.equal(own.status, 200);
    assert.equal(own.headers.get('content-type'), 'image/png');
    assert.equal((await bob.get(image)).status, 404);
    assert.equal((await ada.upload('/api/media', Buffer.from('hi'), 'notes.txt', 'text/plain')).status, 400);
  });

  it('makes one card per box number, and syncs cards when boxes change', async () => {
    const masks = [{ x: 0.1, y: 0.1, w: 0.2, h: 0.2, n: 1 }, { x: 0.5, y: 0.5, w: 0.2, h: 0.2, n: 2 }, { x: 0.8, y: 0.1, w: 0.1, h: 0.1, n: 1 }];
    const r = await ada.post(`/api/decks/${deckId}/cards`, { kind: 'occlusion', front: JSON.stringify({ image, mode: 'all', masks }), back: 'Heart' });
    assert.equal(r.status, 200);
    assert.equal(r.body.ids.length, 2, 'boxes sharing a number are one card');
    const upd = await ada.patch(`/api/cards/${r.body.ids[0]}`, { front: JSON.stringify({ image, mode: 'one', masks: masks.slice(0, 1) }) });
    assert.deepEqual([upd.body.added, upd.body.removed], [0, 1]);
    const left = (await ada.get(`/api/decks/${deckId}/cards`)).body.filter((c) => c.kind === 'occlusion');
    assert.equal(left.length, 1);
    assert.equal(JSON.parse(left[0].front).mode, 'one');
  });

  it('rejects occlusion without boxes or with an outside image', async () => {
    const none = await ada.post(`/api/decks/${deckId}/cards`, { kind: 'occlusion', front: JSON.stringify({ image, masks: [] }) });
    assert.equal(none.status, 400);
    const outside = await ada.post(`/api/decks/${deckId}/cards`, { kind: 'occlusion', front: JSON.stringify({ image: 'https://example.com/x.png', masks: [{ x: 0, y: 0, w: 0.5, h: 0.5 }] }) });
    assert.equal(outside.status, 400);
    assert.match(outside.body.error, /uploaded to Recall/);
  });
});

describe('JSON import and API tokens', () => {
  let token;
  const deck = { deck: 'Verbs', folder: 'Languages/Spanish', cards: [['hablar', 'to speak'], { front: 'comer', back: 'to eat' }, { cloze: 'Yo {{c1::hablo}}' }] };

  it('imports a deck into a new folder, and skips cards it already has on re-import', async () => {
    const first = await ada.post('/api/import/json', deck);
    assert.equal(first.status, 200);
    assert.equal(first.body.added, 3);
    assert.equal(first.body.decks[0].folder, 'Languages/Spanish');
    const again = await ada.post('/api/import/json', { ...deck, cards: [...deck.cards, ['vivir', 'to live']] });
    assert.equal(again.body.added, 1);
    assert.equal(again.body.skipped, 3);
    const folders = (await ada.get('/api/folders')).body.map((f) => f.name).sort();
    assert.deepEqual(folders, ['Languages', 'Spanish']);
  });

  it('explains every problem in invalid JSON', async () => {
    const r = await ada.post('/api/import/json', { deck: 'Bad', cards: [{ back: 'no front' }, { cloze: 'no blanks' }] });
    assert.equal(r.status, 400);
    assert.equal(r.body.errors.length, 2);
    assert.match(r.body.errors[0], /cards\[0\]\.front/);
  });

  it('creates an API token that can import and list, nothing else', async () => {
    token = (await ada.post('/api/account/tokens', { name: 'agent' })).body.token;
    assert.match(token, /^rk_/);
    const agent = new Client(server.url);
    agent.headers.authorization = `Bearer ${token}`;
    assert.equal((await agent.get('/api/decks')).status, 200);
    assert.equal((await agent.post('/api/import/json', { deck: 'From agent', cards: [['a', 'b']] })).status, 200);
    const deckId = (await ada.get('/api/decks')).body[0].id;
    assert.equal((await agent.del(`/api/decks/${deckId}`)).status, 401, 'no deleting');
    assert.equal((await agent.get('/api/stats')).status, 401, 'no other routes');
    assert.equal((await agent.get('/api/account')).status, 401, 'no account access');
  });

  it('rejects a revoked token', async () => {
    const list = (await ada.get('/api/account/tokens')).body;
    await ada.del(`/api/account/tokens/${list[0].id}`);
    const agent = new Client(server.url);
    agent.headers.authorization = `Bearer ${token}`;
    assert.equal((await agent.get('/api/decks')).status, 401);
  });
});

describe('signing out', () => {
  it('ends the session', async () => {
    assert.equal((await bob.get('/api/decks')).status, 200);
    assert.equal((await bob.post('/api/logout')).status, 200);
    assert.equal((await bob.get('/api/decks')).status, 401);
  });
});
