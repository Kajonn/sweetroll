# System Expression Engine v0.1 - Design

**Status:** Draft for review

## 1. Purpose

Implement I1 Task 5 of `design_v2.md`: the math-and-dice **tokenizer, parser, typed AST, type checker, dependency validation, deterministic evaluator, normalized roll output, and hard depth/node budgets** for the grammar defined in the System Package Contract and Grammar v0.1 increment.

This increment compiles the bounded source expression strings contained in a `SystemDocumentV1` into the already-defined `CompiledExpressionV1` values embedded in a `SystemPackageV1`, and deterministically evaluates those compiled expressions against a plain id-to-value binding map.

It does not implement the SystemRuntime Module, system persistence, authoring workflows, or HTTP routes. Those remain future increments.

## 2. Scope

**In scope:**

- A tokenizer that turns an expression source string into a token stream.
- A parser that produces the exact `ExpressionAstV1` node shapes already defined in `src/systems/implementation/package/schema/expression.ts`.
- A type checker that infers result types per the grammar typing rules and verifies them against declared result/fallback types.
- `compileExpression(source, env)` producing one `CompiledExpressionV1`.
- `compileDocument(document)` producing a full `SystemPackageV1` from a `SystemDocumentV1`.
- `evaluate(compiled, bindings, rng?)` returning a scalar value or a roll result, deterministically for a given rng sequence.
- `renderExpression(ast)` producing canonical source text.
- Reuse of the existing `PackageDiagnostic` / `DecodeResult<T>` shape for failure reporting.
- A test-only seeded RNG and property tests over evaluated expressions.

**Out of scope:**

- The SystemRuntime Module (`SystemRuntime.resolve`), render projections, character state, and resource semantics.
- System persistence, authoring workflows, HTTP routes, or OpenAPI generation.
- Semantic package assessment, compatibility comparison, and semantic-version policy.
- Rerolls, exploding dice, push mechanics, custom faces, failure cancellation, arbitrary keep predicates, property traversal beyond `fields.<id>` and `inputs.<id>`, collections, effects, loops, assignment, and user-defined functions (all excluded by grammar v0.1).
- Wall-clock/time budgets for compile or evaluate (deferred to the runtime/HTTP layer where per-request time limits belong). Node and depth budgets are already enforced structurally by the package codec.
- String concatenation, aggregate functions, and ternary.

## 3. Architecture

The expression engine lives under `src/systems/implementation/rules/`, matching the directory named in `design_v2.md`. It is private to the systems implementation: the package-level barrel `src/systems/implementation/package/index.ts` already exports the contract schemas, and the rules barrel `src/systems/implementation/rules/index.ts` exports only the workflow functions the later runtime and authoring code consume. It does not export `Tokenizer`, `Parser`, `TypeChecker`, `Evaluator`, or their intermediate types.

The engine consumes the TypeScript types already defined by the v0.1 contract:

- `ExpressionAstV1` (node shapes) — `package/schema/expression.ts`
- `CompiledExpressionV1` — `package/schema/expression.ts`
- `SystemDocumentV1`, `SourceExpressionV1` — `package/schema/document.ts`
- `SystemPackageV1`, `UnsignedSystemPackageV1` — `package/schema/package.ts`
- `ScalarValue`, `ValueType`, `DefinitionId` — `package/schema/common.ts`
- `PACKAGE_LIMITS` — `package/limits.ts`

The compile pipeline is: `source -> tokenize -> parse -> typecheck -> resolveDependencies -> cost -> CompiledExpressionV1`.

The document compile pipeline walks every source expression in the document, gathers field and action-input type context, compiles each expression, and assembles an `UnsignedSystemPackageV1` which the existing `signSystemPackage` turns into a signed `SystemPackageV1`.

## 4. Data Flow

```text
SystemDocumentV1 (source expressions)
        |
        v
   field/input type context            expression source strings
        |                                      |
        +----------------+---------------------+
                         v
              compileDocument / compileExpression
                         |
                         v
        CompiledExpressionV1 (typed AST, deps, cost)
                         |
                         v
       evaluate(compiled, bindings, rng?) -> scalar or roll
```

