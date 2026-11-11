# Sweetroll rules coverage: fixes and wider system support

**Implementation plan · 10 November 2026 · Owner-approved 2026-11-10 (C1–C13; C6, C10, C12 and C13 as amended by the owner)**

## Goal

Fix the defects found in the 2026-11-10 review and widen the rules contract so
that every system family in the coverage matrix below can be implemented as a
published system, without giving up the security invariant of design Section 6.4:
packages stay declarative data with bounded, platform-evaluated expressions.

This is rules-contract work. It adds no application/database migration chain
(design Sections 12.4 and 17.0). Schema changes go into the current baseline and
disposable test databases are recreated.

## Owner request (2026-11-10)

> Plan for all the fixes and expand scope with the goal to support all systems in
> matrix.

The owner approved all decisions below and asked for R0 to start on 2026-11-10.
Stages R1–R8 change the design and update `design_v2.md` as they are delivered.

**Owner statement (2026-11-10):** no systems are published yet, so the whole
engine can be rewritten. The plan therefore replaces the rules contract in place
instead of adding a version beside it (C1). What is kept is what already works
and is contract-independent: the HMAC dice stream with server-generated execution
IDs, compile-time and runtime budgets, typed fallbacks, idempotent
revision-checked commands and the audience model.

## Coverage matrix (target)

| # | System family | Today | Blocked by | Stage that unblocks it |
|---|---------------|-------|------------|------------------------|
| M1 | d20 + modifier (OSR, simple d20) | Works | `adv()` bug, no conditional bonus | R0, R2 |
| M2 | d20 with classes, levels, armor | Partial | No lookups, no sums over entries, fixed resource maximum | R1, R2, R3 |
| M3 | PbtA 2d6 | Roll only | No outcome bands | R5 |
| M4 | Year Zero d6 pools | Works | — | regression only |
| M5 | d100 roll-under (BRP style) | No | No success result, degrees, doubles | R4, R5 |
| M6 | Variable target number pools | No | Threshold must be a literal; cannot count ones | R4 |
| M7 | Step dice with exploding dice | No | Die size must be a literal; no explode | R4 |
| M8 | Roll-and-keep with dynamic pools | No | Keep works on static dice only | R4 |
| M9 | Fudge/custom-face dice and cards | No | No custom faces; no decks | R6 (faces), R8 (cards) |
| M10 | Opposed rolls, attack vs. defense | No | No access to another character or roll | R7 |

Each row gets one original, license-neutral reference fixture (design Section
16.2). A row counts as supported when its fixture publishes, plays through the
scripted scenario in `tests/integration/scenarios/`, and passes the creator →
player → GM browser journey.

## Review findings covered

| # | Finding | Stage |
|---|---------|-------|
| F1 | `adv(d20)`/`dis(d20)` keep both dice and return their sum (`rules/parser.ts`, `parseAdvDis`) | R0 |
| F2 | One 256-node budget covers all computed fields and validations of a sheet, and publishing does not check it; a published system can fail every sheet with `budget_exceeded` (`runtime/resolve.ts`) | R0 |
| F3 | String literals parse only inside `group(...)`; text and choice fields cannot be compared with a value | R2 |
| F4 | No conditional and no boolean-to-number conversion | R2 |
| F5 | Character resources change one step at a time and their maximum is fixed after creation; design 6.3 promises direct input | R1 |
| F6 | Roll output substitutes only `{total}`; a boolean roll publishes and reports total 0 | R0 (reject), R5 |
| F7 | Definition IDs are unique across the whole document, so two templates cannot share a field ID | R3 |
| F8 | Reference data is authored but never read | R3 |
| F9 | No linter or formatter; dense one-line code in places | Not in this plan (owner decision 2026-11-10: this plan is rules work only) |
| F10 | ~~Tokenizer and evaluator are hand-ported into `web/src/ports`~~ Withdrawn 2026-11-10: the web already imports the server's rules modules through the `@sweetroll/rules` alias; `web/src/ports` only wraps them. No work needed. | — |
| F11 | Documentation drift (README on version upgrades, `grammar-v0.1.md` exclusions, design 6.4 on chained computed fields) | R0 |

