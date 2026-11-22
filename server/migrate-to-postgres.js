// Copy an existing Recall SQLite database (and its media) into an empty Postgres database.
//
//   DATABASE_URL=postgres://user:pass@host:5432/recall node server/migrate-to-postgres.js [path/to/recall.db]
//
// The SQLite file defaults to $DATA_DIR/recall.db (./data/recall.db). Nothing in it is changed.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

if (!process.env.DATABASE_URL) {
  console.error('Set DATABASE_URL to the Postgres database to copy into.');
  process.exit(1);
}
const dataDir = path.resolve(process.env.DATA_DIR || './data');
const file = path.resolve(process.argv[2] || path.join(dataDir, 'recall.db'));
if (!fs.existsSync(file)) { console.error(`No SQLite database at ${file}`); process.exit(1); }

const { db } = await import('./store.js');
const { initDb } = await import('./db.js');
const { mimeFor } = await import('./media.js');

await initDb(); // create tables in Postgres
const src = new Database(file, { readonly: true });
// make sure the source has every column the current version expects (it may be from an older release)
const srcCols = (t) => new Set(src.prepare(`SELECT name FROM pragma_table_info('${t}')`).all().map((r) => r.name));
const hasTable = (t) => !!src.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?`).get(t);

const existing = (await db.get('SELECT COUNT(*) AS n FROM cards')).n + (await db.get('SELECT COUNT(*) AS n FROM decks')).n;
if (existing && !process.argv.includes('--force')) {
  console.error('The Postgres database already has decks/cards. Use an empty database (or pass --force to add to it anyway).');
  process.exit(1);
}

// order matters for foreign keys
const TABLES = ['folders', 'decks', 'cards', 'reviews', 'redo_stack', 'settings', 'media'];
const pgCols = async (t) => new Set((await db.all('SELECT column_name FROM information_schema.columns WHERE table_name = ?', t)).map((r) => r.column_name));

await db.tx(async () => {
  for (const t of TABLES) {
    if (!hasTable(t)) continue;
    const target = await pgCols(t);
    const cols = [...srcCols(t)].filter((c) => target.has(c));
    let rows = src.prepare(`SELECT ${cols.join(', ')} FROM ${t}`).all();
    if (t === 'folders') rows = orderFolders(rows); // parents before children
    const sql = `INSERT INTO ${t} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) ON CONFLICT DO NOTHING`;
    for (const r of rows) await db.run(sql, ...cols.map((c) => r[c]));
    console.log(`  ${t}: ${rows.length}`);
    // keep Postgres id sequences ahead of the copied ids
    if (cols.includes('id')) await db.exec(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), COALESCE((SELECT MAX(id) FROM ${t}), 0) + 1, false)`);
  }

  // media files saved on disk by older versions
  const mediaDir = path.join(path.dirname(file), 'media');
  let files = 0;
  if (fs.existsSync(mediaDir)) {
    for (const prefix of fs.readdirSync(mediaDir)) {
      const dir = path.join(mediaDir, prefix);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const name of fs.readdirSync(dir)) {
        await db.run('INSERT INTO media (path, mime, data) VALUES (?,?,?) ON CONFLICT DO NOTHING', `${prefix}/${name}`, mimeFor(name), fs.readFileSync(path.join(dir, name)));
        files++;
      }
    }
  }
  console.log(`  media files from disk: ${files}`);
});

function orderFolders(rows) {
  const out = [], done = new Set();
  while (out.length < rows.length) {
    const before = out.length;
    for (const r of rows) if (!done.has(r.id) && (r.parent_id == null || done.has(r.parent_id))) { out.push(r); done.add(r.id); }
    if (out.length === before) break; // broken parent links: stop rather than loop
  }
  return out;
}

src.close();
await db.close();
console.log(`Done: copied ${file} into ${db.describe()}.`);
