import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { evaluateExpression } from "../ports/evaluateExpression.js";
import { RollBreakdown } from "./RollBreakdown.js";
import {
  readGuidedGroups,
  writeGuidedGroups,
} from "../editor/actions/GroupedPoolEditor.js";

describe("group results and guided source", () => {
  it("explains mixed results and empty groups using text rather than a dice-sum modifier", () => {
    const result = evaluateExpression({
      source:
        'countSuccesses(group("attribute", "Attribute", 2d6), 6) + 2 * group("gear", "Gear", dice(0, 4))',
      env: { fields: {}, inputs: {} },
      resultType: "number",
      fallback: 0,
      bindings: {},
      rng: () => 1,
    });
    expect(result.ok && result.roll !== null).toBe(true);
    if (!result.ok || !result.roll) return;
    render(<RollBreakdown roll={result.roll} />);
    expect(screen.getByTestId("roll-group-attribute")).toHaveTextContent(
      "Successes ≥ 6: 2",
    );
    expect(screen.getByTestId("roll-group-gear")).toHaveTextContent(
      "Empty group",
    );
    expect(
      screen.getByText(/Calculation:.*Attribute \(2\).*2 × Gear \(0\).* = 2/),
    ).toBeVisible();
  });
  it("falls back cleanly for legacy results", () => {
    const { container } = render(
      <RollBreakdown
        roll={{ dice: [{ sides: 20, value: 12, kept: true }], total: 12 }}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
  it("preserves guided labels and custom count formulas, leaving nested custom arithmetic alone", () => {
    const source =
      'countSuccesses(group("attribute", "Attribute", dice(fields.attribute + inputs.bonus, 6)), 6) + group("gear", "Gear", dice(0, 4))';
    expect(writeGuidedGroups(readGuidedGroups(source)!)).toBe(source);
    expect(readGuidedGroups(`2 * (${source})`)).toBeNull();
  });
});
