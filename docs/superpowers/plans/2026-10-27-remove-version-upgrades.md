# Remove version migrations and upgrades

The owner clarified on 2026-10-27 that both application/database migrations and
character/campaign rules-version upgrades are unnecessary. The app is unreleased,
only runs in test environments and has no users. This supersedes older upgrade
implementation plans and the original narrower PR #24 policy.

- [x] Replace the incremental SQL runner/checksum ledger with atomic current-schema
  initialization. Use `database/schema.sql` and `db:init` entry points throughout
  Docker, Railway, browser runners and acceptance scripts. Never reset data on boot.
- [x] Remove character mapping/candidate builders, previews, commits, rollback,
  persistence operations and both migration tables.
- [x] Remove attached-character and campaign upgrade coordination and repository
  operations; remove all five public HTTP endpoints and regenerate API contracts.
- [x] Remove upgrade dialogs, buttons, API/query methods, offline operation variants,
  retained upgrade results, export-lineage placeholders and translations.
- [x] Remove obsolete feature tests and fixtures. Preserve mixed-purpose character
  journeys, authorization, validation, conflict and offline recovery coverage.
- [x] Preserve published rules IDs and immutability, ordinary character/campaign
  operations, dice history, generic idempotency and database transaction rollback.
- [x] Update AGENTS, design Sections 6.7/12.4, README and current operation guides.

Validation: the new endpoint-removal regression was observed red before removal
and green after. UI regressions check that neither upgrade control is offered.
Database integration covers no migration tables, repeat/concurrent initialization,
failed-initialization atomicity and existing storage constraints. Current execution
results are recorded in the acceptance record linked below.

[Acceptance evidence](../../acceptance/pre-release-database-cleanup-2026-10-27.md)
