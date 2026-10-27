# Development database initialization

Sweetroll has no released application versions or user data to migrate. The only
supported database shape is the current development schema in
`0001_current_schema.sql`. It creates the final tables, constraints, triggers and
indexes directly; do not add transitions through obsolete development schemas,
placeholder template data, backfills or one-off repairs.

The generic migrate process remains the initialization entry point (`npm run
migrate`, or `npm run start:migrate` in the built image). It records a SHA-256
checksum in `schema_migrations`, holds an advisory lock and runs each SQL file in
a transaction. A second run is a no-op. Reference templates are inserted from
compiled fixtures after schema initialization; existing published versions are
never rewritten by startup.

During unreleased development, edit the baseline and recreate disposable test
databases when the schema changes. Databases initialized with the former numbered
migration chain must also be recreated before running this baseline. The app does
not reset databases automatically. Existing browser test profiles may likewise be
cleared instead of adding compatibility conversions for obsolete local schemas.

This policy does not remove the product's generic character/campaign upgrade and
rollback features: those move player data between creator-published rules-system
versions, independently of application releases. Establish a migration baseline
at the first supported app release. Only subsequent releases require upgrade and
compatibility paths for supported released versions; never-released test builds
need no migration path. See [product delivery policy](../design_v2.md#170-release-status-and-application-version-policy).
