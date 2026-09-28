# Deploying 5-10-K

One instance = one port. The server has no npm dependencies; Node 22.5+ is required (built-in `node:sqlite`).

1. Package the code: `git archive --format=tar HEAD package.json server engine public > /tmp/510k.tar`
2. Copy it to the host and extract into `/opt/510k-<port>` (owned by root, readable by the service user).
3. Install `deploy/510k.service` as `/etc/systemd/system/510k-<port>.service` (edit the port), then
   `systemctl daemon-reload && systemctl enable --now 510k-<port>` and `ufw allow <port>/tcp`.
4. Check `curl -s localhost:<port>/api/health`.

Data (accounts, match history, replays) is the SQLite file `/var/lib/510k-<port>/510k.db`. Back it up before upgrades
(`sqlite3 .backup` or copy it with the service stopped); schema migrations run automatically on start.

Admins who may open `/admin` (card counter switches) are set per host, outside the repo, with a drop-in:
`/etc/systemd/system/510k-<port>.service.d/admins.conf` containing
```
[Service]
Environment=ADMIN_USERS=name1,name2
```
then `systemctl daemon-reload && systemctl restart 510k-<port>`.

Importing card-game accounts (once): run as the service user so the database stays writable by it:
`sudo -u cardroom DATA_DIR=/var/lib/510k-<port> node --disable-warning=ExperimentalWarning /opt/510k-<port>/server/import-card-game.js <accounts.json>`
Passwords are hashed on import; ratings start at 60 because 5-10-K keeps its own ranks.

## Zero-interruption deploys

Games survive a restart. On SIGTERM (what `systemctl stop|restart` sends) the server stops accepting connections,
freezes every room, closes the live streams, saves each room that still has a human in it to the `room_snapshots`
table and exits. On the next start it restores those rooms (same room codes, same seat tokens) before it listens,
then clears the table. So an upgrade is just: extract the new code, then `systemctl restart 510k-<port>`.

- Browsers reconnect by themselves; players keep their seats and cards. Deadlines resume with the time that was left.
- For 20 s after the restore (`restoreGraceMs`) nobody is auto-played for being offline, so a human whose turn it
  was has time to reconnect; after that the usual offline rules apply (bots play for them).
- Snapshots older than 15 minutes are ignored, so a long outage starts clean. A snapshot that cannot be restored
  (e.g. after an incompatible code change) is logged and skipped; it never stops the server from starting.
- A crash or `kill -9` saves nothing: only a clean stop saves rooms. `TimeoutStopSec=20` leaves ample time.
- Frontend-only changes under `public/` do not need a restart at all.
