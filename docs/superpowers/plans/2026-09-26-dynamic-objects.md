# Dynamic sheet objects implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Characters gain player-managed dynamic entries (inventory items, talents, spells, effects) instantiated from creator-defined templates into typed sheet slots, with template-granted actions resolving against character stats.

**Architecture:** Additive-only extension across the existing pipeline — package schema (`templates`, `slots`) → structural/compatibility validation → compile env scoping → runtime state (`entries`) with merged-scope resolution → projection of slot elements and granted actions → character entry commands under the existing revision/idempotency guard → Creator template/slot authoring → sheet slot lists with add/remove/roll. No new field kinds, no lookups engine, no sub-entity lifecycles.

**Tech Stack:** TypeScript, TypeBox/Ajv schemas, vitest, Fastify HTTP, PostgreSQL state JSON, React + TanStack Router/Query, Playwright Chromium (dev-server E2E).

**Spec:** `docs/superpowers/specs/2026-09-26-dynamic-sheet-objects-design.md` — the plan argues from the spec; executors read both.

## Global Constraints

- Grammar v0.1 only: `number/string/boolean` literals, `reference(fields|inputs)`, `unary`, `binary`, `call(min|max|round)`, `dice`, `keep(highest|lowest)`, `successCount`. No reroll/explode/custom faces, no lookups, no effects engine.
- No new field kinds in step 1: template fields reuse integer, decimal, text, boolean, singleChoice, multiChoice, resource (`schema/document.ts` field schemas).
- All schema objects keep `additionalProperties: false`.
- Definition IDs keep `^[a-z][a-z0-9_]{0,63}$` (`DefinitionIdSchema`, `schema/common.ts:3`) and join the single global `duplicate_definition_id` set.
- Additive-only: systems without templates/slots validate, compile, run, and render exactly as today. No migration of existing rows.
- Character writes keep `expectedRevision` + idempotency-key discipline (`characters/index.ts:234,243,252`; guards `persistence.ts:1097-1101` / `578-582`).
- Standalone audience rule unchanged: standalone `executeAction` accepts only `owner_only` (`characters/index.ts:1323-1333`).
- Budgets: new counters stay under the `PACKAGE_LIMITS` pattern (`package/limits.ts:1-19`); granted-action expressions obey `expressionAstDepth:32`, `expressionAstNodes:256`, `expressionBytes:1024`.
- Offline snapshots: entries are plain state values; `projectionVersion` stays `"1.0"`; snapshot-compat rule (`SUPPORTED_OFFLINE_PROJECTION`) unchanged.

---

## File structure (new vs modified)

- `src/systems/implementation/package/schema/dynamic.ts` (new): `TemplateKindSchema`, `ObjectTemplateV1`, `SlotDefinitionV1`, `CharacterEntryV1`.
- Modify `schema/document.ts:380` (`SystemDocumentV1` += `templates`, `slots`), `schema/package.ts:37` (`SystemPackageV1` passthrough + compiled templates), `limits.ts` (+4 counters), `structural.ts:60` (unique-id + reference checks), `compatibility.ts:18` (breaking codes).
- `src/systems/implementation/runtime/entries.ts` (new): merged-scope builder + entry validation against slot/template.
- Modify `runtime/state.ts` (`entries` in state + bindings), `runtime.ts` (granted-action intent + env), `runtime/projection.ts:76-87` (slot + granted-action projection), `characters/index.ts` (entry commands), `transport/http/characters.ts` (routes).
- Creator: `web/src/editor/TemplatesTab.tsx` (new, clone `SheetsTab` pattern), `web/src/editor/sheet/slotTypes.ts` (extend `sheetTypes.ts:3` kinds), `SectionEditor`/`ElementEditor` add-element paths.
- Sheet: `web/src/characters/SlotListControl.tsx` (new) + `CharacterSheet`/`CharacterSheetCallbacks` wiring + `session.ts` intents.
- Tests: colocated `*.test.ts`/`*.test.tsx` per repo pattern; e2e `web/tests/e2e/dynamicObjects.spec.ts`.

---

### Task 1: Package schema — templates, slots, entries

**Files:**
- Create: `src/systems/implementation/package/schema/dynamic.ts`
- Modify: `src/systems/implementation/package/schema/document.ts` (`SystemDocumentV1:380`), `src/systems/implementation/package/schema/package.ts` (`SystemPackageV1:37`), `src/systems/implementation/package/schema/index.ts` (re-export)
- Test: `src/systems/implementation/package/schema/dynamic.test.ts`

