#!/bin/bash
# Exports the live data: a database dump and the uploaded files.
#
# Run this to move existing work onto the new server, and on a schedule
# afterwards as a backup. Both halves matter — a database dump alone loses
# the site photographs, which are the only genuinely irreplaceable data.
#
#   ./deploy/export-data.sh
set -euo pipefail
cd "$(dirname "$0")/.."

# Postgres.app keeps its tools outside PATH; a Linux box will have them on it.
PGBIN=""
for candidate in "$HOME/Applications/Postgres.app/Contents/Versions/16/bin" \
                 "/Applications/Postgres.app/Contents/Versions/16/bin"; do
  [ -x "$candidate/pg_dump" ] && PGBIN="$candidate/" && break
done
command -v pg_dump >/dev/null 2>&1 && PGBIN=""

# Read the one value we need rather than sourcing the file. Sourcing runs it
# as a shell script, so a stray space after an "=" turns a secret into a
# command — which is exactly what happened the first time this ran.
DATABASE_URL=$(sed -n 's/^[[:space:]]*DATABASE_URL[[:space:]]*=[[:space:]]*//p' .env | head -1 | tr -d '"'"'"'\r')
: "${DATABASE_URL:?DATABASE_URL not found in .env}"

STAMP=$(date +%Y%m%d-%H%M)
mkdir -p dist
DB="dist/leakquote-db-${STAMP}.sql.gz"
FILES="dist/leakquote-files-${STAMP}.tar.gz"

echo "Dumping database..."
"${PGBIN}pg_dump" --no-owner --no-privileges "$DATABASE_URL" | gzip > "$DB"

echo "Archiving uploads, exports and signatures..."
tar -czf "$FILES" -C server uploads exports signatures

echo
echo "Database: $DB     ($(du -h "$DB" | cut -f1))"
echo "Files:    $FILES  ($(du -h "$FILES" | cut -f1))"
