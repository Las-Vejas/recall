import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
export const MEDIA_DIR = path.join(DATA_DIR, 'media');
fs.mkdirSync(MEDIA_DIR, { recursive: true });

export const db = new Database(path.join(DATA_DIR, 'recall.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS decks (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  color       TEXT NOT NULL DEFAULT '#7c5cff',
  new_per_day INTEGER NOT NULL DEFAULT 20,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cards (
  id         INTEGER PRIMARY KEY,
  deck_id    INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
  front      TEXT NOT NULL,
  back       TEXT NOT NULL,
  format     TEXT NOT NULL DEFAULT 'md',   -- 'md' | 'html'
  tags       TEXT NOT NULL DEFAULT '',
  css        TEXT NOT NULL DEFAULT '',
  suspended  INTEGER NOT NULL DEFAULT 0,
  state      INTEGER NOT NULL DEFAULT 0,   -- FSRS State: 0 new, 1 learning, 2 review, 3 relearning
  due        INTEGER NOT NULL,             -- ms epoch, denormalised from fsrs json for indexing
  fsrs       TEXT NOT NULL,                -- serialised ts-fsrs Card
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS cards_deck_due ON cards(deck_id, suspended, state, due);

CREATE TABLE IF NOT EXISTS reviews (
  id          INTEGER PRIMARY KEY,
  card_id     INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  deck_id     INTEGER NOT NULL,
  rating      INTEGER NOT NULL,
  prev_state  INTEGER NOT NULL,
  prev_fsrs   TEXT NOT NULL,               -- for undo
  interval_ms INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  reviewed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS reviews_time ON reviews(reviewed_at);
CREATE INDEX IF NOT EXISTS reviews_card ON reviews(card_id);
`);

// ---- folders (added later; migrate older databases in place) ----
db.exec(`
CREATE TABLE IF NOT EXISTS folders (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  parent_id  INTEGER REFERENCES folders(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
`);
if (!db.prepare(`SELECT 1 FROM pragma_table_info('decks') WHERE name = 'folder_id'`).get()) {
  db.exec('ALTER TABLE decks ADD COLUMN folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL');
}

// ---- cloze notes (added later): one note's text produces one card per cloze number ----
for (const [col, def] of [['kind', "TEXT NOT NULL DEFAULT 'basic'"], ['cloze_ord', 'INTEGER'], ['note_id', 'TEXT']]) {
  if (!db.prepare(`SELECT 1 FROM pragma_table_info('cards') WHERE name = ?`).get(col)) db.exec(`ALTER TABLE cards ADD COLUMN ${col} ${def}`);
}
db.exec('CREATE INDEX IF NOT EXISTS cards_note ON cards(note_id)');

// ---- redo stack: what an undo removed, so it can be put back exactly (cleared by any new rating) ----
db.exec(`CREATE TABLE IF NOT EXISTS redo_stack (
  id         INTEGER PRIMARY KEY,
  card_id    INTEGER NOT NULL,
  deck_id    INTEGER NOT NULL,
  review     TEXT NOT NULL,   -- the deleted reviews row, as JSON
  next_fsrs  TEXT NOT NULL,   -- the card's state after that review
  next_state INTEGER NOT NULL,
  next_due   INTEGER NOT NULL
)`);
