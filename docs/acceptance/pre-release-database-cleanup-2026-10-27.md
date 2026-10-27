# Remove version migrations and upgrades — 2026-10-27

Base: `main` at `759323a529a50569a22b5d3db9172bb81a153d29`.
The owner clarified that both database/application version migration and
character/campaign rules-version upgrade features must be removed: the app is
unreleased, has no users and only runs with disposable test data.

## Result

- One current schema in `database/schema.sql`; no incremental SQL chain,
  migration history/checksum ledger, backfills or historical repair.
- `npm run db:init` / `npm run start:db:init` initialize an empty database in a
  transaction. Concurrent starts serialize and repeated startup preserves data.
  Schema changes require recreating the test database; boot never resets it.
- Remove character previews, mappings, upgrade commits and rollback; remove
  campaign/attached-character upgrade coordination, repository methods, both
  migration tables and all five HTTP routes.
- Remove frontend dialogs, controls, API/query methods, offline migration
  operations, retained migration results, export-lineage placeholders and strings.
  IndexedDB creates its stores only on first creation, without requesting a
  historical version or adding missing stores to previous schemas.
- Regenerate the shared HTTP contract and client types. Update Docker, Railway,
  browser startup, backup metadata and the standalone acceptance script.
- Keep published rules IDs and immutable snapshots, creation and play, authoritative
  rolls/history, generic idempotency/recovery and database transaction rollback.
  A different rules snapshot requires a new test character/campaign.

## Verification

- TDD: the endpoint-removal test first failed with all five old paths, then passed.
  The IndexedDB regression was also red (historical version 4) before switching
  to default first creation. Frontend regressions assert that character and campaign upgrade controls are absent.
- Server: 431 tests pass, with 10 pre-existing skips. Frontend: all 1,132
  tests pass. Server/client typechecks and builds pass.
- API contract generation/check passes. Focused character HTTP/OpenAPI tests pass.
- Embedded PostgreSQL: fresh schema contains no migration tables; first reference
  seed inserts three templates and repeat seed inserts zero. A second initialization
  preserves an existing user. An intentional schema collision rolls back all newly
  created tables and retains the pre-existing table.
- Real PostgreSQL integration tests retain current storage/authorization/command
  coverage and add no-ledger, repeat/concurrent and failed-initialization tests.
  Their CI result is recorded on the PR; embedded PostgreSQL is not concurrency
  or browser acceptance evidence.

## Adoption and integration

Recreate disposable test databases before using this branch and after schema
changes. Existing browser test profiles can be cleared. No remote database was
changed and no automatic reset was introduced.

Draft #23 must be reconciled with the removed upgrade APIs/tests and its push
schema folded into `database/schema.sql` before integration. Older plans and
acceptance reports remain historical; current scope is in AGENTS, design Sections
6.7/12.4 and `database/README.md`.
