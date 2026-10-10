# Campaign data-only templates — slice B implementation plan

**Status (2026-10-10):** implemented in [PR #19](https://github.com/Kajonn/sweetroll/pull/19); required CI #91 passed. Isolated deployed multi-account/offline acceptance passed. See [acceptance evidence](../../acceptance/campaign-data-templates-2026-10-10.md) for exact coverage and remaining gates.
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

Add `campaign_item_templates` and `campaign_item_template_revisions` in a new immutable SQL migration, `0022_campaign_item_templates.sql`.

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

The character's existing pin identifies the version for system sources. Legacy `templateId: string` decodes as system; `templateId: null` as personal. Campaign entries retain `templateId: null` for compatibility with old data-only paths, but explicit source controls new rendering/validation. Reject contradictory source/legacy inputs. Do not introduce campaign IDs into system package template lookup.

Campaign state additionally holds a server-created snapshot of kind and original bounded defaults, with character-local `values` and quantity kept separate. Never trust a client snapshot, kind, label override, action or template definition on placement. The stored snapshot is data-only; runtime projection consumes it without catalog access and grants zero actions. User-facing source is **Campaign**, including on a returned sheet; edit/remove remain character commands.

All mutation effects, appended content, activity and receipt storage are atomic. Reuse transaction/advisory-lock conventions and one lock order across placement, template edits/archive, membership removal and character return. Authorization must be checked under that transaction, including successful receipt replay. A previously committed placement may replay its original result after template edit/archive if the actor still has current character access and the original campaign scope; a revoked actor receives no old payload. A new attempt requires current template revisions. Do not change frozen requests on retry.

## Task 1 — Lock contracts and migration safety (TDD)

**Files:** `src/characters/migration.ts`, `src/characters/index.ts`, `src/campaigns/index.ts`, `src/transport/http/characters.ts`, `src/transport/http/campaigns.ts`, `src/transport/http/openapi.ts`; tests in `tests/integration/character-migration.test.ts`, `campaign-upgrade.test.ts`, and relevant HTTP tests.

- [ ] Add failing migration regressions with populated system and personal entries before adding campaign state. Exercise standalone preview/commit, campaign preview/commit, and rollback with post-migration entries. Assert unchanged pin/state/revision after denial.
- [x] Implement the conservative entry-presence guard in the shared migration path and all commit/rollback paths, including stale previews created before an entry was added. An unchanged/no-op path may only succeed if it demonstrably preserves the entire state.
- [x] Surface an actionable conflict in existing upgrade/migration UI: entries cannot yet be safely migrated; current sheet remains usable. Do not automatically remove entries or offer destructive cleanup as recovery.
- [ ] Add failing schema/HTTP tests for source normalization, revision requirements, bounded fields, all four kinds, unknown keys, forged actions/snapshots and contradictions. Record exact wire/error choices in OpenAPI before dependent frontend work.
- [x] Green the guard/contracts and preserve preexisting empty-entry upgrade tests. Regenerate generated contracts using the existing script; never hand-edit `web/src/api/schema.d.ts`.

**Gate:** no upgrade/rollback path silently loses entries; old command payloads remain accepted.

## Task 2 — Catalog storage and GM operations (TDD)

**Files:** new migration and `src/campaigns/templates.ts`; `src/campaigns/index.ts`, `persistence.ts`, `policy.ts`; `src/platform/config.ts` if an existing budget needs a template-specific bound; HTTP/bootstrap wiring. Create `tests/integration/campaign-templates.test.ts` and focused module/HTTP tests.

- [ ] Red: fresh DB migration and reapplication; create/publish, read/list, edit append, archive/recover and preserved historical content. Assert resource versus content revision transitions.
- [ ] Red: active owner/co-GM writes; member reads; outsider, removed member, system author and cross-campaign guessed ID denial. Player cannot edit, archive, recover, or browse archived records. Test campaign lifecycle and limit/cursor validation.
- [ ] Red: identical receipt replay produces one row/revision/activity event; changed payload with reused key conflicts; concurrent same-revision writes yield one success and one conflict; unrelated templates can be edited independently.
- [x] Implement separate storage/resource collaborators, immutable revisions, fixed audience, bounded pagination, limits and transactional current-policy checks. Integrate template events with existing authorized campaign activity; expose no archived content through a receipt or unrelated source join.
- [ ] Include active authorized catalog data in bounded campaign export, and snapshots/source in existing character export. Test player export filtering, revoked export/receipt access and archived management isolation.
- [x] Run targeted PostgreSQL + HTTP tests green with a real test database. Validate atomic rollback on failure; do not interpret skipped suites as proof.

**Gate:** usable catalog API with independent revision/idempotency semantics; no dependency on system package mutation.

## Task 3 — Place and operate immutable copies (TDD)

**Files:** `src/characters/index.ts`, `export.ts`, relevant persistence/placement seams; `src/systems/runtime.ts`, `src/systems/implementation/package/schema/dynamic.ts`, `src/systems/implementation/runtime/entries.ts`, `projection.ts`; bootstrap dependency wiring. Extend `src/characters/entries.test.ts`, runtime/schema tests, `tests/integration/campaign-templates.test.ts`, `campaign-placement.test.ts`, `campaign-character-authorization.test.ts`, `character-replay-authorization.test.ts`, and duplicate/migration regressions.

- [ ] Red: system/personal legacy decode and old name-only records; campaign entry schema round-trip; materialized source appears as Campaign and cannot grant an action.
- [ ] Red: controller and active GM/co-GM placement on compatible attached characters; denial for another controller, standalone character, wrong campaign, wrong kind, missing/full slot, stale resource/content revision, archived template and client-authored snapshot/action.
- [x] Materialize catalog defaults server-side on first placement; retain the existing client entry UUID, character expected revision, receipt and activity flow. Editable overrides occur through existing entry updates after placement.
- [x] Red → green: revision 1 copy survives revision 2 edit/archive/recover; new valid placement uses revision 2; update/remove/export of old copies require character access, not access to the current catalog row.
- [ ] Add transactional concurrent placement/edit/archive and membership-removal races. Each outcome corresponds to a valid serialization; no partial snapshot, receipt or leaked body.
- [x] Red → green: authorized exact replay after catalog change remains original and exactly once; revoked replay denies; unsent old selection conflicts. Distinguish replay reconciliation from a fresh placement.
- [x] Prove return-on-leave/removal preserves snapshots, kind and local values while removing picker/catalog access; campaign history stays scoped. Cover duplication, export/reload and the migration guard with campaign entries.

**Gate:** independent snapshots, current authorization and backward compatibility through the full server path.

## Task 4 — Offline/session and cache lifecycle (TDD)

**Files:** `web/src/characters/types.ts`, `api.ts`, `session.ts`, `store.ts` and tests; `web/src/campaigns/api.ts`, `types.ts`, `campaignQueries.ts` and tests; identity/cache integration where proven necessary. Inspect `web/src/offline/worker.ts`; API responses must remain outside service-worker asset caching.

- [ ] Red: typed campaign source + both revisions persist through queue creation, IndexedDB reload, frozen request construction, retries and explicit conflict review. Existing queued personal/system requests still drain verbatim.
- [x] Preserve a bounded actor/campaign-scoped set of fetched compatible choices for offline placement; no offline discovery of unseen templates. If store format changes, version and migrate safely. Never rewrite already frozen requests or replace the chosen revision with latest.
- [x] Red → green: offline add/reload/reconnect commits once; template change/archive before first commit enters the existing reviewable conflict/error state with user's intent retained. Deliberately choosing a new template revision creates a new reviewed intent/key.
- [x] Reuse current queue handling for denied commands and uncertain outcomes. Membership removal, actor switching, logout, return and 404 revalidation purge relevant catalog/selector caches and prevent delayed old-generation responses from repopulating them.
- [x] State offline limitations truthfully: a disconnected device cannot know remote revocation immediately. Revalidate on reconnect/focus before granting new access; server denies stale authority at commit. Returned-sheet snapshots are the explicit allowed exception.
- [x] Add deferred-response cache tests and durable-store assertions, not only hidden DOM checks. Keep catalog authoring online-only with explicit status.

**Gate:** pinned offline intent and safe cache lifecycle without a new GM mutation queue.

## Task 5 — Catalog UI and slot picker (TDD)

**Files:** create `web/src/campaigns/CampaignTemplates.tsx` and tests, plus styling consistent with existing controls; `CampaignDetail.tsx`, campaign API/query hooks; `web/src/characters/SlotListControl.tsx`, `CharacterSheet.tsx`, session hooks and relevant tests; existing i18n resources; upgrade/conflict UI as required by Task 1.

- [x] Red → green: Campaign → Items & powers tab, paginated active catalog, empty/loading/permission/error states, GM Create and edit, archived management view, confirmation to archive, recover. Player view is read-only; no secret audience options or formula editor.
- [x] Create saves and publishes in one acknowledged operation. Explain **Visible to all campaign members** and **Changes affect new copies** in plain language. Show existing save/conflict feedback; preserve form values on failed or uncertain save and retry with the same request/key where required.
- [x] Add system/campaign choices to the existing typed slot picker, label origin, filter compatibility and carry explicit revisions. Keep personal creation and old system interactions intact. Do not merge distinct template IDs merely because names match.
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

### PR acceptance matrix

| Gate | Required evidence |
|---|---|
| Authoring/publication | GM and co-GM real API + browser create/edit; no player writes; every published template is all-player. |
| Immutable copies | PostgreSQL + browser revision 1/revision 2, local edit/reload, archive/recover, exports. |
| Permissions | Controller/GM/member matrix; standalone/cross-campaign/revoked direct-ID denial; authorized replay vs revoked replay. |
| Lifecycles | Return/removal/duplication snapshots; current catalog denial; guarded upgrade/rollback without state loss. |
| Concurrency/offline | Same-revision conflict, placement/archive race, receipt replay, durable offline exactly once, changed-choice conflict. |
| UI/cache | Actor-generation races, purge assertions, accessible responsive catalog/picker and existing system/personal regressions. |
| Release | Green required CI plus recorded deployed branch/commit/health/live journey; physical-device and production-provider limits stated. |

Implementation and required automated CI are delivered; [the acceptance record](../../acceptance/campaign-data-templates-2026-10-10.md) identifies the observed tests and deployed status. Unchecked bundles retain additional named test/race or manual accessibility requirements; do not infer that every permutation was exercised from the core flow. Slice B required CI and the isolated deployed multi-account/offline gate passed; physical devices, real-provider authentication, C/D, I7 and wider G9 gates remain separate.
