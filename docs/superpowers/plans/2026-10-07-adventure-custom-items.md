# Adventure-specific custom items — implementation plan

**Status:** proposed follow-up, 2026-10-07. Planning only; no runtime or UI implementation is claimed.
**Authority:** [design_v2.md](../../../design_v2.md), especially §§3, 4.1, 5, 7.4, 9, 17; [dynamic sheet objects design](../specs/2026-09-26-dynamic-sheet-objects-design.md).
**Dependency:** the delivered dynamic-object slots, system templates, character entries, granted actions, revision/idempotency and offline flows.

## Goal and boundary

Players and GMs can create items specific to a character or adventure without editing or publishing the underlying system. A campaign can offer reusable adventure items to its members. The same scoped mechanism should support spell, ability (stored kind `talent`), and effect entries where the system slot accepts the kind. The first release does not implement automatic conditions or stat modifications.

The existing custom entry (`templateId: null`, currently a name-only fallback) is data-only. Existing system templates can grant rolls and nominal actions. This follow-up preserves both facts and introduces campaign-scoped templates separately; it does not make player-authored expressions executable or change immutable published system packages.

## Proposed product rules

| Scope | Creator/editor | Who can add to a character | Actions | Lifetime |
|---|---|---|---|---|
| Personal entry | Controller of the character or active GM/co-GM with sheet edit access | Created directly on that character | Data only | Character lifecycle |
| Campaign template | Active GM/co-GM; a player can submit a proposal for GM review in a later slice | Authorized controllers and GMs on attached characters | Inherit only validated actions from a pinned system template when based on one; a wholly custom template is data-only | Campaign lifecycle |
| System template | System creator, via existing publish flow | Existing character permissions | Existing validated granted actions | Immutable system version |

A player may create a personal item immediately. A GM may create the same kind of personal item on an editable campaign character and, separately, publish a reusable campaign template. A system author gains no campaign access from authorship. Standalone characters cannot use campaign templates. Active campaign membership and character authority are checked on each read, add, edit and action, with generic not-found for cross-campaign IDs.

Campaign templates have an audience of **GM only**, **selected players**, or **all players**. Visibility applies to template discovery and use; it is checked server-side, including direct IDs and pagination. A private template cannot be placed on a sheet visible to a broader audience without an explicit reveal/placement step: the existing campaign sheet policy grants GMs and controllers sheet access, so a sheet entry itself is not a secret store. Never send hidden labels, fields, or actions in a character projection. Start the first implementation with all-players templates and defer restricted visibility until the placement/reveal contract and preview-as-player are proven; GM notes already support secret preparation.

## UX journey

1. From a typed sheet slot, choose **Add → Custom item**. Enter name, optional description, quantity and simple notes/values appropriate to that slot. Show origin **Personal**. Save through the existing offline-capable character command.
2. A GM opens **Campaign → Items & powers → Create** and chooses **Start blank** (data only) or **Based on system item**. The latter offers only templates from the campaign's pinned system version and compatible slots, copies the base definition into a campaign revision, and allows a new label, description and permitted default values. The inherited hit/damage/nominal buttons remain available only if their expressions are valid for the target character/slot.
3. GM publishes the campaign template to all players. A player sees it in the slot picker with origin **Campaign**, adds it and changes that character's own values/quantity without editing the shared template.
4. Editing a shared template creates a new revision. Existing character entries stay pinned to the revision used at placement; GM can preview and explicitly update instances later. History retains the displayed label and resolved roll details from the time of use. Archiving a template hides it from new additions, while existing entries and actions remain usable until individually removed or explicitly migrated.
5. A player's optional **Suggest to GM** flow submits a data-only proposal. Only a GM/co-GM can approve and publish it; rejection leaves the personal entry untouched. This is a later slice, not a gate for personal and GM creation.

On phones, keep Add in the existing slot interaction, show scope and source in the picker, keep advanced fields collapsed, use the existing save/conflict status and destructive confirmation, and avoid duplicating the item name in its row.

## Architecture and implementation slices

### A. Personal custom entries (first usable slice)