**Interfaces:**
- Consumes: `DefinitionIdSchema` (`common.ts:3`), field schemas (`document.ts:28-156`), `ActionV1` (`document.ts:354`), `SheetElementV1` (`document.ts:247`).
- Produces: `ObjectTemplateV1`, `SlotDefinitionV1`, `CharacterEntryV1`; extended `SystemDocumentV1` / `SystemPackageV1` for Tasks 2–3.

- [ ] **Step 1: Write the failing test.** Create `dynamic.test.ts` asserting a minimal item template with one granted roll action passes the schema, plus a rejection case (template id with uppercase must fail `DefinitionIdSchema`). Match the TypeBox assertion idiom used in neighboring schema tests (read one first).
- [ ] **Step 2: Run it.** `npx vitest run src/systems/implementation/package/schema/dynamic.test.ts` from repo root. Expected: FAIL, cannot find module.
- [ ] **Step 3: Write `schema/dynamic.ts`.** `TemplateKindSchema` = union of `item|spell|talent|effect` literals. `ObjectTemplateV1` = `{id, label, kind, description?, fields: <imported field union>[max 64], grantedActions: ActionV1[max 16]}` with `additionalProperties: false`. `SlotDefinitionV1` = `{id, label, accepts: TemplateKind[1..4], maxEntries?: 1..200}`. `CharacterEntryV1` = `{entryId: uuid, slotId, templateId: DefinitionId|null, values: Record<string,Unknown>, quantity?: >=1}`. Import (never redefine) the field union from `document.js`.
- [ ] **Step 4: Extend the documents.** `SystemDocumentV1` += `templates: ObjectTemplateV1[max 128]`, `slots: SlotDefinitionV1[max 64]`; same two arrays on `SystemPackageV1`; re-export from `schema/index.ts`.
- [ ] **Step 5: Run.** `npx vitest run src/systems/implementation/package/schema/` — all pass including existing tests.
- [ ] **Step 6: Commit.** `git add src/systems/implementation/package/schema/` + `git commit -m "feat: template/slot/entry schemas for dynamic sheet objects"`.

---

### Task 2: Structural validation, budgets, compatibility

**Files:**
- Modify: `src/systems/implementation/package/limits.ts:1-19`, `src/systems/implementation/package/structural.ts:60-286`, `src/systems/implementation/package/compatibility.ts:18`
- Test: `src/systems/implementation/package/structural.test.ts` (colocated, same pattern as `codec.test.ts` / `compatibility.test.ts` — if the file does not exist, create it with that exact path)

**Interfaces:**
- Consumes: Task 1 schemas; `validateStructure`, `validateBudgets`, `collectId` patterns.
- Produces: enforced budgets + reference integrity + breaking-change codes for Tasks 3, 6.

- [ ] **Step 1: Write failing tests.** Cases: duplicate template id → `duplicate_definition_id`; granted roll action with missing expression → `missing_reference`; slot element referencing unknown slot → `missing_reference`; template count over budget → budget diagnostic; template removing a live-referenced expression → breaking code (see Step 3).
- [ ] **Step 2: Run.** `npx vitest run src/systems/implementation/package/structural.test.ts`. Expected: FAIL (no checks yet).
- [ ] **Step 3: Implement.** `limits.ts` += `templates:128, slots:64, templateFields:512 (global sum with fields), grantedActions:256 (global sum with actions)`. `validateStructure`: feed template/slot ids into the existing `collectId` walk; reference checks — granted roll→expression exists, granted bump→resource exists in template fields, template field ids unique within template AND globally (same global set), slot ids global. `compatibility.ts`: new breaking codes `template_removed`, `template_action_removed`, `slot_removed`, `slot_kind_narrowed`; adding templates/slots/actions = non-breaking.
- [ ] **Step 4: Run.** Full package suite `npx vitest run src/systems/implementation/package/` — green, no existing-diagnostic changes.
- [ ] **Step 5: Commit.** `git add src/systems/implementation/package/limits.ts src/systems/implementation/package/structural.ts src/systems/implementation/package/compatibility.ts src/systems/implementation/package/structural.test.ts` + `git commit -m "feat: validate templates/slots budgets references and breaking codes"`.

---

### Task 3: Compile path — template expressions and granted actions

