import type { ExpressionAstV1 } from "../package/schema/index.js";
import type { RulesDiagnostic } from "./diagnostic.js";

export function children(node: ExpressionAstV1): ExpressionAstV1[] {
  switch (node.kind) {
    case "binary": return [node.left, node.right];
    case "unary": return [node.operand];
    case "call": return node.arguments;
    case "pool": {
      const source = node.source.kind === "dice" ? [node.source.count, node.source.sides] : [];
      const faces = node.modifiers.flatMap((modifier) => modifier.face ? [modifier.face] : []);
      return [...source, ...faces, ...(node.reducer ? [node.reducer.amount] : [])];
    }
    default: return [];
  }
}

export function containsDice(ast: ExpressionAstV1): boolean {
  return ast.kind === "pool" || children(ast).some(containsDice);
}

function drawsDice(ast: ExpressionAstV1): boolean {
  return (ast.kind === "pool" && ast.source.kind === "dice") || children(ast).some(drawsDice);
}

export function hasDiceGroups(ast: ExpressionAstV1): boolean {
  return (ast.kind === "pool" && ast.group !== undefined) || children(ast).some(hasDiceGroups);
}

export function validateDiceGroups(ast: ExpressionAstV1): RulesDiagnostic[] {
  const diagnostics: RulesDiagnostic[] = [];
  const ids = new Set<string>();
  const available = new Set<string>();
  const fail = (message: string) =>
    diagnostics.push({ code: "invalid_expression", path: "", message });

  const branch = (node: ExpressionAstV1) => {
    const prior = new Set(available);
    walk(node);
    for (const id of available) if (!prior.has(id)) available.delete(id);
  };
  function walk(node: ExpressionAstV1): void {
    if (node.kind === "call" && node.function === "if") {
      const [condition, ...branches] = node.arguments;
      if (condition) walk(condition);
      branches.forEach(branch);
      return;
    }
    if (node.kind === "binary" && (node.operator === "&&" || node.operator === "||")) {
      walk(node.left);
      branch(node.right);
      return;
    }
    if (node.kind === "pool" && node.source.kind === "rolled") {
      if (!available.has(node.source.groupId)) fail(`Group '${node.source.groupId}' must be rolled before it is reused.`);
      if (node.group || node.modifiers.length) fail("Reused dice cannot be named or modified again.");
      children(node).forEach(walk);
      return;
    }
    children(node).forEach(walk);
    if (node.kind !== "pool") return;
    if (node.modifiers[0]?.kind === "explode" && node.modifiers.length > 1)
      fail("Reroll once before applying explosions.");
    if (new Set(node.modifiers.map((modifier) => modifier.kind)).size !== node.modifiers.length)
      fail("Each dice pool modifier can be used only once.");
    if (!node.group) return;
    if (children(node).some(drawsDice)) fail("Named dice pool parameters cannot draw new dice.");
    const { id, label } = node.group;
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(id) || label.length < 1 || label.length > 120)
      fail("Invalid dice group ID or label.");
    if (ids.has(id)) fail("Dice group IDs must be unique per expression.");
    ids.add(id);
    available.add(id);
    if (ids.size > 32) fail("At most 32 named dice groups are supported.");
  }
  walk(ast);
  return diagnostics;
}
