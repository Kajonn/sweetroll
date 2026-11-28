import { Value } from "@sinclair/typebox/value";
import { PushPolicySchema } from "../package/schema/push-policy.js";
import type {
  ActionV1,
  ExpressionAstV1,
  ObjectTemplateV1,
} from "../package/schema/index.js";
import type { RulesDiagnostic } from "./diagnostic.js";
import { children, containsDice } from "./groups.js";
import type { PoolAst } from "../package/schema/expression.js";

export function matchesPoolModifiers(allowed: readonly string[] = [], actual: readonly string[] = []): boolean {
  return actual.length === allowed.length && actual.every((modifier) => allowed.includes(modifier));
}
/** Only additive dice reductions and bounded literal scaling can vary on a push. */
function affine(n: ExpressionAstV1, scale = 1): boolean {
  if (!containsDice(n)) return true;
  if (n.kind === "pool") {
    return n.source.kind === "dice" &&
      n.reducer?.kind !== "keepHighest" && n.reducer?.kind !== "keepLowest" &&
      !children(n).some(containsDice);
  }
  if (n.kind === "unary" && n.operator === "-")
    return affine(n.operand, -scale);
  if (n.kind === "binary") {
    if (n.operator === "+" || n.operator === "-")
      return affine(n.left, scale) && affine(n.right, scale);
    if (n.operator === "*") {
      const lit = (x: ExpressionAstV1): number | undefined =>
        x.kind === "numberLiteral"
          ? x.value
          : x.kind === "unary" &&
              x.operator === "-" &&
              x.operand.kind === "numberLiteral"
            ? -x.operand.value
            : undefined;
      const l = lit(n.left),
        r = lit(n.right),
        factor = l ?? r;
      return (
        factor !== undefined &&
        Number.isFinite(scale * factor) &&
        Math.abs(scale * factor) <= 1e6 &&
        affine(l !== undefined ? n.right : n.left, scale * factor)
      );
    }
  }
  return false;
}
export function validatePushPolicies(value: {
  actions: ActionV1[];
  templates: ObjectTemplateV1[];
  expressions: { id: string; ast?: ExpressionAstV1 }[];
}): RulesDiagnostic[] {
  const errors: RulesDiagnostic[] = [];
  const actions = [
    ...value.actions.map((action, i) => ({
      action,
      path: `/actions/${i}/pushPolicy`,
    })),
    ...value.templates.flatMap((t, i) =>
      t.grantedActions.map((action, j) => ({
        action,
        path: `/templates/${i}/grantedActions/${j}/pushPolicy`,
      })),
    ),
  ];
  for (const { action, path } of actions) {
    if (action.kind !== "roll" || action.pushPolicy === undefined) continue;
    const fail = (message: string) =>
      errors.push({ code: "invalid_expression", path, message });
    if (!Value.Check(PushPolicySchema, action.pushPolicy)) {
      fail("Invalid bounded push policy.");
      continue;
    }
    if ("nominal" in action && action.nominal === true) {
      fail("Nominal actions cannot be pushed.");
      continue;
    }
    if (
      new Set(action.pushPolicy.groups.map((g) => g.groupId)).size !==
      action.pushPolicy.groups.length
    )
      fail("Push group IDs must be unique.");
    const ast = value.expressions.find(
      (e) => e.id === action.expressionId,
    )?.ast;
    if (ast === undefined) continue; // Source documents are checked again after compilation.
    if (!affine(ast))
      fail(
        "Push requires additive sum/count dice terms and bounded literal scaling; keep and nonlinear dice formulas are unsupported.",
      );
    const groups = new Map<string, PoolAst>();
    const walk = (n: ExpressionAstV1) => {
      if (n.kind === "pool" && n.group) groups.set(n.group.id, n);
      children(n).forEach(walk);
    };
    walk(ast);
    for (const g of action.pushPolicy.groups) {
      const pool = groups.get(g.groupId);
      if (pool?.source.kind !== "dice") {
        fail(`Unknown named push group: ${g.groupId}.`);
        continue;
      }
      if (!matchesPoolModifiers(g.modifiers, pool.modifiers.map((modifier) => modifier.kind)))
        fail(`Push policy for ${g.groupId} must explicitly allow its pool modifiers.`);
      const sides = pool.source.sides;
      if (sides.kind === "numberLiteral" && [...g.lockedFaces, ...g.reportedFaces].some((face) => face > sides.value))
        fail(`Push face exceeds die sides for ${g.groupId}.`);
    }
  }
  return errors;
}
