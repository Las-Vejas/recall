// One async database API on top of SQLite (default) or Postgres (when DATABASE_URL is set).
//
// Write SQL in the SQLite style: "?" placeholders, `IS ?` for null-safe equality, LIKE for case-insensitive
// matching, `x COLLATE NOCASE` for case-insensitive ordering. For Postgres these are translated automatically.
// JSON fields: use db.json('c.fsrs', 'stability') to get a number out of a JSON text column.
import Database from 'better-sqlite3';
import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';

const URL = process.env.DATABASE_URL || '';
export const DIALECT = URL ? 'pg' : 'sqlite';
export const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');

const txContext = new AsyncLocalStorage();

// ---------------- SQL translation (SQLite style -> Postgres) ----------------
const translated = new Map();
function toPg(sql) {
  let out = translated.get(sql);
  if (out) return out;
  let n = 0, inStr = false, res = '';
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'") inStr = !inStr;
    if (ch === '?' && !inStr) { res += `$${++n}`; continue; }
    res += ch;
  }
  res = res
    .replace(/\bIS \$(\d+)/g, 'IS NOT DISTINCT FROM $$$1')
    .replace(/\bLIKE\b/g, 'ILIKE')
    .replace(/([\w.]+) COLLATE NOCASE/g, 'lower($1)')
    .replace(/\bWHERE 1 /g, 'WHERE TRUE ');
  translated.set(sql, res);
  return res;
}

// ---------------- SQLite backend ----------------
function sqliteBackend() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const conn = new Database(path.join(DATA_DIR, 'recall.db'));
  conn.pragma('journal_mode = WAL');
  conn.pragma('foreign_keys = ON');
  const stmts = new Map();
  const prep = (sql) => { let s = stmts.get(sql); if (!s) { s = conn.prepare(sql); stmts.set(sql, s); } return s; };

  // better-sqlite3 is synchronous and has one connection, but our transactions are async functions.
  // A lock keeps other requests' statements out of an open transaction.
  let lock = Promise.resolve();
  let txOpen = false;
  const waitTurn = async () => { while (txOpen && !txContext.getStore()) await lock; };

  return {
    async all(sql, params) { await waitTurn(); return prep(sql).all(...params); },
    async get(sql, params) { await waitTurn(); return prep(sql).get(...params); },
    async run(sql, params) { await waitTurn(); const r = prep(sql).run(...params); return { changes: r.changes }; },
    async insert(sql, params) { await waitTurn(); return Number(prep(sql).run(...params).lastInsertRowid); },
    async exec(sql) { await waitTurn(); conn.exec(sql); },
    async tx(fn) {
      if (txContext.getStore()) return fn(); // already inside one: join it
      const prev = lock;
      let release;
      lock = new Promise((r) => { release = r; });
      await prev;
      txOpen = true;
      try {
        return await txContext.run({}, async () => {
          conn.exec('BEGIN IMMEDIATE');
          try { const r = await fn(); conn.exec('COMMIT'); return r; }
          catch (e) { conn.exec('ROLLBACK'); throw e; }
        });
      } finally { txOpen = false; release(); }
    },
    async hasColumn(table, col) { return !!conn.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name = ?`).get(col); },
    close() { conn.close(); },
    describe: () => `SQLite at ${path.join(DATA_DIR, 'recall.db')}`,
  };
}

// ---------------- Postgres backend ----------------
function pgBackend() {
  // BIGINT / NUMERIC come back as strings by default; our values (ids, ms timestamps, counts) fit in a JS number.
  pg.types.setTypeParser(20, (v) => Number(v));
  pg.types.setTypeParser(1700, (v) => Number(v));
  const ssl = /sslmode=(require|verify)/.test(URL) || process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: process.env.DATABASE_SSL_INSECURE !== 'true' } : undefined;
  const pool = new pg.Pool({ connectionString: URL, ssl, max: 10 });
  pool.on('error', (e) => console.error('Postgres pool error:', e.message));
  const client = () => txContext.getStore()?.client ?? pool;
  const q = (sql, params) => client().query(toPg(sql), params);

  return {
    async all(sql, params) { return (await q(sql, params)).rows; },
    async get(sql, params) { return (await q(sql, params)).rows[0]; },
    async run(sql, params) {
      const r = await q(sql, params);
      return { changes: r.rowCount };
    },
    // only db.insert() asks for the new id: not every table has an "id" column (settings, media, auth_links)
    async insert(sql, params) {
      const r = await q(/\bRETURNING\b/i.test(sql) ? sql : `${sql} RETURNING id`, params);
      return r.rows[0]?.id;
    },
    async exec(sql) { await client().query(sql); },
    async tx(fn) {
      if (txContext.getStore()) return fn();
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const r = await txContext.run({ client: c }, fn);
        await c.query('COMMIT');
        return r;
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
      finally { c.release(); }
    },
    async hasColumn(table, col) {
      return !!(await pool.query('SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2', [table, col])).rows[0];
    },
    close() { return pool.end(); },
    describe: () => { try { const u = new globalThis.URL(URL); return `Postgres at ${u.hostname}${u.port ? ':' + u.port : ''}${u.pathname}`; } catch { return 'Postgres'; } },
  };
}

const backend = DIALECT === 'pg' ? pgBackend() : sqliteBackend();

export const db = {
  dialect: DIALECT,
  all: (sql, ...params) => backend.all(sql, params),
  get: (sql, ...params) => backend.get(sql, params),
  run: (sql, ...params) => backend.run(sql, params),
  /** INSERT and return the new row's id. */
  insert: (sql, ...params) => backend.insert(sql, params),
  exec: (sql) => backend.exec(sql),
  tx: (fn) => backend.tx(fn),
  hasColumn: (t, c) => backend.hasColumn(t, c),
  close: () => backend.close(),
  describe: () => backend.describe(),
  /** Numeric value of a key inside a JSON text column, in either dialect. */
  json: (col, key) => (DIALECT === 'pg' ? `((${col})::json->>'${key}')::float8` : `json_extract(${col},'$.${key}')`),
};
