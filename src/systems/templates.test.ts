import { describe, it, expect } from "vitest";
import { resolveTemplateBase } from "./templates.js";
import { compileDocument } from "./implementation/rules/compile-document.js";
import { validDocument } from "./implementation/package/schema/test-values.js";
import type { SystemDocumentV1 } from "./implementation/package/schema/index.js";
function pkg(change?: (d: SystemDocumentV1) => void) {
  const d = validDocument();
  d.expressions = d.expressions.filter((e) => e.id !== "title_expr");
  d.slots = [{ id: "bag", label: "Bag", accepts: ["item"] }];
  d.sheets[0]!.sections[0]!.elements.push({
    kind: "slot",
    id: "bag_element",
    slotId: "bag",
  });
  d.templates = [
    {
      id: "sword",
      kind: "item",
      label: "Sword",
      fields: [
        {
          kind: "integer",
          id: "damage_bonus",
          label: "Bonus",
          required: true,
          default: 1,
          min: 0,
          max: 10,
          step: 1,
        },
      ],
      grantedActions: [],
    },
  ];
  change?.(d);
  const r = compileDocument(d, {
    systemId: "00000000-0000-4000-8000-000000000001",
    versionId: "00000000-0000-4000-8000-000000000002",
    semanticVersion: "1.0.0",
  });
  if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
  return r.value;
}
describe("campaign base capability", () => {
  it("resolves only a pinned usable base and validates declared typed defaults", () => {
    const p = pkg();
    expect(
      resolveTemplateBase(p, "sword", "item", { damage_bonus: 4 })?.id,
    ).toBe("sword");
    for (const [id, kind, values] of [
      ["missing", "item", {}],
      ["sword", "spell", {}],
      ["sword", "item", { damage_bonus: 11 }],
      ["sword", "item", { damage_bonus: "4" }],
      ["sword", "item", { actions: [] }],
    ] as const)
      expect(resolveTemplateBase(p, id, kind, values)).toBeUndefined();
  });
});

it("rejects an inherited action depending on a template computed value the entry runtime cannot supply", () => {
  const p = pkg((d) => {
    d.templates![0]!.fields.push({
      id: "total_bonus",
      kind: "computed",
      label: "Total",
      valueType: "number",
      expressionId: "base_bonus_expr",
    });
    d.templates![0]!.grantedActions.push({
      id: "sword_hit",
      kind: "roll",
      label: "Hit",
      inputs: [],
      expressionId: "sword_expr",
      outputTemplate: "{total}",
    });
    d.expressions.push(
      {
        id: "base_bonus_expr",
        context: "computed",
        resultType: "number",
        source: "fields.damage_bonus + 1",
        fallback: 0,
      },
      {
        id: "sword_expr",
        context: "roll",
        resultType: "number",
        source: "d20 + fields.total_bonus",
        fallback: 0,
      },
    );
  });
  expect(resolveTemplateBase(p, "sword", "item", {})).toBeUndefined();
});
