// Test helpers: start a real Recall server on a throwaway database, and a tiny HTTP client with a cookie jar.
//
// Databases: SQLite in a fresh temp folder by default. To run against Postgres, set TEST_DATABASE_URL
// (never DATABASE_URL): that database is WIPED before each test file, so point it at a scratch database.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.unref();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

async function resetPostgres(url) {
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await client.end();
}

/** Starts `node server/index.js` and resolves once it's listening and has printed its claim link. */
export async function startServer() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-test-'));
  const testDb = process.env.TEST_DATABASE_URL || '';
  if (testDb) await resetPostgres(testDb);
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), DATA_DIR: dataDir, PUBLIC_URL: '', TZ: 'UTC', NODE_ENV: 'test' };
  delete env.DATABASE_URL; // never touch a developer's real database
  if (testDb) env.DATABASE_URL = testDb;

  const proc = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  proc.stdout.on('data', (d) => { logs += d; });
  proc.stderr.on('data', (d) => { logs += d; });

  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  let claimToken = null;
  while (!claimToken) {
    if (proc.exitCode !== null) throw new Error(`Server exited early:\n${logs}`);
    if (Date.now() > deadline) { proc.kill(); throw new Error(`Server didn't start in time:\n${logs}`); }
    claimToken = /\/claim\/([A-Za-z0-9_-]+)/.exec(logs)?.[1] ?? null;
    if (!claimToken) await new Promise((r) => setTimeout(r, 50));
  }
  return {
    url,
    claimToken,
    logs: () => logs,
    async stop() {
      if (proc.exitCode === null) {
        proc.kill('SIGTERM');
        await new Promise((r) => { proc.once('exit', r); setTimeout(r, 3000); });
      }
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** A browser-like client: keeps cookies between requests, sends and parses JSON. */
export class Client {
  constructor(base) { this.base = base; this.cookies = new Map(); this.headers = {}; }

  async req(method, url, body, headers = {}) {
    const h = { ...this.headers, ...headers };
    if (body !== undefined && !h['content-type']) h['content-type'] = 'application/json';
    if (this.cookies.size) h.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(this.base + url, {
      method, headers: h, redirect: 'manual',
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const k = pair.slice(0, i), v = pair.slice(i + 1);
      if (!v || /Expires=Thu, 01 Jan 1970/i.test(c) || /Max-Age=0\b/i.test(c)) this.cookies.delete(k);
      else this.cookies.set(k, v);
    }
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: res.status, body: json ?? text, headers: res.headers };
  }
  /** multipart upload of one file field named "file" */
  async upload(url, data, name, type) {
    const form = new FormData();
    form.append('file', new Blob([data], { type }), name);
    const headers = this.cookies.size ? { cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } : {};
    const res = await fetch(this.base + url, { method: 'POST', headers: { ...this.headers, ...headers }, body: form });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: res.status, body: json ?? text, headers: res.headers };
  }
  get(url, h) { return this.req('GET', url, undefined, h); }
  post(url, body = {}, h) { return this.req('POST', url, body, h); }
  patch(url, body = {}, h) { return this.req('PATCH', url, body, h); }
  del(url, h) { return this.req('DELETE', url, undefined, h); }
}

/** Claims the instance (first account = superadmin) and returns a signed-in client. */
export async function claim(server, who = { username: 'ada', email: 'ada@example.com', name: 'Ada Lovelace', password: 'correct-horse-battery' }) {
  const c = new Client(server.url);
  const r = await c.post(`/api/claim/${server.claimToken}`, who);
  if (r.status !== 200) throw new Error(`claim failed: ${r.status} ${JSON.stringify(r.body)}`);
  return c;
}

/** Uses an admin client to invite and register another account; returns that person's signed-in client. */
export async function invitePerson(admin, who) {
  const inv = await admin.post('/api/admin/invites', { note: 'test' });
  if (inv.status !== 200) throw new Error(`invite failed: ${inv.status} ${JSON.stringify(inv.body)}`);
  const token = inv.body.url.split('/invite/')[1];
  const c = new Client(admin.base);
  const r = await c.post('/api/register', { inviteToken: token, ...who });
  if (r.status !== 200) throw new Error(`register failed: ${r.status} ${JSON.stringify(r.body)}`);
  return c;
}
