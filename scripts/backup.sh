#!/usr/bin/env bash
# Database + uploads backup. Adapted from Paradigmshift scripts/backup-postgres.sh (pipefail, private umask,
# atomic rename, integrity check) and extended with the uploads directory Nogiti stores on disk.
set -Eeuo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then echo 'DATABASE_URL must be set; its value will not be printed.' >&2; exit 2; fi
command -v pg_dump >/dev/null 2>&1 || { echo 'pg_dump is required (same major version as the server).' >&2; exit 2; }
backup_dir="${BACKUP_DIR:-./backups}"
upload_dir="${UPLOAD_DIR:-./uploads}"
umask 077
mkdir -p "$backup_dir"
chmod 700 "$backup_dir"
now="$(date -u +%Y%m%dT%H%M%SZ)"
db_out="$backup_dir/nogiti-db-$now.sql.gz"
tmp="$(mktemp "$backup_dir/.nogiti-db.XXXXXXXX.sql.gz")"
trap 'rm -f -- "$tmp"' EXIT
# pipefail guarantees a pg_dump failure is not mistaken for a valid gzip archive.
pg_dump --no-owner --no-privileges --format=plain "$DATABASE_URL" | gzip -9 > "$tmp"
gzip -t "$tmp"
mv -n -- "$tmp" "$db_out"
trap - EXIT
printf 'Database backup: %s\n' "$db_out"

if [[ -d "$upload_dir" ]]; then
  up_out="$backup_dir/nogiti-uploads-$now.tar.gz"
  tar -C "$upload_dir" -czf "$up_out" .
  tar -tzf "$up_out" >/dev/null
  printf 'Uploads backup:  %s\n' "$up_out"
else
  printf 'Uploads directory %s not found; skipped.\n' "$upload_dir" >&2
fi
( cd "$backup_dir" && sha256sum "nogiti-db-$now.sql.gz" ${up_out:+"$(basename "$up_out")"} > "nogiti-$now.sha256" )
printf 'Store backups encrypted and off-host, and run a restore drill before relying on them.\n'
