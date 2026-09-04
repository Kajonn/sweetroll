# System Expression Engine v0.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Implement the math-and-dice tokenizer, parser, typed AST, type checker, dependency resolution, deterministic evaluator, normalized roll output, and node/depth budgets that compile `SystemDocumentV1` source expressions into `CompiledExpressionV1` values and deterministically evaluate them.

**Architecture:** A private pipeline under `src/systems/implementation/rules/`: tokenize → parse → type-check → resolve dependencies → cost, producing `CompiledExpressionV1` either per-expression (`compileExpression`) or across a whole document (`compileDocument`). A separate deterministic `evaluate` consumes compiled expressions against an id→value binding map with an injectable RNG, and `renderExpression` emits canonical source text. The package barrel exports only the five workflow functions.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` import extensions), Vitest, the existing TypeBox/AJV contract types under `src/systems/implementation/package/`.

**Spec:** `docs/superpowers/specs/2026-09-04-system-expression-engine-design.md` (binding authority; read it together with this plan).

## Global Constraints

- All code lives under `src/systems/implementation/rules/`; the barrel `index.ts` exports exactly `compileExpression`, `compileDocument`, `evaluate`, `renderExpression` (plus their input/output types needed by sibling implementation code). It must NOT export the tokenizer/parser/type-checker/evaluator internals or `Parser`/`Validator`/`Rules` Interfaces.
- ESM convention: every relative import uses a `.js` extension; `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noUnusedLocals`, `noUnusedParameters` are on.
- TypeScript types come from `src/systems/implementation/package/schema/index.ts`: `ExpressionAstV1`, `CompiledExpressionV1`, `SystemDocumentV1`, `SystemPackageV1`, `UnsignedSystemPackageV1`, `ScalarValue`, `ValueType`, `DefinitionId`. `PACKAGE_LIMITS` from `src/systems/implementation/package/limits.ts`; `signSystemPackage` from `src/systems/implementation/package/canonical.js`.
- Exact ceilings: `expressionAstNodes` 256, `expressionAstDepth` 32, `expressionBytes` 1024, `dicePerRoll` 100, `sidesPerDie` 1000.
- `cost` = exact AST node count. It is read by NO consumer and exists purely as deterministic metadata.
- Diagnostics reuse the `PackageDiagnostic` shape `{ code, path, message }`. The rules module defines its OWN local diagnostic type (a `RulesDiagnostic` with `code: string` and the same `path`/`message` fields), NOT the package `PackageDiagnosticCode` union — because the new codes `invalid_syntax`, `invalid_expression`, `missing_reference`, `limit_exceeded` (compile) and `arithmetic_failure` (runtime) are not members of `PackageDiagnosticCode` (which only has the 8 decode codes). Keeping a local type avoids widening/altering the package contract's decode codes. The rules code constructs diagnostics typed as `RulesDiagnostic` (or a generic `{ code: string; path: string; message: string }`) so TypeScript's strict mode is satisfied. Every task below that returns diagnostics uses this local type; the tests that assert `.code` still work since `code` is a string.
- Compile failures always return diagnostics and never a partial AST or partial package.
- Reference ids are `^[a-z][a-z0-9_]{0,63}$`; references are only `fields.<id>` and `inputs.<id>`.
- Precedence (low→high): `||`, `&&`, `== !=`, `< <= > >=`, `+ -` (binary), `* /`, unary `- !`, atoms (`( )`, literals, refs, dice notation, functions).
- Determinism: `evaluate(compiled, bindings, rng)` returns identical output for identical `(compiled, bindings, rng-sequence)`. Default rng is `Math.random`. Dice are read from the rng left-to-right, depth-first.

---

### Task 1: Tokenizer

**Files:**
- Create: `src/systems/implementation/rules/tokenizer.ts`
- Test: `src/systems/implementation/rules/tokenizer.test.ts`

**Interfaces:**
- Consumes: `PackageDiagnostic` shape from `src/systems/implementation/package/diagnostics.js`.
- Produces: `Token` union and `tokenize(source: string): { ok: true; tokens: Token[] } | { ok: false; diagnostics: PackageDiagnostic[] }`. Later parser consumes `Token[]`.

The tokenizer splits a source string into an ordered token stream and rejects malformed input without throwing.

Token union:

```typescript
export type Token =
  | { kind: "number"; value: number; start: number }
  | { kind: "id"; scope: "fields" | "inputs"; id: string; start: number }
  | { kind: "function"; name: "min" | "max" | "round" | "dice" | "countSuccesses"; start: number }
  | { kind: "advDis"; which: "adv" | "dis"; start: number }
  | { kind: "dice"; count: number; sides: number; keep?: { mode: "highest" | "lowest"; count: number }; start: number }
  | { kind: "operator"; op: "+" | "-" | "*" | "/" | "<" | "<=" | ">" | ">=" | "==" | "!=" | "&&" | "||" | "!"; start: number }
  | { kind: "lparen"; start: number }
  | { kind: "rparen"; start: number }
  | { kind: "comma"; start: number };
```

The `start` field is the zero-based character offset of the token start, used only for diagnostic messages.

Rules:
- Whitespace (spaces, tabs, newlines) is skipped.
- Booleans `true`/`false` are NOT tokens; the parser recognizes them from identifier-ish tokens. To keep the tokenizer simple, `true`/`false` are produced as `{ kind: "boolean"; value: boolean }`. Add `| { kind: "boolean"; value: boolean; start: number }` to the union.
- `fields.<id>` and `inputs.<id>` (and `fields.<id>`/`inputs.<id>` where `<id>` matches `[a-z][a-z0-9_]{0,63}`) tokenize as a single `id` token.
- `min`, `max`, `round`, `dice`, `countSuccesses` → `function` tokens.
- `adv` / `dis` → `advDis` tokens (typed sugar, parsed into keep nodes by the parser).
- Static dice notation `<N>d<S>` (N optional, defaults to 1 when omitted) → `dice` token; optional `<N>d<S>kh<K>` / `kl<K>` suffix → `dice` token with `keep`. Count `N` and sides `S` and keep count `K` must be positive integers. Examples: `d20` → count 1 sides 20; `2d6` → count 2 sides 6; `4d6kh3` → count 4 sides 6 keep {mode highest, count 3}.
- Operators per the symbol set above. `!` is both the logic-not unary AND the `!=` equality prefix; the tokenizer greedily matches `!=` before bare `!`.
- `(`, `)`, `,` → paren/comma tokens.
- Any other character, an unknown bare word, a malformed dice literal (e.g. `d`, `6d`, `d0`, `x6`), or an unterminated `fields.` / `inputs.` is an `invalid_syntax` diagnostic.

Dice-literal detection rule: a maximal run starting with an optional positive integer, then `d`, then a positive integer, is a dice literal ONLY if the run does not begin with a letter and the segment before `d` is entirely digits. This prevents `fields` from being misread.

- [x] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import { tokenize } from "./tokenizer.js";

describe("tokenizer", () => {
  it("tokenizes a simple arithmetic expression", () => {
    const r = tokenize("10 + fields.modifier");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tokens).toEqual([
      { kind: "number", value: 10, start: 0 },
      { kind: "operator", op: "+", start: 3 },
      { kind: "id", scope: "fields", id: "modifier", start: 5 },
    ]);
  });

  it("tokenizes static dice notation with keep", () => {
    const r = tokenize("4d6kh3");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tokens).toEqual([
      { kind: "dice", count: 4, sides: 6, keep: { mode: "highest", count: 3 }, start: 0 },
    ]);
  });

  it("tokenizes d20 with default count 1", () => {
    const r = tokenize("d20");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tokens).toEqual([{ kind: "dice", count: 1, sides: 20, keep: undefined, start: 0 }]);
  });

  it("rejects an unknown bare word", () => {
    const r = tokenize("foo");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics[0]!.code).toBe("invalid_syntax");
  });

  it("rejects an unknown scope", () => {
    const r = tokenize("things.modifier");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics[0]!.code).toBe("invalid_syntax");
  });

  it("recognizes booleans, functions, and operators", () => {
    const r = tokenize("fields.ability >= 3 && true");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tokens.map((t) => t.kind)).toEqual(["id", "operator", "number", "operator", "boolean"]);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- src/systems/implementation/rules/tokenizer.test.ts`
Expected: FAIL (module `./tokenizer.js` not found / no such export).

- [x] **Step 3: Implement `tokenize`**

