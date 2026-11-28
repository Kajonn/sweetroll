import type { ExpressionAstV1 } from "../package/schema/index.js";
import type { PoolAst } from "../package/schema/expression.js";
import { children } from "./groups.js";
import { tokenize, type Token, type FunctionName } from "./tokenizer.js";
import type { RulesDiagnostic } from "./diagnostic.js";

type BinaryOp = "+" | "-" | "*" | "/" | "%" | "==" | "!=" | "<" | "<=" | ">" | ">=" | "&&" | "||";

export type ParseResult =
  | { ok: true; ast: ExpressionAstV1 }
  | { ok: false; diagnostics: RulesDiagnostic[] };

export function countNodes(ast: ExpressionAstV1): number {
  return 1 + children(ast).reduce((sum, child) => sum + countNodes(child), 0);
}

export function depthOf(ast: ExpressionAstV1): number {
  return 1 + Math.max(0, ...children(ast).map(depthOf));
}

function literal(value: number): ExpressionAstV1 {
  return { kind: "numberLiteral", value };
}

const reducers = ["keepHighest", "keepLowest", "countAtLeast", "countAtMost", "countEqual"] as const;
type ReducerName = typeof reducers[number];
function isReducer(name: string): name is ReducerName {
  return reducers.some((reducer) => reducer === name);
}

class Parser {
  private tokens: Token[] = [];
  private pos = 0;
  private errors: RulesDiagnostic[] = [];

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
  private fail(msg: string, code: RulesDiagnostic["code"] = "invalid_syntax"): void { this.errors.push({ code, path: "", message: msg }); }

  private at(kind: string): boolean {
    const t = this.peek(); return t !== undefined && t.kind === kind;
  }

  private peekOp(op: string): boolean {
    const t = this.peek(); return t !== undefined && t.kind === "operator" && t.op === op;
  }

  private peekOpIn(ops: string[]): boolean {
    const t = this.peek(); return t !== undefined && t.kind === "operator" && ops.includes(t.op);
  }