**Files:**
- Modify: `src/systems/implementation/rules/compile-document.ts:38-179`, `src/systems/implementation/authoring/assess.ts:44-64`
- Test: extend `src/systems/implementation/rules/compile-document.test.ts` (colocated; check exact filename first — `compile-document.test.ts` confirmed present)

**Interfaces:**
- Consumes: Task 1–2 (schemas, budgets, reference integrity).
- Produces: compiled template expressions in the package (same `CompiledExpressionV1` shape: ast/dependencies/cost/inferredType) for Tasks 4–5.

- [ ] **Step 1: Write failing tests.** Cases: template roll expression compiling against template fields + `inputs` (mirrors `check_expr`); granted-action expression referencing an unknown field → compile diagnostic; two templates sharing one expression id → rejection (no sharing, same rule as `compile-document.ts:111`); template computed-cycle detection (expression A depends on B depends on A → diagnostic, mirrors `computedCycle:179`).
- [ ] **Step 2: Run.** `npx vitest run src/systems/implementation/rules/compile-document.test.ts`. Expected: FAIL on the new cases.
- [ ] **Step 3: Implement.** In `compile-document.ts`, after the entity-expression pass, add a template pass: for each template, build the env from its fields (+ `inputs` for roll actions), run the existing `compileExpression` per granted expression, enforce node/depth budgets via the existing `measureAst` path, reject shared expression ids and computed cycles with the same diagnostics as entities. Thread the unsigned-package passthrough (`compile-document.ts:146`) and `documentFromPackage` (`assess.ts:64`) so compiled templates round-trip. No changes to entity compilation.
- [ ] **Step 4: Run.** `npx vitest run src/systems/implementation/rules/ src/systems/implementation/package/` — green.
- [ ] **Step 5: Commit.** `git add src/systems/implementation/rules/ src/systems/implementation/authoring/` + `git commit -m "feat: compile template expressions and granted actions"`.

---

### Task 4: Runtime state — entries, bindings, validation

**Files:**
- Create: `src/systems/implementation/runtime/entries.ts`
- Modify: `src/systems/implementation/runtime/state.ts:9-74`
- Test: `src/systems/implementation/runtime/entries.test.ts`

**Interfaces:**
- Consumes: Task 1 (`CharacterEntryV1`), package templates/slots, `buildFieldBindings`.
- Produces: `validateEntryForSlot(entry, slot, template|null)`, `buildEntryScope(entry, template)` for Tasks 5, 7.

- [ ] **Step 1: Write failing tests.** Cases: valid templated entry passes; entry with unknown slotId fails; template kind not in slot `accepts` fails; custom entry (`templateId: null`) with granted actions fails (data-only lock); entry values violating template field types fail; `maxEntries` overflow fails (takes existing entry count as input); `buildEntryScope` merges `{strength_mod: 2}` (character) + `{bonus: 1}` (entry) with entry winning on collision.
- [ ] **Step 2: Run.** `npx vitest run src/systems/implementation/runtime/entries.test.ts`. Expected: FAIL, module missing.
- [ ] **Step 3: Implement `entries.ts`.** Pure functions, no I/O: `validateEntryForSlot(entry, slots, templates, siblingCount)` returning `{ok} | {ok:false, code, message}` with codes `unknown_slot`, `kind_not_accepted`, `custom_entry_with_actions`, `entry_values_invalid`, `slot_full`; `buildEntryScope(characterFields, entryValues)` returning merged record, entry-first. Keep the functions total (no throws) to match the codebase's `Result`-adjacent style — read `state.ts` error idiom first and mirror it.
- [ ] **Step 4: Extend state.** `RuntimeStateV1` (`runtime.ts:20-23`) += `entries: Record<string, CharacterEntryV1>` (default `{}` for old rows — read `decodeRuntimeState` (`state.ts:39`) and preserve its strict-shape handling so legacy states decode). `buildFieldBindings` unchanged (character fields only; entry scope merges at resolution in Task 5, keeping bindings backward-compatible).
- [ ] **Step 5: Run.** `npx vitest run src/systems/implementation/runtime/ src/characters/` — green, legacy states decode.
- [ ] **Step 6: Commit.** `git add src/systems/implementation/runtime/entries.ts src/systems/implementation/runtime/entries.test.ts src/systems/implementation/runtime/state.ts src/systems/runtime.ts` + `git commit -m "feat: character entries state and slot validation"`.