## Decisions (owner-approved 2026-11-10)

| # | Question | Recommendation |
|---|----------|----------------|
| C1 | How are the new capabilities versioned? | They are not gated. Owner statement 2026-11-10: no system is published, so the engine may be rewritten. There is one current contract, document/package `2.0` with grammar `1.0`; the `1.0`/`1.1`/`1.2` literals, the `0.1`/`0.2` language switch and every legacy decode or evaluation path are removed. Reference fixtures, seeded templates, contract examples and tests are rewritten to the current contract, and test databases are recreated (design 12.4, 17.0). No converter and no compatibility tests. Published-version immutability and checksums apply from the first release tag onward. |
| C2 | Sheet evaluation budget | Add a separate `sheetEvaluationNodes` limit (recommended 8,192) to `effectiveLimits` for all computed fields, validations and aggregates of one sheet. The 256-node limit stays per expression. Publishing rejects a document whose worst-case sheet cost exceeds the limit. |
| C3 | Boolean roll expressions | Rejected at publish for every package version. A roll expression is a number; pass/fail is expressed with outcomes (R5). |
| C4 | Resource editing | Two new atomic server commands: `adjustResource { delta }` and `setResource { current?, max? }`, both revision-checked and idempotent, bounded by the field's `min`/`max`/`step`. No client read-modify-write (design 12.2). The sheet gets direct input and an "apply amount" control; offline queuing treats them like bumps. |
| C5 | Conditionals | `if(condition, a, b)`, both branches the same type, only the chosen branch is evaluated. Allowed in roll expressions; dice in the branch not taken are not rolled. No loops, assignment or user-defined functions. |
| C6 | Field ID scope | A field is identified by its owner path: `<entityId>.<fieldId>` or `<templateId>.<fieldId>`. Field, option, action-input and granted-action IDs need to be unique only inside their owner; two character types or two templates may both define `damage`. Formulas name the scope instead of sharing one namespace: `fields.<id>` is always the character, `item.<id>` is the entry a granted action or template formula belongs to, so nothing is shadowed. Validations and sheet bindings resolve IDs inside their entity. Stored state is unchanged: a value is already addressed by character, entry and field ID. Entity, template, slot, action, expression, dataset and sheet-element IDs stay document-unique. The merged `fields.` namespace of granted actions is removed. |
| C7 | Reading data | `lookup(dataset, key, column)` for exact keys and `lookupBand(dataset, number, column)` for "highest row at or below" tables (level, weight). Datasets declare a key column and typed columns. Choice fields may take their options from a dataset (`optionsFrom`), as design 6.2 already states. |
| C8 | Reading entries | Aggregates over one slot only: `sum(slot, field)`, `count(slot)`, `sumWhere(slot, field, flagField)`, `countWhere(slot, flagField)`, `maxOf(slot, field)`. Quantity multiplies when the template opts in. No traversal into a single entry and no nesting. |
| C9 | Dice model | Pools become first-class: a pool source (`dice`, custom dice), optional modifiers (`explode`, `rerollOnce`), then one reducer (sum, `keepHighest`, `keepLowest`, `countAtLeast`, `countAtMost`, `countEqual`). Count, sides, keep count and thresholds are integer expressions. `rolled("groupId")` reads an already rolled named group again. Explosions are capped (10 per die) and count toward the 100-dice limit. |
| C10 | Outcomes (owner decision 2026-11-10) | A roll action may carry ordered outcome bands (first match wins) and named detail values, each a non-dice expression that may read `roll.total` and `rolled(...)`. The result stores the outcome ID and label. The output template gains `{outcome}`, `{detail.<id>}`, `{fields.<id>}` and `{inputs.<id>}`. Rolls never change characters: players read the result and apply effects to sheets by hand. |
| C11 | Custom dice | A package may define up to 16 dice, each with up to 20 faces. A face has a numeric value, an optional label and optional symbol counts. `dice(n, "dieId")` rolls them; `countSymbol(pool, "symbol")` counts symbols. |
| C12 | Opposed rolls (owner decision 2026-11-10) | Campaign-only, with no extra privacy layer. (a) An action may declare a target of a given entity and read that character's fields through `target.<fieldId>`; the values it reads appear in the roll's bindings like the roller's own, to the roll's normal audience. (b) A response action rolls against a recorded roll the responder can see and reads `opposed.total`. No `targetable` marking, no hidden bindings, and no responses to rolls the responder cannot see. Standalone characters cannot use targeted actions. |
| C13 | Cards (owner decision 2026-11-10: included, kept simple) | A system may define up to 4 decks, each a dataset of at most 200 cards. A deck has one stored state: the remaining order, per campaign (shared by the table) or per standalone character. Two action kinds only: `draw` (1–10 cards) and `shuffle` (return all cards and reorder). A draw is recorded like a roll, with the same audiences, showing each card's label and columns. No hands, discard piles, peeking, dealing to other players, returning single cards, or use of drawn cards inside formulas. |

