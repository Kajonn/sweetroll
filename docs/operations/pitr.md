# Point-in-time recovery (opt-in WAL archiving)

Opt-in PITR path for the compose postgres. The base `compose.yaml` ships
with NO WAL archiving; `compose.pitr.yaml` is an override that enables it.
Never apply the override to the dev database without owner approval.
Drills use scratch databases only (`sweetroll_drill_pitr*`), all SQL through
`docker compose exec`. Never point host tooling at `localhost:5432` (that
port may belong to an unrelated postgres on shared hosts).

Enable (owner-gated; restarts postgres, so NOT run as part of the drill):

```bash
docker compose -f compose.yaml -f compose.pitr.yaml up -d
docker compose exec -T postgres psql -U sweetroll -d sweetroll -tAc "SHOW archive_mode;"
# expected after restart: on
```

Validate the override without starting anything:

```bash
docker compose -f compose.yaml -f compose.pitr.yaml config | grep -A3 "archive_mode\|wal_archive"
# expected: the archive_mode=on command line and the sweetroll-wal volume
```

## Base backup

Exact `pg_basebackup` via compose exec into a scratch dir (inside the
container; scratch path only). Requires the override active (archive_mode=on,
wal_level=replica); without the owner-gated restart this step is not run.

```bash
docker compose exec -T postgres mkdir -p /tmp/pitr-base
docker compose exec -T postgres pg_basebackup -U sweetroll -D /tmp/pitr-base -Fp -Xs -P -c fast
```

## WAL replay drill

Scratch targets only. `sweetroll_drill_pitr` is the drill source,
`sweetroll_drill_pitr_recovery` is the recovery target. Never `sweetroll`.

```bash
# 1. Create the scratch database.
docker compose exec -T postgres psql -U sweetroll -d postgres \
  -c "CREATE DATABASE sweetroll_drill_pitr;"

# 2. Marker table + first marker row with timestamp.
docker compose exec -T postgres psql -U sweetroll -d sweetroll_drill_pitr \
  -c "CREATE TABLE pitr_markers (id serial PRIMARY KEY, label text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());"
docker compose exec -T postgres psql -U sweetroll -d sweetroll_drill_pitr \
  -c "INSERT INTO pitr_markers (label) VALUES ('pitr-marker-1') RETURNING label, created_at;"

# 3. Record a recovery target time strictly after marker-1.
docker compose exec -T postgres psql -U sweetroll -d sweetroll_drill_pitr \
  -tAc "SELECT pg_sleep(2); SELECT now();"

# 4. Base backup (see "Base backup" above; requires the override active).
docker compose exec -T postgres mkdir -p /tmp/pitr-base
docker compose exec -T postgres pg_basebackup -U sweetroll -D /tmp/pitr-base -Fp -Xs -P -c fast

# 5. Second marker row after the backup.
docker compose exec -T postgres psql -U sweetroll -d sweetroll_drill_pitr \
  -c "INSERT INTO pitr_markers (label) VALUES ('pitr-marker-2') RETURNING label, created_at;"

# 6. Kill the scratch source (destructive step scoped to the drill name only).
docker compose exec -T postgres psql -U sweetroll -d postgres \
  -c "DROP DATABASE sweetroll_drill_pitr;"

# 7. Replay to a recovery target with recovery_target_time set between the
#    two markers (owner-gated: requires stopping postgres, restoring
#    /tmp/pitr-base plus the wal_archive contents to a scratch data dir,
#    setting recovery_target_time to the timestamp recorded in step 3,
#    promoting, and starting on a scratch port — NOT run here).
#    Then create the recovery database handle:
#    CREATE DATABASE sweetroll_drill_pitr_recovery;

# 8. Assert only the first marker is present (see "Verification queries").
#    Cleanup afterwards:
#    DROP DATABASE sweetroll_drill_pitr_recovery;
#    rm -rf /tmp/pitr-base (inside the container)
```

## Verification queries

The two `SELECT` statements (run against the recovery target;
expect exactly one row, `pitr-marker-1`):

```bash
docker compose exec -T postgres psql -U sweetroll -d sweetroll_drill_pitr_recovery \
  -c "SELECT label, created_at FROM pitr_markers ORDER BY id;"
docker compose exec -T postgres psql -U sweetroll -d sweetroll_drill_pitr_recovery \
  -tAc "SELECT max(filename) FROM schema_migrations"
```

The second query is the migrations high-water mark
(`schema_migrations(max(filename))`, cf.
`docs/operations/backup-restore.md`); on a fully replayed target it matches
the source value recorded before step 6.

## Status

PITR drill: NOT-EXERCISED — WAL override validated by config only
