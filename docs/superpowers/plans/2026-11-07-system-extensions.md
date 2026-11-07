# Sweetroll system extensions

**Implementation plan · 7 November 2026 · Proposed, awaiting owner approval**

## Goal

Let a system be extended with new items and abilities without publishing a new
version of the system itself. An **extension** is a separately published,
immutable package of templates (items, spells, talents, effects) for one system.
A character or campaign is built on **system version + a set of extension
versions** (its *composition*). A campaign's composition is the union of the
extensions it chose itself and every extension used by its attached characters.

This is a rules-content feature. It adds no application/database migration chain
(design Sections 12.4 and 17.0): new tables and columns go into the current
schema baseline, and disposable test databases are recreated.

## Owner request (2026-11-07)

> Systems should be able to be extended with new items and abilities. Add support
> for extensions which add items to a system. A character or campaign is built on
> system + extensions. Campaigns add all extensions that characters use + the ones
> the campaign uses.

## Proposed decisions (need owner confirmation before E1)

| # | Question | Recommendation |
|---|----------|----------------|
| X1 | What may an extension contain? | Only templates (`item`, `spell`, `talent`, `effect`) with their fields, granted actions and image, plus the `roll` expressions those granted actions use. No entities, character fields, sheets, slots, entity actions, validations, reference data or presentation. "Abilities" are `spell`/`talent` templates. New stats or slots still need a new system version. |
| X2 | Who can author one? | Any signed-in user, for any system they can use (owner, `public` or `link` access). The extension has its own owner, `private`/`link`/`public` sharing and lifecycle, like systems. Authoring an extension gives no rights over the base system. |
| X3 | Which system versions does an extension work with? | An extension version is published against one base version (`builtAgainst`). It can be combined with any version of the same system for which the composition validates (X4). The creator picks the base version used for preview and validation. |
| X4 | When is a composition valid? | Every extension validates against the base version: its granted actions and expressions typecheck against the character entity's fields, referenced resources exist, and at least one base slot accepts each template kind (warning, not error, when none does). Extensions never see each other. |
| X5 | Template ID clashes? | No renaming. Template and expression IDs are scoped by origin: the base system, or one extension (by its stable extension ID). Entries record `extensionId` next to `templateId`. |
| X6 | How many extensions? | At most 16 extensions per composition, one version of each. The existing 128-template limit applies per package. |
| X7 | Campaign union rule | Adopting or creating a character in a campaign adds the character's extensions to the campaign (one version per extension). An attached character uses the whole campaign composition, as attached characters already share the campaign's system pin (Section 6.7). Extensions added this way stay in the campaign when the character leaves; the GM removes them explicitly. |
| X8 | Version conflict on adoption | If the campaign already has the extension at another version, adoption is blocked until the owner moves the character to the campaign's extension version (same dry run as Section 6.7). The campaign never moves automatically. |
| X9 | Removal | Removing an extension from a character or campaign is allowed only when no entry (and, for a campaign, no attached character entry or system-based campaign template) uses it. The dry run lists blockers. |
| X10 | Access through a campaign | Campaign members may use the templates of every extension in the campaign composition inside that campaign, even a private one, through the campaign's pinned snapshot. This grants no access to the extension outside the campaign and no authoring rights. Returned characters keep the composition they had, like pinned versions today. |
| X11 | Upgrades and revert | Section 6.7 extends to compositions: upgrading or reverting the base system, upgrading one extension to a later version of the same extension, adding and removing extensions all use the same check, commit and single-step revert. The recorded previous state becomes the previous composition. |
| X12 | Public API v1 | Read-only composition fields on character and campaign responses in this plan. Writing compositions through `/api/v1` is a later, separately approved stage (E7). |
| X13 | Not included | Extensions of extensions, dependencies between extensions, extensions that override or remove base templates, breaking extension upgrades, field mapping, cross-system extensions, a public extension catalog/marketplace (OD-07) and automatic extension upgrades. |

## Current model (baseline facts)

- A published system version is an immutable `SystemPackageV1`
  (`src/systems/implementation/package/schema/package.ts`) with optional
  `templates` and `slots`. Granted roll actions reference `expressions` by ID.
- Characters and campaigns pin exactly one `system_version_id` and record
  `previous_system_version_id` (`database/schema.sql`).
- Entries (`CharacterEntryV1`, `.../schema/dynamic.ts`) store `templateId`, an
  optional `source` (`personal`, `system`, `campaign`) and, for campaign entries,
  a derived base `{ versionId, packageChecksum, templateId }`.