## Not included

Automatic application of roll consequences to state (owner decision 2026-11-10),
effect engines, private target values, card hands and discard piles, loops,
user-defined functions, executable extension points, linter/formatter tooling, cross-system references,
initiative/turn trackers, and map-aware rules (range, line of sight). Breaking
rules-version upgrades stay excluded (design Section 6.7).

## Current model (baseline facts)

- Grammar: `rules/tokenizer.ts`, `parser.ts`, `typecheck.ts`, `evaluate.ts`,
  `groups.ts`, `render.ts`; documents compile in `rules/compile-document.ts`.
  Language `0.2` is selected for document versions other than `1.0`; this
  switch and the three document versions are removed by C1.
- Document/package schemas: `package/schema/document.ts`, `expression.ts`,
  `package.ts`, `push-policy.ts`; limits in `package/limits.ts`; ID and reference
  checks in `package/structural.ts`; change classification in
  `package/compatibility.ts`.
- Runtime: `runtime.ts` (intents `initialize`, `observe`, `set`, `bump`, `action`,
  `push`), `runtime/resolve.ts` (computed fields and validations),
  `runtime/resolve-entries.ts` (granted actions), `runtime/state.ts` (bindings).
- Dice are drawn from an HMAC stream keyed by a server-generated execution ID
  (`runtime/deterministic-rng.ts`).
- Character commands: `setField`, `bumpResource`, `executeAction`, `pushRoll`
  and the entry commands (`src/characters/index.ts`).
- Extensions may contain templates with `roll` and `computed` expressions
  (`rules/compile-extension.ts`).

## Stages

Every stage follows the increment definition of done (design Section 17.1): red
tests first, unit and integration suites, `contracts:generate`, creator and sheet
UI, public API v1 parity, the row's fixture and scenario, and a design update in
the same PR.

### R0 — Defects inside the current design

1. `adv`/`dis` keep one die. Add parser, evaluator and render tests, and the same
   cases in the web port.
2. Add `sheetEvaluationNodes` (C2). Compute each entity's worst-case cost at
   compile time (computed fields + validations + granted-action observation) and
   return `limit_exceeded` with the entity path. `resolve.ts` uses the new limit.
3. Reject roll expressions whose result type is not `number` (C3).
4. Sheet: disable "increase" at the stored maximum, not the field cap
   (`CharacterSheet.tsx`).
5. Documentation: correct the README statement on version upgrades, mark
   `grammar-v0.1.md` as superseded for groups and pushes, and state in design 6.4
   that computed fields may depend on other computed fields without cycles.

Acceptance: a 60-computed-field document is either accepted and observable or
rejected at publish with a located diagnostic; never published and broken.

### R1 — Resource editing (M2)

1. Runtime intents `adjust { resourceId, delta }` and
   `setResource { resourceId, current?, max? }`; validation reuses
   `decodeRuntimeState`.
