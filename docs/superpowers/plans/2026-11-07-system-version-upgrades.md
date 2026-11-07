# Sweetroll system version upgrades and revert

**Implementation plan · 7 November 2026 · Baseline `1475b6a` · Owner-approved 2026-11-07**

## Goal

Let an owner move a character, or a GM move a campaign with its characters, to a
later non-breaking published version of the same system, and revert to the
version used before the most recent upgrade. Systems will often add items, spells
and talents and change item stats, so play must not require new characters for
every release. The design contract is
[design Section 6.7](../../../design_v2.md#67-pinned-rules-and-non-breaking-version-upgrades-owner-decision-2026-11-07).

This is a rules-version feature. It is not application/database migration and
adds no schema migration chain (Sections 12.4 and 17.0 are unchanged). The new
columns are added to the current schema baseline.

## Owner decisions (2026-11-07)

1. A campaign upgrade or revert is blocked when any attached character, or any
   campaign template base, fails the dry run.
2. Revert is required: back to the version recorded before the most recent upgrade.
3. Forward upgrades require a package comparison with no breaking findings (not
   separately answered; the planned default stands). Revert skips that check and
   relies on the per-character dry run.

## Why this is small

- Character state is stored by stable definition ID (`state_json.values`,
  `state_json.entries`). Granted actions and expressions resolve from the pinned
  package. Placing an item copies its template field defaults into the entry, so
  the check moves values that still equal the old default to the new default and
  keeps changed values (the preview reports both).
- `comparePackages` (`src/systems/implementation/package/compatibility.ts`)
  already classifies breaking changes at publish time.
- `decodeRuntimeState`, `validateEntryForSlot`, `validDefaults` and
  `templateApplicable` already validate a state against a package on every write.
  Running them against the target package is the "verify the build" dry run.

## Stage 1 — Version check (pure, read only) — done

- [x] `checkVersionChange({ from, to, entityId, state, direction })` in
  `src/systems/implementation/runtime/version-change.ts`. `upgrade` blocks on any
  `comparePackages` finding; both directions rebuild the state against the target
  entity (keep values by ID, default new stored fields, drop fields the target
  lacks), move entries (follow unchanged template defaults and art, keep changed
  values, add new template fields, re-pin derived campaign bases), validate every
  entry (sheet slot, slot acceptance and capacity, template values, derived base)
  and evaluate the target. Returns `{ ok, blockers[], packageFindings[],
  addedFields[], droppedFields[], changedEntries[], validations[], nextState }`.
  Target validation messages are reported, not blocking, as on normal saves.
- [x] `comparePackages` now also flags `template_field_removed`,
  `template_field_kind_changed`, `template_field_required_added` and
  `slot_capacity_reduced` (also breaking at publish).
- [x] Unit tests: additive upgrade with followed and kept item stats, new
  character field, campaign-derived entry re-pinned with its override kept,
  breaking template field removal, value outside a narrowed range, same version,
  other system, revert keeping play values and dropping a new field, revert
  blocked by a newer-only item.

## Stage 2 — Character upgrade and revert

- [ ] Schema baseline: `characters.previous_system_version_id uuid NULL
  REFERENCES system_versions(id)`.
- [ ] `GET /characters/:id/version-options`: later published versions of the same
  system the actor may use with package compatibility, plus the revert target if
  one is recorded.
- [ ] `GET /characters/:id/version-check?targetVersionId=`: dry-run report. The
  direction is `revert` only when the target equals the recorded previous version.
- [ ] `POST /characters/:id/version` with `{ targetVersionId, expectedRevision }`
  and an idempotency key. One transaction: lock, recheck revision and
  authorization, rerun the check, write the version, state and
  `previous_system_version_id` (set on upgrade, cleared on revert), bump revision,
  record activity/audit `system_version_upgraded` / `system_version_reverted`.
  Standalone and returned characters, owner only; attached characters use the
  campaign path.
- [ ] Tests: upgrade, revert, second revert rejected, revision conflict, replay,
  blocked report returns 409 with blockers, cache disposition `replace`, rolls and
  activity kept.

## Stage 3 — Campaign upgrade and revert

- [ ] Schema baseline: `campaigns.previous_system_version_id`.
- [ ] `GET /campaigns/:id/version-check?targetVersionId=`: dry run for every
  attached character and every campaign template with a system base.
- [ ] `POST /campaigns/:id/version`: active GM/co-GM; one transaction moves the
  campaign, all attached characters and template bases (`versionId`,
  `packageChecksum`) or nothing. Campaign and per-character activity.
- [ ] Tests: all pass, one blocked character blocks all, concurrent sheet edit
  conflicts, player denied, revert after a template using a new base was created
  is blocked, adoption at the new version works.

## Stage 4 — GUI

- [ ] Character sheet menu and campaign settings: **Rules version** shows the
  current version, compatible later versions (publication date, short ID, release
  notes) and **Revert to …** when available. The preview lists added and dropped
  fields, changed items in this character's inventory and blockers in plain
  language; confirm commits.
- [ ] Standalone adoption into a campaign on a newer version offers the upgrade
  first.
- [ ] e2e at 360/1280 px: author publishes an additive version with a changed
  item stat, owner upgrades, the sheet shows the new stat and a roll uses it,
  owner reverts and the old stat returns with current values kept.

## Out of scope

Breaking upgrades, field mapping/renaming, reverting to any version other than the
recorded previous one, moving between systems, automatic upgrade on publish,
updating campaign-derived entries already placed on sheets, version lineage tables.
