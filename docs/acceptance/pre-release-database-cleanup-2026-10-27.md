# Pre-release database cleanup — 2026-10-27

Base: `main` at `759323a529a50569a22b5d3db9172bb81a153d29`.
The owner confirmed that the app has no release/users and all databases are
throwaway test data. Historical records/plans remain as history; the current
policy is in `migrations/README.md` and design Section 12.4.

## Findings and changes

- Replace 19 incremental SQL files with one current-schema initializer. Fold
  final columns/checks into table creation, preserving every existing storage
  contract. The remaining `ALTER TABLE` creates the deferred cyclic template
  foreign key after both referenced tables exist; it is not an upgrade step.
- Remove synthetic template placeholder insertion followed by deletion, old
  `active` → `published` normalization, and the one-off draft-name backfill.
- Remove runtime placeholder/drift repair, reference probing and repair-by-delete
  from `seedReferenceTemplates`. Startup inserts missing real fixtures with
  `ON CONFLICT DO NOTHING` and never rewrites existing published versions.
- Remove the IndexedDB v3 → v4 cache conversion and its obsolete upgrade test.
  Keep generic object-store initialization and current offline behavior.
- Replace the 463-line copied character/campaign test schema and later schema
  alterations with the shared current schema. Retain current constraint,
  authorization, transactional, replay and concurrency coverage.
- Keep the generic locked/checksummed/transactional SQL runner and its process
  entry points. Keep product-level character/campaign rules-version upgrades,
  previews, atomic commits and rollback; these are not app-version migration.

## Verification

- TDD: the insert-only seed regression failed against the old SELECT/repair
  implementation, then passed after simplification. Real-database tests verify
  first seeding, repeated seeding, immutable existing rows, valid identities and
  runtime loading.
- Catalog comparison on PostgreSQL 17 and 18: old chain versus new initializer
  have identical named columns/types/nullability/defaults, constraints, indexes,
  triggers and functions. Column ordinal positions are intentionally irrelevant.
- `npm run test:integration` on PostgreSQL 17: all 367 tests passed across 31 files.
- Built bootstrap: empty database initialized and seeded; second migrate was a
  no-op; HTTP readiness and exactly three real templates verified after boot.
- `npm test`: 437 passed, 10 already-skipped tests.
- `npm --prefix web test`: 1,170 passed, including 52 current store tests.
- Server typecheck/build, client typecheck/build and contract generation check
  passed. This environment disallows tsx CLI Unix sockets, so the equivalent
  contract command used `node --import tsx scripts/generate-system-contracts.ts --check`.

## Adoption

Recreate disposable databases initialized by the old chain before using this
branch. Later development schema edits also use the baseline and a rebuilt test
database. Startup does not delete databases or data. Existing browser test profiles
can be cleared instead of maintaining conversions for obsolete local schemas.

This PR is independent of draft #23. Its added push schema (`0024`) must be folded
into the current baseline and its test-schema setup reconciled when integrating
that branch. No change to deployed Railway databases is part of this cleanup.
