# Expression grammar 1.0

System and extension documents and packages use schema version `2.0`. Each compiled expression declares `languageVersion: "1.0"`.

## Values And References

Literals are finite numbers, booleans, and double-quoted strings with JSON
escaping. References use `fields.<id>` and `inputs.<id>`. A resource field
also exposes `fields.<id>.current` and `fields.<id>.max`. Its bare reference
continues to mean current value. Single choices compare against quoted option
IDs. An unset choice compares unequal to a quoted option ID. Multi-choice
values are sets of selected IDs and can be read with `has`.

## Operators

| Precedence | Forms |
|------------|-------|
| 1 | parentheses |
| 2 | `-`, `!` |
| 3 | `*`, `/`, `%` |
| 4 | `+`, `-` |
| 5 | `<`, `<=`, `>`, `>=` |
| 6 | `==`, `!=` |
| 7 | `&&` |
| 8 | `||` |

## Functions And Dice

| Form | Result |
|------|--------|
| `min(a, b, …)`, `max(a, b, …)` | Minimum or maximum of two to eight numbers |
| `floor(value)`, `ceil(value)`, `abs(value)` | Round down, round up, or take the absolute value |
| `if(condition, a, b)` | Evaluate one branch. The condition is boolean and both branches must have the same scalar type. |
| `has(fields.skills, "climb")` | Whether a multi-choice field contains the quoted option ID |
| `round(number, mode?)` | Rounded number; mode is `nearest`, `down`, or `up` |
| `d20`, `2d6` | Static dice result |
| `4d6kh3`, `4d6kl1` | Keep highest/lowest dice result |
| `adv(d20)`, `dis(d20)` | Roll two dice and keep the higher/lower one |
| `dice(count, sides)` | Roll and sum a pool with expression-valued count and sides |
| `dice(count, "die_id")` | Roll and sum a custom die defined in the system package |
| `countSymbol(pool, "symbol")` | Sum the named symbol’s multiplicities across faces in the pool |
| `group("pool", "Pool", dice)` | Give a dice term a stable identity and display label |
| `keepHighest(pool, count)`, `keepLowest(pool, count)` | Sum the highest or lowest dice after applying modifiers |
| `countAtLeast(pool, threshold)`, `countAtMost(pool, threshold)`, `countEqual(pool, threshold)` | Count dice at or above, at or below, or equal to the threshold. `countSuccesses` is an alias for `countAtLeast`. |
| `rerollOnce(pool, face)` | Replace each starting die showing that face once |
| `explode(pool, face?)` | Draw again on the chosen face, which defaults to the highest face |
| `rolled("pool")` | Read an earlier named pool total or pass its saved dice to a reducer |

`d20 + if(fields.proficient, 2, 0)` adds a proficiency bonus.
`if(fields.class == "fighter", 3, 0)` uses a choice to select a bonus.
`if(fields.health.current > 0, d20, 0)` consumes no dice at zero health.
Both branches count toward the static AST budget. Division and remainder by zero
produce an arithmetic diagnostic.

## Types, Fallbacks, And Limits

Arithmetic and ordering require numbers. Equality operands have the same scalar type. Boolean composition requires booleans. Every expression declares a result type and same-typed fallback. A roll expression must produce a number. Safe arithmetic failures return the fallback and a diagnostic; parse, type, reference, and budget failures reject compilation.

| Limit | Ceiling |
|-------|---------|
| Encoded input | 1 MiB |
| Expression source | 1,024 UTF-8 bytes |
| AST | 256 nodes, depth 32 |
| All computed fields and validations of one sheet | 8,192 nodes, checked when the system is published |
| Dice | 100 draws per roll, 1,000 sides per standard die |
| Custom dice | 16 definitions, 1–20 faces per die, 16 symbol IDs per face with counts 1–100 |
| Entities | 32 |
| Total fields | 512 |
| Reference datasets | 64 |
| Records per dataset | 1,000 |
| Values per record | 64 |
| Sheets | 32 |
| Sections per sheet | 64 |
| Total sheet elements | 1,024 |
| Actions | 256 |
| Validations | 256 |
| Expressions | 1,024 |

## Tables and slots

Use quoted definition IDs in data functions. `lookup("levels", fields.level,
"bonus")` matches the key exactly. `lookupBand("levels", fields.level, "bonus")`
selects the highest numeric key at or below the supplied level. Missing keys
produce an arithmetic diagnostic. Computed values then use their declared
fallback.

| Form | Result |
| --- | --- |
| `sum("equipment", "weight")` | Sum a stored numeric field |
| `count("equipment")` | Count entries |
| `sumWhere("equipment", "armor", "equipped")` | Sum values for entries with a true boolean flag |
| `countWhere("equipment", "equipped")` | Count entries with a true boolean flag |
| `maxOf("equipment", "armor")` | Largest individual value, or zero for an empty set |

Entries missing a requested field make no contribution. Sums and counts use
quantity when the template sets `aggregateQuantity`. Each call scans one
slot, and its declared capacity is charged to the sheet evaluation budget.
`fields.<id>` resolves character fields and `item.<id>` resolves the entry
for a granted roll or template formula. Both scopes support resource parts.

