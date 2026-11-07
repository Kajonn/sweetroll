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
3. A breaking package change blocks an upgrade only when it affects the
   character (its entity, sheet actions, used templates/slots, or expressions they
   depend on). Revert skips the package comparison and relies on the dry run.

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
  `src/systems/implementation/runtime/version-change.ts`. `upgrade` runs
  `comparePackages` and blocks only on findings that touch the character
  (`affectsCharacter` on each reported finding); both directions rebuild the state against the target
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
  breaking template field removal blocking only an owner of that item, unused
  item/slot removal allowed, own entity field removal blocked, value outside a narrowed range, same version,
  other system, revert keeping play values and dropping a new field, revert
  blocked by a newer-only item.

## Stage 2 — Character upgrade and revert — done

- [x] Schema baseline: `characters.previous_system_version_id uuid NULL
  REFERENCES system_versions(id)`.
- [x] Systems: `SystemRuntime.checkVersionChange` loads both packages and runs the
  stage 1 check; `SystemAuthoring.listUpgradeTargets` returns later published
  versions of the same system the actor may use (owner or `public`/`link`
  access, active system); `describeVersionChoices` describes pinned versions.
- [x] `GET /characters/:id/version-options`: `{ current, revertTo, upgrades }`.
  It lists choices only; the dry run runs for the chosen target (no package is
  loaded per listed version).
- [x] `GET /characters/:id/version-check?targetVersionId=`: `{ revision,
  direction, report }` without the next state. `revert` only when the target is
  the recorded previous version; any other target must be a listed upgrade (404
  otherwise, 422 for the current version).
- [x] `POST /characters/:id/version` with `{ targetVersionId, expectedRevision,
  idempotencyKey }`: management command `changeVersion`. The dry run uses the
  record only when its revision equals `expectedRevision`; the transaction locks
  the row, rechecks revision, version and standalone placement, writes version,
  state and `previous_system_version_id` (set on upgrade, cleared on revert),
  bumps revision and records activity/audit `system_version_upgraded` /
  `system_version_reverted`. A blocked report returns 409. The result view has
  cache disposition `replace`.
- [x] Standalone and returned characters, owner only; attached characters are
  denied like ownership transfer and move with their campaign (stage 3).
- [x] Integration tests (`tests/integration/character-version-change.test.ts`,
  full schema): options, check, stale revision 409, upgrade with followed item
  stat and new field, idempotent replay, activity payload, revert blocked by a
  newer-only item, revert after removing it, breaking change blocking only the
  affected character, other users denied, older/foreign/current targets rejected.

## Stage 3 — Campaign upgrade and revert — done

- [x] Schema baseline: `campaigns.previous_system_version_id`.
- [x] Systems facade (`src/systems/templates.ts`) exports `checkVersionChange` and
  `checkTemplateBaseChange` (re-pin a template base, follow unchanged defaults,
  block on a breaking finding for that base, on a missing base or invalid
  defaults) so the campaign transaction verifies locked rows itself.
- [x] `GET /campaigns/:id/version-options` and
  `GET /campaigns/:id/version-check?targetVersionId=` (active GM/co-GM; others
  404): per-character reports and per-template blockers, overall `ok`.
- [x] `POST /campaigns/:id/version` (`{ targetVersionId, expectedCampaignRevision,
  idempotencyKey }`): active GM/co-GM, active campaign. Locks the campaign, then
  attached characters and templates; rechecks revision and direction; any blocker
  returns 409 and writes nothing. Otherwise moves every attached character
  (version, state, previous version, revision, campaign-scoped activity, audit),
  appends a template content revision with the re-pinned base for each
  system-based template, moves the campaign pin and records campaign audit and an
  idempotency receipt in one transaction.
- [x] Integration tests (`tests/integration/campaign-version-change.test.ts`):
  player denied, options/check, stale revision 409, upgrade moving two characters
  and a template base with the campaign override kept, placement working after
  the upgrade, attached characters refused on the standalone route, revert,
  one breaking template blocking the whole campaign with nothing written, and a
  breaking version allowed when nothing in the campaign uses the change.
- Not done here: a campaign activity-feed entry. Campaign activity kinds are a
  checked enum rendered by the web app; add `system_version_upgraded` /
  `system_version_reverted` there in stage 4. Audit and per-character activity
  are recorded now.

## Stage 4 — GUI — done

- [x] Character tools: **Rules version** (standalone characters the actor may
  edit; hidden for campaign characters and read-only tabs) opens a dialog with
  the current version, the revert target and later versions (semantic version,
  publication date, release notes). Choosing one runs the server check; the
  preview (`VersionReportSummary`) lists blockers first, then added and dropped
  fields, per-item updated/kept/added/removed stats and art, error messages after
  the change and how many other rule changes do not affect the character.
  **Upgrade**/**Revert** stays disabled until the check passes and while edits
  are pending, the tab is offline or the character is archived.
- [x] The change goes through the character session as a durable online attempt
  (`kind: "version"`, `POST /characters/:id/version`) with the same ordering,
  replay and review rules as archive/recover. The POST answers 409 (not 404) for
  a target that is no longer available, so the session never reads it as a lost
  character.
- [x] Campaign Settings (GM/co-GM): **Rules version** panel with the same choices;
  the check shows every character's summary and blocked campaign items; the
  change asks for confirmation and sends the current campaign revision with a
  fresh key.
- [x] Campaign activity feed: `system_version_upgraded` /
  `system_version_reverted` (schema CHECK, API enum, web labels), visible to all
  members.
- [x] Adoption: the dialog still lists only characters at the campaign's exact
  version and now tells owners to upgrade older characters with Rules version
  first (character summaries carry no system ID, so mismatched characters are
  not listed individually).
- [x] Tests: `VersionDialog.test.tsx`, campaign settings rules-version tests,
  session request test, and e2e `tests/e2e/systemVersionUpgrade.spec.ts` (player
  upgrade with the new item stat, revert with the old stat back, GM campaign
  upgrade, no horizontal scroll at 360/1280 px). The e2e journey passed locally
  against a fresh database; it does not roll dice after the upgrade.

## Out of scope

Breaking upgrades, field mapping/renaming, reverting to any version other than the
recorded previous one, moving between systems, automatic upgrade on publish,
updating campaign-derived entries already placed on sheets, version lineage tables.