## 5. Package Barrel

`src/systems/implementation/rules/index.ts` exports exactly:

- `compileExpression(source: string, opts: { env: ExpressionCompileEnv; resultType: ValueType; context: "computed" | "roll" | "validation"; fallback: ScalarValue }): CompileResult<CompiledExpressionV1>`
- `compileDocument(document: SystemDocumentV1): CompileResult<SystemPackageV1>`
- `evaluate(compiled: CompiledExpressionV1, bindings: Record<string, ScalarValue>, rng?: Rng): EvalResult`
- `renderExpression(ast: ExpressionAstV1): string`

It does not export the tokenizer, parser, type checker, or evaluator classes, nor their intermediate types.

## 6. Compile Env

`compileExpression` needs to know the declared type of each referenced id to type-check references. The environment maps a definition id to its value type.

```typescript
type ExpressionCompileEnv = {
  fields: Record<string, ValueType>;
  inputs: Record<string, ValueType>;
};
```

- `compileExpression` accepts `env` for the caller-supplied context.
- `compileDocument` builds `env` from the document: every field definition contributes its value type under `fields`, and every action input contributes its value type under `inputs`.

Reference ids that are not present in the corresponding map are compile-time `missing_reference` errors.

## 7. Tokenizer

The tokenizer reads an expression source string and produces an ordered token list. It rejects malformed input with a tokenizer diagnostic (`invalid_syntax`).

Token kinds:

- `number` — finite integer or decimal literal (`10`, `3.5`, `0.25`). Leading `+`/`-` is handled by the parser as unary, not by the tokenizer. Negative literal handling is specified in the parser. Reject `NaN`, `Infinity`, and empty.
- `id` — a definition reference identifier `fields.<id>` or `inputs.<id>` (the dot form is tokenized as the whole `fields.<id>` identifier so unknown scopes are rejected at parse time).
- `function` — `min`, `max`, `round`, `dice`, `countSuccesses`.
- `diceNotation` — a static dice notation literal: `d<N>`, `<N>d<N>`, `<N>d<N>kh<K>`, `<N>d<N>kl<K>` where counts and sides are positive integers.
- `identifier` — a bare word that is not a known function or static dice notation. Used by `adv`/`dis` handling only if required; otherwise treated as an error.
- `operator` — one of `+ - * / < <= > >= == != && || ! -` (unary minus and `!` handled by the parser using the same token).
- `paren` — `(`, `)`.
- `comma` — `,`.
- `end` — end of input.

Whitespace is insignificant and skipped. Tokenizer errors are reported as `invalid_syntax`.

### 7.1 Static dice notation

- `d20` → dice node count=1, sides=20.
- `2d6` → dice node count=2, sides=6.
- `4d6kh3` → keep(highest, count=3, dice(dice(4,6))).
- `4d6kl1` → keep(lowest, count=1, dice(dice(4,6))).

This matches the AST shapes already present in the three fixture packages. `adv(d20)` and `dis(d20)` are typed sugar in the grammar (§6.2 of the contract spec); they expand to `keep(highest, count=2, dice(...))` and `keep(lowest, count=2, dice(...))` respectively. Because these are function forms, they are handled in the parser's function-call case.

## 8. Parser

The parser is a recursive-descent parser driven by the precedence table from grammar v0.1. It produces an `ExpressionAstV1`. It rejects:

- unmatched or missing parentheses;
- dangling operators (e.g. `1 +`), missing operands;
- misplaced commas (wrong argument counts);
- unknown identifiers, scopes, functions, or malformed static dice notation;
- input longer than the compiler's node/depth budget (node count and depth checks mirror the codec's structural checks; exceeding them yields a `limit_exceeded` diagnostic and rejects compilation with no partial AST).

Precedence (lowest to highest):

1. `||`
2. `&&`
3. `==`, `!=`
4. `<`, `<=`, `>`, `>=`
5. `+`, `-` (binary)
6. `*`, `/`
7. unary `-`, `!`
8. atoms: literals, references, dice notation, functions, parens