- Extend the custom-entry command and schema with bounded, explicit data fields: name, description and notes; item quantity remains a positive integer. Define accepted kinds by the target slot rather than trusting a client-supplied kind. Keep `templateId: null` and reject granted actions on this path.
- Reuse character revisions, idempotency, offline queue, activity and export. Preserve old name-only entries on decode and migration. Validate lengths and payload size server-side; escape displayed text.
- Build accessible create/edit UI for a personal entry; show stored labels, not technical field IDs. Editing/removal follows existing sheet permissions.
- Gate: player and GM add/edit/remove; compatible slot checks; stale revision and retry; offline add/reconnect once; unauthorized character access denied; previous entries still render.

### B. GM campaign catalog (reusable data-only templates)

- Add a campaign-owned catalog resource keyed by campaign ID and stable template ID, with revision, lifecycle, creator, kind, labels, bounded fields, source metadata and audience. Keep it distinct from `campaign_content_items` notes and from immutable system packages.
- Add campaign Module operations and HTTP contracts for create/list/read/update/archive; all mutations require expected revision and idempotency. Pagination filters by active membership and audience before returning results. Archive is recoverable while retention permits.
- Add the GM catalog view and combine authorized compatible system and campaign choices in the slot picker. Character entries store a typed source and pinned catalog revision; legacy `templateId` system references and `null` custom entries continue to decode.
- Gate: GM/co-GM writes; player reads/instantiates allowed templates; revoked/outside members get no catalog or cached data; independent character cannot attach; archive blocks new placement and preserves old instances.

### C. Derived campaign templates with inherited actions

- Resolve the base against the campaign's pinned published system version. Allow only label/description/default-value overrides in the first pass; do not accept new expressions, action definitions, or field schemas. Validate compatible slot kinds and every referenced character attribute; reject missing references and budget violations at authoring and use.
- Snapshot the validated base action definitions in an immutable campaign template revision or pin the exact base version and revision with equivalent immutable lookup. The runtime uses the same granted-action evaluator and server authorization as system entries; no client-authored executable input. Preserve result/history after removal.
- Preview changes to existing instances before explicit migration; a campaign system upgrade must not silently reinterpret base template references. Include a compatible migration path or block upgrade with an actionable conflict until mappings are supplied.
- Gate: derived Longsword uses carrying character's Might for hit and damage; another character missing the required attribute cannot add it; nominal action, removed entry and history behave as existing system templates; a later catalog revision does not change placed entries.

### D. Restricted audiences and player proposals (follow-up)

- Add GM-only/selected-player draft visibility with explicit reveal and safe placement; prove direct-ID, list, projection, offline cache purge and preview-as-player behavior. Keep hidden drafts off character sheets.
- Add player proposals with submit/approve/reject status, distinct from live campaign templates. Approval creates a campaign revision; it never rewrites the personal entry automatically.

## Verification and release

- Unit: slot/kind, lengths/budgets, source resolution, immutable revision, action inheritance, cross-version invalidation and backward decoding.
- Integration: actor/GM/controller permissions, cross-campaign ID isolation, list filtering, revision conflict, idempotent retry, archive, upgrade and revocation. Test that hidden drafts cannot leak through character projections or cached selectors before enabling restricted audiences.
- Browser journey: player creates a personal key and edits quantity/notes; GM creates a campaign item derived from Longsword; player adds and rolls hit/damage; GM revises the catalog item; existing character remains on its pinned revision; new placement sees the revision; removal hides actions and preserves roll history. Repeat core write offline/reconnect and with a second editor causing a conflict.
- Run relevant server/web tests and a deployed acceptance journey before release; record CI and findings in `docs/acceptance/`.

## Decisions to settle during design review

1. Should players be allowed to submit proposals in the first campaign-catalog release, or is direct personal creation sufficient initially? Recommendation: later slice D.
2. Should a GM be able to edit action formulas for adventure items? Recommendation: no in this follow-up; base system actions only, with any freeform rule authoring designed separately.
3. Should sharing be restricted at launch? Recommendation: all-players published catalog first; private drafts and placement need a separate secrecy model.
4. Should changes to a shared template update existing copies? Recommendation: pin revisions and require explicit preview/update.
