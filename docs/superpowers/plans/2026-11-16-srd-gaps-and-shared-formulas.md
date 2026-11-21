# SRD gaps: what was closed, shared formulas and the remaining stages

> **Moved (owner decision 2026-11-21):** the 5e SRD system, its record, data and
> scenario left this repository so that the SRD licence stays out of Sweetroll
> core; it is published to a server through `/api/v1` from
> [Kajonn/sweetroll-dnd5e](https://github.com/Kajonn/sweetroll-dnd5e).
> Paths below that name `tests/integration/fixtures/dnd5e/`, `docs/systems/` or
> the 5e scenario are historical. The stages S1–S11 are covered here by the
> original Ember Trail test system (`tests/integration/scenarios/ember-trail.test.ts`).

**Plan · 16 November 2026 · Part 1 implemented 2026-11-16; parts 2 and 3 implemented 2026-11-21 on the owner's instruction "Implement plan"**

## Owner request (2026-11-16)

> First all missing features should be addressed. Increase size to 5 mb. Suggest
> a way to share formulas. Multiclassing should be possible. It should simply be
> a way to add new classes to a character.

The "missing features" are the 14 platform limits in the
5e SRD system record (moved; see the note above). This plan covers all of them.
Four are closed (part 1). Formula sharing is proposed (part 2). The other nine
need a design decision each before they are built (part 3).

## Part 1: implemented 2026-11-16

| Gap | Change | Where |
|---|---|---|
| 1. Size | A document and its compiled package may each be 5 MiB. Validation and publishing reject a larger package, so every published version can be exported and imported. Browser draft saves accept the same size (they were held to 1 MiB by the server default). | `package/limits.ts`, `rules/compile-document.ts`, `transport/http/systems.ts` |
| 6. Totals over looked-up values | Slot aggregates read computed number fields of a template, and computed booleans as a filter. Each read is charged to the sheet budget per entry the slot can hold. | `rules/slots.ts`, `rules/data.ts`, `runtime/rule-bindings.ts`, `runtime/resolve.ts` |
| 4. Looked-up text on an entry | The sheet projection and `/api/v1` return an entry's computed fields. The web sheet shows them read-only and folds long text. | `runtime/projection.ts`, `runtime/entry-values.ts`, `public-api/views.ts`, `web/src/characters/SlotListControl.tsx` |
| 12. Multiclassing | A system change, built on the two rows above. A class is an entry in the character's class list; its computed fields are what the class contributes at its level, and the character sums them. | `tests/integration/fixtures/dnd5e/document.ts` |

Design Section 6.4, the grammar contract, the API guide and the OpenAPI
contracts are updated. Tests: `rules/r3-data.test.ts` (three new cases),
`SlotListControl.test.tsx` and the 5e scenario.

With 5 MiB the SRD system also takes back what was cut for size: magic item
descriptions, all 362 magic items, the rule sections and the race lore. It is a
1.4 MB document and a 1.6 MB package.

**Not done in part 1.** No browser journey was run for the 5e system. The
creator's formula help does not yet mention computed fields in aggregates.
Monster stat blocks are still imported as sheet values (stage S3 below).

## Part 2: sharing formulas (proposal)

**Problem.** An expression has exactly one owner and one action. Thirty-seven
weapon templates need 37 copies of every attack formula: 340 kB compiled, and 37
places to fix a mistake. The 5e system therefore uses one generic weapon entry
with a 37-option list instead of a weapon catalog.

| Option | What the author does | Platform change | Cost |
|---|---|---|---|
| **A. One expression, several owners** (recommended) | Points several templates' computed fields or granted actions at the same expression ID. | Remove the single-owner rule for templates. Compile the expression once against the fields that every owning template defines with the same ID and type (granted rolls already do this for the entities that show a slot). Actions that share a roll expression must declare the same inputs; outcome and detail expressions follow their roll. | Small: `compile-document.ts`, `structural.ts`, compatibility comparison, one creator picker ("use an existing formula"). No grammar change. |
| B. Base templates | Declares `extends: "weapon"` on a template and overrides field defaults. Fields, computed fields and granted actions come from the base. | New template property, resolution at compile time, creator support for inherited parts, version comparison of inherited definitions. | Medium. Removes the repeated action definitions as well as the formulas. |
| C. Named formulas with parameters | Writes `use("attack", item.dice)` in a formula. | User-defined functions: call typing, cost accounting, recursion ban. Excluded by decision C5 of the rules coverage plan. | Large. |

**Recommendation: A now, B only if repeated action definitions remain a burden.**
A keeps packages declarative and adds no language. With A, the 5e system gets a
weapon catalog: each weapon is a template with fixed number fields (damage dice,
die, finesse flag) and the shared attack and damage formulas read them through
`item.`. Rough size: 37 templates of about 1.5 kB each and four formulas.

Decision F1: approve option A.

## Part 3: remaining gaps (each needs a decision)

Stages are independent unless noted. Each follows design Section 17.1.

| Stage | Gap | Proposal | Decision needed |
|---|---|---|---|
| S1 | 3. Formula sharing | Part 2, option A. Then give the 5e system a weapon catalog. | F1 |
| S2 | 5. Players cannot read reference data | `GET /system-versions/{id}/reference-data` and `/{datasetId}` for any account that may use the version; a "Rules" panel on the sheet with search. | G1: every dataset of a version is readable by everyone who can use the version. Recommended: yes. |
| S3 | 2. Monsters are not a catalog | An entity may name a dataset as its presets. Creating a character from a preset copies the record's values into the new sheet (same shape as `srd-5.1-monsters.json`). The 5e bestiary becomes a dataset. | G2: presets are copied once, not linked. Recommended: copied. |
| S4 | 7. New characters are not full | A resource option `startFull`: at creation, and whenever its computed maximum rises from 0, the current value is set to the maximum. | G3: scope of the rule (creation only, or also the first rise from 0). Recommended: both; later rises stay manual. |
| S5 | 8. No rest action | Action kind `resourceBatch`: an ordered list of resets and deltas over entity resources, applied in one command. Covers a long rest. | G4: may one batch also change entry resources? Recommended: not yet. |
| S6 | 9. Rolls do not change sheets | Keep decision C10 (rolls never change characters automatically). Add a separate, explicit command: "apply this roll's total to resource X of character Y", by a person who may edit Y. | G5: reopen C10 to this extent. No recommendation; it reverses an owner decision. |
| S7 | 10. Targets | `target.entityIds` lists several entities (fields common to all are readable). `target.optional: true` lets the same action run without a target and skips target-reading outcomes. Removes the duplicate "attack" and "attack a monster". | G6 |
| S8 | 11. Advantage | Allow the same dice group ID in both branches of an `if`, since only one branch runs. `if(dis, keepLowest(group("d20", …)), keepHighest(group("d20", …)))` then needs no zero-multiplied term. | G7 |
| S9 | 13. Conditional layout | Sheet elements and sections take `visibleWhen`: the ID of a boolean computed field. Hidden elements are not rendered; their values stay in the API. | G8 |
| S10 | 14. `npc` kind | Standalone creation accepts playable entities only; `npc` entities are created inside a campaign by a GM. | G9. Recommended: enforce. |
| S11 | Class resources on the class entry (follow-up to gap 12) | Template resources may have a computed maximum, and template formulas may read the character's stored fields. Removes the twelve fixed class meters. Depends on S9 for a tidy sheet either way. | G10 |

Not proposed: initiative order, turn tracking, effects with durations, range and
areas. They stay excluded by the rules coverage plan.

## Risks

| Risk | Mitigation |
|---|---|
| A 5 MiB package is read for every sheet request | The 1.6 MB SRD package runs the 5e scenario (177 requests) in about 28 s on the test database; no load test was run. Measure before a hosted release. |
| Aggregates over computed fields multiply sheet cost | Charged per slot capacity at publish and at run time; the 5e sheet stays inside the 8,192-step budget with six class entries. |
| Option A lets one edit change many templates | That is its purpose; the creator must show which templates use a formula before it is edited. |

## Decisions and implementation record (2026-11-21)

**Owner instruction (2026-11-21):** "Implement plan". Asked about G5, the owner
chose to add the apply-roll command. The other decisions take the
recommendations above; where the plan gave none (G6–G8, G10) its proposal is
taken as written.

| Decision | Taken |
|---|---|
| F1 | Option A: one expression, several template owners |
| G1 | Every dataset of a version is readable by everyone who may use the version, or read a character pinned to it |
| G2 | Presets are copied once, not linked |
| G3 | Start full at creation and on the first rise from 0; later rises stay manual |
| G4 | A batch changes entity resources only |
| G5 | Owner: add the explicit apply-roll command; rolls still never change characters on their own |
| G6 | `target.otherEntityIds` and `target.optional` |
| G7 | One group name per `if` branch |
| G8 | `visibleWhen` on sections and elements, naming a true/false field |
| G9 | `npc` entities only in campaigns |
| G10 | Template resources with a calculated maximum; template formulas read stored character fields |

| Stage | Implemented | Where |
|---|---|---|
| S1 | Templates share expressions compiled against common fields; actions sharing a roll must agree on inputs, target, outcomes and details. The template editor offers another template's formula, names who shares it and drops an unused one. | `rules/compile-document.ts`, `web/src/editor/TemplatesTab.tsx` |
| S2 | `GET /characters/{id}/reference-data[/{datasetId}]` (browser and v1) and `GET /system-versions/{id}/reference-data[/{datasetId}]` (v1); a Rules panel with search on the sheet. | `characters/index.ts`, `transport/http/characters.ts`, `public-api/characters.ts`, `web/src/characters/RulesPanel.tsx` |
| S3 | `presetsFrom` on entities; `presetId` on standalone and campaign creation (browser and v1); presets in creation options; picker in the campaign create panel. | `runtime/presets.ts`, `systems/runtime.ts`, `characters/campaignPlacement.ts`, `web/src/campaigns/CampaignCharacters.tsx` |
| S4 | `startFull` on resources, entity and template; creator checkbox. | `runtime/state.ts`, `runtime/resolve.ts`, `ResourceFieldEditor.tsx` |
| S5 | `resourceBatch` action kind; creator editor. | `systems/runtime.ts`, `structural.ts`, `ResourceBatchEditor.tsx` |
| S6 | `applyRoll` command, `POST …/resources/{id}/apply-roll` and `GET …/applicable-rolls` (browser and v1); activity `character_roll_applied`; sheet control. | `characters/index.ts`, `CharacterSheet.tsx`, `CharacterRoute.tsx` |
| S7 | `target.otherEntityIds`, `target.optional`; outcomes and details that read the target are skipped without one; target picker offers "No target". | `rules/targets.ts`, `rules/outcomes.ts`, `runtime/roll-context.ts`, `characters/persistence.ts`, `RollActionEditor.tsx` |
| S8 | One group name per branch; a group named on every branch is available afterwards. | `rules/groups.ts` |
| S9 | `visibleWhen` on sections and elements; publish check; projection leaves hidden parts out; "Show only when" pickers in the sheet builder. | `compile-document.ts`, `runtime/projection.ts`, `web/src/editor/sheet/*` |
| S10 | Standalone creation rejects `npc` entities; the standalone picker hides them. | `systems/runtime.ts`, `CreateCharacter.tsx` |
| S11 | Template resource maxima and template formulas reading stored character fields; entry resources normalized before the sheet is evaluated. | `runtime/entry-values.ts`, `runtime/resolve.ts`, `rule-bindings.ts`, `projection.ts` |

Tests: runtime, rules and creator unit tests for every stage
(`runtime.test.ts`, `r3-data.test.ts`, `groups.test.ts`, `opposed.test.ts`,
`compile-document.test.ts`, `TemplatesTab.test.tsx`, `RulesPanel.test.tsx`), and
the 5e scenario, which uses every stage through `/api/v1`.

The 5e system uses all of them: 37 weapon templates sharing four formulas, one
attack with an optional target of either kind, class features on the class
entry, start-full resources, long and short rests, hidden empty slot levels and
death saves, the bestiary as presets, and the apply-roll command in play.

**Not done.** No browser journey or hosted run for any stage. Extensions keep
one owner per expression, cannot carry presets and cannot calculate template
resource maxima. The apply-roll control and the Rules panel are online only.
A batch cannot restore entry resources, so class features are restored on their
class entries. The 512-field budget, not the 5 MiB size, is now the binding limit
of the 5e system (490 used); it is why classes stay one template.