The parser must produce ASTs identical to those in the committed fixtures for the same source strings. The cost (node count) of an AST is the total number of nodes in the tree.

### 8.1 AST node construction rules

- `numberLiteral`: value is a finite number.
- `stringLiteral`: value is a string. String literals are tokenized as `text` values; grammar v0.1 supports bounded strings, but only numbers, booleans, and references appear in the reference fixtures. String support is present for completeness and typing, not exercised by fixtures.
- `booleanLiteral`: `true` / `false`.
- `reference`: `{kind:"reference", scope:"fields"|"inputs", id}`.
- `unary`: `-` or `!` with one operand.
- `binary`: `+ - * / == != < <= > >= && ||` with left and right.
- `call`: `min` / `max` / `round` with arguments and optional `roundMode`. `round` accepts one or two arguments; two-argument form sets `roundMode` to the provided mode literal.
- `dice`: `{kind:"dice", count, sides}` where `count` is an integer AST expression and `sides` is a positive integer literal.
- `keep`: `{kind:"keep", mode:"highest"|"lowest", count, dice}`.
- `successCount`: `{kind:"successCount", dice, threshold}`.

Unary minus preceding a numeric literal is normalized into a `numberLiteral` with a negative value (matching how a negative literal is represented), unless the operand is a non-literal in which case a `unary` node is used. The precise normalization rule: if the operand of a unary minus is a `numberLiteral`, the parser folds the sign into the literal value; otherwise it emits a `unary` node.

## 9. Type Checker

The type checker walks the AST and infers a `ValueType` (`number` | `text` | `boolean`) for every node, applying the grammar typing rules (contract spec §6.3):

- Number literal → `number`.
- String literal → `text`.
- Boolean literal → `boolean`.
- Reference → the declared type of the referenced id from the compile env (`fields` or `inputs`). Unknown id is a `missing_reference` error; a reference to a definition of a non-scalar kind in the document compile path is a type error (fields that are data datasets or not addressable are not scalar). In the `compileExpression` path, the env controls what is addressable.
- Unary `-` → operand must be `number`; result `number`. Unary `!` → operand must be `boolean`; result `boolean`.
- Binary arithmetic (`+ - * /`) → both operands `number`; result `number`. (`+` on two `text` is NOT allowed in v0.1.)
- Binary comparison (`< <= > >=`) → both operands `number`; result `boolean`.
- Binary equality (`== !=`) → operands have the same scalar type; result `boolean`.
- Binary `&&` / `||` → both operands `boolean`; result `boolean`.
- `min`/`max`/`round` → all numeric arguments; result `number`. `round` with a mode must have a mode literal of `nearest`/`down`/`up`; the mode is not an expression.
- `dice` → `count` is `number` (must be integer), `sides` is a positive integer literal; the dice node's type is `number` (a dice pool resolves to a multiset of integers); result `number`.
- `keep` → its operand dice must be a dice/roll expression; result `number`.
- `successCount` → its operand must be a dice/roll expression; result `number`. The threshold is an integer literal.

### 9.1 Dice/roll typing

A `dice` node represents a roll and is only valid in `roll`-context expressions (contract §6.2: "Dice expressions are valid only in action-roll contexts. Computed fields and validations are deterministic."). `compileDocument` receives each expression's `context`; if a `dice`/`keep`/`successCount` node appears in a `computed` or `validation` expression, compilation rejects it with a `invalid_schema` / `invalid_expression` diagnostic. `compileExpression` treats dice as always allowed (no context), which the document-level caller constrains.

### 9.2 Declared type verification

For each source expression, the parser's inferred type must equal `resultType`. Additionally `fallback`'s runtime type must equal `resultType`. Discrepancies reject compilation with a type diagnostic.

The fallback in the compiled expression is the same scalar value as the document's fallback, whose type is verified to match `resultType`.

## 10. Dependency Resolution

For each compiled expression, collect every referenced definition id across the whole AST in document order, deduplicate, and preserve order. The dependency list contains ids referenced via `fields.<id>` and `inputs.<id>`. This matches the fixture dependencies:

