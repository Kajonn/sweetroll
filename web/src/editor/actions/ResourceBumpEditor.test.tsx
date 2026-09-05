import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { ResourceFieldV1 } from "../../state/documentFieldTypes.js";
import {
  ResourceBumpEditor,
  type ResourceBumpActionV1,
} from "./ResourceBumpEditor.js";

function makeResource(
  overrides: Partial<ResourceFieldV1> = {},
): ResourceFieldV1 {
  return {
    kind: "resource",
    id: "health",
    label: "Health",
    default: { current: 6, max: 6 },
    min: 0,
    max: 20,
    step: 1,
    resetTo: "max",
    ...overrides,
  };
}

const defaultAction: ResourceBumpActionV1 = {
  kind: "resourceBump",
  id: "heal",
  label: "Heal",
  resourceId: "health",
  operation: { kind: "delta", amount: 1 },
};

type RenderOptions = {
  action?: ResourceBumpActionV1;
  availableResources?: ReadonlyArray<ResourceFieldV1>;
};

function renderEditor(options: RenderOptions = {}) {
  const {
    action: initialAction = defaultAction,
    availableResources = [makeResource()],
  } = options;
  const onChange = vi.fn();
  const view = render(
    <ResourceBumpEditor
      action={initialAction}
      onChange={onChange}
      availableResources={availableResources}
    />,
  );
  return { ...view, onChange };
}

function lastCallPayload(
  onChange: ReturnType<typeof vi.fn>,
): ResourceBumpActionV1 | undefined {
  const calls = onChange.mock.calls;
  return calls[calls.length - 1]?.[0];
}

