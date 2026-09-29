#!/bin/sh
# Assemble the NAS project folder: Dockerfile, compose.yaml, entrypoint.sh and app/ (from git HEAD).
# The data/ folder next to them is never touched, so accounts and matches survive updates.
# Usage: deploy/nas/bundle.sh /Volumes/Share/docker/510k
set -e
dest=${1:?usage: bundle.sh <project folder>}
repo=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
mkdir -p "$dest/data"
rm -rf "$dest/app.new"
mkdir -p "$dest/app.new"
git -C "$repo" archive HEAD package.json server engine public | tar -x -C "$dest/app.new"
git -C "$repo" rev-parse --short HEAD > "$dest/app.new/VERSION"
rm -rf "$dest/app"
mv "$dest/app.new" "$dest/app"
cp "$repo/deploy/nas/Dockerfile" "$repo/deploy/nas/compose.yaml" "$repo/deploy/nas/entrypoint.sh" "$dest/"
echo "bundled $(cat "$dest/app/VERSION") into $dest"