---

### Task 5: Resolution — merged scope, granted rolls, nominal actions

**Files:**
- Modify: `src/systems/runtime.ts:244-432`, `src/systems/implementation/runtime/projection.ts:16-175`
- Test: extend `src/systems/implementation/rules/evaluate.test.ts`? No — resolution tests live with the runtime: create `src/systems/implementation/runtime/resolve-entries.test.ts` driving `runtime.resolve` with a compiled template package (build the package in-test via `compileDocument` on a Task-3-style document, mirroring how existing runtime tests construct packages — read one first).

**Interfaces:**
- Consumes: Task 4 (`buildEntryScope`, `validateEntryForSlot`); `resolveObservedValues`, `findOwnedAction`, `evaluate`.
- Produces: `resolveGrantedAction` behavior + `NominalActionResult` shape + projected slot/granted-action elements for Tasks 6–7.

- [ ] **Step 1: Write failing tests.** Cases: granted roll `d20 + fields.strength_mod + fields.bonus` with character `{strength_mod: 2}` and entry `{bonus: 1}` evaluates with bonus=1; entry value shadows same-named character field; nominal action (template action flagged `nominal: true` — decide exact flag name while implementing, must match Task 1 schema? No: Task 1 has no nominal flag. RULING NEEDED — see Step 3) records activity and returns display text without touching state; custom entry granted-action attempt rejected; unknown entryId rejected.
- [ ] **Step 2: Run.** Expected: FAIL (no granted-action path).
- [ ] **Step 3: Implement — including the nominal-action ruling.** First decide the nominal marker: read `RollActionV1` (`schema/document.ts:311`) — if it has an optional display/output template field, reuse it: a granted roll action with `expressionId: null`? Schema says expressionId required, so instead add optional `nominal: true` to granted actions only (extend `ActionV1` usage in `dynamic.ts` via `Type.Intersect` or optional field — keep entity actions untouched). Record this decision in the commit message. Then: `findOwnedAction` accepts `{entryId, actionId}` — resolve template from package, entry from state, validate via Task 4; env = `buildEntryScope(characterFields, entry.values)`; nominal path short-circuits to activity-only result. Wire `entryId` through the EXISTING `executeAction` path only (`characters/index.ts` `apply()`: intent/inputHash/activity payload, mirrors `:1348-1354+1414`) — new add/remove/edit-entry commands belong to Task 7, not this task.
- [ ] **Step 4: Project.** `projection.ts`: for each sheet `slot` element, emit `{kind:"slot", slotId, label, accepts, entries:[{entryId, templateId, label, values}]}`; for each entry with granted actions, emit synthetic `{kind:"action", actionId, entryId, label, actionKind, inputs[], validations}` directly after its entry (never for custom entries). Bump `projectElement` (`projection.ts:76-87`) accordingly. `projectionVersion` stays `"1.0"`.
- [ ] **Step 5: Run.** Runtime + characters + package suites green; existing projection tests unchanged (no slots = no new elements).
- [ ] **Step 6: Commit.** `git add src/systems/runtime.ts src/systems/implementation/runtime/ src/systems/implementation/package/schema/dynamic.ts src/characters/index.ts` + `git commit -m "feat: granted-action resolution and slot projection"`. Scope: executeAction wiring only — no new command kinds here.

---

### Task 6: Creator UI — Templates tab + slot elements

**Files:**
- Create: `web/src/editor/TemplatesTab.tsx`, `web/src/editor/sheet/slotTypes.ts`
- Modify: `web/src/editor/DocumentEditor.tsx` (`CreatorTabId:43`, `CREATOR_TABS:63`, render `543-562`), `web/src/editor/sheet/sheetTypes.ts:3`, `web/src/editor/sheet/SheetEditor.tsx` (placement `125`, `204-236`, unplaced `829-858`), `web/src/editor/sheet/SectionEditor.tsx` (add-element paths), `web/src/editor/sheet/ElementEditor.tsx:20-66`
- Test: `web/src/editor/TemplatesTab.test.tsx` (+ extend sheet editor tests for slot placement if colocated tests exist — check first)

**Interfaces:**
- Consumes: Tasks 1–3 (schemas compile; invalid templates surface as draft diagnostics through the existing assess path).
- Produces: creator-authored templates/slots in draft documents for Task 8 e2e.

