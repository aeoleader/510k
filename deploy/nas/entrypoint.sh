#!/bin/sh
# The data folder is a bind mount owned by a NAS user; hand it to the unprivileged `node`
# user, keep the database private, then run the server as `node` (exec keeps SIGTERM working).
set -e
chown -R node:node /data
chmod 700 /data
exec su-exec node node --disable-warning=ExperimentalWarning server/index.js