  private parseOr(): ExpressionAstV1 | undefined {
    let left = this.parseAnd();
    while (left && this.peekOp("||")) {
      this.take();
      const right = this.parseAnd();
      if (!right) return undefined;
      left = { kind: "binary", operator: "||", left, right };
    }
    return left;
  }
  private parseAnd(): ExpressionAstV1 | undefined {
    let left = this.parseEquality();
    while (left && this.peekOp("&&")) {
      this.take();
      const right = this.parseEquality();
      if (!right) return undefined;
      left = { kind: "binary", operator: "&&", left, right };
    }
    return left;
  }
  private parseEquality(): ExpressionAstV1 | undefined {
    let left = this.parseComparison();
    while (left && this.peekOpIn(["==", "!="])) {
      const op = this.take()! as Extract<Token, { kind: "operator" }>;
      const right = this.parseComparison();
      if (!right) return undefined;
      left = { kind: "binary", operator: op.op as BinaryOp, left, right };
    }
    return left;
  }
  private parseComparison(): ExpressionAstV1 | undefined {
    let left = this.parseAdditive();
    while (left && this.peekOpIn(["<", "<=", ">", ">="])) {
      const op = this.take()! as Extract<Token, { kind: "operator" }>;
      const right = this.parseAdditive();
      if (!right) return undefined;
      left = { kind: "binary", operator: op.op as BinaryOp, left, right };
    }
    return left;
  }
  private parseAdditive(): ExpressionAstV1 | undefined {
    let left = this.parseMultiplicative();
    while (left && this.peekOpIn(["+", "-"])) {
      const op = this.take()! as Extract<Token, { kind: "operator" }>;
      const right = this.parseMultiplicative();
      if (!right) return undefined;
      left = { kind: "binary", operator: op.op as BinaryOp, left, right };
    }
    return left;
  }
  private parseMultiplicative(): ExpressionAstV1 | undefined {
    let left = this.parseUnary();
    while (left && this.peekOpIn(["*", "/", "%"])) {
      const op = this.take()! as Extract<Token, { kind: "operator" }>;
      const right = this.parseUnary();
      if (!right) return undefined;
      left = { kind: "binary", operator: op.op as BinaryOp, left, right };
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
      case "string": return { kind: "stringLiteral", value: t.value };
      case "boolean": return { kind: "booleanLiteral", value: t.value };
      case "id": return { kind: "reference", scope: t.scope, id: t.id, ...(t.part && { part: t.part }) };
      case "dice": {
        const pool: PoolAst = { kind: "pool", source: { kind: "dice", count: literal(t.count), sides: literal(t.sides) }, modifiers: [] };
        if (t.keep) pool.reducer = { kind: t.keep.mode === "highest" ? "keepHighest" : "keepLowest", amount: literal(t.keep.count) };
        return pool;
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
  private parseCall(name: FunctionName): ExpressionAstV1 | undefined {
    if (!this.at("lparen")) { this.fail(`expected '(' after ${name}`); return undefined; }
    this.take();
    const args: ExpressionAstV1[] = [];
    let roundMode: "nearest" | "down" | "up" | undefined;
    while (!this.at("rparen")) {
      if (name === "round" && args.length === 1 && this.at("roundMode")) {
        const rm = this.take()! as Extract<Token, { kind: "roundMode" }>;
        roundMode = rm.mode;
        break;
      }
      const arg = this.parseOr();
      if (!arg) return undefined;
      args.push(arg);
      if (this.at("comma")) {
        this.take();
        if (this.at("rparen")) { this.fail("expected an argument after comma"); return undefined; }
        continue;
      }
      break;
    }
    if (!this.at("rparen")) { this.fail("missing closing paren"); return undefined; }
    this.take();
    const [first, second, third] = args;
    if (name === "dice" && args.length === 2) {
      const source = second?.kind === "stringLiteral"
        ? { kind: "custom", count: first!, dieId: second.value } as const
        : { kind: "dice", count: first!, sides: second! } as const;
      return { kind: "pool", source, modifiers: [] };
    }
    if (name === "rolled" && args.length === 1 && first?.kind === "stringLiteral") {
      return { kind: "pool", source: { kind: "rolled", groupId: first.value }, modifiers: [] };
    }
    if (name === "group" && args.length === 3 && first?.kind === "stringLiteral" &&
        second?.kind === "stringLiteral" && third?.kind === "pool" && third.source.kind !== "rolled" && !third.group) {
      return { ...third, group: { id: first.value, label: second.value } };
    }
    if (name === "explode" || name === "rerollOnce") {
      const validArity = args.length === 2 || (name === "explode" && args.length === 1);
      if (validArity && first?.kind === "pool" && first.source.kind !== "rolled" &&
          !first.reducer && !first.modifiers.some((modifier) => modifier.kind === name)) {
        const modifier = name === "rerollOnce" ? { kind: name, face: second! } as const
          : { kind: name, ...(second && { face: second }) } as const;
        return { ...first, modifiers: [...first.modifiers, modifier] };
      }
      this.fail(`${name} expects an unreduced dice pool and ${name === "explode" ? "an optional" : "a"} face`);
      return undefined;
    }
    if (name === "countSymbol") {
      if (args.length === 2 && first?.kind === "pool" && !first.reducer && second?.kind === "stringLiteral") {
        return { ...first, reducer: { kind: "countSymbol", symbol: second.value } };
      }
      this.fail("countSymbol expects a direct dice expression or rolled group and a quoted symbol ID", "invalid_expression");
      return undefined;
    }
    if (name === "countSuccesses" || isReducer(name)) {
      if (args.length === 2 && first?.kind === "pool" && !first.reducer) {
        return { ...first, reducer: { kind: name === "countSuccesses" ? "countAtLeast" : name, amount: second! } };
      }
      this.fail(`${name} expects a direct dice expression or rolled group and a numeric argument`, "invalid_expression");
      return undefined;
    }
    if (name === "dice" || name === "group" || name === "rolled") {
      const expected = { dice: "a count and numeric sides or a quoted custom die ID", group: "an ID, label and dice pool", rolled: "a quoted group ID" };
      this.fail(`${name} expects ${expected[name]}`);
      return undefined;
    }
    const call: ExpressionAstV1 = { kind: "call", function: name, arguments: args };
    if (roundMode) call.roundMode = roundMode;
    return call;
  }
  private parseAdvDis(which: "adv" | "dis"): ExpressionAstV1 | undefined {
    if (!this.at("lparen")) { this.fail("expected '(' after " + which); return undefined; }
    this.take();
    const t = this.take();
    if (!t || t.kind !== "dice" || t.count !== 1 || t.keep) { this.fail(which + " expects a single die such as d20"); return undefined; }
    if (!this.at("rparen")) { this.fail("missing closing paren"); return undefined; }
    this.take();
    return {
      kind: "pool",
      source: { kind: "dice", count: literal(2), sides: literal(t.sides) },
      modifiers: [],
      reducer: { kind: which === "adv" ? "keepHighest" : "keepLowest", amount: literal(1) },
    };
  }
}

export function parse(source: string): ParseResult {
  const p = new Parser(source);
  return p.parse();
}