```typescript
import type { PackageDiagnostic } from "../package/diagnostics.js";

export type Token =
  | { kind: "number"; value: number; start: number }
  | { kind: "boolean"; value: boolean; start: number }
  | { kind: "id"; scope: "fields" | "inputs"; id: string; start: number }
  | { kind: "function"; name: "min" | "max" | "round" | "dice" | "countSuccesses"; start: number }
  | { kind: "advDis"; which: "adv" | "dis"; start: number }
  | { kind: "dice"; count: number; sides: number; keep?: { mode: "highest" | "lowest"; count: number }; start: number }
  | { kind: "operator"; op: "+" | "-" | "*" | "/" | "<" | "<=" | ">" | ">=" | "==" | "!=" | "&&" | "||" | "!"; start: number }
  | { kind: "lparen"; start: number }
  | { kind: "rparen"; start: number }
  | { kind: "comma"; start: number };

export type TokenizeResult =
  | { ok: true; tokens: Token[] }
  | { ok: false; diagnostics: PackageDiagnostic[] };

const FUNCTIONS = new Set(["min", "max", "round", "dice", "countSuccesses"]);
const ASSIGNED_FUNCTIONS = new Set(["adv", "dis"]);
const ID_RE = /^[a-z][a-z0-9_]{0,63}$/;

function error(message: string, start: number): PackageDiagnostic {
  return { code: "invalid_syntax", path: "", message };
}

export function tokenize(source: string): TokenizeResult {
  const tokens: Token[] = [];
  let i = 0;
  const n = source.length;

  const fail = (msg: string): TokenizeResult => ({ ok: false, diagnostics: [error(msg, i)] });

  while (i < n) {
    const ch = source[i]!;
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") { i++; continue; }
    const start = i;

    // numbers (also used as the leading count of dice notation handled below)
    if (/[0-9]/.test(ch)) {
      // Possible dice literal: N*digits 'd' positive-int (optional keep)
      const diceMatch = matchStaticDice(source, i);
      if (diceMatch) {
        tokens.push({ kind: "dice", count: diceMatch.count, sides: diceMatch.sides, keep: diceMatch.keep, start });
        i = diceMatch.end;
        continue;
      }
      let j = i;
      while (j < n && /[0-9]/.test(source[j]!)) j++;
      let val: number;
      if (j < n && source[j] === ".") {
        j++;
        const fracStart = j;
        while (j < n && /[0-9]/.test(source[j]!)) j++;
        if (j === fracStart) return fail("trailing decimal point");
        val = Number(source.slice(i, j));
      } else {
        val = Number(source.slice(i, j));
      }
      if (!Number.isFinite(val)) return fail("invalid number");
      tokens.push({ kind: "number", value: val, start });
      i = j;
      continue;
    }

    // identifiers, scopes, functions, booleans, adv/dis
    if (/[a-z]/i.test(ch)) {
      let j = i;
      while (j < n && /[a-z0-9_]/i.test(source[j]!)) j++;
      const word = source.slice(i, j);

      const idMatch = /^(fields|inputs)\.[a-z_][a-z0-9_]{0,63}$/.exec(word);
      if (idMatch) {
        const scope = idMatch[1] as "fields" | "inputs";
        const id = word.slice(scope.length + 1);
        if (!ID_RE.test(id)) return fail("invalid id");
        tokens.push({ kind: "id", scope, id, start });
        i = j;
        continue;
      }
      if (FUNCTIONS.has(word)) { tokens.push({ kind: "function", name: word, start }); i = j; continue; }
      if (word === "true" || word === "false") { tokens.push({ kind: "boolean", value: word === "true", start }); i = j; continue; }
      if (ASSIGNED_FUNCTIONS.has(word)) { tokens.push({ kind: "advDis", which: word as "adv" | "dis", start }); i = j; continue; }
      return fail(`unknown identifier '${word}'`);
    }

    // operators
    const two = source.slice(i, i + 2);
    if (["<=", ">=", "==", "!=", "&&", "||"].includes(two)) {
      tokens.push({ kind: "operator", op: two, start }); i += 2; continue;
    }
    if ("+-*/<>=!".includes(ch)) {
      tokens.push({ kind: "operator", op: ch, start }); i++; continue;
    }
    if (ch === "(") { tokens.push({ kind: "lparen", start }); i++; continue; }
    if (ch === ")") { tokens.push({ kind: "rparen", start }); i++; continue; }
    if (ch === ",") { tokens.push({ kind: "comma", start }); i++; continue; }

    return fail(`unexpected character '${ch}'`);
  }
  return { ok: true, tokens };
}

type StaticDice = { count: number; sides: number; keep?: { mode: "highest" | "lowest"; count: number }; end: number };

function matchStaticDice(source: string, i: number): StaticDice | null {
  const n = source.length;
  let j = i;
  let count: number | undefined;
  if (/[0-9]/.test(source[j]!)) { let k = j; while (k < n && /[0-9]/.test(source[k]!)) k++; count = Number(source.slice(j, k)); j = k; }
  if (source[j] !== "d") return null;
  j++;
  // sides must start with a digit
  if (j >= n || !/[0-9]/.test(source[j]!)) return null;
  let k = j; while (k < n && /[0-9]/.test(source[k]!)) k++;
  const sides = Number(source.slice(j, k));
  if (!Number.isInteger(sides) || sides < 1) return null;
  j = k;
  let keep: { mode: "highest" | "lowest"; count: number } | undefined;
  const kh = source.slice(j, j + 3);
  const kl = source.slice(j, j + 3);
  if (kh === "kh" || kl === "kl") {
    const mode = kh === "kh" ? "highest" : "lowest";
    j += 2;
    let kk = j; while (kk < n && /[0-9]/.test(source[kk]!)) kk++;
    if (kk === j) return null; // keep requires a count
    const keepCount = Number(source.slice(j, kk));
    if (!Number.isInteger(keepCount) || keepCount < 1) return null;
    keep = { mode, count: keepCount };
    j = kk;
  }
  const resolvedCount = count ?? 1;
  if (!Number.isInteger(resolvedCount) || resolvedCount < 1) return null;
  return { count: resolvedCount, sides, keep, end: j };
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npm test -- src/systems/implementation/rules/tokenizer.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/systems/implementation/rules/tokenizer.ts src/systems/implementation/rules/tokenizer.test.ts
git commit -m "feat: add expression tokenizer"
```

---

### Task 2: Parser

**Files:**
- Create: `src/systems/implementation/rules/parser.ts`
- Test: `src/systems/implementation/rules/parser.test.ts`

**Interfaces:**
- Consumes: `Token` and `tokenize` from `./tokenizer.js` (Task 1); `ExpressionAstV1` types and `DefinitionId` from `../package/schema/index.js`.
- Produces: `parse(source: string): { ok: true; ast: ExpressionAstV1 } | { ok: false; diagnostics: PackageDiagnostic[] }`; plus `countNodes(ast)` and `depthOf(ast)` helpers used by the compiler.

`countNodes(ast): number` returns the total number of AST nodes (a `numberLiteral` is 1 node, a `binary` is 1 node plus its left/right subtrees, etc.). `depthOf(ast): number` returns the maximum root-to-leaf depth (a single node has depth 1).

The parser is recursive-descent over the token precedence table and produces exactly the `ExpressionAstV1` node shapes. It rejects with `invalid_syntax` diagnostics on: trailing tokens, missing operands, empty parens, wrong function arity, dice in an out-of-context position left to the type checker (the parser only rejects malformed syntax). Keep/successCount shapes come from tokens/functions.

Parser responsibilities and AST mapping (must match Task 3 type checker and the committed fixtures):

- `number` token → `numberLiteral`.
- `boolean` token → `booleanLiteral`.
- `id` token → `reference` with `{ scope, id }`.
- binary ops → `binary` nodes (left-associative).
- unary `-` on a `numberLiteral` operand → fold sign into a `numberLiteral` (e.g. `-3` → `{kind:"numberLiteral", value:-3}`); unary `-` on any other operand → `{kind:"unary", operator:"-", operand}`; unary `!` → `{kind:"unary", operator:"!", operand}`.
- `min`/`max` → `{kind:"call", function, arguments:[a,b]}`.
- `round` → `{kind:"call", function:"round", arguments, roundMode?}`; with 1 arg no `roundMode`; with 2 args the second must be a `boolean`? No — the round mode is a mode literal token. Since the tokenizer doesn't produce mode literals, the parser reads `nearest|down|up` directly from the source. Implement mode literals in the tokenizer OR parse them specially. **Decision:** extend the tokenizer in this task (modify `tokenizer.ts`) to also emit mode literals.
  - Modify the tokenizer's function-word branch so that when inside a `round(...)` call the words `nearest`/`down`/`up` become `{ kind: "roundMode"; mode: "nearest"|"down"|"up" }`. Simpler consistent approach: whenever the tokenizer encounters the whole-word identifiers `nearest`, `down`, or `up`, emit them as `{ kind: "roundMode"; mode }`. These are only valid as `round`'s second argument, which the parser enforces.
- `dice` token → `{kind:"dice", count:{kind:"numberLiteral", value: count}, sides}` when no `keep`; when `keep` present → `{kind:"keep", mode, count: keep.count, dice:{kind:"dice", count:{kind:"numberLiteral",value}, sides}}`.
- `advDis` token `adv` → `{kind:"keep", mode:"highest", count:2, dice:{kind:"dice", count:{kind:"numberLiteral",value:2}, sides:20}}`; `dis` → keep lowest count 2 (the sugar rolls 2×d20 in the contract). NOTE: spec §7.1 says `adv(d20)` expands to keep(highest, count=2, dice(...)). Because the tokenizer does NOT treat `adv(d20)` specially, implement `adv`/`dis` as accepting the following dice token in parens OR as bare sugar for 2d20. **Decision for this plan:** `adv`/`dis` are handled only in their parenthesized function form `adv(d20)`/`dis(d20)` per the grammar. The parser, on an `advDis` token, expects `(` `<dice-token with sides S>` `)` and produces `keep(mode, count=2, dice(count=1,sides=S))` — i.e. `adv(d20)` → keep highest 2 of dice(1,20); `dis(d20)` → keep lowest 2 of dice(1,20).
- `( expr )` → parenthesized subexpression (no node; precedence only).
- `countSuccesses(diceExpr, integerThreshold)` → `{kind:"successCount", dice: <parsedExpr>, threshold}` where threshold is a positive integer literal.