- [ ] **Step 1: Write failing component tests.** Render `TemplatesTab` with an empty document: shows empty-state + add-template button. Add `item` template: label field + kind picker + granted roll action editor appear (reuse `RollActionEditor` component, not a copy). Slot placement: sheet section add-element menu offers `slot`, placing it binds a `slotId`.
- [ ] **Step 2: Run.** `npx vitest run web/src/editor/TemplatesTab.test.tsx` from `web/`. Expected: FAIL, module missing.
- [ ] **Step 3: Implement.** Add `CreatorTabId="templates"` + `CREATOR_TABS` entry + tab panel (clone the `SheetsTab:728-825` structure, not its code). `TemplatesTab` = template list (add/remove/rename/kind) + per-template fields (reuse `EntityList` field-kind pickers via composition, reading `EntityList.tsx:205-248` first) + granted actions (reuse `RollActionEditor`/`ResourceBumpEditor` from `DiceTab:919-1059`). Extend `SheetElementKind` with `slot`; extend `makeElementOfKind`/`ElementBodyRouter` with a slot branch (binding picker over document slots, mirroring `element-binding-{id}` + `definition-id-input`); extend `unplacedDefinitionsForSheet`/`placeDefinition` so templates and slots appear as placeable definitions. Template editing lives behind the existing advanced disclosure only where expressions are involved (`advanced-disclosure-toggle:1337-1364`).
- [ ] **Step 4: Run.** `npm test` from `web/` — green; save/publish flow untouched (draft assess path validates templates automatically via Tasks 2–3).
- [ ] **Step 5: Commit.** `git add web/src/editor/` + `git commit -m "feat: creator template authoring and slot placement"`.

---

### Task 7: Entry commands + sheet UI

**Files:**
- Modify: `src/characters/index.ts` (new command kinds ONLY — executeAction wiring done in Task 5), `src/transport/http/characters.ts:896-937` (routes), `web/src/characters/CharacterSheet.tsx:124-201`, `web/src/characters/session.ts:1785-1806`, `web/src/api.ts:108-111`
- Create: `web/src/characters/SlotListControl.tsx`
- Test: `src/characters/entries.test.ts` (command-level, through `apply()`), `web/src/characters/SlotListControl.test.tsx`

**Interfaces:**
- Consumes: Task 4 (`validateEntryForSlot`), Task 5 (`resolveGrantedAction`, nominal results, projection shapes), Task 6 (documents with slots — for UI tests, construct draft documents in-test).
- Produces: full player loop for Task 8.

- [ ] **Step 1: Write failing command tests.** Through `apply()`: `addEntry` (templated, valid slot) bumps revision and stores the entry; `addEntry` with wrong-kind template → rejection, revision unchanged; `addEntry` custom (templateId null) with actions → rejection; `removeEntry` deletes entry, granted actions leave projection, prior activity rows intact (assert activity table count unchanged); `updateEntryValues` merges values; stale `expectedRevision` → conflict; replayed idempotency key → identical result without duplication. Read `apply()` (`index.ts:1204`) + an existing command test first and mirror their harness exactly.
- [ ] **Step 2: Run.** `npx vitest run src/characters/entries.test.ts` from repo root. Expected: FAIL (unknown command kinds).
- [ ] **Step 3: Implement commands + routes.** New command kinds `addEntry|removeEntry|updateEntryValues`, each `{kind, entry fields, expectedRevision, idempotencyKey, audience?}` mirroring the existing command shapes (`index.ts:234,243,252`). Validation order inside `apply()`: idempotency claim → auth/scope (same as sibling commands) → `validateEntryForSlot` → mutate → activity (`entry_added/entry_removed/entry_updated`) → `applyCommandTx`. Routes `POST /characters/:id/entries`, `DELETE /characters/:id/entries/:entryId`, `PATCH /characters/:id/entries/:entryId` in `transport/http/characters.ts` next to `:896-937`, same envelope/error conventions. Regenerate OpenAPI client types if the repo generates them (`npm run contracts:check` must pass — check package.json scripts first).
- [ ] **Step 4: Write failing component tests.** `SlotListControl` with a projected slot: lists entries, Add opens template picker with custom-entry fallback, remove asks confirm, granted roll button submits via callback prop. Follow `ActionControl:87-113` test patterns (read them first).
- [ ] **Step 5: Implement UI.** `SlotListControl` beside `ActionControl`/`FieldControl`, composing `Button/Select/Dialog/Panel/EmptyState` from `web/src/ui/`. Extend `renderElement` (`CharacterSheet.tsx:177-189`) with the `slot` branch and `CharacterSheetCallbacks:9-14` with `onAddEntry/onRemoveEntry/onUpdateEntry/onExecuteGranted`; wire through `session.ts` durable intents (mirroring `executeAction` at `:1785-1806`, carrying inputs+audience+idempotencyKey) and direct `api.ts` calls. Removal uses the standard destructive-confirm; add flow lists templates first, custom entry as labeled fallback.
- [ ] **Step 6: Run.** Root `npm test`, web `npm test`, both typechecks, `contracts:check` — all green.
- [ ] **Step 7: Commit.** `git add src/characters/ web/src/characters/ src/transport/http/characters.ts` + `git commit -m "feat: entry commands and sheet slot UI"`.

