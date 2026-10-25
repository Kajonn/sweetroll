# Dice pool reliability and push-roll delivery plan

**Status (2026-10-24, after B merge):** slice A merged as PR #21 (`740204f`), B as PR #22 (`759323a`). B's final branch head `4cfc04a` passed all seven verification jobs in [run 121](https://github.com/Kajonn/sweetroll/actions/runs/40109298631); earlier [B live acceptance](../../acceptance/named-dice-groups-2026-10-23.md) was on `ae7d1e8`, before the later parser fix. Slice C's [versioned push contract](../specs/2026-10-24-configurable-push-rolls.md) and [execution plan](2026-10-24-configurable-push-rolls.md) now define the before-code prerequisite. C implementation/acceptance, the B compatibility bundle and wider release gates remain open. No full-release claim.
**Baseline:** `4ab950c` (`main`, PR #19 merged), checked against remote `main` on 2026-10-21.
**Goal:** make current dice-pool authoring and execution trustworthy, then extend the existing engine with named dice groups and configurable push rolls.
**Authority:** [design_v2.md §6.4](../../../design_v2.md#64-rules-and-expression-engine), [expression engine design](../specs/2026-09-04-system-expression-engine-design.md), [package contract](../specs/2026-09-04-system-package-contract-design.md), [original engine plan](2026-09-04-system-expression-engine.md), and [GUI integration gates](2026-09-08-gui-integration.md).
**Method:** for each implementation task, write a meaningful failing regression, run and record red, implement the smallest repair, run green, then refactor. Preserve established module ownership, generated contracts, projection/session rendering, and revision/idempotency behavior.

## Scope and sequence

| Slice | Outcome | Dependency / completion boundary |
|---|---|---|
| A — existing defects | Invalid rolls are explicit failures; unsupported success-count operands fail assessment; custom pool formulas survive guided editing; preview never invents modifiers. | Tasks 1–5. Independently releasable without new dice grammar, named groups, or pushing. |
| B — structured results | Named dice groups and an explicit calculation breakdown survive execution, persistence, transport, history, export, and display. | Task 6, after A. Versioned contract and compatibility design precede implementation. |
| C — push rolls | An authorized player pushes a saved roll under declarative eligibility and attempt limits; retries and concurrent requests cannot grant extra attempts. | Task 7, after B. A new command references the authoritative parent roll. |

Implement and review A first, B second, and C third. Do not wait for B/C to repair A, or declare full dice-pool support from the basic fixture. B is delivered with package 1.1 / grammar 0.2. C's planned package 1.2 keeps pushes outside formula grammar: an explicit command operates on an authoritative saved roll. C remains unimplemented; its contract/plan does not change current runtime capabilities.

Keep arbitrary scripting, collection traversal, automatic damage/resource effects, exploding dice, custom faces, and unrelated editor redesign outside this plan. Push consequences can be reported for manual bookkeeping without introducing an effect engine. Existing personal/campaign data-only entries continue to grant no actions.

## Evidence and required regressions

The review ran 75 focused backend tests and 25 frontend tests successfully. Separate direct runtime/assessment probes reproduced R1/R2. R3/R4 were identified by static inspection and still require observed failing UI regressions. These historical results are not red/green evidence for future repairs, full-suite acceptance, or deployed acceptance.

| ID | Priority | Reproduction | Owning task |
|---|---|---|---|
| R1 | P1 | Seeded d6 fixture: attribute `1`, skill `1`, bonus dice `-3`. Runtime returns success with `Successes: 0`, empty dice, and no disclosed arithmetic diagnostic. | 2 |
| R2 | P2 | Both `countSuccesses(5, 6)` and `countSuccesses(dice(2, 6) + dice(2, 6), 6)` pass document assessment, but the evaluator only executes a direct `dice` operand. | 1 |
| R3 | P2 | Open a custom success-pool formula in the guided action editor and select a field modifier. The editor replaces it with `d20 + fields.<selected>`. | 3 |
| R4 | P2 | Preview a success pool yielding `[6, 2, 1]`. Total is `1`, but the displayed modifier is `1 - 9 = -8`. | 4 |

## Slice A contract decisions

- Preserve declarative packages, server-authoritative rolls, existing deterministic dice order and execution IDs, package budgets, and current authorization/audience rules.
- A valid zero-sized dynamic pool remains legal and returns zero successes. Negative and fractional counts are invalid; counts over the effective budget fail. A game's minimum pool belongs in its authored formula, such as `max(1, ...)`, rather than a universal silent clamp.
- Keep scalar fallback behavior for computed fields and validations. At the action boundary, an arithmetic diagnostic means the roll failed: do not expose its fallback or partially rolled dice as a successful roll.
- Return a bounded, typed action-evaluation diagnostic through the existing runtime → Characters → HTTP → session path. Map it to the existing `invalid_value` / HTTP 422 behavior; keep runtime diagnostics distinct from sheet validation diagnostics. The optional `actionDiagnostics` field carries bounded action/expression identities and arithmetic messages, separately from sheet-validation diagnostics. Never return another audience's bindings or private data in an error.
- An unsuccessful action does not append a successful roll/activity event or advance character state/revision. Its definite failure may use the existing error receipt. Same-key retries preserve the original error; a corrected request uses a new reviewed command/key.
- `countSuccesses` accepts a direct `dice` node in v0.1, including a field-derived count. Reject scalar, boolean, arithmetic-combination, and keep-wrapped operands during assessment/compilation. Multiple pools can still be expressed as the sum of independently valid `countSuccesses(...)` terms; no new collection type or implicit combination is introduced in A.
- Already published versions and saved historical results are not rewritten. Valid package checksums, deterministic outcomes, pinned versions, and historical receipts remain stable. Existing invalid formulas receive an actionable failure; do not silently repair their source or republish a system.
- A does not require a new public success-result schema. Preview can conservatively omit the modifier row when the existing shared compiled AST does not prove an ordinary additive dice sum. B provides the complete structured breakdown.

## Task 1 — Reject unsupported success-count operands (R2, TDD)

**Files:** `src/systems/implementation/rules/typecheck.ts`, `typecheck.test.ts`, `compile.test.ts`, `compile-document.test.ts`; `src/systems/implementation/authoring/assess.test.ts`; existing system HTTP/package tests where needed.

- [ ] Red: the two R2 examples must fail `compileExpression`, `compileDocument`, and `assessDocument` with `invalid_expression`, identifying the authored expression. Cover a boolean operand and a keep-wrapped operand too.
- [ ] Red: publish/preview assessment cannot approve an expression that its evaluator cannot execute. Test the real authoring path, not just a mocked diagnostic.
- [x] Enforce the direct-dice operand shape in the shared type checker so browser preview and server compilation use the same rule; retain defensive evaluator guards for legacy or malformed compiled values.
- [ ] Green: direct static/dynamic pools, sums of separate success-count expressions, d20, PbtA, and existing keep-high/low expressions remain supported. Dynamic zero/negative/fractional counts are runtime cases, not guessed from field types.
- [x] Reconcile the operand wording in the expression/package specs before implementation is considered complete; preserve the v0.1 syntax and immutable package format.

**Gate:** the supported compiler/evaluator operand shapes agree, and ordinary valid packages retain their identities and behavior.

## Task 2 — Propagate failed roll evaluation end to end (R1, TDD)

**Files:** `src/systems/implementation/rules/evaluate.ts` and tests if needed; `src/systems/runtime.ts`, `runtime.test.ts`; `src/systems/implementation/runtime/resolve-entries.ts`, `resolve-entries.test.ts`; `src/characters/index.ts`, `persistence.ts`, `idempotency.ts`; `src/transport/http/characters.ts` and tests; `web/src/api/client.ts`, character API/session/error UI and tests; generated contracts through `scripts/generate-system-contracts.ts`.

- [ ] Red: entity and item-granted rolls with negative/fractional counts fail with a visible diagnostic. Include division by zero and an invalid legacy compiled operand to prove fallback/partial dice never masquerade as a factual roll.
- [ ] Red: preserve valid zero pools, exact budget boundaries, effective per-package budgets, deterministic retries, valid item/character bindings, and computed/validation fallback behavior.
- [x] Add one consistent action-evaluation failure mapping to both runtime action paths. Preserve typed diagnostics and action/expression identity through Characters, transport serialization, and the frontend error adapter; avoid a second interpreter or a generic unexplained internal error.
- [ ] Red → green in PostgreSQL/HTTP: failure leaves character state/revision and successful-roll/activity counts unchanged. A matching retry returns the same recorded error; changed input under the same key mismatches; a corrected new request can succeed.
- [ ] Preserve authorization before evaluation and replay. Recheck revoked/cross-campaign attempts, audience filtering, and policy changes without returning saved private diagnostics or results.
- [x] Show a persistent, actionable input/formula error. Retain entered inputs, release busy state, and provide the existing review/correction path for a definite rejected command. Do not convert an uncertain timeout into an automatic fresh roll.
- [x] Regenerate affected JSON/OpenAPI/client types with `npm run contracts:generate`, then run `npm run contracts:check`. Update the design/spec's action-failure exception while leaving scalar fallback intact.

**Gate:** R1 fails explicitly for both action sources, errors are reviewable, and transaction/replay semantics are unchanged for valid actions.

## Task 3 — Preserve custom pool formulas in guided editing (R3, TDD)

**Files:** `web/src/editor/actions/RollActionEditor.tsx` and tests; callers in `DocumentEditor.tsx`, `TemplatesTab.tsx`, and their tests; existing i18n resources.

- [ ] Red: render the real guided editor with a field-derived success pool; interacting with its simple field-modifier control must not change it into a d20 formula. Cover template-granted actions as well as entity actions.
- [x] Hide/disable the simple additive-modifier control for unsupported custom formulas, with a clear route to the custom expression editor. Keep existing simple dice-plus-field/input controls working and preserve input terms.
- [ ] Red → green: switch basic → custom, edit, autosave, reload, and undo/redo through the existing document flow. Formula text and bound inputs must survive without inferred rewrites or new IDs.
- [ ] Cover keyboard use, accessible labels, light/dark styles, and mobile width with existing UI primitives. A dedicated no-code pool wizard may be designed in B; it is not a prerequisite for this repair.

**Gate:** normal editing cannot silently replace a custom pool formula, including in reusable system item templates.

## Task 4 — Make previews truthful for success counts (R4, TDD)

**Files:** `web/src/editor/actions/RollActionEditor.tsx` and tests; `web/src/api/evaluateExpression.ts`; `web/src/ports/evaluateExpression.ts` and tests; preview renderers only where the same issue is demonstrated.

- [ ] Red: deterministic RNG produces `[6, 2, 1]` for a threshold-six pool. Assert one success and no fictitious `-8` modifier. Cover a sum of success counts and mixed arithmetic/dice expressions.
- [x] Use the AST already returned by the shared evaluator adapter to show a modifier only when that additive interpretation is proven; otherwise omit the row. Never infer a modifier from `total - sum(all dice)` for arbitrary expressions, and do not introduce a handwritten formula parser.
- [ ] Green: ordinary `d20 + 5` still displays its real modifier. Preserve individual dice, kept/discarded status, total, output text, diagnostics, and explicit preview audience.
- [x] Cover the existing numeric-field sample limitation: preview currently substitutes zero for numeric fields. Show the sample bindings used; provide explicit sample values or a clear zero-sample explanation so a zero-die preview is not represented as a test of actual character defaults. Keep this separate from the non-destructive full character preview.

**Gate:** preview communicates the calculation it actually performed, without fabricated modifiers or misleading sample values.

## Task 5 — Verify and release slice A

**Files:** existing backend/unit/integration and frontend suites; extend `web/tests/e2e/character-sheet.spec.ts` and relevant authoring journeys; add a focused dice-pool browser spec under the canonical runner if needed; write a dated acceptance record under `docs/acceptance/` during execution.

- [x] Run an author → assess → preview → publish → create-character journey using a license-neutral pool system, with attributes, skill, a situational dice modifier, a resource, and a system item-granted roll.
- [x] Prove invalid formula rejection, custom formula preservation after reload, truthful preview, valid zero pool, negative-pool error/correction, valid roll/retry, and item-granted parity through actual UI and HTTP. Retain d20/PbtA journeys.
- [x] Run Node 24 checks: root `npm test`, `npm run test:integration`, `npm run typecheck`, `npm run contracts:check`, `npm run build`; then `npm run web:test`, `npm run web:typecheck`, `npm run web:build`, canonical `npm run web:test:e2e` and `npm run web:test:offline`. Use the repository's real isolated DB/ports and runner configuration; do not count skips as passing DB/browser coverage.
- [ ] Verify the production web build, offline reopening/queued failed-action review where supported, and historical result/receipt decoding. Do not add a new offline or GM command queue as part of A.
- [ ] Check 360/768/1280 widths, a 320px overflow probe, light/dark themes, keyboard/focus, and error recovery. Keep physical-device and real-provider authentication checks open if unavailable; do not change screenshot baselines merely to pass.
- [x] Before deployed acceptance, verify the acceptance service's source branch, exact deployment commit, completed build/migrations, `/health/ready`, and loaded frontend/service-worker assets. Test a dedicated branch preview or acceptance after merge; keep production sources unchanged.
- [x] Repeat the core pool and item journey against that verified deployment; record tested commit, red/green commands, CI, local/live evidence, browser/viewport/theme, failures, and limitations. Update this plan and GUI/design status only from observed results.

**Gate:** R1–R4 have observed red → green regressions, required CI and actual deployed acceptance. Passing A does not close B/C or wider G9 release gates.

## Task 6 — Design and deliver structured, named dice groups (slice B, TDD)

**Files/seams:** expression/package schemas, compiler/evaluator/rendering, `src/systems/runtime.ts`, granted actions, Characters persistence/export, HTTP contracts, generated client types, authoring controls, player/GM result/history surfaces, and their existing tests. Add a new immutable SQL migration only if persisted storage requires it.

- [x] First write a versioned successor contract and update `design_v2.md` plus package/expression specs. Specify declarative group IDs/labels, count expressions, die sizes, thresholds, calculation terms and their operations, and stable per-die identity. Keep existing scalar `total` and legacy decoding meaningful.
- [x] Distinguish sum terms from success-count terms; preserve group identity through nested/multiple terms rather than adding one global `mode` flag. A mixed expression cannot be reconstructed correctly from a flat dice sum. Per-die/group metadata must describe thresholds and results without relying on display color alone.
- [ ] Define compatibility before code: old published packages and stored receipts/results still load without mutation; new features require a capable package/engine version. Add import/export, clone, preview/publish, upgrade/rollback and mixed-client/service-worker tests; reject unsupported versions clearly. Do not silently backfill old group identities or change checksums.
- [x] Red → green: a three-group fixture uses distinct attribute, skill and gear counts, including an empty group, a situational modifier, different group thresholds, and mixed sum/count terms. Assert exact structured results under injected RNG and total/dice budget enforcement across all groups.
- [x] Preserve old RNG draw order for legacy expressions. New grouped expressions have documented deterministic order. Server-owned IDs/metadata cannot be injected or changed by client-supplied roll outcomes.
- [x] Carry the structured result through runtime, item-granted actions, persistence, command replay, campaign audiences, activity/history, export, transport, frontend session/cache and display. Test full round trips and legacy result fallback, not only evaluator output.
- [x] Add guided pool authoring using existing definition choices, with custom expression editing preserved. Show separate group dice/counts, successes, kept/discarded state and a truthful breakdown in preview and actual play.
- [x] Run Task 5's relevant/full verification matrix and record a separate B acceptance result before introducing push commands.

**Gate:** named groups and structured calculations survive the full author-to-player lifecycle without changing historical package/result behavior. B alone does not reroll anything.

## Task 7 — Design and deliver configurable pushes (slice C, TDD)

**Files/seams:** versioned action/package definitions; a pure eligibility/result evaluator within Systems; Characters command/idempotency/persistence and a new immutable migration for lineage constraints if needed; character HTTP/OpenAPI/client contracts; existing session, player/GM roll UI, history/export and tests.

- [x] Before code, specify a bounded declarative policy per action/group: pushable dice, locked face values, maximum attempts, recalculation of totals, reported face outcomes, and whether pushing a successful or empty roll is permitted. No arbitrary predicates, scripts, or automatic state effects. Specified in the [C contract](../specs/2026-10-24-configurable-push-rolls.md); this checkbox records design only.
- [ ] Define a push command referencing an authoritative saved parent roll ID and expected revision, with its own idempotency key. Load the original dice, groups, bindings and pinned rules server-side; accept no replacement dice, seed, eligibility list, count, or total from the client.
- [ ] Specify eligibility after attribute edits, action-source removal, upgrade, archive, return or campaign/policy changes before implementation. The default is an active same-version character with current write permission and a still-applicable action source; new values never silently change the saved pool. Pushing uses the original roll snapshot and the original action's push policy.
- [ ] Enforce each lineage step atomically using the existing transaction/locking conventions plus database uniqueness. Only one accepted child may consume a parent's next push step, even for distinct keys and simultaneous devices. Enforce the configured chain maximum; a replay returns the same child, and a competing request cannot buy another attempt.
- [ ] Derive randomness from the server-owned push execution ID. Roll only eligible dice, preserve locked dice identity/value, retain parent/root/attempt lineage and the combined result, and enforce group/count/attempt budgets. Preserve the original result as immutable history.
- [ ] Reuse existing authorization and audience policy, checking current rights on execution and replay. A push cannot disclose a hidden parent or widen its audience; apply the most restrictive current permitted audience when policy changes. Test controller/GM/co-GM as allowed by existing policy, outsider, revoked member, cross-character ID, hidden parent and returned-character cases.
- [ ] Red → green: ordinary sum/count policies, locked successes and configured locked failures, all-locked/empty pools, exhausted limits, tampered requests, exact retry, mismatched key/body, distinct-key races, stale revision, source/version changes, lost acknowledgement/reload and transactional rollback. Verify once-only rows/history/attempt consumption with PostgreSQL concurrency tests.
- [ ] Keep pushing online-only initially. Use existing durable uncertain-command/reconciliation support, not a new offline push queue; never generate a fresh push automatically after timeout. Offline/reload must retain enough nonsecret reference state to reconcile an uncertain push after reconnect.
- [ ] Add accessible Push controls with eligibility/attempt explanation and parent → child history. Disable ineligible/exhausted/uncertain actions and retain results after reload. Show consequences for manual bookkeeping rather than mutating unrelated character resources.
- [ ] Run Task 5's verification matrix plus new DB concurrency and multi-account deployed journeys. Document the exact supported policy fixture; do not claim every Year Zero variant is supported from one example.

**Gate:** a push is an authorized, traceable transformation of a saved roll, with no extra rerolls from retries/races and no loss or disclosure of historical results.

## Delivery tracking

| Slice | Contract/spec | Red → green | CI | Deployed journey | Status |
|---|---|---|---|---|---|
| A | Package/expression specs updated; `actionDiagnostics` contract generated | R1–R4 observed red → green | Run 112: all seven verification jobs passed | `ad5de63`, 2026-10-23: core journey and offline reopening passed | Merged PR #21; unchecked bundles and wider release gates remain |
| B | [Contract 1.1 / grammar 0.2](../specs/2026-10-23-named-dice-groups.md) | Group evaluator/editor and async focus observed red → green | Final branch `4cfc04a`: run 121, all seven verification jobs passed | `ae7d1e8`, 2026-10-24: named groups, legacy and production-offline journeys passed (before later parser fix) | Merged PR #22; compatibility bundle and wider release gates remain |
| C | [Push contract 1.2](../specs/2026-10-24-configurable-push-rolls.md), [C execution plan](2026-10-24-configurable-push-rolls.md) | Package/evaluator/session/editor regressions observed red → green; [review record](../../acceptance/configurable-push-review-2026-10-24.md) | `f75cb02`: CI 129, all seven verification jobs passed | `f75cb02`: [three core live journeys](../../acceptance/configurable-push-rolls-2026-10-24.md), exact artifacts verified | Draft PR #23; remaining C7–C8 compatibility/transition gates open |

This document records execution steps. No checkbox or green test count from the original engine plan closes these new findings or extension gates.


### Slice A implementation evidence — 2026-10-22

The shared type checker now enforces direct success-count operands. Both runtime action paths use one arithmetic-failure guard; Characters persists the definite error using its existing stable receipt path. HTTP/OpenAPI/client/session carry bounded `actionDiagnostics`. The editor preserves custom formulas, rejects fallback previews, shows sample bindings, and shares AST-based additive-modifier detection with full-sheet preview.

Observed pre-fix red: 16 server regressions and three editor regressions failed. The subsequent adapter/full-preview regressions also failed before their repairs. Focused green and full-suite results, CI and deployed evidence are recorded separately in the dated acceptance record. Existing undo/redo controls are not provided by the creator; this slice does not add an unrelated history UI. Unchecked bundles retain their additional acceptance requirements. No named-group or push contract has been enabled.


### Slice A deployed evidence — 2026-10-23

Owner-approved isolated Railway deployment `d16eefbe-3863-4ea1-b83d-33d7bffbde1b` reached SUCCESS on exact application commit `ad5de63`, after the platform's earlier deployment pause. Migrations/readiness and served HTML/JS/CSS/service-worker/manifest identity were verified. The canonical core pool/item journey passed against the remote production build (53.6s), followed by a separate offline deep-link reopening check (24.7s). See the [acceptance record](../../acceptance/dice-pool-reliability-2026-10-22.md#final-ci-and-deployed-acceptance--2026-10-23) for exact IDs, artifact hashes, commands, cleanup and remaining limitations. CI on the same application commit passed all seven verification jobs, including real PostgreSQL, retained d20/PbtA journeys and production-offline coverage. Documentation-only evidence updates do not change the pinned application. A review precedes B; this evidence does not close the unchecked combined keyboard/focus or failed-action-offline-review gates or wider G9 release gates.


### Slice B CI evidence and staged preview — 2026-10-23

Application `aa77d09` passed [run 118](https://github.com/Kajonn/sweetroll/actions/runs/40002468608): 445 server, 370 real PostgreSQL integration, 1,171 frontend, 53 browser, 25 production-offline and 10 visual checks, plus typechecks/contracts/builds/Docker. The [B acceptance record](../../acceptance/named-dice-groups-2026-10-23.md) records red → green, intermediate failures and retained limitations. The new history projection admits full grouped results only under the originating roll's audience check; personal state exports still exclude roll history.

Reviewed Railway patch `eb9e086b-a72f-423e-8668-707d45b2a8f8` pins the isolated acceptance service to this exact application commit. At this historical checkpoint the deployment tool cancelled activation for lack of tool approval; B live acceptance had not run. The later deployment and results below resolve this activation blocker. The remaining compatibility/release bundles are not closed by CI alone.


### Slice B deployed evidence — 2026-10-24

Isolated deployment `87604ee3-6f89-48b3-a86f-585b118fdd0d` reached SUCCESS on observed commit `ae7d1e8`, with completed migrations and healthy readiness. The service configuration reports pin `aa77d09`; the deployed metadata reports `ae7d1e8`. Only three documentation files differ, so application code matches CI run 118. Served HTML, JS, CSS, worker and manifest match the deployed source rebuild byte for byte. Three live journeys passed with zero retries: named groups (83.530s), legacy pool reliability (79.619s) and production-worker offline grouped history (65.786s). A separate persisted-history probe verified group membership, dice identity, subtotals and total consistency; test-created systems and characters were archived and read back. See [the B acceptance record](../../acceptance/named-dice-groups-2026-10-23.md#isolated-deployed-acceptance--2026-10-24) for exact deployment/artifact/resource IDs, environment and remaining limitations.

This completes B's relevant verification/deployed core gate and makes PR #22 ready for review. The combined compatibility checkbox still requires additional explicit mixed old/new client/worker cases; physical-device, provider-authentication and wider G9 gates remain open. Slice C has not started and requires its own contract and execution evidence.


### Slice C contract and implementation sequence — 2026-10-24

After B merged, main `759323a` was reviewed for command/replay, ordinary roll revisions, standalone/campaign transactions, audience checks, package version gates, editor promotion and player/GM uncertainty handling. The [C contract](../specs/2026-10-24-configurable-push-rolls.md) specifies bounded group policies, original-pool snapshots, deterministic eligible-only RNG, one-child uniqueness, inherited audience principal, scoped lineage, online-only durable attempts and a concrete mixed-pool fixture. The [C execution plan](2026-10-24-configurable-push-rolls.md) maps red → green implementation tasks to those existing seams. This completes the initial before-code policy specification only; the command/storage/UI and verification checkboxes above remain open until implemented and observed. Runtime/package 1.2 capability is not enabled by these documents.


### Slice C acceptance follow-up — 2026-10-25

[PR #23](https://github.com/Kajonn/sweetroll/pull/23) implements C; the earlier contract-only paragraph describes the initial planning checkpoint. [The acceptance follow-up](../../acceptance/configurable-push-rolls-2026-10-25.md) records ten passed bounded software scenarios on the unchanged verified application, plus canonical transition, worker-update and adapter-compatibility tests. The automatic rollback ID mismatch and early Activity-loading error were subsequently [repaired and verified](../../acceptance/character-tools-fixes-2026-10-25.md). The C plan retains the unperformed wider release gates; the PR remains draft.
