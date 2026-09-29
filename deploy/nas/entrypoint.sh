#!/bin/sh
# The data folder is a bind mount owned by a NAS user; hand it to the unprivileged `node`
# user, keep the database private, then run the server as `node` (exec keeps SIGTERM working).
set -e
echo "510k $(cat /app/VERSION 2>/dev/null || echo '?') starting as $(id -un)"
if ! su-exec node test -r /app/server/index.js; then
  # Print what the container sees, so a broken build shows up in the Container Manager log.
  echo "cannot read /app/server/index.js as node:" >&2
  ls -la /app /app/server >&2 || true
fi
chown -R node:node /data
chmod 700 /data
exec su-exec node node --disable-warning=ExperimentalWarning server/index.js