- The runtime loads one package per character through `PublishedPackageLoader`
  (`src/systems/implementation/runtime/package-loader.ts`) and validates entries
  with `validateEntryForSlot` (`.../runtime/entries.ts`).
- `checkVersionChange` (`.../runtime/version-change.ts`) and `comparePackages`
  (`.../package/compatibility.ts`) implement the Section 6.7 dry run.

## Design

### Extension package

```yaml
extensionPackage:
  schemaVersion: "1.0"
  extensionId: uuid          # stable identity (a `systems` row of kind extension)
  versionId: uuid
  semanticVersion: x.y.z
  baseSystemId: uuid
  builtAgainstVersionId: uuid
  metadata: { name, description, language }
  expressions: [ compiled roll expressions used by granted actions ]
  templates: [ ObjectTemplateV1 ]
  effectiveLimits, integrity: { checksum }
```

Storage reuses the system tables so drafts, publishing, checksums, sharing,
audit and item-art bundles work unchanged:

- `systems.kind text NOT NULL DEFAULT 'system'` (`system` | `extension`) and
  `systems.base_system_id uuid NULL REFERENCES systems(id)`; check constraint:
  base set exactly for extensions.
- `system_versions` holds extension versions too; `package_json` is an extension
  package and a new `built_against_version_id` column records X3.

### Composition

A composition is `{ systemVersionId, extensions: [{ extensionId, versionId }] }`
with a canonical, sorted form and a `compositionChecksum` over the base and
extension package checksums. It is stored relationally:

- `character_extensions(character_id, extension_id, extension_version_id,
  PRIMARY KEY (character_id, extension_id))`.
- `campaign_extensions(campaign_id, extension_id, extension_version_id,
  added_by text NOT NULL /* 'campaign' | 'character' */, added_by_character_id
  uuid NULL, PRIMARY KEY (campaign_id, extension_id))`. `added_by` is shown in
  Settings; it does not change behaviour after the add (X7).
- `characters.previous_composition_json` and `campaigns.previous_composition_json`
  replace the single `previous_system_version_id` for revert (X11).

A new `ComposedRules` view replaces direct package access in the runtime:
`templates(origin)`, `template(origin, templateId)`, `expression(origin, id)`,
`slots`, `entity`, `actions`. `origin` is `base` or an extension ID. A
`CompositionLoader` loads and caches the base and extension packages (each still
checksum-verified) and builds the view.

### Entries

`CharacterEntryV1` gains optional `extensionId` (absent means base system).
`source` gains `{ kind: "extension", extensionId, templateId }`. Campaign
derived bases gain optional `extensionId` and `extensionVersionId` with the
extension package checksum. Every place that resolves `effectiveTemplateId`
resolves `(origin, templateId)` instead. Granted action identity in rolls,
receipts, pushes and activity records the origin.

## Stages

Each stage ends with unit, contract and PostgreSQL integration tests passing and
the design document updated (red → green, per existing plans).

### E1 — Extension package contract (pure)

- [ ] TypeBox schemas for the extension document and package; codec, canonical
  form and checksum.
- [ ] `validateExtensionAgainst(base, extension)` (X4): expression typecheck with
  base entity bindings, resource references, slot acceptance warnings, limits.
- [ ] `composeRules(base, extensions)` → `ComposedRules`, with
  `compositionChecksum`.
- [ ] `compareExtensionPackages(prev, next)` reusing the template part of
  `comparePackages` for publish-time breaking-change findings.
- [ ] Tests: valid/invalid extensions, ID clash between base and extension and
  between two extensions resolved by origin, extension referencing a field the
  base version lacks, limits.

### E2 — Authoring and publishing

- [ ] Schema baseline: `systems.kind`, `systems.base_system_id`,
  `system_versions.built_against_version_id`.
- [ ] `SystemAuthoring.createExtension(systemVersionId)`; drafts restricted to
  metadata, templates and their expressions; preview against the chosen base
  version; publish with validation and comparison; sharing and archive reuse
  `changeSharing`/lifecycle.
- [ ] Routes: `POST /systems/:id/extensions`, `GET /systems/:id/extensions`
  (owned plus `public`; `link` by ID), existing draft/publish routes accept
  extension drafts. Seeding of reference templates is unchanged.
- [ ] Item art bundles and `system_image_permissions` cover extension templates.
- [ ] Tests: authorization matrix (owner/public/link/private, archived base),
  publish idempotency, immutable versions.

### E3 — Character composition

- [ ] Schema baseline: `character_extensions`, `characters.previous_composition_json`.
- [ ] `CompositionLoader` and `ComposedRules` adopted in `SystemRuntime`,
  entries, action evaluation, pushes, export and projection.
