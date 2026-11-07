# Sweetroll non-breaking system version upgrades

**Implementation plan · 7 November 2026 · Baseline `1475b6a` · Scope set by owner 2026-11-07, plan awaiting approval**

## Goal

Let an owner move a character, or a GM move a campaign with its characters, to a
later non-breaking published version of the same system. Systems will often add
items, spells and talents and change item stats, so play must not require new
characters for every release. The design contract is
[design Section 6.7](../../../design_v2.md#67-pinned-rules-and-non-breaking-version-upgrades-owner-decision-2026-11-07).

This is a rules-version feature. It is not application/database migration and
adds no schema migration chain (Sections 12.4 and 17.0 are unchanged).

## Why this is small

- Character state is stored by stable definition ID (`state_json.values`,
  `state_json.entries`), and system-template entries store only `templateId` plus
  per-instance values. Template fields and granted actions are resolved from the
  pinned package, so a template stat change takes effect when the pin moves.
- `comparePackages` (`src/systems/implementation/package/compatibility.ts`)
  already classifies breaking changes at publish time.
- `decodeRuntimeState`, `validateEntryForSlot`, `validDefaults` and
  `templateApplicable` already validate a state against a package on every write.
  Running them against the target package is the "verify the build" dry run.

## Stage 1 — Upgrade check (read only)

- [ ] `SystemRuntime.checkUpgrade(pkgFrom, pkgTo, entityId, state)`: run
  `comparePackages(from, to)`; then decode the state against the target entity,
  filling declared defaults for new non-computed fields; validate every entry
  (template exists, slot accepts kind, slot `maxEntries`, entry values valid for
  the target template fields, campaign-derived `base` still applicable); run
  target validations. Return `{ upgradable, blockers[], addedFields[],
  changedTemplates[], nextState }`. Pure function, no I/O.
- [ ] Extend `comparePackages` with gaps that matter to existing characters but
  are not caught today: template field removed or kind changed, template field
  made required, slot `maxEntries` lowered. Classify them as breaking for publish
  too (they already break live entries).
- [ ] `GET /characters/:id/upgrade-options`: later published versions of the same
  system that the actor may use, each with its package-level compatibility.
  `GET /characters/:id/upgrade-check?targetVersionId=` returns the dry-run report.
  Same authorization as reading the sheet.
- [ ] Unit tests: additive template/spell, item stat change, new field with
  default, removed template in use (blocked), removed template not in use
  (package-breaking, therefore blocked), slot narrowed, value out of new range,
  different system, older version.

## Stage 2 — Character upgrade commit

- [ ] `POST /characters/:id/upgrade` with `{ targetVersionId, expectedRevision }`
  and an idempotency key. In one transaction: lock, recheck revision and
  authorization, rerun the check, write `system_version_id`, `state_json`, bump
  `revision`, append activity/audit `system_version_upgraded` with from/to
  versions. Reject attached characters (campaign path only).
- [ ] Standalone and returned characters only; owner authorization.
- [ ] Tests: success, revision conflict, replay returns the original result,
  blocked report returns 409 with blockers, offline cache gets `replace`.

## Stage 3 — Campaign upgrade

- [ ] `GET /campaigns/:id/upgrade-check?targetVersionId=`: dry run for each
  attached character and each campaign item template with a system base.
- [ ] `POST /campaigns/:id/upgrade`: active GM/co-GM; one transaction moves the
  campaign, all attached characters and template bases (`versionId`,
  `packageChecksum`) or nothing. Campaign and per-character activity.
- [ ] Tests: all pass, one blocked character blocks all, concurrent sheet edit
  conflicts, player cannot upgrade, adoption at the new version works.

## Stage 4 — GUI

- [ ] Character sheet menu and campaign settings: **Upgrade rules version**,
  listing compatible later versions with publication date, short ID and release
  notes. Preview shows added fields, changed items in this character's inventory
  and blockers in plain language; confirm commits.
- [ ] Standalone adoption into a campaign on a newer version offers the upgrade
  first.
- [ ] e2e at 360/1280 px: author publishes an additive version with a changed
  item stat, owner upgrades, sheet shows the new stat and roll result uses it.

## Out of scope

Breaking upgrades, field mapping/renaming, downgrade or rollback, moving between
systems, automatic upgrade on publish, upgrading campaign-derived entries already
placed on sheets, version lineage tables.

## Open questions for the owner

1. Should a campaign upgrade be blocked by one non-verifying character (planned),
   or upgrade the others and detach/leave that one?
2. Is a revert to the previous version needed? It is excluded here; the previous
   version stays available for new characters.
3. Should a package-breaking change that does not touch a given character (for
   example a removed spell the character never took) still block that character?
   Planned: yes, any breaking package finding blocks. The alternative is to let the
   per-character dry run decide.
