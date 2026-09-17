# Backup and restore

Backs up the compose postgres `sweetroll` database plus media files, and
documents the restore drill that proves the backup is recoverable.

## Backup procedure

From the repo root, with the compose stack up (`docker compose up -d`):

```bash
scripts/backup.sh /tmp/opencode/drill-backup
```

Replace `/tmp/opencode/drill-backup` with any new-or-empty output directory.
Expected: exit 0 and three artifacts in the output dir:

- `sweetroll.dump` — `pg_dump -Fc` custom-format dump of the `sweetroll`
  database, taken inside the compose container
  (`docker compose exec -T postgres pg_dump -U sweetroll -Fc sweetroll`),
  so no database ports need to be published.
- `media.tar.gz` — tarball of `data/media` (validated image originals and
  derivatives; see `src/campaigns/media.ts` and `SWEETROLL_MEDIA_DIR`).
  Skipped with a warning, recorded in the manifest, if `data/media` is absent.
- `manifest.txt` — see "Manifest format" below.

`scripts/backup.sh` refuses to run when the output dir is missing from the
arguments, is not empty, resolves inside `data/`, or is named `sweetroll`
(the dev/prod database name). The script takes no restore-target argument
and contains no restore path: it can only back up, never restore over the
dev database, by construction.

## Restore drill procedure (scratch targets only)

NEVER restore into `sweetroll`. NEVER drop anything except
`sweetroll_drill_*`. NEVER point host tooling at `localhost:5432` (that port
belongs to an unrelated postgres on shared hosts — always go through
`docker compose exec`).

```bash
# 1. Create the scratch database.
docker compose exec -T postgres psql -U sweetroll -d postgres \
  -c "CREATE DATABASE sweetroll_drill_restore;"

# 2. Copy the dump into the container (the backup file lives on the host).
docker compose cp /tmp/opencode/drill-backup/sweetroll.dump postgres:/tmp/drill.dump

# 3. Restore into the scratch database only.
docker compose exec -T postgres pg_restore -U sweetroll \
  -d sweetroll_drill_restore --clean --if-exists /tmp/drill.dump

# 4. Verify: row counts must match the live database.
for t in users systems system_versions campaigns characters; do
  a=$(docker compose exec -T postgres psql -U sweetroll -d sweetroll \
    -tAc "SELECT count(*) FROM $t")
  b=$(docker compose exec -T postgres psql -U sweetroll -d sweetroll_drill_restore \
    -tAc "SELECT count(*) FROM $t")
  echo "$t: sweetroll=$a drill=$b"
done
# Also compare the migration high-water mark:
docker compose exec -T postgres psql -U sweetroll -d sweetroll \
  -tAc "SELECT max(filename) FROM schema_migrations"
docker compose exec -T postgres psql -U sweetroll -d sweetroll_drill_restore \
  -tAc "SELECT max(filename) FROM schema_migrations"

# 5. Clean up the scratch target and container temp file.
docker compose exec -T postgres rm /tmp/drill.dump
docker compose exec -T postgres psql -U sweetroll -d postgres \
  -c "DROP DATABASE sweetroll_drill_restore;"
```

## Manifest format

`manifest.txt` is written by `scripts/backup.sh`:

```
# sweetroll backup manifest
timestamp_utc: 2026-09-15T05:08:12Z
git_head: 8a044f2c17f4de26112baa7dbb77fe0fa0e0154a
database: sweetroll (compose service postgres, pg_dump -Fc)
migrations_table: schema_migrations
migrations_max: 0020_display_credentials.sql
media: absent (data/media not present; skipped with warning)
files:
<sha256>  sweetroll.dump
[<sha256>  media.tar.gz]
```

- `migrations_max` is `max(filename)` from `schema_migrations`
  (`src/platform/migrations.ts`). That table has columns
  `(filename, checksum, applied_at)` and no `version` column, so there is no
  numeric version to report — the lexicographically greatest applied
  migration filename is the high-water mark.
- `files:` holds `sha256sum` lines for each artifact present
  (`media.tar.gz` line omitted when media was skipped).

## Measured drill evidence (2026-09-15)

Environment: worktree compose project `i7-hardening`
(`i7-hardening-postgres-1`, postgres:17-alpine, fresh volume migrated with
`npm run migrate`: 20 migration files through `0020_display_credentials.sql`
plus reference-template seeds). Host port 5432 on that machine belongs to an
unrelated postgres, so the stack ran with an ephemeral port override
(`127.0.0.1:5434:5432`, override file outside the repo); all backup/restore
commands went through `docker compose exec` as documented above.

- Backup: `scripts/backup.sh /tmp/opencode/drill-backup` → exit 0,
  wall-clock ≈ 1 s, `sweetroll.dump` 101162 bytes, `media.tar.gz` skipped
  (`data/media` absent — recorded in manifest).
- Restore: `pg_restore --clean --if-exists` into `sweetroll_drill_restore` →
  exit 0, wall-clock ≈ 1 s.
- Verification: counts MATCH on all 33 public tables, including the
  required `users` (0/0), `systems` (3/3), `system_versions` (3/3),
  `campaigns` (0/0), `characters` (0/0); `migrations_max` identical
  (`0020_display_credentials.sql`) on both databases.
- Cleanup: scratch database dropped, `/tmp/drill.dump` removed from the
  container, dev `sweetroll` confirmed intact afterwards.