2. Character commands, idempotency receipts, activity kinds, audit, campaign
   feed and GM permissions mirror `bumpResource`.
3. Browser and `/api/v1` routes; OpenAPI regenerated.
4. Sheet: numeric input for current and maximum, "apply amount" control,
   keyboard and screen-reader labels; offline queue and conflict review.

Acceptance: 17 damage is one command; raising the maximum on level-up works
online, queued offline and through the public API.

### R2 — Contract consolidation and grammar core (M1, M2)

1. One contract (C1): document/package `2.0`, grammar `1.0`. Remove the version
   unions, the language switch, legacy group gating and the optional
   `templates`/`slots`/`entries` shapes kept for old rows. Rewrite the reference
   fixtures, seeded templates, `docs/contracts` examples and schemas, and replace
   `grammar-v0.1.md` and `capability-matrix-v0.1.md` with current documents.
2. String literals as values; text equality.
3. `if(c, a, b)` (C5); `%`; `floor`, `ceil`, `abs`; `min`/`max` with 2–8
   arguments.
4. Multi-choice fields bind as a set; `has(fields.x, "option")`. Null single
   choice compares unequal instead of failing the expression.
5. Resource parts: `fields.hp.current`, `fields.hp.max`.
6. `compatibility.ts`: same context and result type stays non-breaking.
7. (Withdrawn: the web already compiles and evaluates through the server's
   rules modules via `@sweetroll/rules`; see F10.)
8. Creator: expression help, autocomplete entries and diagnostics for the new
   forms.

Acceptance: "add proficiency bonus when proficient" and "bonus when class is X"
publish and evaluate; property tests cover type soundness and budgets.

### R3 — Data: lookups, entry aggregates, computed maximum (M2)

1. Scoped IDs (C6): per-owner uniqueness in `structural.ts`; the compiler looks
   fields up by owner instead of by bare ID; the `item.` scope for template
   formulas and granted actions; validation targets resolved inside their
   entity; creator pickers show `owner.field`. First task: confirm that the
   version comparison in `compatibility.ts` matches fields inside their owner.
   A granted action may read the character fields that every entity showing
   its slot defines with the same ID and type; with shared IDs this set is no
   longer empty for systems with more than one character type.
2. Datasets: key column, typed columns, publish-time type check; `lookup`,
   `lookupBand` (C7); `optionsFrom` on choice fields. A missing row is an
   arithmetic failure with the declared fallback.
3. Slot aggregates (C8). Type check: the field has one value type across all
   templates the slot accepts; templates without it contribute nothing.
   Aggregates are available to entity computed fields, validations and rolls,
   and count toward `sheetEvaluationNodes` at the slot's `maxEntries`.
4. Resource `maxExpressionId`: the stored maximum is replaced by a computed one;
   `setResource` then rejects `max`.
5. Extensions: templates may use shared field IDs; composition validation
   re-checks aggregate field types across base and extension templates.
6. Version-change dry run (design 6.7) covers datasets, aggregates and computed
   maxima.

Acceptance: fixture M2 derives armor defense from equipped items, carried weight
from quantities, and proficiency bonus and hit-point maximum from a level table.

### R4 — Dice pools (M5–M8)

1. AST: one pool node with source, modifiers and reducer (C9) replaces the
   `dice`, `keep` and `successCount` nodes. `4d6kh3`, `adv(d20)` and
   `countSuccesses(...)` remain as notation that parses to the pool node.
2. Expression-valued sides, keep counts and thresholds with runtime bounds.
3. `explode(pool)` / `explode(pool, n)`, `rerollOnce(pool, n)`.
4. `countAtLeast`, `countAtMost`, `countEqual`; `rolled("groupId")`.
5. One breakdown graph format for every roll (no ungrouped legacy shape): explosion chains, rerolled dice and reuse are
   recorded per die; history, export and activity render them as text.
6. Push policies name which pool shapes they accept; exploded dice are not
   pushable unless the policy says so.
7. Creator pool builder for the common shapes; free-form editor remains.

