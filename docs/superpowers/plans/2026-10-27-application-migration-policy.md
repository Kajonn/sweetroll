# Application and database migration policy

**Owner decision — 2026-10-27.** This is the agreed plan for future migrations,
not a request to implement migrations before release.

## Release boundary

The app and database remain under development until the first application release
Git tag (`v*.*.*`, as used by `.github/workflows/release.yml`). A branch, pull
request, preview deployment, CI run or untagged main deployment is not a release.
The tag identifies the exact app commit and database baseline to preserve.

Before that tag:

- Maintain one current app and database schema. Change the current SQL baseline
  directly; recreate disposable test databases and browser profiles when needed.
- Do not implement app/database upgrades, development-data backfills, obsolete
  format converters or support for clients from earlier development builds.
- Do not add or retain tests or implementation-plan tasks for those transitions.
  Test fresh initialization, safe repeated initialization and current behavior.
- Keep normal current-version validation, authorization, transactions, durable
  retries and offline recovery. Never silently reset a database on app startup.

At the first release tag, freeze the current baseline and record the tag, commit,
baseline checksum, persistent JSON/API formats and browser-storage schema. No
migration from earlier untagged development builds is required. No release tag
is created as part of this plan.

After that tag, every later schema or durable-format change must be assessed for
migration needs against the released baseline. A release that makes no such
change needs no artificial migration.

## Post-tag migration design

1. **Add a migration runner when the first post-tag change needs it.** Reuse the
   current initializer's advisory-lock/transaction conventions; introduce ordered
   scripts and an applied-script checksum ledger at that time. Freeze the tagged
   baseline and append numbered SQL migrations for subsequent changes. Never edit an applied
   released migration or reset a released database during startup.
2. **Preserve released data.** Map changed columns and JSON documents explicitly,
   with bounded validation and a documented treatment of incompatible values.
   Preserve IDs, ownership, audience, audit history, immutable published content
   and idempotency identities. Data deletion requires a separate explicit decision.
3. **Keep deployment safe.** Prefer additive schema changes while an older
   supported app can still run. Backfill only where real released data requires
   it; remove obsolete fields in a later compatible release after their readers
   and writers are retired. Use staged/resumable work only if data volume requires
   it, rather than building a migration framework in advance.
4. **Define client support for each change.** Document supported released API,
   package and browser-storage formats. Convert persistent local records only
   when their format changes; preserve pending commands and their original keys.
   Recheck authorization on replay. An unsupported released client must receive
   clear update guidance instead of losing work or issuing a fresh command.
5. **Support upgrade sequencing.** The initial path starts at the first release
   tag. Apply all required intervening migrations in order, including when a user
   skips an app release. Any later retirement of a released starting version needs
   an explicit support decision and documented upgrade/export path. Never add a
   transition from an untagged development snapshot.
6. **Separate failure recovery from downgrade.** A failed transactional migration
   rolls back that script and blocks app readiness; previously applied scripts
   remain recorded and a retry resumes safely. Roll back the app image only if it
   can use the resulting schema. Otherwise repair forward. Backups and tested
   restore procedures are recovery tools; destructive down-migrations and automatic
   database restoration are not the default rollback strategy.

## Execution gates after the first release tag

These tasks are activated by a change to a released schema or durable format.
They are not pre-release implementation or test requirements.

- [ ] Identify the released source tag(s), target format and support window;
      describe the data mapping, app/client coexistence and rollback limits.
- [ ] Add the required SQL or persistent-format migration, update fresh-install
      initialization and document application order and operational requirements.
- [ ] Test against representative data produced by the actual released app:
      data preservation, constraints, immutable history, pending-command/replay
      identities, failure rollback, safe retry and migration locking.
- [ ] Verify both a fresh target database and the supported upgrade path, including
      skipped releases. Test old/new released clients or workers only where the
      stated support window permits coexistence.
- [ ] Run on an isolated copy before deployment; verify backup/restore readiness,
      migration completion, health checks and the current app's user journeys.
- [ ] Record the target release tag, checksums, migration evidence and recovery
      procedure. Update the support policy when a released version is retired.

## Scope and plan maintenance

This policy governs application and database versions, including persistent
character/campaign data. Published RPG rules snapshots remain immutable and pinned;
conversion between snapshots, mapping previews and rollback are also outside the
current pre-tag scope. Any future content-upgrade feature needs its own post-tag
product decision and must follow the same data-preservation principles.

Keep this policy in the product delivery plan, database instructions and agent
rules. Existing feature plans must describe current-schema development, not require
incremental upgrade scripts or conversion tests before the first release tag.
Dated acceptance reports remain records of what was executed, not tasks to repeat.
