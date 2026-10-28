#!/usr/bin/env bash
# Restore a database dump (and optionally uploads) produced by scripts/backup.sh.
# Adapted from Paradigmshift scripts/restore-postgres.sh: refuses to run without explicit confirmation.
# Restore into an EMPTY database (or a freshly recreated one); the dump is plain SQL.
set -Eeuo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then echo 'DATABASE_URL must be set; its value will not be printed.' >&2; exit 2; fi
command -v psql >/dev/null 2>&1 || { echo 'psql is required.' >&2; exit 2; }
if [[ $# -lt 1 || ! -f "$1" ]]; then echo "Usage: DATABASE_URL=... CONFIRM_DESTRUCTIVE_RESTORE=YES $0 nogiti-db-<ts>.sql.gz [nogiti-uploads-<ts>.tar.gz]" >&2; exit 2; fi
if [[ "${CONFIRM_DESTRUCTIVE_RESTORE:-}" != 'YES' ]]; then
  echo 'Refusing restore: verify the target database and backup, then set CONFIRM_DESTRUCTIVE_RESTORE=YES.' >&2
  exit 3
fi
gzip -t "$1"
tables="$(psql "$DATABASE_URL" -Atc "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public'")"
if [[ "$tables" != "0" && "${ALLOW_NON_EMPTY_TARGET:-}" != 'YES' ]]; then
  echo "Target database is not empty ($tables tables). Restore into a new empty database, or set ALLOW_NON_EMPTY_TARGET=YES." >&2
  exit 4
fi
printf 'Restoring database from %s (target URL intentionally not displayed)…\n' "$1"
gzip -dc -- "$1" | psql "$DATABASE_URL" --set ON_ERROR_STOP=1 --quiet >/dev/null
if [[ $# -ge 2 ]]; then
  upload_dir="${UPLOAD_DIR:-./uploads}"
  tar -tzf "$2" >/dev/null
  mkdir -p "$upload_dir"
  tar -C "$upload_dir" -xzf "$2"
  printf 'Uploads restored into %s\n' "$upload_dir"
fi
printf 'Restore finished. Run "npm run db:status" and start the application.\n'
