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
2. Container Manager > Project > `510k` > **Action > Build** (rebuild the image and restart).
   Stopping sends SIGTERM, so rooms in play are saved and restored after the restart.

## Data

`Share/docker/510k/data/510k.db` is the whole database (accounts, matches, replays). Back it up
with Hyper Backup, or copy it while the container is stopped. Do not open it over SMB while the
server runs.
