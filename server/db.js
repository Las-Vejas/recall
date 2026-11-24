// Schema + migrations. Works on SQLite (default) and Postgres (DATABASE_URL).
import fs from 'node:fs';
import path from 'node:path';
import { db, DIALECT, DATA_DIR } from './store.js';

export { db, DATA_DIR };
/** Media imported by older versions was stored as files here; new media goes into the database. */
export const MEDIA_DIR = path.join(DATA_DIR, 'media');

const PG = DIALECT === 'pg';
const ID = PG ? 'BIGSERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY';
const BIG = PG ? 'BIGINT' : 'INTEGER'; // ms timestamps and ids
const BLOB = PG ? 'BYTEA' : 'BLOB';

// Inside a container, a SQLite file only survives if DATA_DIR is a mounted volume. Say so loudly if it isn't.
function warnIfNotPersistent() {
  try {
    const inContainer = fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv');
    if (!inContainer || !fs.existsSync('/proc/self/mountinfo')) return;
    const mounted = fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\n').some((l) => l.split(' ')[4] === DATA_DIR);
    if (mounted) return;
    console.warn([
      '',
      '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!',
      `!! WARNING: ${DATA_DIR} is not a mounted volume. Everything you add will be LOST when`,
      '!! this container is removed or recreated. Set DATABASE_URL to use Postgres, or start',
      `!! with ./recall.sh / docker compose, or add  -v recall-data:${DATA_DIR}  to docker run.`,
      '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!',
      '',
    ].join('\n'));
  } catch { /* best effort */ }
}

async function addColumn(table, col, def) {
  if (!(await db.hasColumn(table, col))) await db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}

export async function initDb() {
  if (!PG) warnIfNotPersistent();

  await db.exec(`
CREATE TABLE IF NOT EXISTS folders (
  id         ${ID},
  name       TEXT NOT NULL,
  parent_id  ${BIG} REFERENCES folders(id) ON DELETE CASCADE,
  created_at ${BIG} NOT NULL
);

CREATE TABLE IF NOT EXISTS decks (
  id          ${ID},
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  color       TEXT NOT NULL DEFAULT '#7c5cff',
  new_per_day INTEGER NOT NULL DEFAULT 20,
  created_at  ${BIG} NOT NULL
);

CREATE TABLE IF NOT EXISTS cards (
  id         ${ID},
  deck_id    ${BIG} NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
  front      TEXT NOT NULL,
  back       TEXT NOT NULL,
  format     TEXT NOT NULL DEFAULT 'md',
  tags       TEXT NOT NULL DEFAULT '',
  css        TEXT NOT NULL DEFAULT '',
  suspended  INTEGER NOT NULL DEFAULT 0,
  state      INTEGER NOT NULL DEFAULT 0,
  due        ${BIG} NOT NULL,
  fsrs       TEXT NOT NULL,
  created_at ${BIG} NOT NULL,
  updated_at ${BIG} NOT NULL
);
CREATE INDEX IF NOT EXISTS cards_deck_due ON cards(deck_id, suspended, state, due);

CREATE TABLE IF NOT EXISTS reviews (
  id          ${ID},
  card_id     ${BIG} NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  deck_id     ${BIG} NOT NULL,
  rating      INTEGER NOT NULL,
  prev_state  INTEGER NOT NULL,
  prev_fsrs   TEXT NOT NULL,
  interval_ms ${BIG} NOT NULL,
  duration_ms ${BIG} NOT NULL DEFAULT 0,
  reviewed_at ${BIG} NOT NULL
);
CREATE INDEX IF NOT EXISTS reviews_time ON reviews(reviewed_at);
CREATE INDEX IF NOT EXISTS reviews_card ON reviews(card_id);
CREATE INDEX IF NOT EXISTS reviews_deck_time ON reviews(deck_id, reviewed_at);

CREATE TABLE IF NOT EXISTS redo_stack (
  id         ${ID},
  card_id    ${BIG} NOT NULL,
  deck_id    ${BIG} NOT NULL,
  review     TEXT NOT NULL,
  next_fsrs  TEXT NOT NULL,
  next_state INTEGER NOT NULL,
  next_due   ${BIG} NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS media (
  path TEXT PRIMARY KEY,
  mime TEXT NOT NULL,
  data ${BLOB} NOT NULL
);
`);

  // ---- accounts (multi-user) ----
  await db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            ${ID},
  username      TEXT NOT NULL UNIQUE,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL DEFAULT '',
  password_hash TEXT,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  created_at    ${BIG} NOT NULL,
  last_login_at ${BIG}
);

CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  user_id      ${BIG} NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  method       TEXT NOT NULL DEFAULT '',
  user_agent   TEXT NOT NULL DEFAULT '',
  ip           TEXT NOT NULL DEFAULT '',
  created_at   ${BIG} NOT NULL,
  last_seen_at ${BIG} NOT NULL,
  expires_at   ${BIG} NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS passkeys (
  id           TEXT PRIMARY KEY,
  user_id      ${BIG} NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key   ${BLOB} NOT NULL,
  counter      ${BIG} NOT NULL DEFAULT 0,
  transports   TEXT NOT NULL DEFAULT '',
  name         TEXT NOT NULL DEFAULT 'Passkey',
  created_at   ${BIG} NOT NULL,
  last_used_at ${BIG}
);
CREATE INDEX IF NOT EXISTS passkeys_user ON passkeys(user_id);

CREATE TABLE IF NOT EXISTS identities (
  id         ${ID},
  user_id    ${BIG} NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider   TEXT NOT NULL,
  subject    TEXT NOT NULL,
  email      TEXT NOT NULL DEFAULT '',
  username   TEXT NOT NULL DEFAULT '',
  created_at ${BIG} NOT NULL,
  UNIQUE (provider, subject)
);

CREATE TABLE IF NOT EXISTS auth_providers (
  id            TEXT PRIMARY KEY,
  type          TEXT NOT NULL,
  name          TEXT NOT NULL,
  client_id     TEXT NOT NULL,
  client_secret TEXT NOT NULL,
  issuer        TEXT NOT NULL DEFAULT '',
  scopes        TEXT NOT NULL DEFAULT '',
  allow_signup  INTEGER NOT NULL DEFAULT 0,
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    ${BIG} NOT NULL
);

CREATE TABLE IF NOT EXISTS invites (
  id         ${ID},
  token_hash TEXT NOT NULL UNIQUE,
  note       TEXT NOT NULL DEFAULT '',
  is_admin   INTEGER NOT NULL DEFAULT 0,
  created_by ${BIG} REFERENCES users(id) ON DELETE SET NULL,
  created_at ${BIG} NOT NULL,
  expires_at ${BIG} NOT NULL,
  used_at    ${BIG},
  used_by    ${BIG} REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS api_tokens (
  id           ${ID},
  user_id      ${BIG} NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   ${BIG} NOT NULL,
  last_used_at ${BIG}
);

CREATE TABLE IF NOT EXISTS oauth_clients (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,
  created_at    ${BIG} NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_links (
  token_hash TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  user_id    ${BIG} REFERENCES users(id) ON DELETE CASCADE,
  expires_at ${BIG} NOT NULL,
  used_at    ${BIG}
);
`);

  // columns added after the first release (older SQLite databases are upgraded in place)
  await addColumn('decks', 'folder_id', `${BIG} REFERENCES folders(id) ON DELETE SET NULL`);
  await addColumn('cards', 'kind', "TEXT NOT NULL DEFAULT 'basic'");
  await addColumn('cards', 'cloze_ord', 'INTEGER');
  await addColumn('cards', 'note_id', 'TEXT');
  // flagged while studying, to come back to later (fix a typo, look something up); doesn't change scheduling
  await addColumn('cards', 'flagged', 'INTEGER NOT NULL DEFAULT 0');
  await db.exec('CREATE INDEX IF NOT EXISTS cards_note ON cards(note_id)');
  // reviews brought in from an Anki import: history for FSRS and stats, but not something to undo
  await addColumn('reviews', 'imported', 'INTEGER NOT NULL DEFAULT 0');
  // per-person settings (server/prefs.js) and a per-deck FSRS target retention (NULL = the person's)
  await addColumn('users', 'prefs', 'TEXT');
  await addColumn('decks', 'retention', PG ? 'DOUBLE PRECISION' : 'REAL');
  // every piece of library data belongs to a user (NULL = from before accounts; given to whoever claims the instance)
  for (const t of ['decks', 'folders', 'reviews', 'redo_stack', 'media']) {
    await addColumn(t, 'user_id', `${BIG} REFERENCES users(id) ON DELETE CASCADE`);
    await db.exec(`CREATE INDEX IF NOT EXISTS ${t}_user ON ${t}(user_id)`);
  }
}
