# Sweetroll system extensions

**Implementation plan · 7 November 2026 · Owner-approved 2026-11-07 (X1–X13 as recommended)**

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

## Decisions (owner-approved 2026-11-07)

| # | Question | Recommendation |
|---|----------|----------------|
| X1 | What may an extension contain? | Only templates (`item`, `spell`, `talent`, `effect`) with their fields, granted actions and image, plus the expressions those templates use (`roll` for granted actions, `computed` for template fields; never `validation`). No entities, character fields, sheets, slots, entity actions, validations, reference data or presentation. "Abilities" are `spell`/`talent` templates. New stats or slots still need a new system version. |
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
| X13 | Not included | Extensions of extensions, dependencies between extensions, extensions that override or remove base templates, breaking extension upgrades, field mapping, cross-system extensions, a public extension catalog/marketplace (see *Future features*) and automatic extension upgrades. |

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
  expressions: [ compiled roll/computed expressions owned by its templates ]
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
The `system` source gains an optional `extensionId` (as implemented in E3; a
separate `extension` source kind was not needed). Campaign
derived bases gain optional `extensionId` and `extensionVersionId` with the
extension package checksum. Every place that resolves `effectiveTemplateId`
resolves `(origin, templateId)` instead. Granted action identity in rolls,
receipts, pushes and activity records the origin.

## Stages

Each stage ends with unit, contract and PostgreSQL integration tests passing and
the design document updated (red → green, per existing plans).

### E1 — Extension package contract (pure) — done

- [x] TypeBox schemas `ExtensionDocumentV1` and `ExtensionPackageV1`
  (`src/systems/implementation/package/schema/extension.ts`); codec
  `decodeExtensionDocument`/`decodeExtensionPackage` with structural checks and
  checksum (`package/extension.ts`); `signExtensionPackage` and
  `canonicalChecksum` (`package/canonical.ts`). Structural checks reuse the
  system ones (unique IDs, references, budgets, push policies). Extension
  expressions always compile with grammar 0.2.
- [x] `compileExtensionDocument(document, base, opts)` and
  `validateExtensionAgainst(base, extension)` (X4) in
  `rules/compile-extension.ts`. Computed template fields read only their
  template's fields; granted rolls also read the character fields the base
  exposes to that template kind (`grantedEntityFieldsForKind`, now shared with
  `compileDocument`) and their inputs. A different system is
  `extension_base_mismatch`; an expression that no longer typechecks is
  `extension_incompatible`; a kind no placed base slot accepts is a
  `template_kind_unplaceable` warning (its rolls then see no character fields).
- [x] `composeRules(base, extensions)` → `ComposedRules` (`rules/compose.ts`)
  with origin-scoped `template`/`expression` lookups (`null` = base),
  `templates()`, warnings, `identity` and an order-independent
  `compositionChecksum`; rejects more than 16 extensions
  (`PACKAGE_LIMITS.extensionsPerComposition`) and two versions of one extension.
- [x] `compareExtensionPackages(prev, next)` reusing the template and expression
  rules of `comparePackages` (refactored into shared helpers), plus
  `extension_identity_changed`.
- [x] Tests (`rules/compile-extension.test.ts`): compile and decode round trip,
  tampered checksum, unknown character field, computed field isolation,
  unplaceable-kind warning, validation expressions, duplicate IDs, shared
  expressions, push policies, later compatible base, base that no longer
  exposes a field, other system, same template ID in base and two extensions,
  checksum stability, duplicate/too many extensions, extension comparison.

### E2 — Authoring and publishing — done

- [x] Schema baseline: `systems.kind` (`system` | `extension`, check constraint
  with `base_system_id`), `systems.base_system_id`,
  `system_versions.built_against_version_id` and `system_drafts.base_version_id`
  (the base version an extension draft is previewed and validated against).
