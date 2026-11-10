# Sweetroll rules coverage: fixes and wider system support

**Implementation plan · 10 November 2026 · Owner-requested 2026-11-10 · Decisions C1–C14 await owner confirmation**

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

Stage R0 stays inside the current design and needs no further approval. Stages
R1–R8 change the design; each starts only after its decisions below are confirmed.

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
| F9 | No linter or formatter; dense one-line code in places | R0 |
| F10 | Tokenizer and evaluator are hand-ported into `web/src/ports` | R2 |
| F11 | Documentation drift (README on version upgrades, `grammar-v0.1.md` exclusions, design 6.4 on chained computed fields) | R0 |

## Decisions (recommendations; owner confirmation needed)

| # | Question | Recommendation |
|---|----------|----------------|
| C1 | How are the new capabilities versioned? | Package/document `1.3` and grammar `0.3`. A document uses the new forms only when it declares `1.3`. Packages `1.0`–`1.2` keep their checksums, RNG order and results. No converter: authors change the declared version in the creator. |
| C2 | Sheet evaluation budget | Add a separate `sheetEvaluationNodes` limit (recommended 8,192) to `effectiveLimits` for all computed fields, validations and aggregates of one sheet. The 256-node limit stays per expression. Publishing rejects a document whose worst-case sheet cost exceeds the limit. |
| C3 | Boolean roll expressions | Rejected at publish for every package version. A roll expression is a number; pass/fail is expressed with outcomes (R5). |
| C4 | Resource editing | Two new atomic server commands: `adjustResource { delta }` and `setResource { current?, max? }`, both revision-checked and idempotent, bounded by the field's `min`/`max`/`step`. No client read-modify-write (design 12.2). The sheet gets direct input and an "apply amount" control; offline queuing treats them like bumps. |
| C5 | Conditionals | `if(condition, a, b)`, both branches the same type, only the chosen branch is evaluated. Allowed in roll expressions; dice in the branch not taken are not rolled. No loops, assignment or user-defined functions. |
| C6 | Field ID scope | From `1.3`, field, option and granted-action IDs are unique per owner (entity or template) instead of per document. Entity, template, slot, action, expression, dataset and sheet-element IDs stay document-unique. |
| C7 | Reading data | `lookup(dataset, key, column)` for exact keys and `lookupBand(dataset, number, column)` for "highest row at or below" tables (level, weight). Datasets declare a key column and typed columns. Choice fields may take their options from a dataset (`optionsFrom`), as design 6.2 already states. |
| C8 | Reading entries | Aggregates over one slot only: `sum(slot, field)`, `count(slot)`, `sumWhere(slot, field, flagField)`, `countWhere(slot, flagField)`, `maxOf(slot, field)`. Quantity multiplies when the template opts in. No traversal into a single entry and no nesting. |
| C9 | Dice model | Pools become first-class: a pool source (`dice`, custom dice), optional modifiers (`explode`, `rerollOnce`), then one reducer (sum, `keepHighest`, `keepLowest`, `countAtLeast`, `countAtMost`, `countEqual`). Count, sides, keep count and thresholds are integer expressions. `rolled("groupId")` reads an already rolled named group again. Explosions are capped (10 per die) and count toward the 100-dice limit. |
| C10 | Outcomes | A roll action may carry ordered outcome bands (first match wins) and named detail values, each a non-dice expression that may read `roll.total` and `rolled(...)`. The result stores the outcome ID and label. The output template gains `{outcome}`, `{detail.<id>}`, `{fields.<id>}` and `{inputs.<id>}`. Rolls stay factual: nothing is applied to state. |
| C11 | Custom dice | A package may define up to 16 dice, each with up to 20 faces. A face has a numeric value, an optional label and optional symbol counts. `dice(n, "dieId")` rolls them; `countSymbol(pool, "symbol")` counts symbols. |
| C12 | Opposed rolls | Campaign-only. (a) An action may declare a target of a given entity and read fields that entity marks `targetable`. (b) A response action rolls against a recorded roll and reads `opposed.total`. Target values are disclosed to the roller only through the outcome, never in the bindings shown to them. Standalone characters cannot use targeted actions. |
| C13 | Cards | Last stage, largest change: a deck is a dataset plus stored deck state on a campaign (shared) or standalone character. `draw` and `shuffle` are new action kinds with server-side deterministic order. Recommended only after R1–R7 are accepted; may be dropped without affecting the other rows. |
| C14 | Tooling | Add one formatter/linter dev dependency (recommended Biome) with a CI check, applied file by file as files are touched; no repository-wide reformat commit. |

## Not included

Automatic application of roll consequences to state, effect engines, loops,
user-defined functions, executable extension points, cross-system references,
initiative/turn trackers, and map-aware rules (range, line of sight). Breaking
rules-version upgrades stay excluded (design Section 6.7).