- `defense_expr` `10 + fields.modifier` → `["modifier"]`.
- `check_expr` `d20 + fields.modifier + inputs.bonus` → `["bonus","modifier"]` (input deps and field deps mixed, document order of first appearance, deduplicated).
- `pool_roll_expr` → `["attribute","bonus_dice","skill"]`.

The dependency list is exactly the set of ids the evaluator will read from the bindings map.

## 11. Cost

`cost` is defined as **the exact structural node count of the AST** (the number of `ExpressionAstV1` nodes in the tree). This directly ties `CompiledExpressionV1.cost` to the `PACKAGE_LIMITS.expressionAstNodes` budget and to the schema's `maximum` on the field. It is deterministic: the same source compiles to the same cost. The codec's structural preflight already caps the AST at 256 nodes, and this increment's compiler further recomputes node count and depth so a caller cannot bypass via a pre-built AST.

### 11.1 Reference fixture cost correction

The committed fixture packages currently record five hand-authored `cost` values that do not equal their AST node counts:

| Fixture | Expression | Node count | Recorded cost |
|---------|-----------|------------|---------------|
| d20 | `check_expr` | 6 | 4 |
| d20 | `ability_valid_expr` | 7 | 9 |
| pbta-2d6 | `penalty_expr` | 3 | 2 |
| pbta-2d6 | `move_expr` | 6 | 4 |
| pbta-2d6 | `stat_valid_expr` | 7 | 9 |

The d6-success-pool fixture already records correct node-count costs. This increment corrects the five values above to their true node counts (6, 7, 3, 6, 7). Because fixture packages are signed (`SystemPackageV1` carries a checksum over the canonical package), correcting the `cost` value requires regenerating the signed fixture package and its `SystemPackageV1`/`SystemExportV1` checksums, and re-running `npm run contracts:generate` for any artifact that embeds these fixtures. `compileDocument`'s acceptance criterion is then: it reproduces the corrected fixtures exactly.

## 12. compileExpression

```typescript
type CompileResult<T> =
  | { ok: true; value: T }
  | { ok: false; diagnostics: PackageDiagnostic[] };
```

`compileExpression(source, opts)`:
1. Tokenize; on failure return diagnostics (no AST).
2. Parse; on failure return diagnostics (no AST).
3. Check node-count and depth against `PACKAGE_LIMITS`; on exceed return `limit_exceeded` (no AST).
4. Type-check using `opts.env`, `opts.context`, `opts.resultType`, `opts.fallback`; on failure return type/`missing_reference` diagnostics (no AST).
5. Resolve dependencies; on failure return `missing_reference`.
6. Return `CompiledExpressionV1` with `resultType: opts.resultType`, `inferredType`, `fallback: opts.fallback`, `dependencies`, `cost`, `ast`.

The `resultType` and `fallback` come from the source expression definition; `env` from the calling layer. `compileDocument` supplies both. The `context` field controls whether dice are permitted (see §9.1).

## 13. compileDocument

```typescript
compileDocument(document: SystemDocumentV1): CompileResult<SystemPackageV1>
```

`compileDocument`:
1. Builds `env.fields` from every field definition in `document.entities`, and `env.inputs` from every action input in `document.actions`. Field value types: integer/decimal/computed(model on `valueType`) → `number`; text → `text`; boolean → `boolean`; singleChoice/multiChoice → `text` (choice ids are opaque strings); resource → `number` (current/max are numbers); image attachment → not addressable in expressions (excluded).
2. For every source expression in `document.expressions`, calls `compileExpression` with its `context`, `resultType`, `fallback`, and the shared `env`.
3. If any expression fails, returns the combined diagnostics (a caller cannot receive a partial package).
4. Assembles the compiled document into an `UnsignedSystemPackageV1` body (schema structure identical to the existing fixture packages, i.e., `entities`, `sheets`, `actions`, `validations` carried through from the document with `CompiledExpressionV1` in `expressions`, `systemId`/`versionId`/`semanticVersion` assigned by the caller, plus `effectiveLimits`).
5. Invokes the existing `signSystemPackage` to produce the final `SystemPackageV1`.

