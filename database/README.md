# Test database initialization

The app is unreleased, runs only in test environments and has no users. There is
one current schema: `database/schema.sql`.

Run `npm run db:init` (`npm run start:db:init` from the built image). Initialization
creates the schema atomically in an empty database, serializes concurrent starts,
and inserts missing reference templates. Repeated startup preserves existing data.
There is no migration history, migration checksum ledger, incremental SQL runner,
backfill, old-schema detection or automatic reset.

After a schema change, recreate the disposable test database and initialize it
again. Databases created by earlier development code must likewise be recreated.
Browser storage creates the current stores on first creation without requesting
a version upgrade. Clear obsolete browser test profiles rather than maintaining
conversion code.

Character/campaign upgrades between published rules versions, field-mapping
previews, upgrade commits and rollback are not supported. Published rules remain
immutable and existing characters/campaigns retain their original version IDs.
Create new test characters/campaigns to use a different published rules snapshot.

The app and database remain under development until the first application release
Git tag (`v*.*.*`, used by the release workflow). The
[post-tag migration strategy](../docs/superpowers/plans/2026-10-27-application-migration-policy.md)
is specified now. The tag freezes the baseline; subsequent changes require data
migrations where needed. Do not implement transition code or tests before that tag.
