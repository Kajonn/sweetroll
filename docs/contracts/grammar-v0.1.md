# Expression Grammar v0.1

## Values And References

Literals are finite numbers, booleans, and bounded strings. References are only `fields.<id>` and `inputs.<id>`.

## Operators

| Precedence | Forms |
|------------|-------|
| 1 | parentheses |
| 2 | `-`, `!` |
| 3 | `*`, `/` |
| 4 | `+`, `-` |
| 5 | `<`, `<=`, `>`, `>=` |
| 6 | `==`, `!=` |
| 7 | `&&` |
| 8 | `||` |

## Functions And Dice

| Form | Result |
|------|--------|
| `min(number, number)` | Smaller number |
| `max(number, number)` | Larger number |
| `round(number, mode?)` | Rounded number; mode is `nearest`, `down`, or `up` |
| `d20`, `2d6` | Static dice result |
| `4d6kh3`, `4d6kl1` | Keep highest/lowest dice result |
| `dice(count, sides)` | Dynamic dice pool; count is an integer expression and sides is a literal |
| `countSuccesses(dice, threshold)` | Number of dice at or above the threshold |

Examples: `d20 + fields.modifier`, `2d6 + fields.stat`, `4d6kh3`, and `countSuccesses(dice(fields.attribute + fields.skill, 6), 6)`.

## Types, Fallbacks, And Limits

Arithmetic and ordering require numbers. Equality operands have the same scalar type. Boolean composition requires booleans. Every expression declares a result type and same-typed fallback. Safe arithmetic failures return the fallback and a diagnostic; parse, type, reference, and budget failures reject compilation.

| Limit | Ceiling |
|-------|---------|
| Encoded input | 1 MiB |
| Expression source | 1,024 UTF-8 bytes |
| AST | 256 nodes, depth 32 |
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

## Exclusions

Rerolls, exploding dice, pushes, custom faces, failure cancellation, property traversal, collections, effects, loops, assignment, and user-defined functions are not part of v0.1.
