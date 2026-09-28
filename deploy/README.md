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

Restarting the service clears rooms in progress (they live in memory); frontend-only changes under `public/` do not need a restart.