The `systemId`, `versionId`, `semanticVersion`, and `name`/description/language/defaultDice metadata are provided by the caller via an options object, since `compileDocument` performs no persistence or identity assignment.

```typescript
compileDocument(
  document: SystemDocumentV1,
  opts: {
    systemId: string;
    versionId: string;
    semanticVersion: string;
  },
): CompileResult<SystemPackageV1>
```

## 14. Evaluator

```typescript
type Rng = () => number; // returns a value in [0, 1)

type EvalResult =
  | { ok: true; result: ScalarValue; roll: RollResult | null; diagnostics: RuntimeDiagnostic[] }
  | { ok: false; diagnostics: RuntimeDiagnostic[] };
```

`evaluate(compiled, bindings, rng = Math.random)`:
1. Reads only the ids in `compiled.dependencies` from `bindings`. Missing bindings for a non-fallback path are handled by falling back.
2. Evaluates the AST deterministically.
3. Returns a scalar value; when the expression is a roll (contains `dice`/`keep`/`successCount`), returns a `RollResult` describing the individual dice and total.

### 14.1 Scalar evaluation

- literals return their value;
- references read from `bindings` (per dependency list);
- unary/binary operators apply the arithmetic/comparison/boolean logic;
- `min`/`max` return the min/max of two numbers;
- `round` rounds per mode (`nearest`, `down`, `up`);
- `dice` rolls the requested count of dice with the given sides (via rng) and sums them;
- `keep` rolls the dice, keeps the highest/lowest `count`, and sums kept dice;
- `successCount` rolls the dice and returns the count of dice >= threshold.

### 14.2 Runtime diagnostics

Safe arithmetic failures (e.g., division by zero) do not reject evaluation. Per contract §6.3 and §14 of the contract spec, they produce the declared fallback value plus a `RuntimeDiagnostic`. The `EvalResult` returns `diagnostics` (empty when no failure) and the scalar `result` (which is the fallback when a failure occurred). Unsafe failures that indicate a malformed compiled value (unexpected node kind / `undefined` — impossible for compiler-produced ASTs) are not expected; the evaluator treats unknown node kinds as unreachable (TypeScript exhaustiveness) rather than a runtime diagnostic.

### 14.3 RollResult

```typescript
type RollResult = {
  total: number;
  dice: DieResult[];
  expression: string; // canonical rendered expression source
};

type DieResult = {
  sides: number;
  value: number;
  kept: boolean; // false for dice discarded by a keep node
};
```

The `total` is the numeric total of the kept dice plus any modifiers. The `dice` array lists every die rolled (individual results for rendering), with `kept` marking whether a `keep` node retained it. `expression` is the rendered canonical source. `RollResult` is non-null only when the top-level expression contains dice/keep/successCount; otherwise `roll` is `null` and the scalar `result` is the value.

For a `successCount` expression, `total` is the success count and every die's `kept` is true.

### 14.4 Determinism

For a fixed `rng` sequence and fixed `bindings`, `evaluate` returns an identical result every time. The default `rng` (`Math.random`) is non-deterministic across runs, but any seeded rng makes the result reproducible. Dice values are derived from the rng in a deterministic order (left-to-right, depth-first) so a seeded rng yields reproducible rolls.

## 15. renderExpression

```typescript
renderExpression(ast: ExpressionAstV1): string
```

Renders an AST back to canonical source text per contract §6.3:
- removes insignificant whitespace;
- uses explicit `keep` notation for keep nodes: `4d6kh3` is rendered as `4d6kh3`, `4d6kl1` as `4d6kl1` (the keep node specifies highest/lowest);
- emits parens where needed to preserve AST meaning;
- canonical dice notation: dice with count 1 render as `d<sides>`; dice with count `N` render as `<N>d<sides>`;
- operators render with their symbol in precedence order with parentheses added only where parenthesization is required to preserve meaning;
- numbers render without trailing `.0` for integer-valued decimals.

The renderer does not claim algebraic equivalence; two structurally different ASTs render differently.

