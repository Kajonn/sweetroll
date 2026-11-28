import { describe, expect, it } from "vitest";

import { decodeSystemDocument, decodeSystemPackage } from "../package/codec.js";
import { d20Document } from "../package/fixtures/d20.js";
import type { RollActionV1 } from "../package/schema/index.js";
import { compileDocument } from "./compile-document.js";
import { evaluate } from "./evaluate.js";

function check(source: string, action: Partial<RollActionV1>) {
  const document = structuredClone(d20Document);
  Object.assign(document.actions[0]!, action);
  document.expressions.find(expression => expression.id === "check_expr")!.source = source;
  const decoded = decodeSystemDocument(document);
  if (!decoded.ok) return decoded;
  return compileDocument(decoded.value, {
    systemId: "00000000-0000-4000-8000-000000000000",
    versionId: "00000000-0000-4000-8000-000000000001",
    semanticVersion: "1.0.0",
  });
}

describe("campaign roll expression scopes", () => {
  it("checks the declared target entity and records only the fields read", () => {
    const result = check("d20 - target.defense + target.health.current", { target: { entityId: "character" } });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    expect(decodeSystemPackage(result.value).ok).toBe(true);
    const expression = result.value.expressions.find(expr => expr.id === "check_expr")!;
    expect(evaluate(expression, { fields: {}, inputs: {}, target: { defense: 12, "health.current": 7, modifier: 2 } }, () => 0))
      .toMatchObject({ result: -4, bindings: [
        { scope: "target", definitionId: "defense", value: 12 },
        { scope: "target", definitionId: "health.current", value: 7 },
      ] });
  });

  it("admits opposed.total only for response actions", () => {
    const result = check("d20 - opposed.total", { respondsTo: true });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    const expression = result.value.expressions.find(expr => expr.id === "check_expr")!;
    expect(evaluate(expression, { fields: {}, inputs: {}, opposed: { total: 5 } }, () => 0))
      .toMatchObject({ result: -4, bindings: [{ scope: "opposed", definitionId: "total", value: 5 }] });
    expect(check("d20 - opposed.total", {}).ok).toBe(false);
    expect(check("d20 - opposed.other", { respondsTo: true }).ok).toBe(false);
  });

  it("rejects missing target declarations, entities, and invalid field types", () => {
    expect(check("d20 - target.defense", {}).ok).toBe(false);
    expect(check("d20", { target: { entityId: "missing" } }).ok).toBe(false);
    expect(check("d20 - target.proficient", { target: { entityId: "character" } }).ok).toBe(false);
  });
});

describe("several target entities and optional targets (SRD gaps S7)", () => {
  /** d20 with a second entity that shares `defense` but not `modifier`. */
  function twoEntities(source: string, target: RollActionV1["target"], outcome?: string) {
    const document = structuredClone(d20Document);
    document.entities.push({ id: "beast", label: "Beast", kind: "npc", fields: [
      { kind: "integer", id: "defense", label: "Defense", default: 10, min: 0, max: 30, step: 1, required: false },
    ] });
    const action = document.actions[0]!;
    if (action.kind !== "roll") throw Error("check must be a roll");
    action.target = target!;
    document.expressions.find(expression => expression.id === "check_expr")!.source = source;
    if (outcome !== undefined) {
      action.outcomes = [{ id: "hit", label: "Hit", expressionId: "hit_expr" }, { id: "rolled", label: "Rolled", expressionId: "any_expr" }];
      action.details = [{ id: "defense", label: "Defense", expressionId: "target_defense_expr" }];
      document.expressions.push(
        { id: "hit_expr", context: "outcome", resultType: "boolean", source: outcome, fallback: false },
        { id: "any_expr", context: "outcome", resultType: "boolean", source: "true", fallback: false },
        { id: "target_defense_expr", context: "outcome", resultType: "number", source: "target.defense", fallback: 0 },
      );
    }
    return compileDocument(document, {
      systemId: "00000000-0000-4000-8000-000000000000", versionId: "00000000-0000-4000-8000-000000000001", semanticVersion: "1.0.0",
    });
  }

  it("reads only the fields every target entity defines", () => {
    expect(twoEntities("d20 - target.defense", { entityId: "character", otherEntityIds: ["beast"] }).ok).toBe(true);
    expect(twoEntities("d20 - target.modifier", { entityId: "character", otherEntityIds: ["beast"] }).ok).toBe(false);
    expect(twoEntities("d20", { entityId: "character", otherEntityIds: ["missing"] }).ok).toBe(false);
  });

  it("keeps an optional target out of the roll and lets outcomes and details read it", () => {
    const target = { entityId: "character", otherEntityIds: ["beast"], optional: true as const };
    expect(twoEntities("d20 - target.defense", target).ok).toBe(false);
    expect(twoEntities("d20", target, "roll.total >= target.defense").ok).toBe(true);
  });
});