- [x] Repository: system records carry `kind`/`baseSystemId`; the system
  library, creation-version listing, version use and upgrade targets select
  `kind = 'system'` only, so extension versions can never become a character's
  base. New `listExtensionsPage`, `listPublishedVersions` and
  `authorizeExtensionUse`; `publishVersion` stores `built_against_version_id`
  and re-compares with `compareExtensionPackages` for extensions.
- [x] `ExtensionAuthoring` (`src/systems/extensions.ts`): `createExtension`
  (base version must be usable by the actor), `open`, `list`, `saveDraft`
  (optional base version change, rule errors are reported in the assessment
  with warnings, schema errors rejected), `preview`, `publish` (idempotent,
  breaking changes need acknowledgement and a major bump, the base version must
  still be usable) and `authorizeExtensionUse`.
- [x] Routes (`src/transport/http/extensions.ts`): `POST`/`GET
  /systems/:systemId/extensions`, `GET /extensions/:extensionId`, `PUT
  /extensions/:extensionId/draft`, `POST /extensions/:extensionId/preview`,
  `POST /extensions/:extensionId/publish`. **Deviation from the first draft of
  this plan:** extension drafts use these dedicated routes instead of the system
  draft/publish routes, because the draft format differs; the system draft,
  preview, publish, clone and export routes return 404 for extensions. Sharing,
  archive/restore and deletion reuse `PATCH`/`DELETE /systems/:systemId`;
  version deprecation reuses `PATCH /system-versions/:versionId`. Extension
  export/import is not included.
- [x] Template art: the system item image routes and `system_image_permissions`
  work for extension drafts and published extension versions unchanged.
- [x] Tests (`tests/integration/system-extensions.test.ts`): full
  create/draft/preview/publish/replay/breaking flow with immutable stored
  package; extensions absent from system routes and never usable as a base;
  base version switch and incompatible base; archived base; owner/public/link/
  private matrix for create, open, edit, list and use; archive and
  deprecation; no extension of an extension; referenced base cannot be deleted;
  template art upload, ownership and frozen published bytes.

### E3 — Character composition — done

- [x] Schema baseline: `character_extensions(character_id, extension_id,
  extension_version_id)`, one version per extension, FK `RESTRICT` on the
  extension and version so used extensions cannot be deleted. Every character
  read returns the sorted list (`CharacterRecord.extensions`). The previous
  composition for revert moves to E5 with the composition commands.
- [x] Runtime: `RuntimeRequest.extensions` and `describeVersion({ extensions })`;
  `createEffectivePackageLoader` (`runtime/composition-loader.ts`) loads the
  base and extension packages, runs `composeRules` and memoizes an in-memory
  *effective package* (`effectivePackage` in `rules/compose.ts`): extension
  templates and expressions are appended under `<extensionId>:<id>` keys, which
  no definition ID can collide with; base `versionId` and checksum are kept so
  campaign-derived bases still match. Entries map to their key with
  `templateKey(entry)`; effective packages are never stored or returned.
  Push contexts store the plain expression ID plus `extensionId` and a
  `compositionChecksum`, so a changed composition reads as `rules_changed`.
  Projected slot entries and described templates carry `extensionId`.
- [x] Characters: `POST /characters` accepts `extensions`; each must be a
  published version of an active extension of the character's system that the
  actor may use, at most 16, one version per extension; the runtime rejects
  compositions that do not fit. Every runtime call passes the record's
  extensions. `GET /characters/:id/templates` lists extension templates with
  `extensionId` and a `system` source; adding an entry accepts `extensionId`
  only for an extension of the character. Duplicates copy the composition.
- [x] Export: `extensions` (IDs and versions only) next to `systemVersionId`,
  omitted when empty; no extension content.
- [x] Public API v1: read-only `extensions` on the character sheet and
  `extensionId` on entries. Placing extension items through v1 is not included
  (X12, E7).
- [x] Guards until later stages: rules-version change returns 409 for
  characters with extensions (E5); campaign adoption returns 409 for them (E4).