Acceptance: fixtures M5 (d100 with doubles read through `rolled`), M6 (successes
at a chosen difficulty minus ones), M7 (trait die chosen from a field, exploding,
best of trait and wild die) and M8 (roll N keep K, exploding tens). Statistical
tests check face distributions and the explosion cap.

### R5 — Outcomes and richer results (M3, M5)

1. Action `outcomes` and `details` (C10); expression context `outcome`.
2. Result, receipt, persistent roll, grouped history and export carry
   `outcome { id, label }` and detail values; audience rules are unchanged.
3. Output template placeholders, validated at publish.
4. Sheet, GM session board, activity and paired display show the outcome label.
5. Pushed rolls re-evaluate outcomes on the child roll.

Acceptance: fixture M3 reports miss / weak hit / strong hit; fixture M5 reports
fumble, failure, success and critical with a success-level detail.

### R6 — Custom dice (M9, first half)

1. Package `dice` definitions, limits and structural checks (C11).
2. Pool source by die ID; `countSymbol`; breakdown records face label and
   symbols.
3. Creator die editor; sheet renders face labels as text with an accessible
   name.

Acceptance: a four-die fudge roll (faces −1, 0, +1) and a symbol-dice fixture
with net successes.

### R7 — Opposed and targeted rolls (M10)

1. Actions gain `target { entityId }`; scope `target.<fieldId>` is type-checked
   against that entity's fields (C12).
2. Command carries `targetCharacterId`; the server checks same campaign, same
   composition and current membership, reads the target under lock order
   campaign → characters, and records the target identifier and the values read
   in the roll's bindings.
3. Response actions: `respondsTo` a recorded roll the responder can see, with
   one response per responder, reusing push lineage storage; scope
   `opposed.total`.
4. Authorization tests for design Section 9.1: non-member, former member,
   archived target, and a roll the responder cannot see.
5. Design Section 14.1 states that a targeted roll shows the target values it
   read to the roll's audience.

Acceptance: fixture M10 runs an attack against a defender's defense and a
contested roll between two players.

### R8 — Cards (M9, second half; C13)

1. Deck definitions over datasets with the C13 limits; one deck-state table
   keyed by deck and campaign or standalone character; schema baseline updated.
2. Actions `draw { count }` and `shuffle`; order derived from the roll secret
   and a per-deck shuffle ID; both are idempotent, online-only commands that
   lock the deck state. An empty deck returns a readable error.
3. Draw results reuse roll storage, audiences, activity and the GM board.
4. Sheet and creator: draw and shuffle buttons, remaining-card count, a simple
   deck editor on top of the dataset editor.

Acceptance: a shared campaign deck never deals the same card twice between
shuffles under concurrent draws; a standalone character has its own deck.

## Order and dependencies

R0 → R1 and R2 in parallel → R3 → R4 → R5 → R6 → R7 → R8. R5 can start after R2
if outcome expressions do not yet read `rolled`. Until the extension upgrade
stage (E5) lands, compositions with extensions keep their current restrictions.

## Risks

| Risk | Mitigation |
|------|------------|
| Budget and denial-of-service surface grows with aggregates, explosions and lookups | Every new form has a compile-time cost and a runtime cap; property tests assert the caps; `sheetEvaluationNodes` is checked at publish |
| A rewrite loses behaviour the current tests protect | Rewrite contract by contract inside the stages, keeping the existing unit, property and integration suites green after porting them to the new contract; the Year Zero fixture (M4) is the regression row for groups and pushes |
| A targeted roll shows another character's values | Accepted by the owner (C12); limited to campaign members and to the fields the system author's formula reads; stated in design 14.1 |
| Contract size makes the creator harder to use | Builders for common shapes per stage; progressive disclosure per the GUI plan; free-form editor stays optional |
| Scope | Eight design-changing stages; each is separately approved, shippable and reversible before the first release tag |

## Implementation record

**R0 — 2026-11-10, implemented.**

- `adv`/`dis` keep one die (`rules/parser.ts`); parser and evaluator tests. The
  web port has a tokenizer and a dice-free evaluator only, so it needed no change.