Precedence implementation via climbing functions: `parseOr`, `parseAnd`, `parseEquality`, `parseComparison`, `parseAdditive`, `parseMultiplicative`, `parseUnary`, `parsePrimary`.

- [x] **Step 1: Extend tokenizer to emit roundMode and update its test**

Modify `tokenizer.ts`: add `| { kind: "roundMode"; mode: "nearest"|"down"|"up"; start: number }` to `Token`. In the word branch, before the unknown-word error, check `["nearest","down","up"].includes(word)` and emit a `roundMode` token. Add to `tokenizer.test.ts`:

```typescript
it("tokenizes round mode words", () => {
  const r = tokenize("round(1.5, down)");
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.tokens.map((t) => t.kind)).toEqual(["function", "lparen", "number", "comma", "roundMode", "rparen"]);
});
```

Run: `npm test -- src/systems/implementation/rules/tokenizer.test.ts` — PASS.

- [x] **Step 2: Write the failing parser test**

```typescript
import { describe, expect, it } from "vitest";
import { parse } from "./parser.js";

describe("parser", () => {
  it("parses arithmetic with correct AST", () => {
    const r = parse("10 + fields.modifier");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ast).toEqual({
      kind: "binary", operator: "+",
      left: { kind: "numberLiteral", value: 10 },
      right: { kind: "reference", scope: "fields", id: "modifier" },
    });
  });

  it("parses static dice into a dice node with count 1", () => {
    const r = parse("d20");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ast).toEqual({ kind: "dice", count: { kind: "numberLiteral", value: 1 }, sides: 20 });
  });

  it("parses 2d6 + fields.move_stat + inputs.forward", () => {
    const r = parse("2d6 + fields.move_stat + inputs.forward");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ast).toEqual({
      kind: "binary", operator: "+",
      left: {
        kind: "binary", operator: "+",
        left: { kind: "dice", count: { kind: "numberLiteral", value: 2 }, sides: 6 },
        right: { kind: "reference", scope: "fields", id: "move_stat" },
      },
      right: { kind: "reference", scope: "inputs", id: "forward" },
    });
  });

  it("parses keep notation 4d6kh3", () => {
    const r = parse("4d6kh3");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ast).toEqual({
      kind: "keep", mode: "highest", count: 3,
      dice: { kind: "dice", count: { kind: "numberLiteral", value: 4 }, sides: 6 },
    });
  });

  it("parses successCount", () => {
    const r = parse("countSuccesses(dice(2, 6), 4)");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ast).toEqual({
      kind: "successCount",
      dice: { kind: "dice", count: { kind: "numberLiteral", value: 2 }, sides: 6 },
      threshold: 4,
    });
  });

  it("parses parentheses and unary negation of literal into a negative literal", () => {
    const r = parse("fields.move_stat >= -1");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ast = r.ast;
    expect(ast.kind).toBe("binary");
    if (ast.kind !== "binary") return;
    expect(ast.right).toEqual({ kind: "numberLiteral", value: -1 });
  });

  it("rejects a dangling operator with a diagnostic", () => {
    const r = parse("1 +");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics[0]!.code).toBe("invalid_syntax");
  });

  it("rejects unbalanced parens", () => {
    const r = parse("(1 + 2");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics[0]!.code).toBe("invalid_syntax");
  });

  it("counts nodes", () => {
    const r = parse("10 + fields.modifier");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(countNodes(r.ast)).toBe(3);
  });
});
```

- [x] **Step 3: Run test to verify it fails**

Run: `npm test -- src/systems/implementation/rules/parser.test.ts`
Expected: FAIL (no `parse` export).

- [x] **Step 4: Implement the parser**

```typescript
import type { PackageDiagnostic } from "../package/diagnostics.js";
import type { ExpressionAstV1 } from "../package/schema/index.js";
import { tokenize, type Token } from "./tokenizer.js";

export type ParseResult =
  | { ok: true; ast: ExpressionAstV1 }
  | { ok: false; diagnostics: PackageDiagnostic[] };

export function countNodes(ast: ExpressionAstV1): number {
  switch (ast.kind) {
    case "numberLiteral": case "stringLiteral": case "booleanLiteral": return 1;
    case "reference": return 1;
    case "unary": return 1 + countNodes(ast.operand);
    case "binary": return 1 + countNodes(ast.left) + countNodes(ast.right);
    case "call": return 1 + ast.arguments.reduce((s, a) => s + countNodes(a), 0);
    case "dice": return 1 + countNodes(ast.count);
    case "keep": return 1 + countNodes(ast.dice);
    case "successCount": return 1 + countNodes(ast.dice);
  }
}

export function depthOf(ast: ExpressionAstV1): number {
  switch (ast.kind) {
    case "numberLiteral": case "stringLiteral": case "booleanLiteral": case "reference": return 1;
    case "unary": return 1 + depthOf(ast.operand);
    case "binary": return 1 + Math.max(depthOf(ast.left), depthOf(ast.right));
    case "call": return 1 + Math.max(0, ...ast.arguments.map(depthOf));
    case "dice": return 1 + depthOf(ast.count);
    case "keep": return 1 + depthOf(ast.dice);
    case "successCount": return 1 + depthOf(ast.dice);
  }
}

class Parser {
  private tokens: Token[] = [];
  private pos = 0;
  private errors: PackageDiagnostic[] = [];

  constructor(source: string) {
    const t = tokenize(source);
    if (!t.ok) { this.errors = t.diagnostics; }
    else { this.tokens = t.tokens; }
  }

  parse(): ParseResult {
    if (this.errors.length > 0) return { ok: false, diagnostics: this.errors };
    const ast = this.parseOr();
    if (!ast) return { ok: false, diagnostics: this.errors };
    if (this.peek() !== undefined) {
      this.fail("unexpected trailing token");
      return { ok: false, diagnostics: this.errors };
    }
    return { ok: true, ast };
  }

  private peek(): Token | undefined { return this.tokens[this.pos]; }
  private take(): Token | undefined { return this.tokens[this.pos++]; }
  private fail(msg: string): void { this.errors.push({ code: "invalid_syntax", path: "", message: msg }); }

  private at(kind: string): boolean {
    const t = this.peek(); return t !== undefined && t.kind === kind;
  }

  private parseOr(): ExpressionAstV1 | undefined {
    let left = this.parseAnd();
    while (left && this.at("operator") && this.peek()!.op === "||") {
      this.take();
      const right = this.parseAnd();
      if (!right) return undefined;
      left = { kind: "binary", operator: "||", left, right };
    }
    return left;
  }
  private parseAnd(): ExpressionAstV1 | undefined {
    let left = this.parseEquality();
    while (left && this.at("operator") && this.peek()!.op === "&&") {
      this.take();
      const right = this.parseEquality();
      if (!right) return undefined;
      left = { kind: "binary", operator: "&&", left, right };
    }
    return left;
  }
  private parseEquality(): ExpressionAstV1 | undefined {
    let left = this.parseComparison();
    while (left && this.at("operator") && (this.peek()!.op === "==" || this.peek()!.op === "!=")) {
      const op = this.take()!.op as "==" | "!=";
      const right = this.parseComparison();
      if (!right) return undefined;
      left = { kind: "binary", operator: op, left, right };
    }
    return left;
  }
  private parseComparison(): ExpressionAstV1 | undefined {
    let left = this.parseAdditive();
    while (left && this.at("operator") && ["<", "<=", ">", ">="].includes(this.peek()!.op)) {
      const op = this.take()!.op as "<" | "<=" | ">" | ">=";
      const right = this.parseAdditive();
      if (!right) return undefined;
      left = { kind: "binary", operator: op, left, right };
    }
    return left;
  }
  private parseAdditive(): ExpressionAstV1 | undefined {
    let left = this.parseMultiplicative();
    while (left && this.at("operator") && (this.peek()!.op === "+" || this.peek()!.op === "-")) {
      const op = this.take()!.op as "+" | "-";
      const right = this.parseMultiplicative();
      if (!right) return undefined;
      left = { kind: "binary", operator: op, left, right };
    }
    return left;
  }
  private parseMultiplicative(): ExpressionAstV1 | undefined {
    let left = this.parseUnary();
    while (left && this.at("operator") && (this.peek()!.op === "*" || this.peek()!.op === "/")) {
      const op = this.take()!.op as "*" | "/";
      const right = this.parseUnary();
      if (!right) return undefined;
      left = { kind: "binary", operator: op, left, right };
    }
    return left;
  }
  private parseUnary(): ExpressionAstV1 | undefined {
    const t = this.peek();
    if (t && t.kind === "operator" && (t.op === "-" || t.op === "!")) {
      this.take();
      const operand = this.parseUnary();
      if (!operand) return undefined;
      if (t.op === "-" && operand.kind === "numberLiteral") {
        return { kind: "numberLiteral", value: -operand.value };
      }
      return { kind: "unary", operator: t.op, operand };
    }
    return this.parsePrimary();
  }
  private parsePrimary(): ExpressionAstV1 | undefined {
    const t = this.take();
    if (!t) { this.fail("unexpected end of input"); return undefined; }
    switch (t.kind) {
      case "number": return { kind: "numberLiteral", value: t.value };
      case "boolean": return { kind: "booleanLiteral", value: t.value };
      case "id": return { kind: "reference", scope: t.scope, id: t.id };
      case "dice": {
        const diceAst: ExpressionAstV1 = { kind: "dice", count: { kind: "numberLiteral", value: t.count }, sides: t.sides };
        if (t.keep) return { kind: "keep", mode: t.keep.mode, count: t.keep.count, dice: diceAst };
        return diceAst;
      }
      case "lparen": {
        const inner = this.parseOr();
        if (!inner) return undefined;
        if (!this.at("rparen")) { this.fail("missing closing paren"); return undefined; }
        this.take();
        return inner;
      }
      case "function": return this.parseCall(t.name);
      case "advDis": return this.parseAdvDis(t.which);
      default:
        this.fail("unexpected token");
        return undefined;
    }
  }
  private parseCall(name: "min" | "max" | "round" | "dice" | "countSuccesses"): ExpressionAstV1 | undefined {
    if (!this.at("lparen")) { this.fail(`expected '(' after ${name}`); return undefined; }
    this.take();
    if (name === "dice") {
      const count = this.parseOr();
      if (!count) return undefined;
      if (!this.at("comma")) { this.fail("dice expects a sides literal"); return undefined; }
      this.take();
      const sidesTok = this.take();
      if (!sidesTok || sidesTok.kind !== "number" || !Number.isInteger(sidesTok.value) || sidesTok.value < 1) {
        this.fail("dice sides must be a positive integer literal"); return undefined;
      }
      if (!this.at("rparen")) { this.fail("missing closing paren"); return undefined; }
      this.take();
      return { kind: "dice", count, sides: sidesTok.value };
    }
    if (name === "countSuccesses") {
      const diceExpr = this.parseOr();
      if (!diceExpr) return undefined;
      if (!this.at("comma")) { this.fail("countSuccesses expects a threshold"); return undefined; }
      this.take();
      const thTok = this.take();
      if (!thTok || thTok.kind !== "number" || !Number.isInteger(thTok.value)) {
        this.fail("countSuccesses threshold must be an integer"); return undefined;
      }
      if (!this.at("rparen")) { this.fail("missing closing paren"); return undefined; }
      this.take();
      return { kind: "successCount", dice: diceExpr, threshold: thTok.value };
    }
    // min / max / round
    if (this.at("rparen")) { this.take(); return { kind: "call", function: name, arguments: [] }; }
    const args: ExpressionAstV1[] = [];
    let roundMode: "nearest" | "down" | "up" | undefined;
    for (;;) {
      if (name === "round" && args.length === 1 && this.at("roundMode")) {
        const rm = this.take()!;
        roundMode = rm.mode;
        break;
      }
      const arg = this.parseOr();
      if (!arg) return undefined;
      args.push(arg);
      if (this.at("comma")) { this.take(); continue; }
      break;
    }
    if (!this.at("rparen")) { this.fail("missing closing paren"); return undefined; }
    this.take();
    const call: { kind: "call"; function: "min" | "max" | "round"; arguments: ExpressionAstV1[]; roundMode?: "nearest" | "down" | "up" } =
      { kind: "call", function: name, arguments: args };
    if (roundMode) call.roundMode = roundMode;
    return call as unknown as ExpressionAstV1;
  }
  private parseAdvDis(which: "adv" | "dis"): ExpressionAstV1 | undefined {
    if (!this.at("lparen")) { this.fail("expected '(' after " + which); return undefined; }
    this.take();
    const t = this.take();
    if (!t || t.kind !== "dice") { this.fail(which + " expects a static dice literal"); return undefined; }
    if (!this.at("rparen")) { this.fail("missing closing paren"); return undefined; }
    this.take();
    const sides = t.sides;
    const diceAst: ExpressionAstV1 = { kind: "dice", count: { kind: "numberLiteral", value: 2 }, sides };
    return { kind: "keep", mode: which === "adv" ? "highest" : "lowest", count: 2, dice: diceAst };
  }
}
```

