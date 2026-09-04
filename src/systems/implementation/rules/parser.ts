import type { ExpressionAstV1 } from "../package/schema/index.js";
import { tokenize, type Token } from "./tokenizer.js";
import type { RulesDiagnostic } from "./diagnostic.js";

type BinaryOp = "+" | "-" | "*" | "/" | "==" | "!=" | "<" | "<=" | ">" | ">=" | "&&" | "||";

export type ParseResult =
  | { ok: true; ast: ExpressionAstV1 }
  | { ok: false; diagnostics: RulesDiagnostic[] };

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
  private fail(msg: string): void { this.errors.push({ code: "invalid_syntax", path: "", message: msg }); }

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
    while (left && this.peekOpIn(["*", "/"])) {
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
    if (this.at("rparen")) { this.take(); return { kind: "call", function: name, arguments: [] }; }
    const args: ExpressionAstV1[] = [];
    let roundMode: "nearest" | "down" | "up" | undefined;
    for (;;) {
      if (name === "round" && args.length === 1 && this.at("roundMode")) {
        const rm = this.take()! as Extract<Token, { kind: "roundMode" }>;
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
    const call: ExpressionAstV1 = { kind: "call", function: name, arguments: args };
    if (roundMode) call.roundMode = roundMode;
    return call;
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

export function parse(source: string): ParseResult {
  const p = new Parser(source);
  return p.parse();
}