describe("ResourceBumpEditor", () => {
  it("renders the action label, resource select, and operation radios", () => {
    renderEditor();
    expect(screen.getByTestId("resource-bump-action-heal")).toBeInTheDocument();
    expect(screen.getByTestId("resource-bump-action-label-heal")).toHaveValue(
      "Heal",
    );
    expect(
      screen.getByTestId("resource-bump-action-resource-id-heal"),
    ).toHaveValue("health");
    expect(
      screen.getByTestId("resource-bump-operation-delta-heal"),
    ).toBeChecked();
    expect(
      screen.getByTestId("resource-bump-operation-reset-heal"),
    ).not.toBeChecked();
  });

  it("renders the amount input and bound hint for a delta action", () => {
    renderEditor();
    expect(screen.getByTestId("resource-bump-action-amount-heal")).toHaveValue(
      1,
    );
    expect(
      screen.getByTestId("resource-bump-action-bound-heal"),
    ).toHaveTextContent(/0/);
    expect(
      screen.getByTestId("resource-bump-action-bound-heal"),
    ).toHaveTextContent(/20/);
    expect(
      screen.queryByTestId("resource-bump-action-reset-hint-heal"),
    ).not.toBeInTheDocument();
  });

  it("renders the reset hint for a reset action", () => {
    renderEditor({
      action: {
        ...defaultAction,
        operation: { kind: "reset" },
      },
    });
    expect(
      screen.queryByTestId("resource-bump-action-amount-heal"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId("resource-bump-action-reset-hint-heal"),
    ).toHaveTextContent(/Reset to max/i);
    expect(
      screen.getByTestId("resource-bump-operation-reset-heal"),
    ).toBeChecked();
  });

  it("shows a 'reset to min' hint when the resource resets to min", () => {
    renderEditor({
      availableResources: [makeResource({ resetTo: "min" })],
      action: {
        ...defaultAction,
        operation: { kind: "reset" },
      },
    });
    expect(
      screen.getByTestId("resource-bump-action-reset-hint-heal"),
    ).toHaveTextContent(/Reset to min/i);
  });

  it("falls back to an empty bound/reset hint when no resource is selected", () => {
    renderEditor({
      action: {
        ...defaultAction,
        resourceId: "",
      },
    });
    expect(
      screen.getByTestId("resource-bump-action-bound-heal"),
    ).toHaveTextContent(/Select a resource/i);
  });

  it("lists every available resource in the resource select", () => {
    renderEditor({
      availableResources: [
        makeResource(),
        makeResource({ id: "mana", label: "Mana", resetTo: "min" }),
      ],
    });
    const select = screen.getByTestId(
      "resource-bump-action-resource-id-heal",
    ) as HTMLSelectElement;
    const optionIds = Array.from(select.options).map((o) => o.value);
    expect(optionIds).toEqual(["", "health", "mana"]);
  });

  it("commits label changes through onChange", () => {
    const { onChange } = renderEditor();
    fireEvent.change(
      screen.getByTestId("resource-bump-action-label-heal"),
      { target: { value: "Big heal" } },
    );
    const last = lastCallPayload(onChange);
    expect(last?.kind).toBe("resourceBump");
    if (last?.kind === "resourceBump") expect(last.label).toBe("Big heal");
  });

  it("commits resource selection through onChange", () => {
    const { onChange } = renderEditor({
      availableResources: [
        makeResource(),
        makeResource({ id: "mana", label: "Mana", resetTo: "min" }),
      ],
    });
    fireEvent.change(
      screen.getByTestId("resource-bump-action-resource-id-heal"),
      { target: { value: "mana" } },
    );
    const last = lastCallPayload(onChange);
    expect(last?.kind).toBe("resourceBump");
    if (last?.kind === "resourceBump") expect(last.resourceId).toBe("mana");
  });

  it("commits delta amount changes through onChange", () => {
    const { onChange } = renderEditor();
    fireEvent.change(
      screen.getByTestId("resource-bump-action-amount-heal"),
      { target: { value: "-3" } },
    );
    const last = lastCallPayload(onChange);
    expect(last?.kind).toBe("resourceBump");
    if (last?.kind === "resourceBump") {
      expect(last.operation.kind).toBe("delta");
      if (last.operation.kind === "delta") expect(last.operation.amount).toBe(-3);
    }
  });

  it("switches to reset through onChange when the reset radio is selected", async () => {
    const user = userEvent.setup();
    const { onChange } = renderEditor();
    await user.click(screen.getByTestId("resource-bump-operation-reset-heal"));
    const last = lastCallPayload(onChange);
    expect(last?.kind).toBe("resourceBump");
    if (last?.kind === "resourceBump") {
      expect(last.operation).toEqual({ kind: "reset" });
    }
  });

  it("switches back to delta with amount=1 when the delta radio is selected", async () => {
    const user = userEvent.setup();
    const { onChange } = renderEditor({
      action: { ...defaultAction, operation: { kind: "reset" } },
    });
    await user.click(screen.getByTestId("resource-bump-operation-delta-heal"));
    const last = lastCallPayload(onChange);
    expect(last?.kind).toBe("resourceBump");
    if (last?.kind === "resourceBump") {
      expect(last.operation).toEqual({ kind: "delta", amount: 1 });
    }
  });

  it("does not emit an onChange when the same operation is re-selected", async () => {
    const user = userEvent.setup();
    const { onChange } = renderEditor();
    onChange.mockClear();
    await user.click(screen.getByTestId("resource-bump-operation-delta-heal"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("disables every control when disabled=true", () => {
    render(
      <ResourceBumpEditor
        action={defaultAction}
        onChange={vi.fn()}
        availableResources={[makeResource()]}
        disabled={true}
      />,
    );
    expect(
      screen.getByTestId("resource-bump-action-label-heal"),
    ).toBeDisabled();
    expect(
      screen.getByTestId("resource-bump-action-resource-id-heal"),
    ).toBeDisabled();
    expect(
      screen.getByTestId("resource-bump-operation-delta-heal"),
    ).toBeDisabled();
    expect(
      screen.getByTestId("resource-bump-operation-reset-heal"),
    ).toBeDisabled();
    expect(
      screen.getByTestId("resource-bump-action-amount-heal"),
    ).toBeDisabled();
  });
});
