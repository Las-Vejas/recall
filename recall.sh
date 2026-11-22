#!/usr/bin/env sh
# Recall: run it with Docker, with a permanent database.
#
#   ./recall.sh start      build and start (creates the permanent "recall-data" volume the first time)
#   ./recall.sh update     rebuild from the current code and restart; your data is kept
#   ./recall.sh stop       stop the app (data is kept)
#   ./recall.sh logs       follow the logs
#   ./recall.sh backup     save a backup to ./backups/
#   ./recall.sh recover    find data from older containers (before the permanent volume existed)
#   ./recall.sh recover <volume>   move that data into the permanent volume
#
# Settings: optional .env file next to this script (see .env.example).
set -e
cd "$(dirname "$0")"

if [ -f .env ]; then set -a; . ./.env; set +a; fi
NAME="${RECALL_NAME:-recall}"
IMAGE="${RECALL_IMAGE:-recall:latest}"
VOLUME="${RECALL_VOLUME:-recall-data}"
PORT="${RECALL_PORT:-3000}"

say() { printf '\033[1m%s\033[0m\n' "$*"; }
die() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }
command -v docker >/dev/null || die "Docker is not installed (https://docs.docker.com/engine/install/)"

build() { say "Building $IMAGE…"; docker build -t "$IMAGE" .; }

# list "volume<TAB>decks<TAB>cards" for every volume that holds a Recall database
find_data_volumes() {
  for v in $(docker volume ls -q); do
    [ "$v" = "$VOLUME" ] && continue
    docker run --rm -v "$v:/v:ro" --entrypoint node "$IMAGE" -e "
      const fs = require('fs'); if (!fs.existsSync('/v/recall.db')) process.exit(1);
      const db = new (require('better-sqlite3'))('/v/recall.db', { readonly: true, fileMustExist: true });
      const n = (t) => { try { return db.prepare('SELECT COUNT(*) n FROM ' + t).get().n } catch { return 0 } };
      if (n('cards') === 0) process.exit(1);   // empty databases aren't worth recovering
      console.log('$v\t' + n('decks') + '\t' + n('cards'));
    " 2>/dev/null || true
  done
}

volume_has_cards() {
  docker run --rm -v "$VOLUME:/v:ro" --entrypoint node "$IMAGE" -e "
    const fs = require('fs'); if (!fs.existsSync('/v/recall.db')) process.exit(1);
    const db = new (require('better-sqlite3'))('/v/recall.db', { readonly: true });
    process.exit(db.prepare('SELECT COUNT(*) n FROM cards').get().n > 0 ? 0 : 1);
  " 2>/dev/null
}

run() {
  docker volume create "$VOLUME" >/dev/null   # no-op if it already exists: this is the permanent database
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker run -d --name "$NAME" --restart unless-stopped \
    -p "$PORT:3000" \
    -v "$VOLUME:/data" \
    -e TZ="${TZ:-UTC}" \
    -e DATABASE_URL="${DATABASE_URL:-}" \
    -e DATABASE_SSL="${DATABASE_SSL:-}" \
    -e PUBLIC_URL="${PUBLIC_URL:-}" \
    -e TRUST_PROXY="${TRUST_PROXY:-}" \
    -e DESIRED_RETENTION="${DESIRED_RETENTION:-0.9}" \
    "$IMAGE" >/dev/null
  if [ -n "$DATABASE_URL" ]; then where="your Postgres database"; else where="Docker volume \"$VOLUME\""; fi
  say "Recall is running on http://localhost:$PORT (data in $where)"
}

case "${1:-start}" in
  start|update|restart)
    build
    run
    if ! volume_has_cards; then
      old=$(find_data_volumes)
      if [ -n "$old" ]; then
        say "Found Recall data from an older container. To bring it back:"
        printf '%s\n' "$old" | while IFS="$(printf '\t')" read -r v d c; do echo "  ./recall.sh recover $v    ($d decks, $c cards)"; done
      fi
    fi
    ;;
  stop) docker stop "$NAME" >/dev/null && say "Stopped. Data is kept in volume \"$VOLUME\"." ;;
  logs) docker logs -f "$NAME" ;;
  backup)
    mkdir -p backups
    stamp=$(date +%Y%m%d-%H%M%S)
    # consistent copy of the live database first, then archive it together with the media
    docker exec "$NAME" node -e "new (require('better-sqlite3'))('/data/recall.db').backup('/data/backup.db').then(() => process.exit(0))"
    docker run --rm -v "$VOLUME:/data:ro" -v "$PWD/backups:/backups" --entrypoint sh "$IMAGE" \
      -c "cd /data && tar czf /backups/recall-$stamp.tgz --exclude=recall.db --exclude=recall.db-wal --exclude=recall.db-shm ."
    say "Backup saved to backups/recall-$stamp.tgz (restore: extract into the volume and rename backup.db to recall.db)"
    ;;
  recover)
    docker image inspect "$IMAGE" >/dev/null 2>&1 || build
    if [ -z "$2" ]; then
      list=$(find_data_volumes)
      [ -z "$list" ] && { say "No older Recall data found in other Docker volumes."; exit 0; }
      say "Recall data found in these volumes:"
      printf '%s\n' "$list" | while IFS="$(printf '\t')" read -r v d c; do echo "  $v  ($d decks, $c cards)"; done
      echo "Bring one back with: ./recall.sh recover <volume>"
      exit 0
    fi
    src="$2"
    docker volume inspect "$src" >/dev/null 2>&1 || die "No volume named $src"
    docker volume create "$VOLUME" >/dev/null
    if volume_has_cards && [ "$3" != "--force" ]; then
      die "The permanent volume already has cards. Run './recall.sh backup' first, then './recall.sh recover $src --force' to replace them."
    fi
    say "Copying $src into $VOLUME…"
    docker stop "$NAME" >/dev/null 2>&1 || true
    docker run --rm -v "$src:/from:ro" -v "$VOLUME:/to" --entrypoint sh "$IMAGE" \
      -c "rm -rf /to/* && cp -a /from/. /to/ && chown -R node:node /to"
    docker start "$NAME" >/dev/null 2>&1 || run
    say "Done. Your old decks are back. (The old volume $src was left untouched; remove it later with: docker volume rm $src)"
    ;;
  *) sed -n '2,13p' "$0"; exit 1 ;;
esac
