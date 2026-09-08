#!/bin/bash
# Builds everything the server needs, as one tarball.
#
# What goes in: compiled server, built web assets, the workbook templates,
# package manifests and the deployment files. What stays out: node_modules
# (installed on the server, since sharp and bcrypt are native), case-studies/
# (118MB of already-imported source material), and your data.
#
#   ./deploy/build-release.sh
#   scp dist/leakquote-<date>.tar.gz  user@server:/tmp/
set -euo pipefail
cd "$(dirname "$0")/.."

echo "Building..."
npm run build:server
npm run build:web

STAMP=$(date +%Y%m%d-%H%M)
OUT="dist/leakquote-${STAMP}.tar.gz"
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
mkdir -p dist "$STAGE/leakquote/server" "$STAGE/leakquote/web"

cp package.json package-lock.json "$STAGE/leakquote/"
cp -R server/dist server/package.json "$STAGE/leakquote/server/"
cp -R server/assets "$STAGE/leakquote/server/"
# schema.sql is read at runtime by the migrate script, and tsc does not copy
# non-TypeScript files into dist.
mkdir -p "$STAGE/leakquote/server/dist/db"
cp server/src/db/schema.sql "$STAGE/leakquote/server/dist/db/"
cp -R web/dist "$STAGE/leakquote/web/"
cp web/package.json "$STAGE/leakquote/web/"
cp -R deploy "$STAGE/leakquote/"

# macOS scatters these through any directory that has been opened in Finder.
find "$STAGE" -name ".DS_Store" -delete

tar -czf "$OUT" -C "$STAGE" leakquote
echo
echo "Release: $OUT  ($(du -h "$OUT" | cut -f1))"
echo "Next:    scp \"$OUT\" user@server:/tmp/   then follow deploy/README.md"
