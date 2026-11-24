# Recall

A self-hosted spaced-repetition web app, inspired by Anki, with a nicer study experience.

- **FSRS scheduling** via [ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs), the same algorithm modern Anki uses
- **Anki import**: `.apkg` / `.colpkg`, both the legacy and the new zstd (schema 18) formats. Note types, templates, cloze, conditionals, CSS, images and audio are all brought in
- **Interactive study**: 3D card flip, swipe to rate (← again, → good, ↑ easy, ↓ hard), keyboard shortcuts, interval previews, undo, streak counter, confetti
- **JSON decks for AI agents**: drop or paste a simple JSON file, or let an agent `POST` it with a scoped API token. Re-imports skip existing cards. See [docs/json-format.md](docs/json-format.md)
- **MCP server** at `/mcp`: connect Claude (sign in from the app), Cursor or any MCP client with an API token to create decks, rename them, search and flag cards and get quizzed in chat. See [docs/mcp.md](docs/mcp.md)
- **Folders**: nest decks in folders, drag decks/folders to reorganise, study a whole folder at once. Anki's `Parent::Child` decks become real folders on import
- **Type-in answers**: type the answer and see it compared letter by letter with the right one (case-insensitive, with an "almost" for accents and punctuation)
- **Image occlusion**: upload or paste an image, drag boxes over the parts to learn; each box is a card, in "hide one" or "hide all, guess one" mode
- **Markdown cards** with live preview, plus bulk add from spreadsheets (tab/CSV)
- **Cloze cards**: `{{c1::answer}}` / `{{c1::answer::hint}}`, one card per number; select text and press `Ctrl+Shift+C` (add `Alt` to reuse the last number). Editing a note adds/removes its cards to match
- **Themes**: eight colour themes (Orchard, Sunset, Forest, Lagoon, Midnight, Orchid, Slate, Mono) in light, dark or system mode, under Account settings → Appearance
- **Installable**: on iPhone/iPad, Safari → Share → *Add to Home Screen* gives a full-screen app with its own icon (also works as a PWA on Android/desktop)
- **Stats**: 12-month heatmap, 30-day forecast, streak, 30-day retention
- Single Node process. Built-in SQLite database, or your own Postgres via `DATABASE_URL`.

## Quick start

On any machine with Docker:

```bash
git clone <your-repo-url> recall && cd recall
./recall.sh start
```

Open the **claim link** printed in the logs (`./recall.sh logs`). It creates the first account, the superadmin. Done.

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

## Accounts and sign-in

Recall is multi-user, modelled on [Orchard](https://github.com/hackclub/orchard): every person has a private library (decks, folders, reviews, stats, media, API tokens).

- **Claim link.** A new instance has no accounts. On start, Recall prints a one-time claim link (valid 24 hours). Whoever opens it creates the first account, which is the **superadmin**. Decks from an older single-user Recall move into that account, and its old password keeps working.
- **Sign-in methods:** passkeys (Touch ID, Face ID, Windows Hello, security keys), identity providers (GitHub, Google, or any OpenID Connect provider such as Authentik, Keycloak, Okta), and passwords.
- **New people** join with an **invite link** (Instance admin → Invites), or anyone can sign up if you turn on **Open sign-up**. Providers create accounts only when you allow it on the provider and the person has an invite (or sign-up is open). A provider never signs into an existing account by matching email: people connect providers from **Account settings → Connections**.
- **Account settings:** connections, API tokens, passkeys and devices (sign out one device or all others), password, appearance.
- **Instance admin** (superadmins): overview and setup checklist, users (make admin, delete), invites, and sign-in providers.

Set `PUBLIC_URL` to the exact address people use (for example `https://recall.example.com`). Passkeys and provider callbacks depend on it, and passkeys need HTTPS (or `localhost`).

**Operator commands**, like `orchardctl`, run where Recall runs (prefix with `docker exec recall` in Docker):

```bash
node server/cli.js claim          # new claim link, while no account exists
node server/cli.js login <user>   # one-time sign-in link (10 minutes), e.g. for a lost passkey
node server/cli.js users          # list accounts
```


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
| `PUBLIC_URL` | *(guessed from the request)* | Your exact address, for passkeys and sign-in providers |
| `DATABASE_URL` | *(empty)* | Use this Postgres instead of the built-in SQLite file |
| `AUTH_OAUTH_*` | *(empty)* | One OpenID Connect provider from the environment (see `.env.example`) |
| `RECALL_PORT` | `3000` | Port on the host |
| `TZ` | `UTC` | Your timezone, so "today" and streaks match your day |
| `TRUST_PROXY` | *(empty)* | `1` when behind one reverse proxy, so client IPs are correct |
| `DESIRED_RETENTION` | `0.9` | Default FSRS target recall (0.7 to 0.97). Each person can change theirs in Account → Study, and decks can override it |

Locked out? `docker exec recall node server/cli.js login <username>` prints a one-time sign-in link.

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

Tests (`node:test`, no extra dependencies) start a real server on a throwaway SQLite database:

```bash
npm test
# against Postgres too: TEST_DATABASE_URL points at a scratch database, which the tests WIPE
TEST_DATABASE_URL=postgres://postgres:test@localhost:5432/recall_test npm test
```

GitHub Actions (`.github/workflows/ci.yml`) runs them on SQLite and Postgres, and typechecks, lints and builds the web app.

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
  auth.js       Accounts: claim link, sessions, passwords, passkeys, invites, API tokens
  oauth.js      Sign-in providers: GitHub, Google, any OpenID Connect
  cli.js        Operator commands: claim, login link, users
  mcp.js        MCP server (/mcp): tools for AI assistants, API token auth
  mcpAuth.js    OAuth 2.1 for /mcp, so apps like Claude connect by signing in
  stats.js      Study statistics (web stats page + MCP)
  store.js      Database layer: SQLite or Postgres behind one async API
  db.js         Schema + migrations (both databases)
  media.js      Imported images/audio, stored in the database
  migrate-to-postgres.js  Copy a SQLite database into Postgres
  scheduler.js  FSRS queue (learning > review > new > learn-ahead), answer, undo
  apkg.js       Anki package importer (protobuf + zstd aware)
  jsonImport.js Recall deck JSON: validation + idempotent import
  cloze.js      Cloze notes: create, sync cards on edit
  folders.js    Folder tree helpers + migration of old "A::B" deck names
scripts/
  build-icons.mjs  Renders the app icons (web/public/icons) with headless Chrome
web/src/
  pages/        Home, Deck (browser/editor), Study, Import, Login
  components/   CardContent (markdown / sandboxed Anki HTML), Charts
```

## Known limitations / next ideas

- Imported Anki cards are stored as rendered HTML per card, not as notes; editing a note's sibling cards is separate.
- Anki review history comes along only when the package includes scheduling (a `.colpkg`, or an `.apkg` exported with "Include scheduling information"). Shared decks from AnkiWeb usually don't, so their cards start as new.
- Fitting FSRS parameters (Account → Study) needs Node.js 24 or newer; the Docker image has it.
- Possible next: PWA/offline mode, AnkiConnect-compatible API.
