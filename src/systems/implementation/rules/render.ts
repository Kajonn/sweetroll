import type { ExpressionAstV1 } from "../package/schema/index.js";

const PREC: Record<string, number> = {
  "||": 1,
  "&&": 2,
  "==": 3, "!=": 3,
  "<": 4, "<=": 4, ">": 4, ">=": 4,
  "+": 5, "-": 5,
  "*": 6, "/": 6, "%": 6,
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
    case "pool":
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
      return JSON.stringify(ast.value);
    case "booleanLiteral":
      return ast.value ? "true" : "false";
    case "reference":
      return `${ast.scope}.${ast.id}${ast.part ? `.${ast.part}` : ""}`;
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
    case "pool": {
      const { source, reducer, modifiers, group } = ast;
      let expression: string;
      const keep = reducer?.kind === "keepHighest" || reducer?.kind === "keepLowest";
      const shorthand = source.kind === "dice" && source.count.kind === "numberLiteral" &&
        Number.isInteger(source.count.value) && source.count.value > 0 &&
        source.sides.kind === "numberLiteral" && Number.isInteger(source.sides.value) && source.sides.value > 0 &&
        keep && reducer.amount.kind === "numberLiteral" && Number.isInteger(reducer.amount.value) && reducer.amount.value > 0 &&
        modifiers.length === 0;
      if (source.kind === "rolled") expression = `rolled(${JSON.stringify(source.groupId)})`;
      else if (shorthand) {
        expression = `${renderNode(source.count)}d${renderNode(source.sides)}${reducer.kind === "keepHighest" ? "kh" : "kl"}${renderNode(reducer.amount)}`;
      } else if (source.count.kind === "numberLiteral" && source.count.value === 1 &&
                 source.sides.kind === "numberLiteral" && Number.isInteger(source.sides.value) && source.sides.value > 0 && !group) {
        expression = `d${source.sides.value}`;
      } else expression = `dice(${renderNode(source.count)}, ${renderNode(source.sides)})`;
      for (const modifier of modifiers) {
        const face = modifier.face ? `, ${renderNode(modifier.face)}` : "";
        expression = `${modifier.kind}(${expression}${face})`;
      }
      if (group) expression = `group(${JSON.stringify(group.id)}, ${JSON.stringify(group.label)}, ${expression})`;
      if (reducer && !shorthand) {
        const name = reducer.kind === "countAtLeast" ? "countSuccesses" : reducer.kind;
        expression = `${name}(${expression}, ${renderNode(reducer.amount)})`;
      }
      return expression;
    }
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
