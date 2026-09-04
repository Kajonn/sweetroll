import { describe, expect, it } from "vitest";
import { parse } from "./parser.js";
import { renderExpression } from "./render.js";

function render(src: string): string {
  const r = parse(src);
  if (!r.ok) throw new Error("parse fail");
  return renderExpression(r.ast);
}

describe("renderExpression", () => {
  it("renders defense_expr canonically", () => {
    expect(render("10 + fields.modifier")).toBe("10 + fields.modifier");
  });
  it("renders a d20 dice", () => {
    expect(render("d20")).toBe("d20");
  });
  it("renders keep notation", () => {
    expect(render("4d6kh3")).toBe("4d6kh3");
  });
  it("renders successCount", () => {
    expect(render("countSuccesses(dice(2, 6), 4)")).toBe("countSuccesses(dice(2, 6), 4)");
  });
  it("adds parentheses only where needed", () => {
    expect(render("(1 + 2) * 3")).toBe("(1 + 2) * 3");
    expect(render("1 + 2 * 3")).toBe("1 + 2 * 3");
    expect(render("1 + (2 * 3)")).toBe("1 + 2 * 3");
  });
  it("drops trailing decimal zeros", () => {
    expect(render("-1")).toBe("-1");
  });
});
