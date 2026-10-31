# Campaign data-only templates — slice B implementation plan

**Current follow-up (2026-10-31):** B is delivered. Implement C using the [inherited-actions execution plan](2026-10-31-campaign-inherited-actions.md), then D1 proposals and D2 restricted audiences. The owner's [pre-release policy](../../../design_v2.md#170-release-status-and-application-version-policy) supersedes historical migration/rollback, previous-format decoding and store-version conversion instructions below: those are not current implementation or acceptance gates. Current-format validation, pinned copies, permissions, returned sheets and exact-request offline recovery remain required. Preserve completed historical evidence without reintroducing removed upgrade code/tests.

**Status (2026-10-14):** core implementation and the three Task 7 review fixes are implemented in [PR #19](https://github.com/Kajonn/sweetroll/pull/19). Required [CI on fix commit `0e61d15`](https://github.com/Kajonn/sweetroll/actions/runs/38596526273) passed. Both follow-up live journeys passed on the isolated preview after user approval; the Task 7 deployed gate is closed. Deployment metadata identifies `ae71eb4`, which differs from the tested fix commit only in documentation; the deployed frontend assets match the tested build byte-for-byte. See [acceptance evidence](../../acceptance/campaign-data-templates-2026-10-10.md).
**Baseline:** `54580adb1cdf64b356fbd3011b31784f7fe938c4` (`main`, PR #17 merged).
**Goal:** an active GM/co-GM publishes a reusable adventure template; an authorized player places a pinned, editable copy on a campaign character.
**Authority:** [design_v2.md](../../../design_v2.md) §§4.1, 5.4, 9, 17.9; [adventure items roadmap](2026-10-07-adventure-custom-items.md), slice B; [dynamic objects design](../specs/2026-09-26-dynamic-sheet-objects-design.md); [GUI integration gates](2026-09-08-gui-integration.md).
**Method:** execute tasks in dependency order. For each behavior, write a meaningful failing test, record the red result, implement the smallest change, run green, then refactor. Do not mark a gate complete from a document, mock, skipped DB suite, or unobserved CI result.

## Scope and delivery

One implementation PR: **Add reusable data-only campaign templates**. Deliver the entire create/publish → discover → place → edit-instance → revise → archive/recover flow. The original planning PR #18 changed documentation only; PR #19 includes the plan and implementation.

Included: blank templates for `item`, `spell`, `talent` (UI: ability), and `effect`; fixed bounded text fields; item quantity; all-player publication; immutable content revisions; recoverable archive; existing character revision/idempotency/offline flow; authorization/cache lifecycle; a conservative migration safeguard.

Deferred: system-derived templates and inherited actions (C), player proposals (D1), restricted audiences/private drafts/reveal/preview-as-player (D2), explicit instance upgrades, custom schemas/formulas, automatic effects, imports, bulk placement, and offline catalog authoring. A data-only effect is a recorded condition, not an automatic stat modifier.

After B, prioritize C, then D1, then D2. C depends on B's source/revision contract plus pinned action resolution. D1 reuses publication; D2 additionally needs secrecy, reveal, projection and cache guarantees.

## Decisions fixed for this slice

| Concern | Contract |
|---|---|
| Publication | Create and publish atomically to `all_players`; no separate draft or publish state. All active members, including GMs, may discover active templates. |
| Writes | Active campaign owner/co-GM only, under existing campaign lifecycle policy. System authorship confers no authority. |
| Editable data | Required nonblank name: 1–200 characters. Optional description/notes: at most 2,000 characters each. Reject unknown keys, nontext values, actions and executable definitions. Reuse slice A validation and HTTP payload limits. |
| Quantity | Optional default quantity for `item`, default 1, positive safe integer. Other template kinds do not author quantity. Existing legacy entry behavior is unchanged. |
| Compatibility | Persist the template kind; the target published slot must accept it and have capacity. Kind is immutable after creation; create a new template to change kind. |
| Revisions | `revision` is mutable-resource concurrency version; `contentRevision` identifies immutable content. Create: both 1. Edit: increment both. Archive/recover: increment only resource revision. |
| Placement | Client sends campaign template ID, selected resource revision and content revision. Server materializes defaults and immutable provenance. A first commit requires an active template with both selected revisions still current. |
| Copy behavior | Character values can be edited independently. Later catalog edits never change old copies. No live catalog lookup is required to render, edit, export or remove a placed data-only copy. |
| Archive/recover | Archive hides discovery and denies new placement; old copies remain usable. Recover publishes the same current content with a new resource revision. No hard-delete/retention worker in B; preserve revisions for the campaign lifecycle. |
| Returned character | Existing materialized copies follow the returned sheet to its owner. Campaign discovery/new placement and campaign history do not follow. This is the existing returned-sheet exception, not continuing membership. |
| Duplication | Existing permitted character duplication preserves data-only snapshots/provenance. It grants no catalog access and cannot fetch another revision. |
| System upgrade | Block preview/commit that would rebuild state containing any entries, until safe entry migration exists. Include legacy system/personal entries and campaign snapshots; do not silently discard them. Rollback also must not discard entries added after migration. |
| Offline | Character placement may queue an already fetched choice with frozen revisions. Catalog writes require connectivity. Catalog changes before first server commit cause explicit conflict, never automatic substitution. |

## Data and module contracts

Add `campaign_item_templates` and `campaign_item_template_revisions` directly in `database/schema.sql`.

- Template row: UUID ID, campaign ID, creator ID, immutable kind, fixed `all_players` audience, active/archived status, resource revision, current content revision, creation/update/archive timestamps.
- Content row: template ID + content revision unique key, name/description/notes, optional item default quantity, author and timestamp. No content-row updates; append on edit. Use relational constraints for campaign/source integrity and positive revisions/quantity, plus module validation for text and body budgets.
- Index catalog queries by campaign/status and stable keyset ordering. Use bounded limits and the existing cursor conventions; authorization precedes pagination and cursor output. Archived management lists and reads are GM-only; active lists are member-readable.
- Keep notes in `campaign_content_items` unchanged. A template is not a note and does not inherit note ownership/sharing rules.

Expose operations through `Campaigns`, implemented in a focused `src/campaigns/templates.ts` collaborator, following `content.ts`. Persistence belongs to the Campaigns module. Wire dependencies through bootstrap; Characters consumes a narrow transaction-aware template resolver, not a pool-owning HTTP call. Runtime remains independent of Campaigns persistence and authorization.

Implemented HTTP contracts (backend paths; deployed same-origin paths have `/api` prefix):

| Operation | Route | Preconditions/result |
|---|---|---|
| Create + publish | `POST /campaigns/{campaignId}/item-templates` | GM; `expectedTemplateRevision: 0` means no prior resource; idempotency key; returns active revision 1. Server generates ID using existing create/receipt conventions. |
| List | `GET /campaigns/{campaignId}/item-templates` | Active member; bounded cursor/limit and optional kind filter; default active. `status=archived` requires GM. |
| Read | `GET /campaigns/{campaignId}/item-templates/{templateId}` | Same campaign/member policy; current content and revisions; archived read GM-only. No public historical-revision browsing. |
| Edit | `PATCH /campaigns/{campaignId}/item-templates/{templateId}` | GM; active; expected resource revision + idempotency key; append full validated content revision. |
| Archive | `POST /campaigns/{campaignId}/item-templates/{templateId}/archive` | GM; active; expected resource revision + idempotency key. |
| Recover | `POST /campaigns/{campaignId}/item-templates/{templateId}/recover` | GM; archived; expected resource revision + idempotency key. |
| Place | Existing `POST /characters/{characterId}/entries` | Existing character command envelope; typed campaign reference; server creates snapshot. |
| Compatible choices | Existing `GET /characters/{characterId}/templates` | Return authorized system and campaign choices with unambiguous origin and pinned references; client filters the selected slot, server always rechecks. |

Use existing error envelopes: 401 for no session, generic 404 for unknown/cross-campaign/revoked resources, existing forbidden policy for known same-campaign writes without authority, 409 for concurrency/stale choice/lifecycle conflicts, validation error for malformed fields or incompatible slots. No denied response may include template content. Preserve existing receipt expiry and reconciliation semantics.

Introduce a typed entry source as an additive contract, conceptually:

```ts
type EntrySource =
  | { kind: "personal" }
  | { kind: "system"; templateId: string }
  | { kind: "campaign"; campaignId: string; templateId: string;
      templateRevision: number; contentRevision: number };
```

The character's existing pin identifies the version for system sources. Use explicit validated system/personal/campaign source semantics in the current contract. Do not introduce a converter for older development records. Reject contradictory source inputs. Do not introduce campaign IDs into system package template lookup.

Campaign state additionally holds a server-created snapshot of kind and original bounded defaults, with character-local `values` and quantity kept separate. Never trust a client snapshot, kind, label override, action or template definition on placement. The stored snapshot is data-only; runtime projection consumes it without catalog access and grants zero actions. User-facing source is **Campaign**, including on a returned sheet; edit/remove remain character commands.

All mutation effects, appended content, activity and receipt storage are atomic. Reuse transaction/advisory-lock conventions and one lock order across placement, template edits/archive, membership removal and character return. Authorization must be checked under that transaction, including successful receipt replay. A previously committed placement may replay its original result after template edit/archive if the actor still has current character access and the original campaign scope; a revoked actor receives no old payload. A new attempt requires current template revisions. Do not change frozen requests on retry.

## Task 1 — Lock current contracts (TDD)

**Files:** `src/characters/index.ts`, `src/campaigns/index.ts`, `src/transport/http/characters.ts`, `src/transport/http/campaigns.ts`, `src/transport/http/openapi.ts`; current character/template integration and relevant HTTP tests.

- [ ] Add failing schema/HTTP tests for source normalization, revision requirements, bounded fields, all four kinds, unknown keys, forged actions/snapshots and contradictions. Record exact wire/error choices in OpenAPI before dependent frontend work.

**Gate:** no upgrade/rollback path silently loses entries; old command payloads remain accepted.

## Task 2 — Catalog storage and GM operations (TDD)

**Files:** current schema baseline and `src/campaigns/templates.ts`; `src/campaigns/index.ts`, `persistence.ts`, `policy.ts`; `src/platform/config.ts` if an existing budget needs a template-specific bound; HTTP/bootstrap wiring. Create `tests/integration/campaign-templates.test.ts` and focused module/HTTP tests.

- [ ] Red: fresh DB initialization and repeated initialization; create/publish, read/list, edit append, archive/recover and preserved historical content. Assert resource versus content revision transitions.
- [ ] Red: active owner/co-GM writes; member reads; outsider, removed member, system author and cross-campaign guessed ID denial. Player cannot edit, archive, recover, or browse archived records. Test campaign lifecycle and limit/cursor validation.
- [ ] Red: identical receipt replay produces one row/revision/activity event; changed payload with reused key conflicts; concurrent same-revision writes yield one success and one conflict; unrelated templates can be edited independently.
- [x] Implement separate storage/resource collaborators, immutable revisions, fixed audience, bounded pagination, limits and transactional current-policy checks. Integrate template events with existing authorized campaign activity; expose no archived content through a receipt or unrelated source join.
- [ ] Include active authorized catalog data in bounded campaign export, and snapshots/source in existing character export. Test player export filtering, revoked export/receipt access and archived management isolation.
- [x] Run targeted PostgreSQL + HTTP tests green with a real test database. Validate atomic rollback on failure; do not interpret skipped suites as proof.

**Gate:** usable catalog API with independent revision/idempotency semantics; no dependency on system package mutation.

## Task 3 — Place and operate immutable copies (TDD)

**Files:** `src/characters/index.ts`, `export.ts`, relevant persistence/placement seams; `src/systems/runtime.ts`, `src/systems/implementation/package/schema/dynamic.ts`, `src/systems/implementation/runtime/entries.ts`, `projection.ts`; bootstrap dependency wiring. Extend `src/characters/entries.test.ts`, runtime/schema tests, `tests/integration/campaign-templates.test.ts`, `campaign-placement.test.ts`, `campaign-character-authorization.test.ts`, `character-replay-authorization.test.ts`, and duplicate/migration regressions.

- [ ] Red: current system/personal entry decoding and campaign entry schema round-trip; materialized source appears as Campaign and cannot grant an action.
- [ ] Red: controller and active GM/co-GM placement on compatible attached characters; denial for another controller, standalone character, wrong campaign, wrong kind, missing/full slot, stale resource/content revision, archived template and client-authored snapshot/action.
- [x] Materialize catalog defaults server-side on first placement; retain the existing client entry UUID, character expected revision, receipt and activity flow. Editable overrides occur through existing entry updates after placement.
- [x] Red → green: revision 1 copy survives revision 2 edit/archive/recover; new valid placement uses revision 2; update/remove/export of old copies require character access, not access to the current catalog row.
- [ ] Add transactional concurrent placement/edit/archive and membership-removal races. Each outcome corresponds to a valid serialization; no partial snapshot, receipt or leaked body.
- [x] Red → green: authorized exact replay after catalog change remains original and exactly once; revoked replay denies; unsent old selection conflicts. Distinguish replay reconciliation from a fresh placement.
- [x] Prove return-on-leave/removal preserves snapshots, kind and local values while removing picker/catalog access; campaign history stays scoped. Cover duplication, export/reload with campaign entries.

**Gate:** independent snapshots, current authorization and backward compatibility through the full server path.

## Task 4 — Offline/session and cache lifecycle (TDD)

**Files:** `web/src/characters/types.ts`, `api.ts`, `session.ts`, `store.ts` and tests; `web/src/campaigns/api.ts`, `types.ts`, `campaignQueries.ts` and tests; identity/cache integration where proven necessary. Inspect `web/src/offline/worker.ts`; API responses must remain outside service-worker asset caching.

- [ ] Red: typed campaign source + both revisions persist through queue creation, IndexedDB reload, frozen request construction, retries and explicit conflict review. Existing queued personal/system requests still drain verbatim.
- [x] Preserve a bounded actor/campaign-scoped set of fetched compatible choices for offline placement; no offline discovery of unseen templates. Before the first release tag, update the current format and recreate obsolete test profiles; add no converter. Never rewrite already frozen requests or replace the chosen revision with latest.
- [x] Red → green: offline add/reload/reconnect commits once; template change/archive before first commit enters the existing reviewable conflict/error state with user's intent retained. Deliberately choosing a new template revision creates a new reviewed intent/key.
- [x] Reuse current queue handling for denied commands and uncertain outcomes. Membership removal, actor switching, logout, return and 404 revalidation purge relevant catalog/selector caches and prevent delayed old-generation responses from repopulating them. **Review repairs verified:** Task 7 R1/R3 now clear the active session on catalog denial and atomically invalidate durable catalog choices on scope changes; unit and canonical browser/offline CI passed. Follow-up deployed verification also passed; see Task 7 and the acceptance record.
- [x] State offline limitations truthfully: a disconnected device cannot know remote revocation immediately. Revalidate on reconnect/focus before granting new access; server denies stale authority at commit. Returned-sheet snapshots are the explicit allowed exception.
- [x] Add deferred-response cache tests and durable-store assertions, not only hidden DOM checks. Keep catalog authoring online-only with explicit status.

**Gate:** pinned offline intent and safe cache lifecycle without a new GM mutation queue.

## Task 5 — Catalog UI and slot picker (TDD)

**Files:** create `web/src/campaigns/CampaignTemplates.tsx` and tests, plus styling consistent with existing controls; `CampaignDetail.tsx`, campaign API/query hooks; `web/src/characters/SlotListControl.tsx`, `CharacterSheet.tsx`, session hooks and relevant tests; existing i18n resources; upgrade/conflict UI as required by Task 1.

- [x] Red → green: Campaign → Items & powers tab, paginated active catalog, empty/loading/permission/error states, GM Create and edit, archived management view, confirmation to archive, recover. Player view is read-only; no secret audience options or formula editor.
- [x] Create saves and publishes in one acknowledged operation. Explain **Visible to all campaign members** and **Changes affect new copies** in plain language. Show existing save/conflict feedback; preserve form values on failed or uncertain save and retry with the same request/key where required.
- [x] Add system/campaign choices to the existing typed slot picker, label origin, filter compatibility and carry explicit revisions. Keep personal creation and old system interactions intact. Do not merge distinct template IDs merely because names match. **Review repair verified:** Task 7 R2 freezes the selected reference across refresh, preserves missing choices and adopts the latest revision only after deliberate review; component and canonical browser/offline CI passed.
- [x] Old snapshots render description/notes/quantity and edit/remove controls without current catalog access. Name appears once; removal is secondary with confirmation. Data-only campaign copies show no action buttons.
- [ ] Use shared dialogs/inputs/theme tokens; test keyboard/focus restoration, textbox names, 44px targets, long fields, light/dark, 360/768/1280 widths and a 320px overflow probe. Keep advanced details collapsed where existing slot UI supports it.
- [x] Green component/session/typecheck tests before real browser acceptance. No new routing framework, dependency, or visual-baseline replacement unless a demonstrated need arises.

**Gate:** complete GM → player journey in the existing responsive app.

## Task 6 — Real journeys, CI and evidence

**Files:** create `web/tests/e2e/campaignTemplates.spec.ts`; extend `web/tests/offline/character.spec.ts` or a focused offline spec under the canonical runner; relevant migration/return journeys; create `docs/acceptance/campaign-data-templates-YYYY-MM-DD.md` when execution occurs. Update this plan, the roadmap and `design_v2.md` with evidence-backed status only.

- [x] Run a real HTTP/PostgreSQL multi-account journey: GM creates Tower key, co-GM edits/publishes, player discovers and places, edits local quantity/notes and reloads. GM publishes a later revision; the old copy remains pinned and a new copy uses the later revision (browser fixture: content 3 → 4 after the two-editor conflict). Archive blocks new placement and preserves copies; recover restores discovery.
- [ ] Verify actual player/controller, outsider and co-GM policy with direct API responses as well as GUI. Prove membership removal, return exception, two-editor conflict, pagination and delayed cache invalidation. Use explicitly seeded supported identities, never invented production sign-in codes.
- [x] Real offline journey: cache choice, disconnect, add, reload, reconnect exactly once. Repeat with GM edit/archive before reconnect and assert explicit conflict; no substituted version. Exercise existing personal/system actions to catch regressions.
- [x] Run root `npm test`, `npm run test:integration`, `npm run typecheck`, `npm run contracts:check`, `npm run build`; web `npm run web:test`, `npm run web:typecheck`, `npm run web:build`, `npm run web:test:e2e`, `npm run web:test:offline`; Docker build and `git diff --check`. Use Node 24, actual DB variables, isolated offline DB/ports and canonical CI/browser fixtures. Expand testing only for new failures or unresolved concerns.
- [x] Record tested commit, red/green commands/results, actual CI run/result, DB/browser/theme/viewport, skipped/blocked checks and release limitations. Do not silently rewrite slice A's historical CI/live evidence.
- [x] Before deployed acceptance, inspect Railway `proactive-expression` service source branch and deployment. Use a dedicated branch preview service/database or the intentionally configured acceptance target after merge. Never change the production source for testing. Wait for successful migrations/deployment and `/health/ready`, then confirm the loaded frontend build (including service-worker activation) matches the tested commit.
- [x] Run the same multi-account live journey with reload and offline/reconnect where supported; record actual live evidence separately from automated results. A test-auth deployment is not real-provider production-auth acceptance. Leave physical Android/iPad and broader G9 gates explicitly open if unavailable.

## Task 7 — Review remediation (TDD)

**Review baseline:** `6a9b0e19a35cd67825ce85dcfd8b0be227236ca4`, PR #19. The review ran 207 existing frontend tests and 47 server unit/contract/runtime tests successfully. Three temporary regression probes failed on the findings below; those probes were not committed. PostgreSQL integration and deployed journeys were not rerun during review. Preserve the earlier CI/live evidence as historical results; it does not close these new regressions.

**Execution order:** R1 → R3 → R2 → combined verification. R1 establishes session-owned revocation; R3 coordinates durable catalog invalidation with confirmed scope changes; R2 preserves selections across the resulting catalog refreshes. These are repairs to the existing slice B contract, without new server permissions or product scope. Implementation commit `0e61d15` passed the seven focused red regressions after repair, all 1,140 frontend tests, 51 browser journeys and 24 production-offline tests; required CI passed. The separate deployed gate passed on 2026-10-14: two live multi-account/offline journeys, zero retries, on the verified preview build. Follow the established session/store/slot structure and record red → green evidence for each repair.

### R1 — P1: Clear the active sheet on template-discovery revocation

**Files:** `web/src/characters/CharacterRoute.tsx`, `session.ts`, `CharacterRoute.test.tsx`, `session.test.ts`; existing coordination tests where needed.

**Reproduction:** character open succeeds; a later `listEntryTemplates` response returns 404 with purge disposition. The route purges IndexedDB but does not clear the session's confirmed snapshot, so private sheet data and editing controls remain visible.

- [x] Red: exercise the real route, session and IndexedDB store; defer the catalog denial until the sheet is loaded. Assert that both the rendered sheet and durable character/catalog caches clear, and editing is released without requiring another user action or reload.
- [x] Route the denial through the session's existing revocation/purge behavior, extending its public seam only if necessary. Coordinate the active view, editing ownership and other open tabs with the same lifecycle; do not leave an independent route-only storage purge.
- [x] Guard the denial against obsolete account/character/placement generations. A late denial from an old scope must not purge a newer authorized view; late successful responses must not restore a genuinely purged view or cache.
- [x] Green the revocation, account-switch and delayed-response regressions. Preserve the returned-owner exception: a successful returned-sheet open retains permitted snapshots; an actual character-access denial clears the sheet.

**Gate:** a current template-discovery denial immediately removes the active unauthorized sheet as well as its caches, without stale-response damage to newer authorized state.

### R3 — P2: Purge durable catalog choices when placement scope changes

**Files:** `web/src/characters/store.ts`, `session.ts`, `CharacterRoute.tsx`, `store.test.ts`, `session.test.ts`, `CharacterRoute.test.tsx`.

**Reproduction:** cache campaign choices, confirm the returned character with `campaignId: null`, then fail the catalog refresh. Display filtering hides those choices, but IndexedDB still contains the former campaign's template names and references.

- [x] Red: use real IndexedDB and a route/session return refresh; assert that the new scope is confirmed and obsolete catalog rows are removed even when the subsequent catalog request fails. Add reload/offline and delayed old-catalog-response cases.
- [x] Invalidate catalog choices atomically with confirmation of a changed campaign/placement scope in every applicable store write path. Keep the permitted character state, materialized entry snapshots, local values and existing queue/receipt semantics intact.
- [x] Bind durable catalog reads/writes to current confirmed scope and generation. If persisted metadata or store format changes, migrate conservatively: discard unverifiable selector caches, retain character snapshots and queued commands, and reject late writes for old scopes.
- [x] Green return/removal and account/purge regressions. Verify valid system choices can be repopulated and returned snapshots remain editable/exportable without restoring campaign discovery.

**Gate:** after an observed return or placement-scope change, old catalog choices are absent from durable storage even if connectivity fails; permitted placed copies survive.

### R2 — P2: Freeze the selected template reference before submission

**Files:** `web/src/characters/SlotListControl.tsx`, `SlotListControl.test.tsx`, `CharacterRoute.test.tsx`, `session.test.ts`; existing e2e/offline campaign-template fixtures.

**Reproduction:** select campaign content revision 1 in an open Add dialog; refresh the catalog to revision 2 for the same ID; confirm. The current submit handler looks up the latest choice and sends revision 2 without explicit review.

- [x] Red: open/select revision 1, replace the catalog props with revision 2, then confirm. Assert no unreviewed revision-2 request; also cover a temporary empty list and an archived/disappearing selection without falling back to a system reference.
- [x] Capture the complete selected source, including resource and content revisions, at selection time. Preserve that reference across catalog updates. If selection becomes stale/unavailable, retain its intent and require explicit review/reselection, or submit its original reference to the existing conflict path; never silently substitute latest.
- [x] Only deliberate selection/review adopts a new reference. Preserve existing system/personal flows and queued/frozen command bytes; a newly reviewed intent gets its own key under the existing session rules.
- [x] Green component/session tests and a browser scenario: another GM revises or archives the template while the player's dialog is open; refresh/focus cannot upgrade the choice silently, and explicit reselection can place the current version. Retain offline reload/exactly-once replay coverage.

**Gate:** submission uses the exact reference the player selected or explicitly reviewed; catalog refresh cannot change it or reinterpret its origin.

### Combined verification and evidence

- [x] Run the affected frontend suites, full frontend tests, typecheck and production build; run the required canonical CI checks on the final fix commit. Add server/PostgreSQL checks where an implementation change or browser prerequisite requires them; do not claim skipped DB coverage.
- [x] Extend the canonical multi-account/browser and production-offline journeys for revocation, return with failed catalog refresh, and open-dialog revision changes. Assert both DOM and durable-storage results and preservation of existing placed copies.
- [x] Verify the final commit on the dedicated acceptance preview: inspect its source/deployment, wait for readiness, verify loaded assets, then exercise these repairs. Keep production sources unchanged. Record the exact tested commit and separate local, CI and deployed evidence. **Passed after user approval:** preview deployment `6c54fd6e-27a5-4158-a79a-2a6bdaae6119` reached SUCCESS at 17:37:56 UTC; migrations/readiness passed and JS/CSS match the tested build. The user applied the scoped patch; deployment metadata is `ae71eb4` (documentation-only changes from `0e61d15`). Two live journeys passed in 5.9 minutes with zero retries, including disconnected reload and two-tab revocation. The temporary browser harness trusted the workspace proxy certificate after diagnosing an initial service-worker SSL failure. Canonical test timeouts/configuration remain unchanged.
- [x] Update the acceptance record and close reopened Task 4/5 checks only with passing evidence for their complete contract. All three review findings must be closed before merge; existing physical-device/provider/G9 limitations remain explicit.

### PR acceptance matrix

| Gate | Required evidence |
|---|---|
| Authoring/publication | GM and co-GM real API + browser create/edit; no player writes; every published template is all-player. |
| Immutable copies | PostgreSQL + browser revision 1/revision 2, local edit/reload, archive/recover, exports. |
| Permissions | Controller/GM/member matrix; standalone/cross-campaign/revoked direct-ID denial; authorized replay vs revoked replay. |
| Lifecycles | Return/removal/duplication snapshots; current catalog denial; guarded upgrade/rollback without state loss. |
| Concurrency/offline | Same-revision conflict, placement/archive race, receipt replay, durable offline exactly once, changed-choice conflict. |
| UI/cache | Actor-generation races, purge assertions, accessible responsive catalog/picker and existing system/personal regressions. |
| Review remediation | Task 7 R1/R3/R2 red → green; active-sheet revocation, atomic durable catalog invalidation on return, and selected-revision preservation across refresh; required CI and preview evidence on the fix commit. |
| Release | Green required CI plus recorded deployed branch/commit/health/live journey; physical-device and production-provider limits stated. |

The core implementation and historical automated/deployed results are recorded in [the acceptance record](../../acceptance/campaign-data-templates-2026-10-10.md). The three Task 7 review findings are repaired and verified by required CI. Task 7 deployed verification also passed after user approval; the three review repairs have completed their planned implementation, CI and live gates. Unchecked bundles retain additional named test/race or manual accessibility requirements; do not infer that every permutation was exercised from the core flow. Physical devices, real-provider authentication, C/D, I7 and wider G9 gates remain separate.
