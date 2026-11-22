#!/bin/sh
# Starts Recall as the unprivileged "node" user, after making sure the data folder is writable.
# Bind-mounted folders (./data:/data) are often created root-owned by Docker; fix that once here.
set -e
DATA_DIR="${DATA_DIR:-/data}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  if [ "$(stat -c %u "$DATA_DIR")" != "$(id -u node)" ]; then
    echo "Making $DATA_DIR writable for the app user"
    chown -R node:node "$DATA_DIR" || echo "warning: could not change owner of $DATA_DIR; the app may not be able to save"
  fi
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi

# already running as a non-root user (e.g. `--user`): just start
exec "$@"
