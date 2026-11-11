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
| `dice(count, sides)` | Dynamic dice pool; count is an integer expression and sides is a literal |
| `group("pool", "Pool", dice)` | Give a dice term a stable identity and display label |
| `countSuccesses(dice, threshold)` | Number of dice at or above the threshold |

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
| Dice | 100 dice, 1,000 sides |
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

## Exclusions

Configurable pushes reroll eligible dice from a recorded named pool under its action policy.
Exploding dice, custom faces, arbitrary property traversal, effects, loops, assignment, and user-defined functions are outside
this grammar. See the [rules coverage plan](../superpowers/plans/2026-11-10-rules-coverage.md).
