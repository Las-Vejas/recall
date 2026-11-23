// MCP server (/mcp): protocol handling, auth, every tool, and that one person's token can't reach another's library.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Client, claim, invitePerson, startServer } from './helpers.js';

let server, ada, mcp, bobMcp;
let nextId = 1;

/** JSON-RPC call over /mcp with the given client; returns the raw HTTP response. */
const rpc = (client, method, params) => client.post('/mcp', { jsonrpc: '2.0', id: nextId++, method, ...(params ? { params } : {}) });
/** Calls a tool and returns its result ({ structuredContent, isError, content }). */
async function tool(client, name, args = {}) {
  const r = await rpc(client, 'tools/call', { name, arguments: args });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.result;
}
async function tokenClient(owner) {
  const token = (await owner.post('/api/account/tokens', { name: 'mcp' })).body.token;
  const c = new Client(server.url);
  c.headers.authorization = `Bearer ${token}`;
  return c;
}

before(async () => {
  server = await startServer();
  ada = await claim(server);
  mcp = await tokenClient(ada);
  const bob = await invitePerson(ada, { username: 'bob', email: 'bob@example.com', name: 'Bob', password: 'correct-horse-battery' });
  bobMcp = await tokenClient(bob);
});
after(async () => { await server?.stop(); });

describe('protocol', () => {
  it('needs an API token', async () => {
    const r = await rpc(new Client(server.url), 'ping');
    assert.equal(r.status, 401);
    assert.match(r.headers.get('www-authenticate'), /Bearer/);
  });

  it('ignores browser cookies (a signed-in session alone is not enough)', async () => {
    assert.equal((await rpc(ada, 'ping')).status, 401);
  });

  it('initializes, echoing a supported protocol version', async () => {
    const r = await rpc(mcp, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.equal(r.body.result.protocolVersion, '2025-06-18');
    assert.equal(r.body.result.serverInfo.name, 'recall');
    assert.ok(r.body.result.capabilities.tools);
    const odd = await rpc(mcp, 'initialize', { protocolVersion: '1999-01-01' });
    assert.match(odd.body.result.protocolVersion, /^\d{4}-\d{2}-\d{2}$/);
  });

  it('accepts notifications with 202 and no body', async () => {
    const r = await mcp.post('/mcp', { jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.equal(r.status, 202);
  });

  it('lists the tools', async () => {
    const names = (await rpc(mcp, 'tools/list')).body.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['add_cards', 'answer_card', 'get_stats', 'import_decks', 'list_decks', 'next_card', 'search_cards', 'undo_answer']);
  });

  it('handles batches, unknown methods, bad JSON and GET', async () => {
    const batch = await mcp.post('/mcp', [{ jsonrpc: '2.0', id: 'a', method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/x' }]);
    assert.deepEqual(batch.body, [{ jsonrpc: '2.0', id: 'a', result: {} }]);
    assert.equal((await rpc(mcp, 'nope')).body.error.code, -32601);
    const bad = await mcp.req('POST', '/mcp', '{not json', { 'content-type': 'application/json' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, -32700);
    assert.equal((await mcp.get('/mcp')).status, 405);
  });
});

describe('tools', () => {
  let deckId;

  it('import_decks creates decks and folders', async () => {
    const r = await tool(mcp, 'import_decks', { decks: [{ deck: 'Chemistry', folder: 'Science', cards: [['pKa of water', '15.7'], { cloze: 'An {{c1::SN2}} reaction inverts' }] }] });
    assert.equal(r.isError, undefined);
    assert.equal(r.structuredContent.added, 2);
    deckId = r.structuredContent.decks[0].deckId;
  });

  it('import_decks reports validation errors as a tool error', async () => {
    const r = await tool(mcp, 'import_decks', { decks: [{ deck: 'Bad', cards: [{ back: 'x' }] }] });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /front: required/);
  });

  it('add_cards adds to a deck by id and skips duplicates', async () => {
    const r = await tool(mcp, 'add_cards', { deck_id: deckId, cards: [['pKa of water', 'dup'], ['Avogadro', '6.022e23']] });
    assert.equal(r.structuredContent.added, 1);
    assert.equal(r.structuredContent.skipped, 1);
  });

  it('list_decks shows decks, folders and due counts', async () => {
    const r = (await tool(mcp, 'list_decks')).structuredContent;
    assert.equal(r.decks.length, 1);
    assert.equal(r.decks[0].folder, 'Science');
    assert.equal(r.decks[0].cards, 3);
    assert.equal(r.decks[0].dueNow.new, 3);
    assert.deepEqual(r.folders.map((f) => f.path), ['Science']);
  });

  it('search_cards finds text and hides the tested cloze', async () => {
    const r = (await tool(mcp, 'search_cards', { query: 'SN2' })).structuredContent;
    assert.equal(r.total, 1);
    assert.equal(r.cards[0].question, 'An […] reaction inverts');
    assert.match(r.cards[0].answer, /\*\*SN2\*\*/);
  });

  it('next_card → answer_card → undo_answer', async () => {
    const next = (await tool(mcp, 'next_card', { deck_id: deckId })).structuredContent;
    assert.ok(next.card.question);
    assert.deepEqual(Object.keys(next.card.nextIntervalIf), ['again', 'hard', 'good', 'easy']);
    const ans = (await tool(mcp, 'answer_card', { card_id: next.card.id, rating: 'good' })).structuredContent;
    assert.equal(ans.state, 'learning');
    assert.equal((await tool(mcp, 'get_stats')).structuredContent.today.reviews, 1);
    const undo = (await tool(mcp, 'undo_answer', { deck_id: deckId })).structuredContent;
    assert.equal(undo.card_id, next.card.id);
    assert.equal((await tool(mcp, 'get_stats')).structuredContent.today.reviews, 0);
    assert.equal((await tool(mcp, 'undo_answer')).isError, true, 'nothing left to undo');
  });

  it('rejects a bad rating', async () => {
    const next = (await tool(mcp, 'next_card')).structuredContent;
    assert.equal((await tool(mcp, 'answer_card', { card_id: next.card.id, rating: 'meh' })).isError, true);
  });

  it("can't reach another person's library", async () => {
    assert.deepEqual((await tool(bobMcp, 'list_decks')).structuredContent.decks, []);
    assert.equal((await tool(bobMcp, 'search_cards', { query: '' })).structuredContent.total, 0);
    assert.equal((await tool(bobMcp, 'add_cards', { deck_id: deckId, cards: [['x', 'y']] })).isError, true);
    assert.equal((await tool(bobMcp, 'next_card', { deck_id: deckId })).isError, true);
    const adaCard = (await tool(mcp, 'next_card')).structuredContent.card.id;
    assert.equal((await tool(bobMcp, 'answer_card', { card_id: adaCard, rating: 'easy' })).isError, true);
  });
});
