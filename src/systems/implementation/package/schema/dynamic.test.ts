import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";

import { ObjectTemplateV1Schema } from "./dynamic.js";

const validate = new Ajv({ allErrors: true, strict: true }).compile(ObjectTemplateV1Schema);

function validItemTemplate() {
  return {
    id: "longsword",
    label: "Longsword",
    kind: "item",
    fields: [],
    grantedActions: [
      {
        kind: "roll",
        id: "longsword_attack",
        label: "Longsword Attack",
        expressionId: "longsword_attack_expr",
        inputs: [],
        outputTemplate: "Result: {total}",
      },
    ],
  };
}

describe("ObjectTemplateV1Schema", () => {
  it("accepts a minimal item template with one granted roll action", () => {
    expect(validate(validItemTemplate())).toBe(true);
  });

  it("rejects a template id with uppercase letters", () => {
    expect(validate({ ...validItemTemplate(), id: "Longsword" })).toBe(false);
  });
});
