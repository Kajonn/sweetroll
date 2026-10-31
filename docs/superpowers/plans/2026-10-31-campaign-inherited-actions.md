# Campaign templates with inherited actions — adventure slice C

**Status:** implementation in PR #25. All seven CI #154 verification jobs pass on draft-preservation fix `f11e7b9`. The normal hosted journey passed on deployed `5d3bb88`; its offline journey exposed an editor draft reset, now repaired with a red → green regression. Redeploying the fix was cancelled by Railway's approval gate, so C7 remains open. [Current verification record](../../acceptance/campaign-inherited-actions-2026-10-31.md#ci-154--hosted-finding-repaired-redeployment-blocked).
**Baseline:** `ba8200b3a6dff4a22e3865a7f7db1aeeab59058e` (`main`, PRs #24 and #23 merged).
**Goal:** a GM derives a campaign item from a published system template; a player adds a pinned copy and uses its existing validated actions.
**Sequence:** after [data-only campaign catalogs (B)](2026-10-09-campaign-data-templates.md), before player proposals (D1) and restricted audiences (D2). This is adventure-items C, separate from the completed dice/push slice C.
**Authority:** [design §§5.4, 6.4, 17.0 and 17.9b](../../../design_v2.md), [adventure-items roadmap](2026-10-07-adventure-custom-items.md), [dynamic objects](../specs/2026-09-26-dynamic-sheet-objects-design.md), [push contract](../specs/2026-10-24-configurable-push-rolls.md), [GUI gates](2026-09-08-gui-integration.md).

The app and its databases are under development until the first application release tag (`v*.*.*`). Edit `database/schema.sql` and recreate isolated disposable databases when needed. No app/database upgrade chain, character/campaign version upgrade, instance conversion, old-client adapter or transition test belongs in this slice. Immutable published rules, current-format validation and exact-request recovery remain required.

## User outcome and scope

1. A GM/co-GM opens Campaign → Items & powers → Create and selects **Based on system template**.
2. Choose a template from the campaign's pinned published system. A license-neutral Longsword example has Hit using the carrying character's Might, Damage using the item's typed damage bonus, and an existing nominal action.
3. Rename it “Captain's sword”, describe it and override allowed field defaults/quantity. Inspect inherited action labels and inputs; formulas and policies are read-only. Save publishes to all active campaign members, as in B.
4. A player adds it from a compatible slot. Values on that copy remain independently editable through existing typed controls. Hit, Damage and nominal actions behave like the base system item.
5. Revising the catalog changes new placements only. Archiving prevents new placement; existing copies, actions and authorized history remain usable. Removing a copy removes its actions and preserves prior history.

Apply the same mechanism to all existing compatible kinds: item, spell, ability (stored `talent`) and effect. An effect entry remains a record; it gains no automatic condition/stat engine. Inherit the base's existing roll, nominal and entry-resource actions, including its push policy where applicable.

Excluded: new expressions/action definitions/field schemas, per-action customization, new game mechanics, restricted audiences/private drafts, player proposals, trading, bulk instance updates, rebasing an existing catalog template, offline catalog authoring, and production identity-provider implementation. Do not silently drop supported base actions to make a derived template publishable; reject an unusable base with an actionable diagnostic.

## Decisions for the implementation contract

| Concern | Required behavior |
|---|---|
| Base identity | Server resolves the base template ID from the campaign's immutable published version and records version ID, package checksum and definition ID. Client cannot select a different rules version or supply executable definitions. |
| Editable content | Existing bounded name/description/notes and item default quantity, plus typed overrides for the base's existing writable fields. Reuse field validation, choice IDs, resource bounds, defaults and budgets. Computed/image fields remain non-editable where the current entry runtime excludes them. |
| Immutable source | Base identity and kind are fixed at creation. Create another campaign template to use another base. Catalog edits append immutable content revisions; resource revision still advances independently for archive/recover. |
| Execution | Resolve actions/expressions from the character's pinned published package through one shared effective-entry-definition resolver. Apply permitted presentation/default overrides without mutating the package or introducing another evaluator. |
| Placement | Keep B's reference-only request: campaign/template IDs and selected resource/content revisions. Reject supplied snapshots, actions, fields, results or seeds. The server materializes metadata and typed defaults; later instance edits cannot change provenance. |
| Existing copies | Preserve the exact materialized catalog revision. Rendering, editing and action execution need the pinned package and placed snapshot, not a live/latest campaign catalog lookup. Catalog archive or edits do not revoke existing copies. |
| Compatibility | Base version/checksum must match the campaign and target character pins. Check slot kind/capacity, target entity/action applicability and referenced carrying-character fields at discovery, placement and execution. Reject mismatches; never remap IDs. |
| Display data | Store campaign name/description/notes separately from inherited typed field values. A display name must not overwrite a base field named `name` or change expression bindings. Preserve existing entry-over-character binding precedence for declared fields only. |
| Permissions | GM/co-GM writes; authorized controller/GM places and uses copies. System authorship grants no campaign authority. Retain membership, lifecycle, controller, audience and scoped receipt checks before disclosure/replay. |
| Return and duplication | Authorized returned/duplicated sheets keep their placed metadata, typed values and base reference under existing ownership rules. Fresh inherited actions work without former campaign membership/catalog access. They acquire no access to former campaign history or other catalog entries. |
| Pushes | A derived granted roll inherits the unchanged base policy. Save the effective base and placed source identity in the server-owned context. Preserve original bindings, eligible-only rerolls, one-child atomicity, limits and inherited audience principal. |
| Changed scope/source | Removal blocks new action/push execution; historical results remain authorized and readable. Exact source restoration follows the existing push contract. Return/adoption changes placement generation: old-scope push IDs/replays remain denied, while fresh authorized rolls use current scope. |
| Offline | Freeze the selected catalog reference, never reselect latest on refresh. New placement must still pass active/current checks at first server commit. Committed exact retries return their recorded outcome under current authorization. Reuse existing durable edits/online push attempts and cache purge; no new push queue. |

Before code, record exact DTO/snapshot shapes and bounds in a short companion spec. Use distinct strict data-only and system-derived snapshot cases: a derived snapshot carries immutable base identity, presentation metadata and typed defaults, while the campaign source continues to identify the selected catalog revision. Keep campaign entries' `templateId: null` convention and make the shared resolver distinguish validated derived copies from data-only personal/blank copies. Do not infer executable authority merely from a non-null ID or an unvalidated snapshot. Clients must never be able to submit this server-owned snapshot through add/update commands.

No new dice grammar or modification of published packages is required. If the companion contract shows that this representation conflicts with an existing public module contract, resolve and document that conflict before implementation; do not add legacy-format conversion to accommodate unreleased test data.

## Code review findings and ownership

| Current seam | Work required |
|---|---|
| `src/campaigns/templates.ts`, `templatePersistence.ts` | Current content is bounded text/quantity only. Extend immutable revisions with validated base identity and typed defaults; preserve campaign locking, receipts and revision/lifecycle semantics. |
| `src/campaigns/index.ts`, `src/bootstrap/http.ts`, Systems public interface | Campaign template commands currently receive only pool/clock/ID dependencies. Wire a narrow published-template read/validation capability owned by Systems; no second interpreter or new cross-module persistence shortcut. |
| `src/transport/http/campaignTemplates.ts`, `campaigns.ts` | Strict input schemas and response/export DTOs must agree. Add authorized base choices and source/default fields; regenerate contracts through the canonical generator. |
| `src/characters/index.ts` | Placement currently materializes text-only snapshots; discovery advertises campaign choices with empty fields/actions. Extend both, retaining exact selected revisions and transaction preconditions. |
| `src/systems/implementation/package/schema/dynamic.ts`, runtime `state.ts`, `entries.ts` | Snapshots currently contain text values; null-template entries accept only personal text fields. Add strict derived validation without allowing personal/blank entries to grant actions. |
| Runtime `resolve-entries.ts`, `projection.ts`, `push.ts`, `push-context.ts` | Action lookup/projection skip null-template entries; push context also omits them. Route validation, projection, roll/nominal/resource resolution and push provenance through the same effective definition. |
| `src/characters/persistence.ts`, `push.ts`, `campaignPlacement.ts` | Retain atomic campaign → character lock ordering, roll/activity/audit/receipt writes and scope generation checks. Validate return/duplication snapshots without new conversion behavior. |
| `web/src/campaigns/CampaignTemplates.tsx`, `campaignTemplateApi.ts` | Extend the existing online editor with a base selector, inherited-action summary and typed default controls; preserve frozen retries and stale revision review. |
| `web/src/characters/SlotListControl.tsx`, `CharacterRoute.tsx`, session/store | Derived campaign entries need typed controls and action projections, including after return and reload when catalog choices are absent. Preserve selected-reference freezing and current revocation/cache protections. |

Companion [implementation contract](../specs/2026-10-31-campaign-inherited-actions.md).

## Delivery and TDD sequence

One feature PR after this planning change. Work in the dependency order below; each behavior needs an observed meaningful red test, the smallest implementation, green, then refactoring. Existing passing tests or unchecked historical bundles are not substitutes for new evidence.

### C0 — Fix the contract before implementation

- [x] Specify exact create/edit/base-choice DTOs, immutable revision and snapshot shapes, effective resolver result, error mapping, payload limits and export boundaries in the companion spec.
- [x] Define both blank and derived cases, default-field collision handling, target-entity applicability, returned-copy rights, push source identity and cache scope. Keep source fixed on catalog edit.
- [x] Cross-link the spec from this plan/design. Verification status below distinguishes code from completed evidence.

**Gate:** every producer/consumer and lifecycle case has one unambiguous current-format contract; no migration or broader sharing work is introduced.

### C1 — Validated source and catalog revisions

**Files:** Campaigns templates/repository/index; Systems public interface and existing package validators; bootstrap wiring; `database/schema.sql`; `src/transport/http/campaignTemplates.ts`, `campaigns.ts`; `tests/integration/campaign-templates.test.ts`.

- [ ] Red: a GM cannot yet create a system-derived template with typed defaults; assert valid base resolution and immutable revision content using a real pinned package.
- [ ] Red: reject another version/campaign's base, unknown template/field/action, incompatible kind, invalid typed default/resource/quantity, arbitrary executable fields and oversized input. A player/system author cannot write.
- [ ] Implement create/edit/archive/recover under existing locks and receipts. Never change the base on edit. Keep blank data-only behavior and the 500-template/catalog paging limits.
- [ ] Green with real PostgreSQL: same-key replay and mismatch, concurrent co-GM edits, role revocation and rollback after content/audit/receipt write failures. Resource lifecycle revisions must not rewrite immutable content.
- [ ] Update the baseline schema only if storage needs it; initialize a fresh isolated test database. No old-schema detection, repair or upgrade suite.

**Gate:** authoritative source/defaults survive catalog round trips and exports, and denied/racing commands create no partial revision or receipt.

### C2 — Shared effective entry definitions

**Files:** `dynamic.ts`; runtime `state.ts`, `entries.ts`, `resolve-entries.ts`, `projection.ts`, `resolve.ts`; existing runtime/module tests.

- [ ] Red: a materialized derived entry currently projects no actions. Prove hit uses current carrying-character Might, damage uses the instance bonus, a nominal action records confirmation only, and an inherited resource action changes only its own entry resource.
- [ ] Implement one resolver for system entries, validated derived campaign copies and data-only entries. Resolve all mechanics from the pinned package; never patch/recompile a synthetic package from client data.
- [ ] Red → green: metadata name/field-name collision; typed defaults/instance edits; unknown base/checksum, missing field/entity/slot, invalid values, capacity and expression budget failures. Invalid runtime state must fail clearly, not silently lose actions or fall back to a success.
- [ ] Preserve system-item behavior and the no-actions rule for personal and blank campaign entries. Two copies of the same base keep independent values/resources and action identities by entry ID.

**Gate:** render/edit/roll/resource/nominal paths agree on the effective source, fields, labels and ownership.

### C3 — Authorized discovery, placement and lifecycle

**Files:** Characters `index.ts`, persistence and placement; catalog repository; transport character DTOs; campaign exports; integration/HTTP tests.

- [ ] Red: derived choices currently report no fields/actions. Return bounded authorized summaries, filtering applicability for the actual target character/slot; never disclose inaccessible bases or catalogs.
- [ ] Materialize the exact selected immutable revision server-side. On first commit recheck active catalog/resource/content revision and campaign/character pins under the existing transaction locks. Preserve reference-only input and immutable provenance on edits.
- [ ] Red → green with PostgreSQL/HTTP: template edit/archive versus placement, duplicate key versus changed key, stale character revision, returned/adopted scope, revoked controller/member and cross-campaign direct IDs. A conflict requires explicit review, never silent use of latest.
- [ ] Verify catalog revision 2 affects new copies only; archive/recover leaves old copies usable; remove deletes actions but preserves prior authorized results/history.
- [ ] Return and authorized duplication retain self-contained derived copies and typed values; fresh actions work without catalog I/O. No former-campaign catalog/history access or accidental grants to the old GM.

**Gate:** copying and playing an item is authorized and deterministic across lifecycle/concurrency boundaries; no partial character/activity/receipt state survives a failed commit.

### C4 — Inherited push policy and disclosure

**Files:** runtime `push.ts`, `push-context.ts`, `resolve-entries.ts`; Characters `push.ts`/persistence; existing push PostgreSQL/HTTP/browser fixtures.

- [ ] Red: derived campaign entries are currently omitted from granted push context. Save and compare effective base/version/checksum plus placed catalog revision/entry/slot identity.
- [ ] Green: original pool survives field/instance edits, excluded/locked dice stay retained, exhausted/empty/disallowed-success controls match server denials, and different-key/actor races create one child only.
- [ ] Preserve root audience principal and current authorization on options, command, replay, history/export and parent navigation. GM demotion or scope changes must not disclose results through an old receipt or cached panel.
- [ ] Catalog edit/archive does not invalidate an existing copy's source. Removing that copy does; exact restoration follows the existing contract. Return/adoption denies earlier-scope pushes; a fresh authorized roll on a retained copy remains pushable.
- [ ] Verify ordinary system-granted/entity pushes retain their existing lineage, deterministic retry and atomic failure behavior.

**Gate:** derived items inherit the supported push behavior completely without creating a weaker action/replay path.

### C5 — GM editor and player controls

**Files:** campaign template API/editor/tests; `SlotListControl`, route/session/store and tests; shared typed controls, translations and generated client contracts.

- [ ] Red: GM cannot choose an authorized base or edit typed defaults. Add Start blank/Based on system template, labeled choices and a read-only summary of inherited actions; do not show formula/policy editors.
- [ ] Reuse existing default-value controls and validation. Lock base/kind on edit; changing catalog defaults creates a revision and clearly leaves placed copies unchanged. Keep save inputs on errors and preserve the exact submitted retry.
- [ ] Derived picker/entry shows Campaign origin, campaign label once, typed values/quantity and existing roll/resource/nominal buttons. Returned copies need no former catalog fetch to edit or display actions.
- [ ] Red → green: delayed account/role responses, catalog revision change while Add is open, stale selection review, revocation cache purge, return with failed catalog refresh and no resurrection of old private data.
- [ ] Verify keyboard/focus/Escape and 320/360/768/1280 widths in light/dark. Keep destructive confirmation and existing data-only/system-item flows.

**Gate:** the complete normal workflow is usable through the existing GUI, with no technical identifiers required from users and no new stale-response disclosure.

### C6 — Durable current-app recovery

**Files:** existing session/store/coordination and production-worker offline suites; campaign-template and push browser fixtures.

- [ ] Red → green: select derived revision 1, queue its placement offline, reload, then reconnect. An unchanged active reference places exactly once; a catalog edit/archive or scope change requires explicit review/denial with original intent retained.
- [ ] Edit a placed derived value offline and replay once. Reopen the current snapshot/typed controls/history from the production worker. Offline roll/push availability follows the existing command policy; do not invent an offline push queue.
- [ ] Lose a committed derived push response, reload offline, reconnect and replay the exact frozen request. Preserve a single child and authoritative result; account switch/revocation purges inappropriate durable data.
- [ ] Keep same-build store reopening and current-worker recovery only; do not create old-client/database transition fixtures or adapters.

**Gate:** exact selected references and uncertain writes survive current-app interruption without duplicate placement/pushes or cross-account leakage.

### C7 — Final CI and deployed acceptance

- [x] Run Node 24 root unit, real PostgreSQL integration, typecheck, contracts check and build; frontend unit/typecheck/build; all canonical browser shards, production-offline and retained visual checks; Docker build. CI #152 on `f1fcbd7`: 468 root, 333 integration, 1,164 frontend, 60 browser, 28 offline and 10 visual checks pass, with no skipped DB coverage. See the verification record.
- [ ] Deploy the final application commit to the isolated test preview. Inspect source/pin/latest deployment, observe terminal SUCCESS and readiness, and match served HTML/JS/CSS/worker/manifest to that exact build. Recreate only the scoped disposable preview DB if the schema baseline changed; do not reset a shared database implicitly.
- [ ] Run two distinct accounts: GM/co-GM catalog create/edit and player placement/play. Cover Longsword hit/damage/nominal/resource parity, a push-enabled named-pool base, target compatibility rejection, independent copy values, revised defaults/new placement, archive/recover, remove/history and return without catalog access.
- [ ] Include racing GM edits/placement, revoked access, a frozen stale picker selection and exact offline/lost-response recovery. Use existing canonical runners; no assertion/retry/timeout/baseline loosening.
- [ ] Archive only run-created systems/characters/campaigns/templates and independently read back cleanup. Record exact commit, deployments/resources, browser/viewport/theme, sampled outcomes, failing findings and fixes under `docs/acceptance/`.
- [ ] Update design/roadmap/spec status from observed evidence; mark the implementation PR ready only after these gates. Real Android/iPad, real-provider sign-in, playtests and other unperformed G9 checks remain explicitly open.

## Completion and follow-up

Slice C is done when a GM-derived template can be placed, independently edited and played with all of its existing supported actions and push rules, while immutable source/revision, permissions, exact-request recovery and returned-copy behavior pass real integration/CI/deployed verification. No application feature is marked implemented by this planning PR.

Then proceed to **D1: data-only player proposals** and **D2: restricted drafts/audiences with explicit reveal and safe placement**, each with its own contract and secrecy/recovery acceptance. Keep public-release G9 work visible alongside feature development.

## Implementation evidence (2026-10-31, in progress)

- Observed red → green: a placed derived copy had no projected action; shared resolution now projects/executes its inherited roll with current carrying-character and independent entry bindings, and rejects a forged checksum.
- Observed red → green: pinned base selection/default validation; GUI base selection and publication; returned-copy editing/actions without a catalog. The editor test also exposed and fixed clearing a typed default restoring its original value before the next keystroke.
- Node 24 local server run: 458 passed, 10 database-backed tests skipped. Frontend: 1,164 passed. Backend/frontend typechecks, production builds and canonical contract identity pass. Skipped DB tests are not acceptance evidence.
- Added real PostgreSQL integration coverage for source authorization/default denial, immutable content/lifecycle, exact replay, hit/damage/nominal/entry-resource parity, independent revised copies, target applicability, returned/duplicated actions, old-scope denial and competing pushes. Added the same canonical derived journey to browser and production-worker suites, with offline placement/value edits and lost committed-push recovery. These suites require actual successful execution before completion is claimed.
- No schema change, historical migration, new expression interpreter or offline push queue is introduced.

### Local review and publication boundary

The exact shared integration/browser fixture also passes strict package compilation and runtime parity tests: metadata is separate from a base field named `name`, hit/damage bind independent typed values, nominal/resource effects agree, and inherited pushes preserve original bindings while removal or changed placed provenance is denied. An observed red → green test exposed source-object aliasing; push context now clones placed provenance. Another observed red → green test rejects base actions that need computed template fields the current entry runtime cannot supply. Source reads reuse the caller's transaction client, with a regression test, avoiding a second pool checkout while holding a campaign lock.

The initial publication block was resolved by the owner’s explicit approval. Command-line Git lacked write credentials; the connected GitHub integration published commit `d720fc3` and its tree was verified identical to the local candidate. CI #149 exposed saved-context UUID validation and a 314 ms versus 300 ms load assertion. The UUID failure has a meaningful red → green regression; the load threshold remains unchanged. CI and deployed verification of the repaired head remain open. The isolated preview was inspected read-only: it still runs main `ba8200b`, deployment `abf9286a-17ad-45a6-a7c2-bfe30409c60d`, so it is not feature acceptance evidence. See the [verification record](../../acceptance/campaign-inherited-actions-2026-10-31.md).

**Current publication/deployment state:** CI #154 verifies application fix `f11e7b9`, including 1,165 frontend tests, Docker and the unchanged 300 ms create p95 gate (278.9 ms). Live preview `5d3bb88` passed asset identity, the normal multi-account journey and supplemental backend boundary checks. Its offline journey revealed an editor draft reset; the repaired application is staged in a single-field commit-pin patch. Railway's deployment gate cancelled the action. Do not mark C7 or the implementation ready until the repaired GUI is deployed and both hosted journeys pass. [Evidence and staged update](../../acceptance/campaign-inherited-actions-2026-10-31.md#ci-154--hosted-finding-repaired-redeployment-blocked).
