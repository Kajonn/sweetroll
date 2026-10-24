# Configurable push rolls — slice C execution plan

**Status (2026-10-24):** implementation is in draft [PR #23](https://github.com/Kajonn/sweetroll/pull/23), based on merged B (`759323a`). Package/evaluator, storage/API, creator controls and shared player/GM sessions are implemented. Review regressions and their repairs are recorded in the [review record](../../acceptance/configurable-push-review-2026-10-24.md). Remaining checklist items are acceptance gates, not a claim that the branch is documentation-only. Canonical C browser journeys, compatibility cases and isolated deployed acceptance remain open.

**Authority:** [design §6.4](../../../design_v2.md#64-rules-and-expression-engine), [parent plan Task 7](2026-10-21-dice-pool-reliability.md#task-7--design-and-deliver-configurable-pushes-slice-c-tdd), [B contract](../specs/2026-10-23-named-dice-groups.md), [GUI gates](2026-09-08-gui-integration.md). Follow current module ownership. For each numbered implementation task, record an observed meaningful failure before the smallest repair, then green and appropriate retained checks. No assertion/retry/timeout/baseline loosening to make acceptance pass.

## Source review that determines the implementation

| Existing seam at `759323a` | Required extension / reason |
|---|---|
| `src/characters/index.ts` apply/claim/replay and `src/characters/idempotency.ts` | Dedicated push command; parent ID in hash; current audience/principal authorization before stored success disclosure |
| `src/characters/persistence.ts` standalone and campaign apply transactions | Both paths lock/recheck and commit lineage/roll/activity/receipt atomically; ordinary rolls need not bump revision, so enforce one child independently. The existing generic precondition hook is currently called only on the campaign path; standalone push validation needs explicit coverage too |
| `src/campaigns/policy.ts` `canReadRoll` uses `actorId` | Preserve root audience principal separately from child executor; test GM demotion and history/export/replay, not only execution permission |
| `src/characters/persistence.ts` history and `src/campaigns/persistence.ts` roll projection/export | Preserve public lineage, private snapshot separation and inherited-principal redaction everywhere |
| `src/systems/runtime.ts`, runtime/resolve-entries and rules/evaluate | Pinned action ownership plus pure push evaluation from original bindings, stable dice and new execution RNG; current fields cannot replace a pool |
| package/schema, structural and rules/compile-document | 1.2 policy gate with grammar 0.2; current equality checks for 1.1 must admit 1.2 deliberately |
| `web/src/state/documentReducer.ts` and editor/DocumentEditor | The group-edit promotion currently writes 1.1; add a regression proving it cannot downgrade a 1.2 policy draft |
| `web/src/characters/session.ts` OnlineOperation and `store.ts` OnlineAttempt | Extend the existing frozen-request/guarded acknowledgement lifecycle; persist child result as well as confirmed state |
| `web/src/campaigns/SessionBoard.tsx` direct online API wrappers | Share durable uncertainty handling for GM pushes; a bare POST with a fresh key on timeout is insufficient |

## C0 — Contract before implementation

- [x] Define document/package 1.2, bounded action/group policy, success/empty rules, supported formula shapes and manual reports without effects.
- [x] Define root/parent/attempt identity, immutable original bindings, authoritative RNG order, current source/version/scope rules, SQL uniqueness and atomic commit.
- [x] Define inherited audience principal, role-change/replay disclosure checks and online-only durable uncertainty for player and GM.
- [x] Define a numeric mixed fixture and a concrete verification/deployment boundary.

These checks mean the design work exists, not that any behavior below is implemented. No owner approval gate is introduced by this document; normal authorized implementation can continue in the sequence below.

## C1 — Versioned policy and compiler validation (TDD)

**Files:** `src/systems/implementation/package/schema/document.ts`, `schema/package.ts`, schema exports; `structural.ts`, `rules/compile-document.ts`, package codec/compatibility/round-trip tests, fixtures; generated schema consumers.

- [ ] Red: policy rejected by existing 1.1/1.0 contracts; 1.2 round-trip and custom formula policy diagnostics absent.
- [ ] Add strict bounded policy schemas for entity/non-nominal granted actions; reject duplicate/unknown groups/faces, invalid bounds, nominal/resource policies and unsupported push expressions. Keep the existing grammar AST.
- [ ] Admit grammar 0.2 in 1.2 and preserve earlier version gates. Reject policy in 1.0/1.1, unsupported policy/package versions and any capability downgrade.
- [ ] Green: import/export/clone/preview/publish plus unchanged 1.0/1.1 canonical package bytes/checksums and legacy draw order.

## C2 — Pure eligibility and child evaluation (TDD)

**Files:** new `src/systems/implementation/rules/push.ts` and tests; `rules/result.ts`; `runtime.ts`, runtime/resolve-entries; named fixtures and runtime tests.

- [ ] Red: table fixture from the contract has no child evaluator; assert exact totals, groups/calculation, stable dice IDs and exactly four RNG calls before implementation.
- [ ] Implement bounded snapshot decode, eligibility, deterministic replacement only of eligible dice, reduction and output rebuilding, attempt bounds and reported-face counts. Use the pinned package and normalized original bindings.
- [ ] Preserve source provenance; validate current sheet/granted-action ownership and entry/slot source applicability without rolling a new current pool as a side effect.
- [ ] Cover sum/count/mixed scalar terms, partial/new locks, all-locked/empty/no-policy/disallowed success, negative scalar modifiers, max bounds and malformed metadata. Prove parent objects unchanged and legacy execution identical.

## C3 — Immutable storage and atomic lineage (PostgreSQL TDD)

**Files:** next unused immutable SQL migration after `0023`, `src/characters/persistence.ts`, records/types; all integration/test schemas that manually define roll storage.

- [ ] Red with actual PostgreSQL: different keys/actors can otherwise consume one parent when character revision stays unchanged. Assert one successful child/receipt/character event/campaign event/audit; root unchanged.
- [ ] Add nullable context/result/root/parent/attempt/audience-principal columns, coherent NULL/object constraints, same-character root/parent references and unique parent plus root/attempt. Ordinary rows remain NULL and old stored JSON is never rewritten.
- [ ] Extend both standalone and campaign transactions with the documented locks, authoritative rechecks and exact conflict mapping. Ensure the snapshot, child and scope-carrying receipt share one commit.
- [ ] Inject failures at child/activity/audit/receipt writes and assert complete rollback; retry/lease reclaim uses the same execution identity and cannot add a sibling.

## C4 — Characters command, HTTP and disclosure policy (TDD)

**Files:** `src/characters/index.ts`, `persistence.ts`, idempotency tests; `src/transport/http/characters.ts`, openapi tests; `src/campaigns/policy.ts`, campaign persistence/index/transport; contract generator/output files.

- [ ] Add authorized push-options read and push command using the existing receipt/error/reconciliation envelope. Hash parent/character/revision; strict HTTP body accepts revision/key only and rejects all forged outcomes/policy/seed/lineage/audience.
- [ ] Recheck source/version/owner-placement generation and lifecycle under transaction locks; current value edits use the original pool, different versions block, exact rollback/restored source follows the explicit contract.
- [ ] Preserve executor for audit but use inherited root principal for visibility. Child audience only narrows against current default. Apply the principal to options, command/replay, character history, campaign roll/activity/export and hidden correlation IDs.
- [ ] Red → green for controller, GM/co-GM, wrong character, outsider, revoked member/controller, hidden owner-only parent, returned/adopted sheet, archive/recover, version migration/rollback and source removal/restoration.
- [ ] Regression: co-GM pushes a player's GM-only roll then is demoted; they must not inherit visibility just by being child executor. Exercise same-key replay after role/scope/default changes, not just fresh POST.
- [ ] Regenerate HTTP/OpenAPI/client types from canonical schemas and compare unchanged legacy envelopes/receipts/export behavior. Personal state exports continue excluding history.

## C5 — Creator and version preservation (UI TDD)

**Files:** `web/src/editor/actions/RollActionEditor.tsx`, GroupedPoolEditor, template action editor, DocumentEditor, `web/src/state/documentReducer.ts` and their tests; generated package types.

- [ ] Red: opening policy controls, enabling one on a suitable formula, and editing a group after 1.2 promotion.
- [ ] Add optional Push section with named-group selectors, bounded locked/reported faces, maximum attempts and explicit success handling. Show unsupported-formula diagnostics without replacing custom source.
- [ ] Promote only on explicit policy edit; never downgrade 1.2 during group edit, save/reopen/import/export/clone or policy removal. Cover entity and template-granted authoring and normal autosave/conflict behavior.

## C6 — Shared durable online push attempts (session/store TDD)

**Files:** `web/src/characters/session.ts`, `store.ts`, API/types/useCharacterSession, session/store/API tests; shared attempt coordinator and GM SessionBoard integration as needed.

- [ ] Red: timeout/lost acknowledgement followed by reload/takeover would otherwise lose a child result or allow a fresh-key push. Assert exact saved POST/key/parent retained and no newer operation sent first.
- [ ] Extend OnlineOperation/OnlineAttempt, leaving offline EditIntent unchanged. Guard actor/account/storage generations and editing ownership; persist before send and refuse fresh pushes offline or behind pending edits/uncertain work.
- [ ] Atomically persist recoverable child result/lineage and confirmed state before retiring the frozen attempt. Handle malformed 2xx and IndexedDB acknowledgement failure as uncertain, not definite failure.
- [ ] Reuse the coordinator for GM pushes; no weaker direct-send recovery path. Test player/GM reload, duplicate click, competing tab, lease pending, backoff, conclusive rejection and expired-window explicit review.
- [ ] Include previous/current durable reader capability cases; unknown push attempt kinds must remain recoverable and cannot be interpreted as another operation. Preserve account purge, revocation and service-worker queue behavior.

## C7 — Result/history controls and canonical browser journeys (TDD)

**Files:** shared `web/src/rolls/` result controls, CharacterSheet/CharacterTools/PersonalActivity, campaign SessionBoard/history, canonical e2e/offline specs.

- [ ] Red: creator → publish → player roll → push; show exact attempt/retained/rerolled/report explanation and authoritative child. Retain accessible text and original pool bindings.
- [ ] Integrate fresh server options, disabled reasons and stale/offline/uncertain states. Parent navigation reauthorizes; display survives reload through durable result/history, not local RNG.
- [ ] Include granted-item parity, controller and GM, leaf-only second attempt, exhausted/locked/empty/changed-source states and responsive 320/360/768/1280 light/dark checks. Verify keyboard focus during async load, Escape and opener restoration.
- [ ] Production-worker cases: cache/read lineage offline without pushing; lose a push response, reload offline and reconcile the same request online; update worker during a pending push and switch/revoke accounts without leakage.

## C8 — Full CI and isolated deployed acceptance

- [ ] Run focused red → green at each step and record actual commands/results; finish with server, real PostgreSQL integration, frontend typecheck/tests/build, generated-contract identity, production build/Docker, every canonical browser shard, offline and unchanged visual checks. DB skips are not integration success.
- [ ] Isolated preview only: verify source/actual deployed commit, terminal SUCCESS, migrations/readiness and served frontend/worker artifact identity before claiming deployed evidence. Do not change `proactive-expression` for this acceptance.
- [ ] Repeat authoring and both action-source pushes with multiple accounts; verify frozen original pool after field edits, competing different-key pushes, same-key lost-response recovery/reload, principal/role/default narrowing and authorized campaign export/history.
- [ ] Record exact commit/deployment/resource IDs, browser/viewport/theme, observed output/rows and scoped test-resource cleanup. Keep existing B compatibility and wider G9/device/provider-authentication gates open until separately proven.
- [ ] Update design/parent plan/acceptance record only from observed evidence; make the implementation PR ready for review after the required gates. Do not claim every Year Zero variant from this fixture.

## Delivery boundary

C0 is complete and C1–C6 plus the result-control portion of C7 have implementations and focused regressions. The unchecked bundles still require their complete listed evidence; in particular, the pre-existing browser suites do not substitute for new C journeys. Follow C7–C8 before marking the PR ready or claiming C accepted. No automatic damage/effect engine, arbitrary scripts, new offline push creation or unrelated editor/campaign redesign belongs here.

**Observed document validation (2026-10-24):** `git diff --check` passed; all 23 local link/anchor destinations in the new documents and added cross-references resolved. The deterministic fixture arithmetic was checked independently: parent 11, child 15, four eligible draws. This is document validation, not evaluator/test/CI or deployed C evidence.
