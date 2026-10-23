import type { ExpressionAstV1 } from "../package/schema/index.js";
import type { RulesDiagnostic } from "./diagnostic.js";

export function children(node: ExpressionAstV1): ExpressionAstV1[] {
  switch (node.kind) {
    case "binary":
      return [node.left, node.right];
    case "unary":
      return [node.operand];
    case "call":
      return node.arguments;
    case "dice":
      return [node.count];
    case "keep":
    case "successCount":
      return [node.dice];
    default:
      return [];
  }
}
export function hasDiceGroups(ast: ExpressionAstV1): boolean {
  return (
    (ast.kind === "dice" && ast.group !== undefined) ||
    children(ast).some(hasDiceGroups)
  );
}
export function validateDiceGroups(
  ast: ExpressionAstV1,
  version: string = "0.1",
): RulesDiagnostic[] {
  const diagnostics: RulesDiagnostic[] = [];
  const ids = new Set<string>();
  const fail = (message: string) =>
    diagnostics.push({ code: "invalid_expression", path: "", message });
  const deterministic = (n: ExpressionAstV1): boolean =>
    !["dice", "keep", "successCount"].includes(n.kind) &&
    children(n).every(deterministic);
  const walk = (node: ExpressionAstV1) => {
    if (node.kind === "dice" && node.group !== undefined) {
      if (version !== "0.2")
        fail("Named dice groups require grammar 0.2 and package 1.1.");
      if (
        !/^[a-z][a-z0-9_]{0,63}$/.test(node.group.id) ||
        node.group.label.length < 1 ||
        node.group.label.length > 120
      )
        fail("Invalid dice group ID or label.");
      if (ids.has(node.group.id))
        fail("Dice group IDs must be unique per expression.");
      ids.add(node.group.id);
      if (ids.size > 32) fail("At most 32 named dice groups are supported.");
      if (!deterministic(node.count))
        fail("Named dice group counts must be deterministic.");
    }
    children(node).forEach(walk);
  };
  walk(ast);
  return diagnostics;
}