## Pool evaluation and saved rolls

A pool has a source, up to one reroll and one explosion modifier, and one
reducer. Apply rerolls before explosions, for example
`keepHighest(explode(rerollOnce(dice(fields.pool_size, 10), 1)), fields.keep_count)`.
Count, numeric sides, standard-die modifier faces, keep count, and thresholds are integer expressions.
Named pool parameters can read earlier groups through `rolled` and cannot draw
new dice. An unnamed pool can use another roll as a parameter, as in
`dice(d6, 6)`. A zero-die pool and a keep count of zero are valid.
Keep compares each complete explosion chain and preserves draw order for ties.
Success reducers compare the chain totals. A die can explode up to ten times.
Every physical draw, including discarded and replacement faces, uses the
same per-roll draw budget.

`countAtLeast(group("check", "Check", dice(3, 10)), inputs.difficulty) - countEqual(rolled("check"), 1)`
reads the same three dice twice. The group must have executed on every path
that reaches the reuse. An unused conditional branch draws no dice.

Every saved roll carries a breakdown graph. Groups list their starting count,
resolved sides, reducer, and draw IDs. Draws link to the face they replace or
extend. A reuse term points to the original group. Character activity and the
campaign export preserve the graph. Campaign exports also include readable
breakdown text.

Configurable pushes keep their additive sum/count and literal-scaling rules.
A listed group with modifiers is eligible only when its policy lists those
modifiers. An eligible starting die redraws its entire chain. Unlisted groups
and locked chains reuse the original draws.

## Custom dice

The system document and compiled package may include a top-level `dice`
array. Each definition has an `id`, `label` and a `faces` array. Every face
has a finite numeric `value`, an optional text `label` and an optional
`symbols` object of symbol IDs and positive counts. Face entries are
equiprobable. Repeating a face gives it proportionally more chances to appear.

```json
{
  "id": "signal_die",
  "label": "Signal die",
  "faces": [
    { "value": 0, "label": "Spark", "symbols": { "hit": 2 } },
    { "value": 0, "label": "Haze", "symbols": { "snag": 1 } },
    { "value": 0, "label": "Still" }
  ]
}
```

`dice(4, "fudge")` sums four values from the defined die. A named custom
pool supports reuse and any pool reducer. Use
`countSymbol(group("signal", "Signal", dice(4, "signal_die")), "hit") - countSymbol(rolled("signal"), "snag")`
to count two symbols from the same draws. An absent symbol contributes zero.
Counting uses the final faces in each chain, excluding replaced starting faces.
A custom die modifier matches the face’s numeric value. A custom explosion
with no explicit face triggers on the highest numeric value. Saved rolls
include each drawn face’s `faceLabel` and `symbols` when defined, plus the
custom die ID in its group. Configurable push policies apply to standard dice.

## Roll outcomes and output text

A roll action may list ordered `outcomes` (at most 16) and `details` (at most
8). Each entry has an ID, a label and an `outcome` expression. Outcome
expressions run after the roll, with the action's fields, inputs and item
values plus `roll.total`. They may read the roll's named groups with
`rolled("group")` but cannot draw dice. A band's condition is a boolean; the
first true band becomes the roll's `outcome`. A detail is a number, such as a
margin or success level. A failed outcome expression uses its fallback. Each
outcome expression belongs to exactly one band or detail.

```text
outcomes: strong_hit  roll.total >= 10
          weak_hit    roll.total >= 7
          miss        true
details:  levels      floor(fields.skill / 10) - floor(roll.total / 10)
```

The output template accepts `{total}`, `{outcome}`, `{detail.<id>}`,
`{fields.<id>}`, `{inputs.<id>}` and, for granted actions, `{item.<id>}`.
Publishing rejects any other placeholder, a `{detail.<id>}` the action does
not define and `{outcome}` on an action without outcomes. When an action has
outcomes and its template omits `{outcome}`, the label is appended to the
output as ` — <label>`. A pushed roll is described again from its new total.
Values an outcome reads that the roll formula did not are saved with the
roll's bindings. Rolls never change characters. Extensions cannot define
outcomes yet.

## Campaign roll references

A roll action can declare `target: { entityId: "character" }`. Its roll and
outcome expressions can use fields on that entity through `target.<fieldId>`,
including resource parts such as `target.health.current`. The roll command
supplies `targetCharacterId`. For example, `d20 - target.defense` reports an
attack margin.

A roll action declared with `respondsTo: true` can use `opposed.total` in its
roll and outcome expressions. The command supplies `respondsTo` with the ID
of a saved campaign roll. For example, `d20 - opposed.total` compares a new
roll with the stored total. Both scopes record the values actually read.

## Exclusions

Arbitrary property traversal, effects, loops, assignment, and
user-defined functions are outside this grammar. See the
[rules coverage plan](../superpowers/plans/2026-11-10-rules-coverage.md).
