import { describe, expect, it } from "vitest";
import { validateTemplateContent } from "./templates.js";

describe("campaign template data budget", () => {
  it.each(["item", "spell", "talent", "effect"])(
    "accepts bounded blank %s data",
    (kind) => {
      expect(
        validateTemplateContent(kind, {
          name: "Tower key",
          description: "Opens gate",
          notes: "Found by Ada",
        }),
      ).toBeNull();
    },
  );
  it.each([
    { name: "" },
    { name: "   " },
    { name: "x".repeat(201) },
    { name: "Key", notes: "x".repeat(2001) },
    { name: "Key", actions: [] },
    { name: "Key", expression: "d20" },
    { name: "Key", notes: 2 },
  ])("rejects hostile data %j", (data) => {
    expect(validateTemplateContent("item", data)).not.toBeNull();
  });
  it("only items author positive safe default quantities", () => {
    for (const quantity of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
      expect(
        validateTemplateContent("item", {
          name: "Key",
          defaultQuantity: quantity,
        }),
      ).not.toBeNull();
    expect(
      validateTemplateContent("spell", { name: "Spark", defaultQuantity: 2 }),
    ).not.toBeNull();
    expect(
      validateTemplateContent("item", { name: "Key", defaultQuantity: 3 }),
    ).toBeNull();
  });
});
