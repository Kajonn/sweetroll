import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { decodeSystemDocument } from "../package/codec.js";
import { d20Document } from "../package/fixtures/d20.js";
import { compileDocument } from "../rules/compile-document.js";
import { createSystemRuntime } from "../../runtime.js";
import { PushContextSchema } from "./push-context.js";

const versionId = "00000000-0000-4000-8000-000000000001";

describe("push snapshot of output placeholders", () => {
  it("accepts resource parts used by a pushable roll's output template", async () => {
    const document = structuredClone(d20Document);
    const action = document.actions.find(candidate => candidate.id === "check");
    if (action?.kind !== "roll") throw new Error("Missing reference roll action");
    document.expressions.find(expression => expression.id === action.expressionId)!.source = 'group("pool", "Pool", dice(2, 6))';
    action.inputs = [];
    action.outputTemplate = "{fields.health.current} of {fields.health.max}, modifier {fields.modifier}: {total}";
    action.pushPolicy = {
      version: "1.0", maxAttempts: 1, successThreshold: 99, allowOnSuccess: true,
      groups: [{ groupId: "pool", lockedFaces: [], reportedFaces: [] }],
    };
    const decoded = decodeSystemDocument(document);
    if (!decoded.ok) throw new Error(JSON.stringify(decoded));
    const compiled = compileDocument(decoded.value, { systemId: "00000000-0000-4000-8000-000000000000", versionId, semanticVersion: "1.0.0" });
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
    const runtime = createSystemRuntime({ loadPackage: async () => compiled.value, authoritativeRollSecret: "0123456789abcdef0123456789abcdef" });
    const created = await runtime.resolve({ versionId, entityId: "character", intent: { kind: "initialize" } });
    if (!created.ok) throw new Error(created.error.message);
    const rolled = await runtime.resolve({
      versionId, entityId: "character", state: created.value.state,
      intent: { kind: "action", actionId: "check", inputs: {}, executionId: "00000000-0000-4000-8000-000000000009" },
    });
    if (!rolled.ok) throw new Error(rolled.error.message);
    expect(rolled.value.pushContext?.outputValues).toEqual({
      "fields.health.current": "10", "fields.health.max": "10", "fields.modifier": "0",
    });
    expect([...Value.Errors(PushContextSchema, rolled.value.pushContext)]).toEqual([]);
  });

  it("still rejects keys outside the placeholder scopes", () => {
    const key = (name: string) => Value.Check(PushContextSchema.properties.outputValues, { [name]: "1" });
    expect(key("item.charges.max")).toBe(true);
    expect(key("fields.health.other")).toBe(false);
    expect(key("target.defense")).toBe(false);
  });
});