- [x] Tests: `src/systems/runtime-extensions.test.ts` (same-ID base and
  extension templates on one sheet, entry without its extension, unknown
  version, missing loader, extension push and `rules_changed` after a different
  extension version, described templates) and
  `tests/integration/character-extensions.test.ts` (create with idempotent
  replay and mismatch, template list, placement of both swords, foreign
  extension rejected, roll with replay, base roll, push, export, duplicate,
  version change blocked; private/link authorization; revoked sharing keeps an
  existing character playable; two versions of one extension, other system,
  unknown version, system version used as extension version; used extension
  cannot be deleted).

### E4 — Campaign composition — done (one item deferred to E4b)

- [x] Schema baseline: `campaign_extensions(campaign_id, extension_id,
  extension_version_id, added_by, added_by_character_id, added_at)`; activity
  kinds `extension_added`/`extension_removed`. The previous composition moves
  to E5 with the composition commands.
- [x] Invariant: every attached character's `character_extensions` equals the
  campaign set, so the E3 character and runtime paths need no campaign lookup
  (`src/characters/campaign-extensions.ts`).
- [x] GM/co-GM commands (`src/campaigns/extensions.ts`), revisioned and
  idempotent like other campaign commands: `GET /campaigns/:id/extensions`
  (any active member; names and versions), `POST /campaigns/:id/extensions`
  (`added_by = 'campaign'`; the GM must be allowed to use the extension, it must
  extend the campaign's system and fit the composition; a second version of an
  included extension is 409) and `DELETE /campaigns/:id/extensions/:extensionId`
  (409 while an attached character has an entry from it or a campaign template
  is based on it, X9). Both write every attached character and bump the
  campaign revision and access revision. **Deviation:** extensions are added
  after campaign creation with the same command rather than in the create
  request; the GUI can do both in one flow (E6).
- [x] Campaign-created characters copy the campaign set. Adoption merges the
  character's extensions into the campaign (`added_by = 'character'`) in the
  adoption transaction, checks the merged composition, writes all attached
  characters and records `extension_added`; a different version of an
  included extension is 409 (X8). Assign and claim move already-attached
  characters and need no change. Returned characters keep their rows (X10).
- [x] Members use campaign-composition extensions only through campaign
  characters: the runtime loads them without a use check, while standalone
  creation, GM add and extension authoring routes still require access (X10).
- [x] Campaign rules-version changes return 409 while a campaign has
  extensions (E5). Campaign creation no longer accepts extension versions as a
  base (`loadAccessibleVersion` selects `kind = 'system'`; fixes an E2 gap).
- [x] Web: activity labels for the new kinds; web fixtures carry
  `extensions` (E3 follow-up).
- [x] Tests (`tests/integration/campaign-extensions.test.ts`): union of GM and
  character extensions shared with an earlier campaign character, the adoptee
  and a later campaign-created character (template list shows both packs);
  non-GM add refused; campaign version change refused; X8 sequential and
  concurrent adoption (the race resolves through the campaign lock and
  revision); private extension placed and rolled inside the campaign but not
  usable outside it or by another campaign; removal blocked while used, then
  allowed, removing from attached characters; activity kinds; idempotent add
  replay and key reuse; extension of another system refused.

### E4b — Campaign templates based on extension templates (deferred)

- [ ] A campaign template's system base may name an extension template:
  derived base `{ versionId, packageChecksum, templateId, extensionId,
  extensionVersionId, extensionChecksum }`, base picker over the campaign
  composition, placement and derived-entry checks by `templateKey`, re-pinning
  in E5. Deferred from E4 because it touches derived-entry pinning, the
  picker, placement, proposals and version re-pinning; removal already
  counts such templates as usage (X9).

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

## Future features (recorded, not authorized)

- **Extension catalog (owner request 2026-11-07).** A browsable catalog where
  users discover, preview and pick published extensions for a system (search,
  filter by system and kind, descriptions, item previews, and later ratings or
  curation). Until then, extensions are found through the per-system
  **Extensions** list (owned plus `public`) and by direct link. The catalog
  depends on the public-content moderation decision (design OD-07) and needs its
  own plan and owner approval before any work starts.

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
