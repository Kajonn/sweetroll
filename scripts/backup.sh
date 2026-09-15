#!/usr/bin/env bash
# Backup the compose postgres `sweetroll` database plus media files.
#
# Usage: scripts/backup.sh <output-dir>
#
# Produces <output-dir>/sweetroll.dump (pg_dump custom format),
# <output-dir>/media.tar.gz (data/media, skipped with a warning if absent),
# and <output-dir>/manifest.txt (timestamp, git HEAD, applied-migration
# high-water mark, checksums).
#
# Safety: this script ONLY backs up. It takes no restore-target argument and
# contains no restore path, so it cannot restore over the dev database by
# construction. Restore drills target scratch databases named
# `sweetroll_drill_*` only (see docs/operations/backup-restore.md).
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: scripts/backup.sh <output-dir>" >&2
  exit 1
fi

# Operate from the repo root so `data/` and `docker compose` resolve.
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

out="$1"
mkdir -p "$out"
resolved_out="$(realpath "$out")"
data_dir="$repo_root/data"

# Guard: refuse an output dir inside data/ (would mix backups with live media).
if [[ "$resolved_out" == "$data_dir" || "$resolved_out" == "$data_dir"/* ]]; then
  echo "error: output-dir must not resolve inside $data_dir (got $resolved_out)" >&2
  exit 1
fi

# Guard: refuse an output dir named like the dev/prod database.
base="$(basename "$resolved_out")"
if [[ "$base" == "sweetroll" ]]; then
  echo "error: output-dir must not be named 'sweetroll' (dev/prod database name)" >&2
  exit 1
fi

# Guard: output dir must be new or empty.
if [[ -n "$(ls -A "$resolved_out")" ]]; then
  echo "error: output-dir is not empty: $resolved_out" >&2
  exit 1
fi

echo "backing up compose postgres database 'sweetroll' to $resolved_out ..."
docker compose exec -T postgres pg_dump -U sweetroll -Fc sweetroll > "$resolved_out/sweetroll.dump"

media_status="present"
if [[ -d "$data_dir/media" ]]; then
  tar -czf "$resolved_out/media.tar.gz" -C "$data_dir" media
else
  media_status="absent (data/media not present; skipped with warning)"
  echo "warning: $data_dir/media absent; skipping media archive" >&2
fi

timestamp_utc="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
git_head="$(git rev-parse HEAD)"
# NOTE: the migrations tracking table is `schema_migrations` (see
# src/platform/migrations.ts); it has columns (filename, checksum,
# applied_at) and no `version` column, so the high-water mark is
# max(filename).
migrations_max="$(docker compose exec -T postgres psql -U sweetroll -d sweetroll -tAc "SELECT max(filename) FROM schema_migrations")"

{
  echo "# sweetroll backup manifest"
  echo "timestamp_utc: $timestamp_utc"
  echo "git_head: $git_head"
  echo "database: sweetroll (compose service postgres, pg_dump -Fc)"
  echo "migrations_table: schema_migrations"
  echo "migrations_max: $migrations_max"
  echo "media: $media_status"
  echo "files:"
  (cd "$resolved_out" && sha256sum sweetroll.dump)
  if [[ -f "$resolved_out/media.tar.gz" ]]; then
    (cd "$resolved_out" && sha256sum media.tar.gz)
  fi
} > "$resolved_out/manifest.txt"

echo "backup complete: $resolved_out"
cat "$resolved_out/manifest.txt"
