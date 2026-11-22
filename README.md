# Recall

A self-hosted spaced-repetition web app, inspired by Anki, with a nicer study experience.

- **FSRS scheduling** via [ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs), the same algorithm modern Anki uses
- **Anki import**: `.apkg` / `.colpkg`, both the legacy and the new zstd (schema 18) formats. Note types, templates, cloze, conditionals, CSS, images and audio are all brought in
- **Interactive study**: 3D card flip, swipe to rate (← again, → good, ↑ easy, ↓ hard), keyboard shortcuts, interval previews, undo, streak counter, confetti
- **JSON decks for AI agents**: drop or paste a simple JSON file, or let an agent `POST` it with a scoped API token. Re-imports skip existing cards. See [docs/json-format.md](docs/json-format.md)
- **Folders**: nest decks in folders, drag decks/folders to reorganise, study a whole folder at once. Anki's `Parent::Child` decks become real folders on import
- **Markdown cards** with live preview, plus bulk add from spreadsheets (tab/CSV)
- **Cloze cards**: `{{c1::answer}}` / `{{c1::answer::hint}}`, one card per number; select text and press `Ctrl+Shift+C` (add `Alt` to reuse the last number). Editing a note adds/removes its cards to match
- **Stats**: 12-month heatmap, 30-day forecast, streak, 30-day retention
- Single Node process. Built-in SQLite database, or your own Postgres via `DATABASE_URL`.

## Quick start

On any machine with Docker:

```bash
git clone <your-repo-url> recall && cd recall
./recall.sh start
```

Open `http://<your-server>:3000`, choose a password, done.

Your decks, progress and media are stored in a permanent Docker volume called **`recall-data`**. It is created the first time and reused every time after, so restarts, rebuilds and updates never touch your data.

| | |
|---|---|
| Update to new code | `git pull && ./recall.sh update` |
| Logs | `./recall.sh logs` |
| Stop | `./recall.sh stop` |
| Backup | `./recall.sh backup` (saved to `./backups/`) |

Prefer Docker Compose? `docker compose up -d` uses the same `recall-data` volume.

Running `docker run` yourself? Always include the volume, or your data disappears with the container:

```bash
docker run -d --name recall --restart unless-stopped -p 3000:3000 -v recall-data:/data recall:latest
```

(Recall prints a loud warning in its logs if it was started without one.)

> Set your password right after starting: until then, whoever opens the page first gets to choose it.

### Use your own Postgres

Point Recall at any Postgres (self-hosted, Supabase, Neon, RDS…) with `DATABASE_URL`. Tables are created on first start, and everything lives there: decks, progress, settings and imported images/audio. The container itself then holds no data, so you can recreate it freely.

```bash
docker build -t recall .
docker run -d --name recall --restart unless-stopped -p 3000:3000 \
  -e DATABASE_URL="postgres://user:password@your-db-host:5432/recall" \
  recall
```

Or put `DATABASE_URL=...` in `.env` and use `./recall.sh start` / `docker compose up -d`.

- Hosted Postgres usually needs TLS: add `?sslmode=require` to the URL. Certificates are verified; for a self-signed server set `DATABASE_SSL_INSECURE=true`.
- Postgres running on the same machine as Docker: use `host.docker.internal` (Docker Desktop) or the host's IP instead of `localhost`.
- If the connection fails, Recall exits with the reason (wrong password, host unreachable…) in `docker logs recall`.

**Moving existing data into Postgres** (from the built-in SQLite database; the source is only read):

```bash
# data in a Docker volume (./recall.sh / compose):
docker run --rm -v recall-data:/data -e DATABASE_URL="postgres://..." recall node server/migrate-to-postgres.js
# data in a local folder:
DATABASE_URL="postgres://..." npm run migrate:postgres -- ./data/recall.db
```

It copies decks, folders, cards, review history, settings (your password and API token) and media into an empty Postgres database.