- [ ] Character creation accepts `extensions: [{ extensionId, versionId }]`;
  each must be usable by the actor (X2) and valid with the base (X4).
- [ ] Placement from an extension template; entries store `extensionId`.
- [ ] Character export includes composition identity only (IDs, versions,
  checksums), no extension content.
- [ ] Tests: create, place, roll, push, offline replay with an extension entry;
  same template ID in base and extension on one sheet; revoked sharing keeps an
  existing character working.

### E4 — Campaign composition

- [ ] Schema baseline: `campaign_extensions`, `campaigns.previous_composition_json`.
- [ ] Campaign creation and Settings: GM/co-GM add extensions (`added_by =
  'campaign'`).
- [ ] Campaign character creation, assign, claim and adoption: one
  transaction merges the character's extensions into the campaign set
  (`added_by = 'character'`), blocks on a different version (X8), dry-runs every
  attached character against the new composition and writes all or nothing. The
  adoption disclosure lists extensions that will be added.
- [ ] Attached characters read the campaign composition; return keeps the
  composition at the time of return (X10).
- [ ] Campaign templates with a system base may use an extension template base.
- [ ] Members access campaign-composition extension content only through the
  campaign (X10).
- [ ] Activity: `campaign_extension_added`, `campaign_extension_removed` with IDs
  and versions only.
- [ ] Tests: union rule with two players using different extensions, version
  conflict blocked, private extension usable inside the campaign only, removal
  blocked while used, concurrent adoption.

### E5 — Composition changes (Section 6.7 extension)

- [ ] Generalise `checkVersionChange` to `checkCompositionChange({ from, to,
  ... })`: base upgrade/revert, extension add, remove, upgrade, and revert to
  the previous composition. Per-character blocking rules from Section 6.7 apply
  per origin.
- [ ] Routes: replace `version-options/version-check/version` with
  `composition-options`, `composition-check` and `POST .../composition` for
  characters and campaigns (pre-release, so the old routes are removed rather
  than kept, Section 17.0). Activity kinds `system_version_upgraded`/`reverted`
  plus `extension_added`/`removed`/`upgraded`.
- [ ] Tests: extension upgrade following unchanged template defaults, extension
  removal blocked by an entry, campaign-wide extension upgrade blocked by one
  character, revert restores previous composition.

### E6 — GUI

Follow the [GUI integration plan](2026-09-08-gui-integration.md) gates.

- [ ] System library: **Extensions** list per system and **Create extension**.
- [ ] Creator: extension mode shows Overview, Templates and Publish only, with a
  base-version selector for preview.
- [ ] Character creation and campaign creation: optional extension picker with
  compatible versions.
- [ ] Item picker groups templates by origin (system name / extension name).
- [ ] Character tools **Rules version** becomes **Rules and extensions**; campaign
  Settings likewise. Both run the check before offering a change.
- [ ] Offline cache stores the composed rules keyed by `compositionChecksum`.
- [ ] Browser tests at 360/768/1280px, keyboard path, light/dark.

### E7 — Public API v1 (separate approval)

- [ ] Read-only: `composition` on v1 character and campaign responses (this
  stage's read part is included in E3/E4).
- [ ] Not in this plan: creating/upgrading compositions or publishing extensions
  through `/api/v1`.

### E8 — Acceptance

- [ ] Local ordered journey: creator publishes system and extension; player A
  creates a character with extension X; GM campaign adds extension Y; A's
  character is adopted (campaign now has X and Y); player B places an X item;
  extension X is upgraded campaign-wide; revert; removal blocked then allowed.
- [ ] Isolated hosted journey with the same steps and independent cleanup.
- [ ] No G9 release gate is closed by this feature.

## Design document changes

Add design Section 6.8 *System extensions* (proposed; links this plan), extend
Section 6.7 and Appendix A/B with compositions and the extension package, and
update the Section 12 data table. Section 6.8 is added as **proposed** now; the
rest is written when the owner approves and the stages land.

## Risks

- **Runtime reach.** Many call sites read `package.templates` directly; E3 must
  move them all to `ComposedRules`. Mitigation: remove direct template access
  from the runtime package type so the compiler finds every site.
- **Campaign blast radius.** Adoption can now change every attached character's
  rules. Mitigation: full dry run in the adoption transaction, explicit
  disclosure, and additions only (no removals or version changes on adoption).
- **Privacy.** Private extensions become visible to campaign members (X10).
  The adoption disclosure states this before the owner confirms.