The single `parseCall` above is the authoritative implementation. It handles `dice(count, sides)` and `countSuccesses(dice, threshold)` directly into their AST nodes (NOT `call` nodes — the `ExpressionAstV1Schema.call` variant only allows `min`/`max`/`round`), and `min`/`max`/`round` into `call` nodes with an optional `roundMode` set when a `roundMode` token follows the first argument.

Then the top-level `parse` helper:

```typescript
export function parse(source: string): ParseResult {
  const p = new Parser(source);
  return p.parse();
}
```

- [x] **Step 5: Run test to verify it passes**

Run: `npm test -- src/systems/implementation/rules/parser.test.ts`
Expected: PASS. Then run `npm run typecheck` — MUST pass (add all needed types to `Token`, resolve the `roundMode` union in `parseCall` so the return is a valid `ExpressionAstV1`).

- [x] **Step 6: Commit**

```bash
git add src/systems/implementation/rules/parser.ts src/systems/implementation/rules/parser.test.ts src/systems/implementation/rules/tokenizer.ts src/systems/implementation/rules/tokenizer.test.ts
git commit -m "feat: add expression parser"
```

---

### Task 3: Type checker and dependency resolution

**Files:**
- Create: `src/systems/implementation/rules/typecheck.ts`
- Test: `src/systems/implementation/rules/typecheck.test.ts`

**Interfaces:**
- Consumes: `parse`, `countNodes`, `depthOf` from `./parser.js` (Task 2); `ExpressionCompileEnv` (defined here); `PackageDiagnostic`, `PACKAGE_LIMITS`, `ExpressionAstV1`, `CompiledExpressionV1`, `ScalarValue`, `ValueType`, `DefinitionId` from the package schema.
- Produces: `ExpressionCompileEnv` type + `inferType(ast, env): { ok: true; type: ValueType } | { ok: false; diagnostics: PackageDiagnostic[] }`, `resolveDependencies(ast): DefinitionId[]`, and `checkCompute/checkContext` helpers used by the compiler.

Define and export:

```typescript
export type ExpressionCompileEnv = {
  fields: Record<string, ValueType>;
  inputs: Record<string, ValueType>;
};
```

`resolveDependencies(ast)` walks the AST in document order collecting every `reference` id (with its scope) into `"{scope}.{id}"` string set order of first appearance; returns `DefinitionId[]` where each entry is the bare id (the compiled package records bare ids, e.g. `["bonus","modifier"]`). Preserve the order of first appearance and deduplicate.

`inferType` applies the typing rules from spec §9 (dispatch on node kind). Reference type from `env.fields[id]` / `env.inputs[id]`; unknown id → `missing_reference` diagnostic. Dice node type is `number`. `successCount`/`keep` type `number`. `round` result `number`.

Also export:

```typescript
export function checkDeterministic(ast: ExpressionAstV1, context: "computed" | "roll" | "validation"): PackageDiagnostic[];
```
Returns a diagnostic (`invalid_expression`) if the tree contains any `dice`/`keep`/`successCount` node and `context !== "roll"`. Empty array otherwise.

- [x] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import { parse } from "./parser.js";
import { inferType, resolveDependencies, checkDeterministic, type ExpressionCompileEnv } from "./typecheck.js";

const env: ExpressionCompileEnv = {
  fields: { ability: "number", modifier: "number", move_stat: "number", harm: "number" },
  inputs: { bonus: "number", forward: "number" },
};

function ast(source: string) { const r = parse(source); if (!r.ok) throw new Error("parse fail"); return r.ast; }

