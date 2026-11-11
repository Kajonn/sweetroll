import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { RollOutcomesEditor, type OutcomeExpressions, type RollOutcomeEntry } from "./RollOutcomesEditor.js";

type Action = { id: string; outcomes?: RollOutcomeEntry[]; details?: RollOutcomeEntry[] };

function Harness({ log }: { log: { action?: Action; sources: Map<string, string> } }) {
  const [action, setAction] = useState<Action>({ id: "move" });
  const [, rerender] = useState(0);
  const expressions: OutcomeExpressions = {
    sourceFor: (id) => log.sources.get(id) ?? "",
    add: (kind, source) => {
      const id = `${kind}_${log.sources.size + 1}`;
      log.sources.set(id, source);
      return id;
    },
    setSource: (id, source) => { log.sources.set(id, source); rerender((n) => n + 1); },
    remove: (id) => { log.sources.delete(id); },
  };
  log.action = action;
  return <RollOutcomesEditor action={action} onChange={setAction} expressions={expressions} />;
}

describe("RollOutcomesEditor", () => {
  it("adds, reorders, edits and removes outcomes and details", () => {
    const log = { sources: new Map<string, string>() } as { action?: Action; sources: Map<string, string> };
    render(<Harness log={log} />);
    expect(screen.getByText("No outcomes. The result shows only the total.")).toBeVisible();

    fireEvent.click(screen.getByTestId("roll-action-outcome-add-move"));
    fireEvent.click(screen.getByTestId("roll-action-outcome-add-move"));
    expect(log.action?.outcomes?.map((entry) => entry.id)).toEqual(["outcome_1", "outcome_2"]);
    expect(log.sources.get(log.action!.outcomes![0]!.expressionId)).toBe("roll.total >= 10");

    const label = screen.getByTestId("roll-action-outcome-move-outcome_2-label");
    fireEvent.change(label, { target: { value: "Miss" } });
    const condition = screen.getByTestId("roll-action-outcome-move-outcome_2-formula");
    fireEvent.change(condition, { target: { value: "true" } });
    fireEvent.blur(condition);
    expect(log.sources.get(log.action!.outcomes![1]!.expressionId)).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Move Miss up" }));
    expect(log.action?.outcomes?.map((entry) => entry.label)).toEqual(["Miss", "New outcome"]);
    expect(screen.getByRole("button", { name: "Move Miss up" })).toBeDisabled();

    fireEvent.click(screen.getByTestId("roll-action-detail-add-move"));
    expect(log.action?.details).toEqual([{ id: "detail_1", label: "New detail", expressionId: expect.any(String) }]);
    expect(log.sources.get(log.action!.details![0]!.expressionId)).toBe("roll.total");

    const removed = log.action!.outcomes![0]!.expressionId;
    fireEvent.click(screen.getByRole("button", { name: "Remove Miss" }));
    expect(log.action?.outcomes?.map((entry) => entry.label)).toEqual(["New outcome"]);
    expect(log.sources.has(removed)).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Remove New outcome" }));
    // An action without outcomes drops the list instead of keeping it empty.
    expect(log.action).not.toHaveProperty("outcomes");
  });
});