---

### Task 8: E2E journey, breaking-change proof, acceptance

**Files:**
- Create: `web/tests/e2e/dynamicObjects.spec.ts`, `docs/acceptance/dynamic-objects-2026-09-26.md`
- Test: the spec itself.

**Interfaces:**
- Consumes: Tasks 1–7. Produces: release-ready evidence.

- [ ] **Step 1: Creator authoring leg (UI).** Sign in as GM (dev panel, journey code or `code-test-a` per existing specs). Create a system, add an `item` template (`torch`: one nominal `Raise Torch` action) and an `item` template (`longsword`: granted `Longsword Attack` roll), place an `inventory` slot accepting `["item"]` on the sheet, save, publish 1.0.0 (reuse testids from `creatorToCharacter.spec.ts` + Task 6's new tab testids — read both files first, invent nothing).
- [ ] **Step 2: Player loop leg (UI).** New player context: create character from the published version, open sheet, Add → pick `longsword` (granted attack appears), Add → custom entry `Lucky Stone` (no actions granted — assert none), roll `Longsword Attack` (result shown), remove `longsword` (attack vanishes; prior activity intact), go offline → add `torch` → reconnect → entry syncs (offline replay inherited — assert `Saved` + single activity row, no dupe).
- [ ] **Step 3: Breaking-change leg (API).** Clone the system, remove the `longsword` template, attempt publish: expect the breaking gate to demand acknowledge; republish with `acknowledgeBreaking: true` (mirrors `publishOwnedClone` payload shape in `test-auth.ts`).
- [ ] **Step 4: Run.** `node scripts/run-e2e.mjs --suite journeys tests/e2e/dynamicObjects.spec.ts` from `web/` (isolated runner, Ruling 5 pattern). Expected: green. Traces retained on failure; product bugs become separate bugfix tasks, spec bugs fixed inline.
- [ ] **Step 5: Suites + record + commit.** Root `npm test`, web `npm test` green. Write `docs/acceptance/dynamic-objects-2026-09-26.md` (commit, commands, scope, UI-vs-API split, findings, limitations). Commit: `git add web/tests/e2e/dynamicObjects.spec.ts docs/acceptance/dynamic-objects-2026-09-26.md` + `git commit -m "test: dynamic objects journey and acceptance"`.

## Self-Review

1. Spec coverage: templates/slots/entries format (T1); budgets/validation/migration-breaking (T2+T8); merged-scope resolution + nominal actions (T5); custom data-only + removal-vanish (T4+T7); Creator UI (T6); sheet UI add/remove/roll (T7); testing pyramid (every task + T8). Out-of-scope items (new field kinds, lookups, effects engine, trading) appear in no task. OD-04 stays deferred except granted roll/bump actions.
2. Placeholder scan: fixed during writing — structural test path made exact; Task 7 template-system setup made explicit (was "on the journey fixture content," which lacks templates); Task 5/7 command-split contradiction resolved (executeAction wiring in T5, new kinds in T7); no TBD/TODO; every API payload mirrors a cited existing call; every UI testid cites its source spec.
3. Type consistency: `ObjectTemplateV1/SlotDefinitionV1/CharacterEntryV1`, `validateEntryForSlot`, `buildEntryScope`, `resolveGrantedAction`, `NominalActionResult`, and the `entryId` intent wiring are named identically in every producing and consuming task above.

## Execution Handoff

Owner pre-committed: write plan, then execute in a worktree with subagents (subagent-driven). Proceed to: commit this plan, create the worktree, dispatch Task 1 implementer under superpowers:subagent-driven-development.

