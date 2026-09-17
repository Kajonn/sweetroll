import { describe, expect, it } from "vitest";

import { expressionUsages } from "./expressionUsage.js";

function makeDocument() {
  return {
    entities: [
      {
        id: "character",
        label: "Character",
        fields: [
          { kind: "integer", id: "modifier", label: "Modifier" },
          {
            kind: "computed",
            id: "defense",
            label: "Defense",
            valueType: "number",
            expressionId: "defense_expr",
          },
        ],
      },
    ],
    actions: [{ id: "check", label: "Check", kind: "roll", expressionId: "check_expr" }],
    validations: [
      {
        id: "v1",
        expressionId: "defense_expr",
        severity: "error",
        message: "Defense too low",
        targetId: "defense",
      },
    ],
  };
}

describe("expressionUsages", () => {
  it("finds computed fields and validations referencing the expression", () => {
    const usages = expressionUsages(makeDocument(), "defense_expr");
    expect(usages).toHaveLength(2);
    expect(usages[0]).toMatchObject({ kind: "field", label: "Defense" });
    expect(usages[1]).toMatchObject({ kind: "validation" });
  });

  it("finds roll actions referencing the expression", () => {
    const usages = expressionUsages(makeDocument(), "check_expr");
    expect(usages).toHaveLength(1);
    expect(usages[0]).toMatchObject({ kind: "action", label: "Check" });
  });

  it("returns empty for unreferenced expressions", () => {
    expect(expressionUsages(makeDocument(), "orphan_expr")).toEqual([]);
  });
});