### Lost your data after a restart?

Older versions created a new, nameless volume each time the container was recreated. The old data is usually still there:

```bash
./recall.sh recover            # lists volumes that contain Recall data, with deck/card counts
./recall.sh recover <volume>   # copies that data into the permanent volume
```

`./recall.sh start` also tells you about such volumes when it finds the permanent volume empty.

### Settings (all optional)

Copy `.env.example` to `.env` and edit; then `./recall.sh update` (or `docker compose up -d`) again.

| Variable | Default | What it does |
|---|---|---|
| `DATABASE_URL` | *(empty)* | Use this Postgres instead of the built-in SQLite file |
| `RECALL_PORT` | `3000` | Port on the host |
| `TZ` | `UTC` | Your timezone, so "today" and streaks match your day |
| `APP_PASSWORD` | *(empty)* | Fix the password in config instead of the setup screen |
| `DISABLE_AUTH` | *(empty)* | `true` = no login at all (trusted home network only) |
| `TRUST_PROXY` | *(empty)* | `1` when behind one reverse proxy, so client IPs are correct |
| `DESIRED_RETENTION` | `0.9` | FSRS target recall (0.7 to 0.97) |

Forgot the password? Reset it to the setup screen:

```bash
docker exec recall node -e "new (require('better-sqlite3'))('/data/recall.db').prepare(\"DELETE FROM settings WHERE key='password_hash'\").run()"
```

### HTTPS

Put it behind a reverse proxy and set `TRUST_PROXY=1`. With [Caddy](https://caddyserver.com) that's one line in a `Caddyfile`:

```
recall.example.com {
  reverse_proxy localhost:3000
}
```

### Backups

`./recall.sh backup` writes `backups/recall-<date>.tgz` (database + media) while the app keeps running.

## Develop

```bash
npm install && npm --prefix web install
npm run dev:server        # API on :3000 (data in ./data)
npm run dev:web           # Vite on :5173, proxies /api and /media
```

## Shortcuts

| Where | Key | Action |
|---|---|---|
| Home | `Enter` | Study all due |
| Deck | `A` / `S` | Add card / study |
| Study | `Space` / `Enter` | Reveal, then Good |
| Study | `1`–`4` or arrows | Again / Hard / Good / Easy |
| Study | `⌘Z` / `Ctrl+Z` (or `Z`) | Undo last rating |
| Study | `⇧⌘Z` / `Ctrl+Shift+Z` / `Ctrl+Y` | Redo |
| Study | `Esc` | Leave |
| Editor | `⌘/Ctrl + Enter` | Save |
| Editor (cloze) | `Ctrl+Shift+C` / `Ctrl+Alt+Shift+C` | New cloze / same number |

## Layout

```
server/
  index.js      Express API, auth, static hosting
  store.js      Database layer: SQLite or Postgres behind one async API
  db.js         Schema + migrations (both databases)
  media.js      Imported images/audio, stored in the database
  migrate-to-postgres.js  Copy a SQLite database into Postgres
  scheduler.js  FSRS queue (learning > review > new > learn-ahead), answer, undo
  apkg.js       Anki package importer (protobuf + zstd aware)
  jsonImport.js Recall deck JSON: validation + idempotent import
  cloze.js      Cloze notes: create, sync cards on edit
  folders.js    Folder tree helpers + migration of old "A::B" deck names
web/src/
  pages/        Home, Deck (browser/editor), Study, Import, Login
  components/   CardContent (markdown / sandboxed Anki HTML), Charts
```

## Known limitations / next ideas

- Imported Anki cards are stored as rendered HTML per card, not as notes; editing a note's sibling cards is separate.
- Anki review history isn't imported, so imported cards start as new.
- Single user. Multi-user would need a `user_id` on decks.
- Possible next: FSRS parameter optimisation from your review log, image occlusion, type-in answers, PWA/offline mode, AnkiConnect-compatible API.