describe("typecheck", () => {
  it("infers number for arithmetic", () => {
    expect(inferType(ast("10 + fields.modifier"), env)).toEqual({ ok: true, type: "number" });
  });
  it("infers boolean for comparison", () => {
    expect(inferType(ast("fields.ability >= 3"), env)).toEqual({ ok: true, type: "boolean" });
  });
  it("infers boolean for &&", () => {
    expect(inferType(ast("fields.ability >= 3 && fields.ability <= 18"), env)).toEqual({ ok: true, type: "boolean" });
  });
  it("rejects mixed-type equality", () => {
    const r = inferType(ast("fields.modifier == true"), env);
    expect(r.ok).toBe(false);
  });
  it("returns missing_reference for unknown field", () => {
    const r = inferType(ast("fields.nope + 1"), env);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics[0]!.code).toBe("missing_reference");
  });
  it("resolves and dedups dependencies in order", () => {
    expect(resolveDependencies(ast("d20 + fields.modifier + inputs.bonus"))).toEqual(["modifier", "bonus"]);
  });
  it("flags dice in a deterministic context", () => {
    expect(checkDeterministic(ast("d20 + 1"), "computed").length).toBeGreaterThan(0);
  });
  it("allows dice in a roll context", () => {
    expect(checkDeterministic(ast("d20 + 1"), "roll")).toEqual([]);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- src/systems/implementation/rules/typecheck.test.ts`
Expected: FAIL (no `inferType` export).

- [x] **Step 3: Implement the type checker**

```typescript
import type { PackageDiagnostic } from "../package/diagnostics.js";
import type { ExpressionAstV1, ValueType, DefinitionId } from "../package/schema/index.js";
import { countNodes } from "./parser.js";

export type ExpressionCompileEnv = {
  fields: Record<string, ValueType>;
  inputs: Record<string, ValueType>;
};

export type InferResult =
  | { ok: true; type: ValueType }
  | { ok: false; diagnostics: PackageDiagnostic[] };

function isNumber(t: ValueType): boolean { return t === "number"; }
function isBoolean(t: ValueType): boolean { return t === "boolean"; }

export function inferType(ast: ExpressionAstV1, env: ExpressionCompileEnv): InferResult {
  const diag = (code: string, message: string): InferResult => ({ ok: false, diagnostics: [{ code, path: "", message }] });
  switch (ast.kind) {
    case "numberLiteral": return { ok: true, type: "number" };
    case "stringLiteral": return { ok: true, type: "text" };
    case "booleanLiteral": return { ok: true, type: "boolean" };
    case "reference": {
      const map = ast.scope === "fields" ? env.fields : env.inputs;
      if (!(ast.id in map)) return diag("missing_reference", `unknown ${ast.scope} reference '${ast.id}'`);
      return { ok: true, type: map[ast.id]! };
    }
    case "unary": {
      const op = inferType(ast.operand, env);
      if (!op.ok) return op;
      if (ast.operator === "!") return isBoolean(op.type) ? { ok: true, type: "boolean" } : diag("invalid_expression", "operand of '!' must be boolean");
      return isNumber(op.type) ? { ok: true, type: "number" } : diag("invalid_expression", "operand of unary '-' must be number");
    }
    case "binary": {
      const l = inferType(ast.left, env);
      if (!l.ok) return l;
      const r = inferType(ast.right, env);
      if (!r.ok) return r;
      switch (ast.operator) {
        case "+": case "-": case "*": case "/":
          return isNumber(l.type) && isNumber(r.type) ? { ok: true, type: "number" } : diag("invalid_expression", "arithmetic operands must be number");
        case "<": case "<=": case ">": case ">=":
          return isNumber(l.type) && isNumber(r.type) ? { ok: true, type: "boolean" } : diag("invalid_expression", "comparison operands must be number");
        case "==": case "!=":
          return l.type === r.type ? { ok: true, type: "boolean" } : diag("invalid_expression", "equality operands must have the same type");
        case "&&": case "||":
          return isBoolean(l.type) && isBoolean(r.type) ? { ok: true, type: "boolean" } : diag("invalid_expression", "'&&'/'||' operands must be boolean");
      }
      return diag("invalid_expression", "unknown operator");
    }
    case "call": {
      for (const a of ast.arguments) {
        const ar = inferType(a, env);
        if (!ar.ok) return ar;
        if (!isNumber(ar.type)) return diag("invalid_expression", "function arguments must be number");
      }
      return { ok: true, type: "number" };
    }
    case "dice": {
      const c = inferType(ast.count, env);
      if (!c.ok) return c;
      if (!isNumber(c.type)) return diag("invalid_expression", "dice count must be a number expression");
      return { ok: true, type: "number" };
    }
    case "keep": {
      const d = inferType(ast.dice, env);
      if (!d.ok) return d;
      return { ok: true, type: "number" };
    }
    case "successCount": {
      const d = inferType(ast.dice, env);
      if (!d.ok) return d;
      return { ok: true, type: "number" };
    }
  }
}

export function resolveDependencies(ast: ExpressionAstV1): DefinitionId[] {
  const out: DefinitionId[] = [];
  const seen = new Set<string>();
  const walk = (n: ExpressionAstV1): void => {
    switch (n.kind) {
      case "reference": {
        const key = `${n.scope}:${n.id}`;
        if (!seen.has(key)) { seen.add(key); out.push(n.id); }
        return;
      }
      case "unary": walk(n.operand); return;
      case "binary": walk(n.left); walk(n.right); return;
      case "call": for (const a of n.arguments) walk(a); return;
      case "dice": walk(n.count); return;
      case "keep": walk(n.dice); return;
      case "successCount": walk(n.dice); return;
      default: return;
    }
  };
  walk(ast);
  return out;
}

export function checkDeterministic(ast: ExpressionAstV1, context: "computed" | "roll" | "validation"): PackageDiagnostic[] {
  if (context === "roll") return [];
  const out: PackageDiagnostic[] = [];
  const walk = (n: ExpressionAstV1): void => {
    if (n.kind === "dice" || n.kind === "keep" || n.kind === "successCount") {
      out.push({ code: "invalid_expression", path: "", message: "dice expressions are only valid in roll contexts" });
    }
    switch (n.kind) {
      case "unary": walk(n.operand); return;
      case "binary": walk(n.left); walk(n.right); return;
      case "call": for (const a of n.arguments) walk(a); return;
      case "dice": walk(n.count); return;
      case "keep": walk(n.dice); return;
      case "successCount": walk(n.dice); return;
      default: return;
    }
  };
  walk(ast);
  return out;
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npm test -- src/systems/implementation/rules/typecheck.test.ts`
Expected: PASS. Run `npm run typecheck` — PASS.

- [x] **Step 5: Commit**

```bash
git add src/systems/implementation/rules/typecheck.ts src/systems/implementation/rules/typecheck.test.ts
git commit -m "feat: add expression type checker and dependency resolution"
```

---

### Task 4: compileExpression

**Files:**
- Create: `src/systems/implementation/rules/compile.ts`
- Test: `src/systems/implementation/rules/compile.test.ts`

**Interfaces:**
- Consumes: `parse`, `countNodes`, `depthOf` (Task 2); `inferType`, `resolveDependencies`, `checkDeterministic`, `ExpressionCompileEnv` (Task 3); `PACKAGE_LIMITS`, `CompiledExpressionV1`, `ScalarValue`, `ValueType`, `DefinitionId` (package schema); `PackageDiagnostic` (diagnostics).
- Produces: `compileExpression(source, opts): CompileResult<CompiledExpressionBody>` and exports the `CompileResult` type and shared helper `compileAst(ast, opts)` used by `compileDocument`.

```typescript
export type CompileResult<T> =
  | { ok: true; value: T }
  | { ok: false; diagnostics: PackageDiagnostic[] };

export type CompileExpressionOpts = {
  env: ExpressionCompileEnv;
  resultType: ValueType;
  context: "computed" | "roll" | "validation";
  fallback: ScalarValue;
};

export function compileExpression(source: string, opts: CompileExpressionOpts): CompileResult<CompiledExpressionBody>;
```

Pipeline:
1. `parse(source)` — parse failure → return diagnostics.
2. `countNodes`/`depthOf` vs `PACKAGE_LIMITS.expressionAstNodes`/`expressionAstDepth` — exceed → `limit_exceeded` diagnostic.
3. `checkDeterministic(ast, context)` — any diagnostics → return.
4. `inferType(ast, env)` — failure → return.
5. Verify inferred === `opts.resultType`; if not → `invalid_expression` (declared result type mismatch).
6. Verify the runtime type of `opts.fallback` equals `opts.resultType` (number vs text vs boolean; `null` fallback not allowed for any result type because `null` is not a scalar result). Type check: number result requires `typeof fallback === "number"`; text → string; boolean → boolean. Mismatch → `invalid_expression`.
7. `const dependencies = resolveDependencies(ast)`.
8. `compileAst` assembles `CompiledExpressionV1` with `id` supplied by caller? **Decision:** `compileExpression` returns a `CompiledExpressionV1` MINUS `id`; the caller (compileDocument) assigns the id. To keep the return type simple, `compileAst` returns `{ ast, resultType, inferredType, fallback, dependencies, cost }` and `compileDocument` merges `id`. `compileExpression` likewise omits `id`. Define an internal `CompiledExpressionBody` type and have clients add `id`.
   - Since `CompiledExpressionV1` requires `id`, define:
     ```typescript
     export type CompiledExpressionBody = Omit<CompiledExpressionV1, "id">;
     export function compileAst(ast: ExpressionAstV1, opts: CompileExpressionOpts): CompileResult<CompiledExpressionBody>;
     ```
     `compileExpression(source, opts)` = `parse` then `compileAst`.
9. Compute `cost = countNodes(ast)`, `inferredType = inferred type`.

- [x] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import { compileExpression, type CompileExpressionOpts } from "./compile.js";

const env = { fields: { modifier: "number", move_stat: "number" }, inputs: { bonus: "number", forward: "number" } } as const;
const numberOpts: CompileExpressionOpts = { env: env as never, resultType: "number", context: "roll", fallback: 0 };
const boolOpts: CompileExpressionOpts = { env: env as never, resultType: "boolean", context: "validation", fallback: false };

describe("compileExpression", () => {
  it("compiles defense_expr", () => {
    const r = compileExpression("10 + fields.modifier", { ...numberOpts, context: "computed" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.dependencies).toEqual(["modifier"]);
    expect(r.value.cost).toBe(3);
    expect(r.value.inferredType).toBe("number");
    expect(r.value.resultType).toBe("number");
    expect(r.value.fallback).toBe(0);
    expect(r.value.ast).toEqual({
      kind: "binary", operator: "+",
      left: { kind: "numberLiteral", value: 10 },
      right: { kind: "reference", scope: "fields", id: "modifier" },
    });
  });

  it("rejects inferred type != declared", () => {
    const r = compileExpression("fields.modifier + 1", { ...numberOpts, resultType: "boolean" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics[0]!.code).toBe("invalid_expression");
  });

  it("rejects fallback type != result type", () => {
    const r = compileExpression("fields.modifier + 1", { ...numberOpts, fallback: "oops" });
    expect(r.ok).toBe(false);
  });

  it("rejects an expression over the node budget", () => {
    const big = "1".split(" ")[0]; // builds a large expression below
    const src = repeatBinary(300);
    const r = compileExpression(src, { ...numberOpts, context: "computed" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics.some((d) => d.code === "limit_exceeded")).toBe(true);
  });
});

function repeatBinary(count: number): string {
  const parts: string[] = [];
  for (let i = 0; i < count; i++) parts.push("1");
  return parts.join(" + ");
}
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- src/systems/implementation/rules/compile.test.ts`
Expected: FAIL (no `compileExpression`).

- [x] **Step 3: Implement compile**

```typescript
import type { PackageDiagnostic } from "../package/diagnostics.js";
import { PACKAGE_LIMITS } from "../package/limits.js";
import type { CompiledExpressionV1, ExpressionAstV1, ScalarValue, ValueType } from "../package/schema/index.js";
import { countNodes, depthOf, parse } from "./parser.js";
import { checkDeterministic, inferType, resolveDependencies, type ExpressionCompileEnv } from "./typecheck.js";

export type CompileResult<T> =
  | { ok: true; value: T }
  | { ok: false; diagnostics: PackageDiagnostic[] };

export type CompileExpressionOpts = {
  env: ExpressionCompileEnv;
  resultType: ValueType;
  context: "computed" | "roll" | "validation";
  fallback: ScalarValue;
};

export type CompiledExpressionBody = Omit<CompiledExpressionV1, "id">;

function missing(id: string): CompileResult<never> {
  return { ok: false, diagnostics: [{ code: "missing_reference", path: "", message: `unknown reference '${id}'` }] };
}

function fallbackTypeMatches(fallback: ScalarValue, resultType: ValueType): boolean {
  if (fallback === null || fallback === undefined) return false;
  if (resultType === "number") return typeof fallback === "number";
  if (resultType === "text") return typeof fallback === "string";
  return typeof fallback === "boolean";
}

export function compileAst(ast: ExpressionAstV1, opts: CompileExpressionOpts): CompileResult<CompiledExpressionBody> {
  const nodes = countNodes(ast);
  const depth = depthOf(ast);
  if (nodes > PACKAGE_LIMITS.expressionAstNodes) {
    return { ok: false, diagnostics: [{ code: "limit_exceeded", path: "", message: "expression exceeds node budget" }] };
  }
  if (depth > PACKAGE_LIMITS.expressionAstDepth) {
    return { ok: false, diagnostics: [{ code: "limit_exceeded", path: "", message: "expression exceeds depth budget" }] };
  }
  const det = checkDeterministic(ast, opts.context);
  if (det.length > 0) return { ok: false, diagnostics: det };
  const inferred = inferType(ast, opts.env);
  if (!inferred.ok) return { ok: false, diagnostics: inferred.diagnostics };
  if (inferred.type !== opts.resultType) {
    return { ok: false, diagnostics: [{ code: "invalid_expression", path: "", message: `inferred type ${inferred.type} does not match declared ${opts.resultType}` }] };
  }
  if (!fallbackTypeMatches(opts.fallback, opts.resultType)) {
    return { ok: false, diagnostics: [{ code: "invalid_expression", path: "", message: "fallback type does not match result type" }] };
  }
  return {
    ok: true,
    value: {
      resultType: opts.resultType,
      inferredType: inferred.type,
      fallback: opts.fallback,
      dependencies: resolveDependencies(ast),
      cost: nodes,
      ast,
    },
  };
}

export function compileExpression(source: string, opts: CompileExpressionOpts): CompileResult<CompiledExpressionBody> {
  const parsed = parse(source);
  if (!parsed.ok) return { ok: false, diagnostics: parsed.diagnostics };
  return compileAst(parsed.ast, opts);
}
```

Note: the plan keeps `compileExpression` returning `CompiledExpressionBody` (no id); `compileDocument` (Task 6) adds the id. This is a deliberate, small deviation so a single expression isn't forced to invent an id. The spec (`§5`, `§12`) has ALREADY been updated to match — no further spec edit is needed in this task.

- [x] **Step 4: Run test**

Run: `npm test -- src/systems/implementation/rules/compile.test.ts` — PASS.
Run `npm run typecheck` — PASS.

- [x] **Step 5: Commit**

```bash
git add src/systems/implementation/rules/compile.ts src/systems/implementation/rules/compile.test.ts docs/superpowers/specs/2026-09-04-system-expression-engine-design.md
git commit -m "feat: compile source expressions into compiled bodies"
```

---

### Task 5: Correct fixture cost values

**Files:**
- Modify: `src/systems/implementation/package/fixtures/d20.ts`, `src/systems/implementation/package/fixtures/pbta-2d6.ts`
- Test: existing `src/systems/implementation/package/fixtures/fixtures.test.ts` (run to confirm still green); `src/systems/implementation/package/schema/package.test.ts` (unchanged but must pass).

**Interfaces:**
- Consumes: node counts established in Task 2 (`countNodes`); the ASTs already in the fixture `unsignedPackage` structures.
- Produces: corrected `cost` values; regenerated signed package checksums.

Per spec §11.1, correct these recorded `cost` values to their AST node counts:

- d20 `check_expr`: 6
- d20 `ability_valid_expr`: 7
- pbta `penalty_expr`: 3
- pbta `move_expr`: 6
- pbta `stat_valid_expr`: 7

The d6-success-pool fixture is already correct.

Because the fixture packages are signed with a checksum over the canonical package, fix `cost` in the `unsignedPackage` body then re-sign. The fixtures export a `const d20Package = signSystemPackage(unsignedPackage)` — so editing `cost` in `unsignedPackage` and running the fixtures module test re-signs at module load time, regenerating checksums automatically. No manual checksum editing needed; the test suite recomputes.

- [x] **Step 1: Write the failing assertion (cost == node count)**

Add to `fixtures.test.ts` a check that each fixture's recorded cost equals its AST node count, using `countNodes` from the new rules module:

```typescript
import { countNodes } from "../../rules/parser.js";
import { d20Package, pbta2d6Package, d6SuccessPoolPackage } from "./index.js";

const pkgs = [d20Package, pbta2d6Package, d6SuccessPoolPackage];
it("records cost equal to AST node count for every expression", () => {
  for (const pkg of pkgs) {
    for (const expr of pkg.expressions) {
      expect(expr.cost, `cost of ${expr.id}`).toBe(countNodes(expr.ast));
    }
  }
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- src/systems/implementation/package/fixtures/fixtures.test.ts`
Expected: FAIL (d20 `check_expr` 4≠6, `ability_valid_expr` 9≠7; pbta `penalty_expr` 2≠3, `move_expr` 4≠6, `stat_valid_expr` 9≠7).

- [x] **Step 3: Correct the fixture cost values**

In `d20.ts` change `check_expr` `cost: 4` → `cost: 6` and `ability_valid_expr` `cost: 9` → `cost: 7`.
In `pbta-2d6.ts` change `penalty_expr` `cost: 2` → `cost: 3`, `move_expr` `cost: 4` → `cost: 6`, `stat_valid_expr` `cost: 9` → `cost: 7`.

(Verify against Task 2 node counts before editing: `check_expr` nodes = 6, `ability_valid_expr` = 7, `penalty_expr` = 3, `move_expr` = 6, `stat_valid_expr` = 7.)

- [x] **Step 4: Run test and regenerate contracts**

Run: `npm test -- src/systems/implementation/package/fixtures/fixtures.test.ts` — PASS.
Run: `npm test` — PASS (checks `package.test.ts` and others unaffected).
Run: `npm run contracts:generate` to regenerate any embedded fixture artifacts, then `npm run contracts:check` to confirm consistency. Commit any regenerated artifact changes.

- [x] **Step 5: Commit**

```bash
git add src/systems/implementation/package/fixtures/d20.ts src/systems/implementation/package/fixtures/pbta-2d6.ts src/systems/implementation/package/fixtures/fixtures.test.ts docs/contracts
git commit -m "fix: record cost equal to AST node count in fixtures"
```

---

### Task 6: compileDocument

**Files:**
- Create: `src/systems/implementation/rules/compile-document.ts`
- Test: `src/systems/implementation/rules/compile-document.test.ts`

**Interfaces:**
- Consumes: `compileAst` (Task 4); `inferType` + `ExpressionCompileEnv` (Task 3); fixture documents `d20Document`, `pbta2d6Document`, `d6SuccessPoolDocument` from `../package/fixtures/index.js`; `signSystemPackage` from `../package/canonical.js`; package schema types.
- Produces: `compileDocument(document, opts): CompileResult<SystemPackageV1>`.

```typescript
export type CompileDocumentOpts = {
  systemId: string;
  versionId: string;
  semanticVersion: string;
};
export function compileDocument(document: SystemDocumentV1, opts: CompileDocumentOpts): CompileResult<SystemPackageV1>;
```

`compileDocument`:
1. Build `env.fields` from `document.entities[].fields[]` and `env.inputs` from `document.actions[]` (only `roll` actions have inputs).
   Field → `ValueType` mapping (spec §13):
   - `text` → `text`
   - `integer`, `decimal` → `number`
   - `boolean` → `boolean`
   - `singleChoice`, `multiChoice` → `text`
   - `resource` → `number`
   - `computed` → its `valueType` (number/text/boolean)
   - `image` → skipped (not addressable)
   Duplicate field ids across entities: the structural codec already rejects duplicate definition ids; here, if a duplicate appears, keep the first.
2. For each `document.expressions`, call `compileExpression(expr.source, { env, resultType: expr.resultType, context: expr.context, fallback: expr.fallback })`. This parses internally and returns a `CompiledExpressionBody`. If any expression fails, return the combined diagnostics with `path` set to the expression id; never return a partial package.
3. Assemble `UnsignedSystemPackageV1`:
   ```typescript
   const unsigned: UnsignedSystemPackageV1 = {
     schemaVersion: "1.0",
     systemId: opts.systemId,
     versionId: opts.versionId,
     semanticVersion: opts.semanticVersion,
     name: document.metadata.name,
     description: document.metadata.description,
     language: document.metadata.language,
     defaultDice: document.metadata.defaultDice,
     entities: document.entities,
     referenceData: document.referenceData,
     sheets: document.sheets,
     expressions: compiled.map((b, i) => ({ id: document.expressions[i]!.id, ...b })),
     actions: document.actions,
     validations: document.validations,
     effectiveLimits: {
       expressionBytes: PACKAGE_LIMITS.expressionBytes,
       expressionAstNodes: PACKAGE_LIMITS.expressionAstNodes,
       expressionAstDepth: PACKAGE_LIMITS.expressionAstDepth,
       dicePerRoll: PACKAGE_LIMITS.dicePerRoll,
       sidesPerDie: PACKAGE_LIMITS.sidesPerDie,
     },
   };
   ```
4. `return { ok: true, value: signSystemPackage(unsigned) }`.

- [x] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import { d20Document, d6SuccessPoolDocument, pbta2d6Document } from "../package/fixtures/index.js";
import { compileDocument } from "./compile-document.js";

const opts = { systemId: "a0000000-0000-5000-8000-000000000001", versionId: "a0000000-0000-5000-8000-000000000002", semanticVersion: "1.0.0" };

describe("compileDocument", () => {
  it("reproduces the d20 package fixture", () => {
    const r = compileDocument(d20Document, opts);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.expressions).toHaveLength(3);
    expect(r.value.expressions.map((e) => e.cost)).toEqual([3, 6, 7]);
    expect(r.value.integrity.checksum).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("compiles the 2d6 document", () => {
    const r = compileDocument(pbta2d6Document, opts);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.expressions.map((e) => e.cost)).toEqual([3, 6, 7]);
  });

  it("compiles the d6 pool document", () => {
    const r = compileDocument(d6SuccessPoolDocument, opts);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.expressions.map((e) => e.cost)).toEqual([3, 7, 7]);
  });

  it("rejects a document with an invalid expression", () => {
    const bad = structuredClone(d20Document);
    bad.expressions[0]!.source = "fields.nope + 1";
    const r = compileDocument(bad, opts);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics[0]!.code).toBe("missing_reference");
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- src/systems/implementation/rules/compile-document.test.ts`
Expected: FAIL (no `compileDocument`).

- [x] **Step 3: Implement compileDocument**

Implement per the specification above. Use `fixtures/index.ts` to confirm the exported document names (`d20Document`, `pbta2d6Document`, `d6SuccessPoolDocument` — check the actual export names in `fixtures/index.ts` and adjust the test imports to match).

- [x] **Step 4: Run test to verify it passes**

Run: `npm test -- src/systems/implementation/rules/compile-document.test.ts` — PASS. Run `npm run typecheck` — PASS. Confirm the compiled `expressions` ASTs equal the committed fixture ASTs by asserting `r.value.expressions[i].ast` deep-equality against the fixture `*Package.expressions[i].ast`.

- [x] **Step 5: Commit**

```bash
git add src/systems/implementation/rules/compile-document.ts src/systems/implementation/rules/compile-document.test.ts
git commit -m "feat: compile system documents into signed packages"
```

---

### Task 7: Deterministic evaluator

**Files:**
- Create: `src/systems/implementation/rules/evaluate.ts`
- Test: `src/systems/implementation/rules/evaluate.test.ts`

**Interfaces:**
- Consumes: `CompiledExpressionV1` from package schema; `ScalarValue` type; the `arithmetic_failure` runtime code.
- Produces: `evaluate(compiled, bindings, rng?)` and the `Rng`, `RollResult`, `DieResult`, `RuntimeDiagnostic` types.

```typescript
export type Rng = () => number;
export type RuntimeDiagnostic = { code: "arithmetic_failure"; path: string; message: string };
export type DieResult = { sides: number; value: number; kept: boolean };
export type RollResult = { total: number; dice: DieResult[]; expression: string };
export type EvalResult =
  | { ok: true; roll: RollResult | null; result: ScalarValue; diagnostics: RuntimeDiagnostic[] }
  | { ok: false; diagnostics: RuntimeDiagnostic[] };

export function evaluate(
  compiled: CompiledExpressionV1,
  bindings: Record<string, ScalarValue>,
  rng?: Rng,
): EvalResult;
```

Failed evaluation (e.g., a required reference bound to `null`/missing at a point that cannot produce a valid result, or a non-boolean in a boolean position at runtime) — per design, "safe arithmetic failures produce the declared fallback plus a runtime diagnostic"; unrecoverable mismatches should fall back too. The evaluator returns `ok: true` with the fallback value and a diagnostic whenever a safe runtime failure occurs (division by zero, reference missing/`null`, non-numeric where numeric required, non-boolean where boolean required). `ok: false` is reserved for structurally impossible misconfiguration (defensive, not expected from compiler output).

Evaluation semantics:
- `numberLiteral` → value.
- `booleanLiteral`/`stringLiteral` → value.
- `reference` → `bindings[id]`; if missing or `null`, safe-fail → fallback + diagnostic.
- unary `-` → negate numeric; `!` → logical not of boolean.
- binary arithmetic `+ - * /`: both numeric; `/` by zero → safe-fail to fallback + diagnostic; otherwise result.
- binary comparison → boolean.
- equality `==`/`!=` → compare (numbers numerically, strings/booleans by value).
- `&&`/`||` → short-circuit booleans.
- `min`/`max` → min/max of two numbers.
- `round` → per mode.
- `dice` → roll `count` dice of `sides` via rng, sum them; produce `DieResult`s; the total is a number. If the count is not a non-negative integer (e.g., negative), safe-fail → fallback.
- `keep` → roll dice, collect die results, keep the highest/lowest `count`, sum kept; `kept` on retained dice = true, discarded = false.
- `successCount` → roll dice, count values >= threshold, every die kept=true; total = count.
- A top-level expression containing any roll node returns a `RollResult` (non-null `roll`); otherwise `roll` is `null` and `result` is the scalar.

RollResult assembly: roll nodes produce `DieResult[]`; modifiers (non-roll arithmetic) contribute to `total` but add no dice. For `keep`, `dice` list contains all rolled dice with `kept` flags. For `successCount`, all dice kept=true and `total` = count.

The evaluator must detect the presence of any roll node via `compiled.ast` (walk) to decide whether to return a `RollResult`. Reuse a small `containsRoll(ast)` walker (define locally).

Determinism: call `rng` (default `Math.random`) exactly in left-to-right, depth-first roll order.

- [x] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import { compileExpression, type CompileExpressionOpts } from "./compile.js";
import { evaluate } from "./evaluate.js";

const env = { fields: { modifier: "number" }, inputs: {} } as const;
const rollOpts: CompileExpressionOpts = { env: env as never, resultType: "number", context: "roll", fallback: 0 };

function compile(src: string, opts: CompileExpressionOpts = rollOpts) {
  const r = compileExpression(src, opts);
  if (!r.ok) throw new Error("compile fail");
  return r.value as never;
}
// deterministic rng that yields the sequence [0, 0.1, 0.2, ...]
function seqRng(seq: number[]): () => number { let i = 0; return () => seq[i++]!; }

describe("evaluate", () => {
  it("evaluates arithmetic against bindings", () => {
    const r = evaluate(compile("10 + fields.modifier"), { modifier: 7 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result).toBe(17);
    expect(r.roll).toBeNull();
    expect(r.diagnostics).toEqual([]);
  });

  it("rolls a d20 deterministically with a seeded rng", () => {
    const r = evaluate(compile("d20"), {}, seqRng([0.05]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.roll).not.toBeNull();
    if (!r.roll) return;
    expect(r.roll.dice).toEqual([{ sides: 20, value: 1, kept: true }]);
    expect(r.roll.total).toBe(1);
  });

  it("handles division by zero via fallback + diagnostic", () => {
    const r = evaluate(compile("1 / fields.modifier", { ...rollOpts, context: "computed" }), { modifier: 0 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result).toBe(0);
    expect(r.diagnostics.length).toBeGreaterThan(0);
    expect(r.diagnostics[0]!.code).toBe("arithmetic_failure");
  });

  it("returns individual dice for successCount", () => {
    const src = "countSuccesses(dice(3, 6), 4)";
    const r = evaluate(compile(src), {}, seqRng([0.1, 0.9, 0.95]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.roll!.dice.map((d) => [d.sides, d.value, d.kept])).toEqual([
      [6, 1, true], [6, 6, true], [6, 6, true],
    ]);
    expect(r.roll!.total).toBe(2);
  });

  it("rounds per mode", () => {
    const up = evaluate(compile("round(2.4, up)"), {});
    expect(up.ok && up.result).toBe(3);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- src/systems/implementation/rules/evaluate.test.ts`
Expected: FAIL (no `evaluate`).

- [x] **Step 3: Implement evaluate**

Implement per the semantics above. Structure: a recursive `evalNode(node, ctx)` where ctx carries bindings, rng, and a list of `DieResult` and diagnostics; returns either a scalar value or a mark that a safe failure occurred (return `undefined` to signal failure and trigger fallback at the top). Because `CompiledExpressionV1` includes `fallback`, the top-level failure path returns `{ ok: true, result: fallback, diagnostics, roll }`.

Carefully handle short-circuit `&&`/`||` (only evaluate the needed side) while still collecting dice deterministically.

- [x] **Step 4: Run test to verify it passes**

Run: `npm test -- src/systems/implementation/rules/evaluate.test.ts` — PASS. Run `npm run typecheck` — PASS.

- [x] **Step 5: Commit**

```bash
git add src/systems/implementation/rules/evaluate.ts src/systems/implementation/rules/evaluate.test.ts
git commit -m "feat: add deterministic expression evaluator"
```

---

### Task 8: renderExpression

**Files:**
- Create: `src/systems/implementation/rules/render.ts`
- Test: `src/systems/implementation/rules/render.test.ts`

**Interfaces:**
- Consumes: `ExpressionAstV1`; parse output from Task 2.
- Produces: `renderExpression(ast: ExpressionAstV1): string`.

`renderExpression` produces canonical source text per spec §15:
- Parenthesize binary nodes only where needed given precedence (left child needs parens if its precedence < the node's; right child needs parens if its precedence <= the node's for left-assoc operators). Unary `-`/`!` operand must be parenthesized if it is a binary of lower precedence.
- `dice`: count 1 → `d<sides>`; count N → `<N>d<sides>`.
- `keep`: `dice` node with keep count K, mode highest → `<count>d<sides>kh<K>`; lowest → `kl<K>`. If `keep.dice` is a plain `dice` node with a literal count, render the combined form; otherwise render `keep(mode, count, dice)` form. **Decision:** the keep node in fixtures carries a literal-count `dice`; render combined notation for that shape, and for non-literal-count keep use a `keep(...)` function form. For simplicity and to match `render->parse` round-trip, always render `keep` as: if `keep.dice.kind === "dice"` and `keep.dice.count.kind === "numberLiteral"`, render `<count>d<sides>kh|kl<K>`; else render a paren-wrapped functional form. Because the parser handles `kh`/`kl` notation, rendering `4d6kh3` from such a keep node round-trips.
- `successCount` → `countSuccesses(<dice>, <threshold>)`.
- `call` → `min(a, b)`, `max(a, b)`, `round(a)`, `round(a, mode)`.
- operators render with their symbols; numbers render via `String(value)` where integer-valued decimals drop the trailing `.0` (use `Number.isInteger(value) ? String(value) : String(value)`).
- references render as `fields.<id>` / `inputs.<id>`.
- literals: numbers, `true`/`false`, strings quoted with double quotes.

- [x] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import { parse } from "./parser.js";
import { renderExpression } from "./render.js";

function render(src: string): string {
  const r = parse(src);
  if (!r.ok) throw new Error("parse fail");
  return renderExpression(r.ast);
}

describe("renderExpression", () => {
  it("renders defense_expr canonically", () => {
    expect(render("10 + fields.modifier")).toBe("10 + fields.modifier");
  });
  it("renders a d20 dice", () => {
    expect(render("d20")).toBe("d20");
  });
  it("renders keep notation", () => {
    expect(render("4d6kh3")).toBe("4d6kh3");
  });
  it("renders successCount", () => {
    expect(render("countSuccesses(dice(2, 6), 4)")).toBe("countSuccesses(dice(2, 6), 4)");
  });
  it("adds parentheses only where needed", () => {
    expect(render("(1 + 2) * 3")).toBe("(1 + 2) * 3");
    expect(render("1 + 2 * 3")).toBe("1 + 2 * 3");
    expect(render("1 + (2 * 3)")).toBe("1 + 2 * 3");
  });
  it("drops trailing decimal zeros", () => {
    expect(render("-1")).toBe("-1");
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- src/systems/implementation/rules/render.test.ts`
Expected: FAIL (no `renderExpression`).

- [x] **Step 3: Implement renderExpression**

Implement per the rules above with a precedence-aware recursive renderer.

- [x] **Step 4: Run test to verify it passes**

Run: `npm test -- src/systems/implementation/rules/render.test.ts` — PASS. Run `npm run typecheck` — PASS.

- [x] **Step 5: Commit**

```bash
git add src/systems/implementation/rules/render.ts src/systems/implementation/rules/render.test.ts
git commit -m "feat: render expressions to canonical source text"
```

---

### Task 9: Package barrel and wire-up

**Files:**
- Modify: `src/systems/implementation/rules/index.ts` (currently `export {};`)
- Test: `src/systems/implementation/rules/index.test.ts` (optional smoke test)

**Interfaces:**
- Consumes: all tasks above.
- Produces: the public rules barrel exporting exactly `compileExpression`, `compileDocument`, `evaluate`, `renderExpression`, plus the public input/output types they consume (`CompileResult`, `CompileExpressionOpts`, `CompileDocumentOpts`, `ExpressionCompileEnv`, `CompiledExpressionBody`, `Rng`, `RollResult`, `DieResult`, `RuntimeDiagnostic`, `EvalResult`).

Replace `src/systems/implementation/rules/index.ts`:

```typescript
export { compileExpression } from "./compile.js";
export type { CompileResult, CompileExpressionOpts, CompiledExpressionBody } from "./compile.js";
export { compileDocument } from "./compile-document.js";
export type { CompileDocumentOpts } from "./compile-document.js";
export { evaluate } from "./evaluate.js";
export type { Rng, RollResult, DieResult, RuntimeDiagnostic, EvalResult } from "./evaluate.js";
export { renderExpression } from "./render.js";
export type { ExpressionCompileEnv } from "./typecheck.js";
```

`compileAst` is NOT exported from the barrel. It remains `export`ed from `./compile.js` so `compile-document.ts` can import it via a relative import, but it is not part of the public rules surface.

Do NOT export the tokenizer, parser, type checker, or render internals beyond `renderExpression`.

- [x] **Step 1: Write/edit the barrel and a smoke test**

```typescript
import { describe, expect, it } from "vitest";
import { compileExpression, evaluate, renderExpression } from "./index.js";

it("exports the public engine functions", () => {
  expect(typeof compileExpression).toBe("function");
  expect(typeof evaluate).toBe("function");
  expect(typeof renderExpression).toBe("function");
});
```

- [x] **Step 2: Run the full test suite**

Run: `npm test` — all tests pass. Run `npm run typecheck` and `npm run build` — both pass.

- [x] **Step 3: Commit**

```bash
git add src/systems/implementation/rules/index.ts src/systems/implementation/rules/index.test.ts
git commit -m "feat: expose expression engine public surface"
```

---

### Task 10: Acceptance and regression verification

**Files:**
- Test: `src/systems/implementation/rules/property.test.ts` (new)

**Interfaces:**
- Consumes: all engine functions.

- [x] **Step 1: Add property tests**

Add a property test (deterministic pseudo-random, no external fuzz library) that generates random arithmetic ASTs within budget and asserts:
1. `evaluate(compiled, bindings, rng)` with a fixed seeded rng returns the same result twice.
2. `render -> parse -> typecheck` round-trips: `parse(renderExpression(ast))` yields an equivalent AST.

Reference already-compiled fixture expressions so the property tests reuse realistic shapes.

- [x] **Step 2: Run full verification**

Run: `npm test` — full unit suite green.
Run: `npm run typecheck` — green.
Run: `npm run build` — green.
Run: `npm run contracts:generate` then `npm run contracts:check` — consistent (fixture cost change regenerates any embedded artifacts; commit any diffs).
Run integration tests (`TEST_DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll npm run test:integration`) — the 9 existing integration tests still pass (this increment adds none).

- [x] **Step 3: Scope check**

Confirm `git diff <baseline>..HEAD -- src/systems/authoring.ts src/systems/runtime.ts src/transport src/bootstrap` is empty (no HTTP/`SystemRuntime` changes).
Scan the new rules code for sensitive data: no `ownerId|actorId|email|token|audit` literals.

- [x] **Step 4: Commit**

```bash
git add src/systems/implementation/rules/property.test.ts
git commit -m "test: add expression engine property tests"
```

- [x] **Step 5: Final whole-plan review**

Dispatch a reviewer subagent over the full branch diff (per the superpowers review workflow) and address findings before finishing the branch.