## Current model (baseline facts)

- Grammar: `rules/tokenizer.ts`, `parser.ts`, `typecheck.ts`, `evaluate.ts`,
  `groups.ts`, `render.ts`; documents compile in `rules/compile-document.ts`.
  Language `0.2` is selected for document versions other than `1.0`.
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
   Packages published earlier read the limit from their stored `effectiveLimits`,
   so their behaviour is unchanged.
3. Reject roll expressions whose result type is not `number` (C3).
4. Sheet: disable "increase" at the stored maximum, not the field cap
   (`CharacterSheet.tsx`).
5. Documentation: correct the README statement on version upgrades, mark
   `grammar-v0.1.md` as superseded for groups and pushes, and state in design 6.4
   that computed fields may depend on other computed fields without cycles.
6. Tooling per C14.

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

### R2 — Grammar 0.3 core (M1, M2)

1. Package/document `1.3`, language `0.3` gating (C1).
2. String literals as values; text equality.
3. `if(c, a, b)` (C5); `%`; `floor`, `ceil`, `abs`; `min`/`max` with 2–8
   arguments.
4. Multi-choice fields bind as a set; `has(fields.x, "option")`. Null single
   choice compares unequal instead of failing the expression.
5. Resource parts: `fields.hp.current`, `fields.hp.max`.
6. `compatibility.ts`: same context and result type stays non-breaking.
7. Replace `web/src/ports` with the server's rules modules through one shared
   source path (they have no Node-only imports), so creator diagnostics and
   preview cannot drift (F10).
8. Creator: expression help, autocomplete entries and diagnostics for the new
   forms.

Acceptance: "add proficiency bonus when proficient" and "bonus when class is X"
publish and evaluate; property tests cover type soundness and budgets.

### R3 — Data: lookups, entry aggregates, computed maximum (M2)

1. Scoped IDs (C6) in `structural.ts`, compile environments and the creator.
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

1. AST: pool node with source, modifiers and reducer (C9); legacy `dice`, `keep`
   and `successCount` nodes stay decodable and evaluate as before.
2. Expression-valued sides, keep counts and thresholds with runtime bounds.
3. `explode(pool)` / `explode(pool, n)`, `rerollOnce(pool, n)`.
4. `countAtLeast`, `countAtMost`, `countEqual`; `rolled("groupId")`.
5. Breakdown graph version `1.1`: explosion chains, rerolled dice and reuse are
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

1. Entity fields gain `targetable`; actions gain `target { entityId }`; scope
   `target.<fieldId>` type-checked against targetable fields only (C12).
2. Command carries `targetCharacterId`; the server checks same campaign, same
   composition and current membership, reads the target under lock order
   campaign → characters, and records the target identifier.
3. Disclosure: target bindings are stored but shown only to GM audiences.
4. Response actions: `respondsTo` a recorded roll with one-response uniqueness,
   reusing push lineage storage; scope `opposed.total`.
5. Authorization tests for design Section 9.1: non-member, former member,
   archived target, private roll.

Acceptance: fixture M10 runs attack against a defender's targetable defense and
a contested roll between two players, with privacy verified for both.

### R8 — Cards (M9, second half; C13)

1. Deck definitions over datasets; deck state table keyed by campaign or
   standalone character; schema baseline updated.
2. Actions `draw { count }`, `shuffle`, optional `discard`; order derived from
   the roll secret and a per-deck shuffle ID; draws are idempotent commands.
3. Hand visibility follows roll audiences; GM can see and reset decks.
4. Offline: draws are online-only, like pushes.

Acceptance: a shared campaign deck never deals the same card twice between
shuffles under concurrent draws.

## Order and dependencies

R0 → R1 and R2 in parallel → R3 → R4 → R5 → R6 → R7 → R8. R5 can start after R2
if outcome expressions do not yet read `rolled`. Until the extension upgrade
stage (E5) lands, compositions with extensions keep their current restrictions.

## Risks

| Risk | Mitigation |
|------|------------|
| Budget and denial-of-service surface grows with aggregates, explosions and lookups | Every new form has a compile-time cost and a runtime cap; property tests assert the caps; `sheetEvaluationNodes` is checked at publish |
| Reproducibility of old rolls | New forms exist only in `0.3`; legacy AST nodes keep their evaluation path and RNG order; golden-result tests for the three existing fixtures |
| Target reads leak private sheet values | Only fields marked `targetable`; roller sees the outcome only; dedicated authorization tests |
| Contract size makes the creator harder to use | Builders for common shapes per stage; progressive disclosure per the GUI plan; free-form editor stays optional |
| Scope | Eight design-changing stages; each is separately approved, shippable and reversible before the first release tag |

## Implementation record

Nothing implemented yet.