- `sheetEvaluationNodes` (8,192) in `package/limits.ts`, the effective-limits
  schema and ceilings, both compilers and the fixtures. `compileDocument` rejects
  an entity whose computed fields and owned validations exceed it;
  `runtime/resolve.ts` enforces the same limit. Contract schemas and examples
  regenerated.
- `compileExpression` rejects roll expressions that do not produce a number, for
  documents and extensions.
- Sheet increase button stops at the stored maximum (`CharacterSheet.tsx`).
- README, `grammar-v0.1.md` and design 6.4 corrected.
- Verified locally: root typecheck, unit suite (561 tests) and integration suite
  (438 tests, PostgreSQL 16), `contracts:check`, web typecheck and web unit suite
  (1,294 tests). Not run locally: browser end-to-end suites; CI runs them, on
  PostgreSQL 17.

**R1 — 2026-11-10, implemented.**

- Runtime intents `adjust` and `setResource` (`src/systems/runtime.ts`).
  `adjust` clamps to the resource's minimum and the stored maximum and requires
  a non-zero multiple of the step; `setResource` validates through
  `decodeRuntimeState` and lowers the current value with a lowered maximum.
- Character commands `adjustResource` and `setResource` with their receipts
  and activity kinds; browser routes `…/resources/:id/adjust` and `…/set`;
  `/api/v1` `POST …/adjust` and `PUT …/resources/:id`; contracts regenerated.
- Web: queue intents with sequential estimates (pending maximum under
  `<resourceId>.max`), sheet amount and direct-input controls, conflict review
  labels, activity labels.
- Tests: runtime unit tests, `scenarios/resources.test.ts`, sheet and session
  tests.
- Not done in R1: amount/direct-input controls on the GM session board (it
  keeps one-tap steps; the GM can open the sheet), and corrections of these two
  intents in conflict review (they can be reapplied or discarded, not edited).

**R2 — implemented.**

- System and extension documents/packages use schema version 2.0 and compiled
  expressions use grammar 1.0. Template, slot, and character entry collections
  are explicit. Generated contracts and reference fixtures use the current shape.
- Shared grammar supports typed conditionals, quoted text, choice membership,
  resource parts, remainder, rounding helpers, and two to eight operands in
  min/max. Creator help and suggestions use the same parser as publishing.
- The conditional d20 scenario exercises publication, proficiency and class
  bonuses, choice sets, and resource bindings through the public API.
- Compatibility classification still uses expression context and result type.

**R3 — implemented.**

- Scoped field, option, input, and granted-action IDs. Version comparison already
  compares fields inside their owner, and regression tests cover shared IDs.
- Typed datasets, exact and banded lookup, dataset choice options, and bounded
  slot aggregates. Extension composition rechecks aggregate field types.
- Computed resource maxima follow the character's current rules. Version dry
  runs use target-version table data and normalize the maximum.
- Roadwardens is the M2 fixture with an API scenario and a browser journey for
  the creator, player sheet, and GM session.

**R4 — implemented.**

- All dice syntax compiles to a pool with deterministic, integer-valued parameters.
  Rerolls run before explosions. Keep and count reducers operate on whole chains.
- A named pool can supply its original total or its saved dice to a later reducer.
  All rolls carry a breakdown graph. Activity preserves the graph and campaign
  export includes the graph and plain-text details.
- Modified push groups require explicit policy opt-in. Pushes redraw eligible
  chains and replay retained draws from the saved roll.
- The creator builder supports dynamic sides, keep counts and thresholds, rerolls
  and explosions. Try it accepts sample values for numeric fields used by a pool.
  The free-form editor supports reuse and compound formulas.
- Glass Observatory, Midnight Dispatch, Far Beacon and Lantern Court cover M5–M8
  in PostgreSQL API scenarios and creator/player/GM browser journeys. The M5
  fixture uses a numeric doubles result. Outcome bands are scheduled in R5.

R5–R8 remain in plan order.
