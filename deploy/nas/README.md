# 5-10-K on a Synology NAS (Container Manager)

A separate, LAN-only copy of the game with its own accounts and matches.

## First install

1. On a Mac with the NAS `Share` folder mounted, assemble the project folder:

       deploy/nas/bundle.sh /Volumes/Share/docker/510k

2. DSM > **Container Manager** > **Project** > **Create**
   - Project name: `510k`
   - Path: `Share/docker/510k`
   - Source: *Use existing docker-compose.yml* (it finds `compose.yaml`)
   - Skip the Web Station portal step. Create — it builds the image and starts the container.
3. Open `http://<NAS IP>:3200` on the home network. Register `aeoleader` to get `/admin`
   (set by `ADMIN_USERS` in `compose.yaml`).

## Update

1. `deploy/nas/bundle.sh /Volumes/Share/docker/510k` (replaces `app/`, never touches `data/`).
2. Container Manager > Project > `510k` > **Stop**, then **Action > Build** (rebuilds the image;
   Start/Restart alone keeps running the old image). Stopping sends SIGTERM, so rooms in play are
   saved and restored after the restart.
3. The container log's first line is `510k <version> starting as root`; the version must match
   `app/VERSION`. If it does not, run **Action > Clean**, then **Build** again.

## Data

`Share/docker/510k/data/510k.db` is the whole database. After the first start the container owns
`data/`, so it is hidden from the share (the bundle script leaves it alone). It holds everything (accounts, matches, replays). Back it up
with Hyper Backup (it runs as root and can read it).