## 16. Diagnostics

Reuse the `PackageDiagnostic` shape from the contract:

```typescript
type PackageDiagnostic = { code: string; path: string; message: string };
```

Diagnostic codes introduced by this increment:

- `invalid_syntax` — tokenizer/parser syntax errors.
- `invalid_expression` — dice in deterministic context, type mismatches, wrong argument counts/arities, unknown scope, unknown function.
- `missing_reference` — reference to an id absent from the compile env.
- `limit_exceeded` — AST node count or depth over `PACKAGE_LIMITS`.

Compile failures return diagnostics with `path` set to the expression id (or an empty path for a bare `compileExpression` call). Evaluator runtime failures return `RuntimeDiagnostic` objects with a `code` of `arithmetic_failure` and a message. Messages never contain caller secrets or stack traces.

## 17. Testing

Unit tests cover:

- tokenizer: every token kind, whitespace handling, malformed input (unknown scopes, bad literals, bad dice notation).
- parser: precedence, associativity, parens, unary, function calls, static dice to AST mapping, `adv`/`dis`, keep/successCount shapes, malformed / unbalanced / over-budget inputs rejected with no AST.
- type checker: every typing rule, type mismatch rejection, missing references, dice-in-deterministic-context rejection, fallback-type mismatch, declared-vs-inferred mismatch.
- `compileExpression`: exact AST/output for the fixture source strings (`10 + fields.modifier`, `d20 + fields.modifier + inputs.bonus`, `fields.ability >= 3 && fields.ability <= 18`, the `pool_*` expressions, etc.), correct `dependencies`, `cost`, `inferredType`, `fallback`.
- `compileDocument`: builds a `SystemPackageV1` equal (structurally) to the committed signed fixtures for the three reference documents; rejects a document with any failing expression with no partial package.
- `evaluate`: literals/references/operators; min/max/round; division-by-zero returns fallback + diagnostic; dice/keep/successCount with a seeded rng produce deterministic totals and `kept` flags; non-roll expressions return `roll: null`; missing binding falling back.
- `renderExpression`: round-trips fixture ASTs to canonical source; parens preservation; keep/dice notation.
- property tests: for random ASTs within the budget, `evaluate` with a seeded rng is deterministic; `render -> parse -> typecheck` round-trips.

Tests are deterministic and require neither PostgreSQL nor HTTP.

## 18. Budget Enforcement

- Node count and depth: enforced by the parser (reject over-budget at parse), and re-checked by the compiler so a pre-built AST cannot bypass. Ceilings are `PACKAGE_LIMITS.expressionAstNodes` (256) and `PACKAGE_LIMITS.expressionAstDepth` (32).
- Encoded/source bytes: already bounded by the document schema (`maxLength: PACKAGE_LIMITS.expressionBytes`) and the codec; the compiler trusts the caller's decoded value.
- No wall-clock/time budget in this increment (deferred to runtime/HTTP).

## 19. Acceptance Demonstration

Using only committed package APIs and the compiler:

1. `compileDocument(d20Document)` reproduces an `UnsignedSystemPackageV1` whose `expressions` ASTs, dependencies, and costs match the corrected `d20Package` fixture (after signing).
2. Same for the 2d6 and d6-success-pool fixtures.
3. `compileExpression("d20 + fields.modifier + inputs.bonus", ...)` returns the expected `CompiledExpressionV1`.
4. `evaluate` on `d20`-bearing expressions with a seeded rng returns a deterministic `RollResult` with individual dice and a canonical rendered `expression`.
5. `evaluate` on `10 + fields.modifier` returns the scalar `10 + modifier` (no roll object).
6. `renderExpression` reproduces canonical source for the fixture ASTs.
7. An expression with a typo, an unknown reference, a type mismatch, or over-budget nesting rejects with stable diagnostics and never produces a partial AST or package.

## 20. Out of Scope Reaffirmed

No `SystemRuntime` module, no persistence, no HTTP, no semantic versioning, no effects, no reroll/explode/push/collection/lookup semantics, no wall-clock budgets. These remain future increments per `design_v2.md`.
