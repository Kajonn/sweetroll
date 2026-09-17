#!/usr/bin/env bash
# Retain timestamped backup dirs: keep newest $KEEP (default 144 = 24h at 10-min cadence).
# Usage: scripts/backup-prune.sh <backup-root> [KEEP] [--dry-run]
# Safety: refuses roots inside <repo>/data; only deletes dirs matching backup-*[0-9].
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
root="${1:?usage: scripts/backup-prune.sh <backup-root> [KEEP] [--dry-run]}"
keep="${2:-144}"
dry_run="0"
if [[ "${keep}" == "--dry-run" ]]; then dry_run="1"; keep="144"; fi
if [[ "${3:-}" == "--dry-run" ]]; then dry_run="1"; fi
resolved="$(realpath "$root")"
if [[ "$resolved" == "$repo_root/data" || "$resolved" == "$repo_root/data"/* ]]; then
  echo "error: backup root must not be inside $repo_root/data" >&2; exit 1
fi
mapfile -t dirs < <(ls -1d "$resolved"/backup-*[0-9] 2>/dev/null | sort)
total="${#dirs[@]}"
remove=$((total - keep))
if [[ "$remove" -le 0 ]]; then echo "prune: $total dirs, keep $keep, nothing to remove"; exit 0; fi
for ((i = 0; i < remove; i++)); do
  if [[ "$dry_run" == "1" ]]; then echo "would remove ${dirs[$i]}";
  else echo "removing ${dirs[$i]}"; rm -rf "${dirs[$i]}"; fi
done