- Media-tarball drill (follow-up, same day): with `data/media` absent the
  first drill only exercised the skip-with-warning branch, so the archive
  path was proven with a scratch fixture — `data/media/.drill-fixture-i7task5-9f3k7q.bin`
  (8 KiB random bytes; unique name, confirmed git-ignored via
  `git check-ignore`: `.gitignore:14:data/media/*`). Re-ran
  `scripts/backup.sh /tmp/opencode/drill-backup-media` → exit 0, ≈ 1 s,
  manifest `media: present` with both checksums; `tar -tzf media.tar.gz`
  listed `media/` + the fixture; extracted to a scratch dir and `cmp`
  against the original → identical (sha256
  `043c7bb1…07e9` both sides). Fixture, output dir, and extract dir all
  deleted afterwards; `data/` removed, `git status` clean. No `backup.sh`
  change needed — the archive path works as written.

Small-volume caveat: the drilled database held migrations + seeds only
(3 systems / 3 versions, all other tables empty), so the ≈ 1 s timings
prove the procedure, not production-scale backup/restore throughput. Re-run
the drill on a production-like volume before quoting RTO numbers externally.
(This caveat is superseded by the 2026-09-17 volume drill numbers below.)

## Scheduled backups and retention (2026-09-17)

Schedule: `ops/backups/backup.cron.example` runs `scripts/backup.sh` with a
UTC-timestamped output dir every 10 minutes on the backup host (installed via
`crontab -e`, NOT in CI; example-only until a production host exists). RPO
math: backup every 10 min ⇒ worst-case data loss ≤ 10 min < 15 min design
§15 target, so the cadence satisfies RPO ≤ 15 min once installed.

Retention: each cron run pipes into `scripts/backup-prune.sh
/var/backups/sweetroll 144` — keep the newest 144 timestamped `backup-*`
dirs (144 × 10 min = 24 h). The prune script refuses roots inside `<repo>/data`
and only deletes dirs matching `backup-*[0-9]`; `--dry-run` prints `would
remove …` without deleting (self-check: 3 fixture dirs with KEEP=2 printed
`would remove …/backup-0001`, exit 0, nothing deleted).

Production-volume re-drill (2026-09-17, worktree compose project
`i7-hardening-remainder`, postgres:17-alpine): seeded 20 campaigns × 50
characters = 1000 characters with `scripts/seed-volume-fixture.ts`
(deterministic `vol-drill-` names) into scratch `sweetroll_drill_volume`
(created via `docker compose exec`, migrated with `npm run migrate` first so
the schema exists). Host port 5432 belongs to an unrelated postgres
(main-repo `sweetroll-postgres-1`), so the stack ran with an out-of-repo
compose override publishing `127.0.0.1:5439:5432`; all SQL went through
`docker compose exec`, and the seeder's `TEST_DATABASE_URL` used
`localhost:5439` (own container). The seeder guard refused a dev-`sweetroll`
URL (exit 1) before the drill.

- Backup: `scripts/backup.sh /tmp/opencode/drill-volume` (dev `sweetroll`
  source, by construction) → exit 0, wall-clock 0.85 s, `sweetroll.dump`
  101157 bytes, media skipped (`data/media` absent). Volume dump of the
  drill DB with `backup.sh`'s identical `pg_dump -Fc` method
  (`docker compose exec -T postgres pg_dump -U sweetroll -Fc
  sweetroll_drill_volume`) → `sweetroll-volume.dump` 141996 bytes,
  wall-clock 0.42 s.
- Restore: `pg_restore --clean --if-exists` into
  `sweetroll_drill_volume_restore` → exit 0, wall-clock 0.85 s.
- Verification: `characters` 1000/1000, `campaigns` 20/20, `migrations_max`
  identical (`0020_display_credentials.sql`) on source and restore.
- Cleanup: both scratch databases dropped (no `sweetroll_drill_*` remain),
  `/tmp/drill-volume.dump` removed from the container, host drill dir
  removed, dev `sweetroll` confirmed intact afterwards (0 characters).

Seeder deviations from the brief's verbatim SQL (actual schema):
`campaigns` has no `settings_json` and requires `title` (used
`vol-drill-<c>`); `characters` has `campaign_id` only under the attached
ownership scope (`owner_id` NULL) plus required `system_version_id`,
`entity_definition_id` (`'vol-drill'`), and `name`; `system_versions` PK is
`id`, not `version_id`. Drill-DB setup likewise added one step the brief
omitted: `CREATE DATABASE` yields an unmigrated DB, so the scratch DB was
migrated with the repo's own `npm run migrate` entrypoint before seeding
(scratch-only; dev migration state unchanged).

## RPO / RTO assessment (against design §15)

Design §15 targets RPO ≤ 15 min and RTO ≤ 4 h.

- RPO: OPEN GAP. Backups are manual (`scripts/backup.sh` on demand); RPO
  equals backup frequency, so RPO ≤ 15 min requires scheduled backups, which
  do not exist yet. No scheduler is claimed here — scheduling (cron/systemd
  timer or platform backups) is separate follow-up work.
- RTO: drill evidence shows a ≈ 1 s restore on a near-empty database plus a
  fixed set of manual steps (create scratch DB, copy dump, restore, verify,
  drop). This is consistent with RTO ≤ 4 h for small volumes but says
  nothing about large-volume restore time (see small-volume caveat above).
- PITR status: `not-configured`. `compose.yaml` has no WAL archiving
  (`archive_mode`/`archive_command` unset), so point-in-time recovery within
  a backup window is not possible; recovery is limited to full backup
  snapshots. Designing WAL archiving/PITR is separate follow-up work and is
  not implemented here.

## Media-file backup coverage

Originals/derivatives live under `data/media`
(`SWEETROLL_MEDIA_DIR ?? <repo>/data/media`; compose volume
`sweetroll-media` mounted at `/app/data/media` in app containers).
`scripts/backup.sh` archives them as `media.tar.gz` when present. The
archive path has been exercised end-to-end with a scratch fixture (see
drill evidence above: tarball contents listed, extracted bytes `cmp`-identical
to the original, fixture removed afterwards).
