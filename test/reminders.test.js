// Slack reminders against a fake Slack API: linking by email or member ID, a test message, and the daily nudge.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { claim, startServer } from './helpers.js';

let server, ada, slack;
const calls = [];

before(async () => {
  slack = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const method = req.url.replace(/^\/api\//, '');
      const params = Object.fromEntries(new URLSearchParams(body));
      calls.push({ method, params, auth: req.headers.authorization });
      const reply = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
      if (method === 'users.lookupByEmail') return reply(params.email === 'ada@example.com' ? { ok: true, user: { id: 'U0ADA1234', real_name: 'Ada L' } } : { ok: false, error: 'users_not_found' });
      if (method === 'users.info') return reply(params.user === 'U0BOB5678' ? { ok: true, user: { id: 'U0BOB5678', name: 'bob' } } : { ok: false, error: 'user_not_found' });
      if (method === 'chat.postMessage') return reply({ ok: true, ts: '1.0' });
      reply({ ok: false, error: 'unknown_method' });
    });
  });
  await new Promise((r) => slack.listen(0, '127.0.0.1', r));
  process.env.SLACK_BOT_TOKEN = 'xoxb-test';
  process.env.SLACK_API_URL = `http://127.0.0.1:${slack.address().port}/api`;
  process.env.REMINDER_TICK_MS = '150';
  server = await startServer();
  delete process.env.SLACK_BOT_TOKEN; delete process.env.SLACK_API_URL; delete process.env.REMINDER_TICK_MS;
  ada = await claim(server);
  await ada.post('/api/import/json', { deck: 'Due', cards: [['one', '1'], ['two', '2']] });
});
after(async () => { await server?.stop(); slack?.close(); });

describe('Slack reminders', () => {
  it('says Slack is available and nothing is linked yet', async () => {
    const r = (await ada.get('/api/account/reminders')).body;
    assert.equal(r.slackConfigured, true);
    assert.equal(r.slackUser, null);
    assert.equal(r.summary.due, 2);
  });

  it('won’t turn reminders on before Slack is linked', async () => {
    assert.equal((await ada.patch('/api/account/reminders', { enabled: true })).status, 400);
  });

  it('links Slack by the account email, or by member ID', async () => {
    let r = await ada.post('/api/account/reminders/slack', {});
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.slackUser, { id: 'U0ADA1234', name: 'Ada L', team: null });
    assert.equal(calls.at(-1).auth, 'Bearer xoxb-test');
    r = await ada.post('/api/account/reminders/slack', { memberId: 'U0NOPE000' });
    assert.equal(r.status, 502);
    assert.match(r.body.error, /No Slack member/);
    r = await ada.post('/api/account/reminders/slack', { memberId: 'U0BOB5678' });
    assert.equal(r.body.slackUser.id, 'U0BOB5678');
    await ada.post('/api/account/reminders/slack', {});
  });

  it('sends a test message as a DM', async () => {
    const r = await ada.post('/api/account/reminders/test');
    assert.equal(r.body.sent, true);
    const post = calls.filter((c) => c.method === 'chat.postMessage').at(-1);
    assert.equal(post.params.channel, 'U0ADA1234');
    assert.match(JSON.parse(post.params.blocks)[0].text.text, /\*2 cards due\*/);
  });

  it('nudges once a day when the reminder time has passed', async () => {
    await ada.patch('/api/account/study', { timezone: 'UTC' });
    const before = calls.filter((c) => c.method === 'chat.postMessage').length;
    const r = await ada.patch('/api/account/reminders', { enabled: true, time: '00:00' });
    assert.equal(r.body.enabled, true);
    await new Promise((res) => setTimeout(res, 800)); // several ticks
    const sent = calls.filter((c) => c.method === 'chat.postMessage').length - before;
    assert.equal(sent, 1, 'exactly one reminder today');
    assert.match((await ada.get('/api/account/reminders')).body.lastSent, /^\d{4}-\d{2}-\d{2}$/);
  });

  it('unlinks Slack and turns reminders off', async () => {
    const r = (await ada.del('/api/account/reminders/slack')).body;
    assert.equal(r.slackUser, null);
    assert.equal(r.enabled, false);
  });
});
