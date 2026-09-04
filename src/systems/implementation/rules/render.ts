import type { ExpressionAstV1 } from "../package/schema/index.js";

const PREC: Record<string, number> = {
  "||": 1,
  "&&": 2,
  "==": 3, "!=": 3,
  "<": 4, "<=": 4, ">": 4, ">=": 4,
  "+": 5, "-": 5,
  "*": 6, "/": 6,
};

const UNARY_PREC = 7;

function precOf(op: string): number {
  return PREC[op] ?? 0;
}

function isAtom(ast: ExpressionAstV1): boolean {
  switch (ast.kind) {
    case "numberLiteral":
    case "stringLiteral":
    case "booleanLiteral":
    case "reference":
    case "dice":
    case "keep":
    case "successCount":
    case "call":
      return true;
    default:
      return false;
  }
}

function renderNode(ast: ExpressionAstV1): string {
  switch (ast.kind) {
    case "numberLiteral":
      return String(ast.value);
    case "stringLiteral":
      return `"${ast.value}"`;
    case "booleanLiteral":
      return ast.value ? "true" : "false";
    case "reference":
      return `${ast.scope}.${ast.id}`;
    case "unary": {
      const operand = renderOperand(ast.operand, UNARY_PREC, "right");
      return `${ast.operator}${operand}`;
    }
    case "binary": {
      const myPrec = precOf(ast.operator);
      const left = renderOperand(ast.left, myPrec, "left");
      const right = renderOperand(ast.right, myPrec, "right");
      return `${left} ${ast.operator} ${right}`;
    }
    case "call": {
      const args = ast.arguments.map(renderNode).join(", ");
      if (ast.function === "round" && ast.roundMode !== undefined) {
        return `round(${args}, ${ast.roundMode})`;
      }
      return `${ast.function}(${args})`;
    }
    case "dice": {
      if (
        ast.count.kind === "numberLiteral" &&
        ast.count.value === 1
      ) {
        return `d${ast.sides}`;
      }
      return `dice(${renderNode(ast.count)}, ${ast.sides})`;
    }
    case "keep": {
      if (
        ast.dice.kind === "dice" &&
        ast.dice.count.kind === "numberLiteral"
      ) {
        const countVal = ast.dice.count.value;
        const mode = ast.mode === "highest" ? "kh" : "kl";
        return `${countVal}d${ast.dice.sides}${mode}${ast.count}`;
      }
      const mode = ast.mode === "highest" ? "highest" : "lowest";
      return `keep(${mode}, ${ast.count}, ${renderNode(ast.dice)})`;
    }
    case "successCount":
      return `countSuccesses(${renderNode(ast.dice)}, ${ast.threshold})`;
  }
}

function renderOperand(
  ast: ExpressionAstV1,
  parentPrec: number,
  side: "left" | "right",
): string {
  if (ast.kind === "binary") {
    const childPrec = precOf(ast.operator);
    const needsParens = side === "left"
      ? childPrec < parentPrec
      : childPrec <= parentPrec;
    if (needsParens) {
      return `(${renderNode(ast)})`;
    }
  }
  if (ast.kind === "unary") {
    if (UNARY_PREC < parentPrec) {
      return `(${renderNode(ast)})`;
    }
  }
  if (isAtom(ast) || ast.kind === "unary" || ast.kind === "binary") {
    return renderNode(ast);
  }
  return `(${renderNode(ast)})`;
}

export function renderExpression(ast: ExpressionAstV1): string {
  return renderNode(ast);
}
