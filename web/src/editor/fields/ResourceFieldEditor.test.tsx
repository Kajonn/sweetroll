import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { FieldV1, ResourceFieldV1 } from "../../state/documentFieldTypes.js";
import { ResourceFieldEditor } from "./ResourceFieldEditor.js";

function makeField(overrides: Partial<ResourceFieldV1> = {}): ResourceFieldV1 {
  return {
    kind: "resource",
    id: "hp",
    label: "Hit points",
    default: { current: 10, max: 20 },
    min: 0,
    max: 999,
    step: 1,
    resetTo: "max",
    ...overrides,
  };
}

function renderEditor(
  overrides: Partial<React.ComponentProps<typeof ResourceFieldEditor>> = {},
) {
  const onChange = vi.fn();
  const field = overrides.field ?? makeField();
  const props: React.ComponentProps<typeof ResourceFieldEditor> = {
    field,
    onChange,
    ...overrides,
  };
  const view = render(<ResourceFieldEditor {...props} />);
  return { ...view, onChange };
}

function lastCallPayload(onChange: ReturnType<typeof vi.fn>): FieldV1 | undefined {
  const calls = onChange.mock.calls;
  return calls[calls.length - 1]?.[0];
}

describe("ResourceFieldEditor", () => {
  it("renders current + max + bounds inputs", () => {
    renderEditor();
    expect(screen.getByTestId("resource-field-hp")).toBeInTheDocument();
    expect(screen.getByTestId("resource-field-label-hp")).toHaveValue("Hit points");
    expect(screen.getByTestId("resource-field-current-hp")).toHaveValue(10);
    expect(screen.getByTestId("resource-field-default-max-hp")).toHaveValue(20);
    expect(screen.getByTestId("resource-field-min-hp")).toHaveValue(0);
    expect(screen.getByTestId("resource-field-max-hp")).toHaveValue(999);
  });

  it("renders the unsupported fallback for non-resource kinds", () => {
    renderEditor({
      field: {
        kind: "text",
        id: "name",
        label: "Name",
        default: "",
        required: false,
        minLength: 0,
        maxLength: 120,
      },
    });
    expect(screen.getByTestId("resource-field-unsupported")).toBeInTheDocument();
  });

  it("commits label changes through onChange", () => {
    const { onChange } = renderEditor();
    const input = screen.getByTestId("resource-field-label-hp");
    fireEvent.change(input, { target: { value: "Stamina" } });
    const last = lastCallPayload(onChange);
    expect(last?.kind).toBe("resource");
    if (last?.kind === "resource") expect(last.label).toBe("Stamina");
  });

  it("commits current value changes through onChange", () => {
    const { onChange } = renderEditor();
    const current = screen.getByTestId("resource-field-current-hp");
    fireEvent.change(current, { target: { value: "5" } });
    const last = lastCallPayload(onChange);
    expect(last?.kind).toBe("resource");
    if (last?.kind === "resource") {
      expect(last.default.current).toBe(5);
      expect(last.default.max).toBe(20);
    }
  });

  it("commits default-max changes through onChange", () => {
    const { onChange } = renderEditor();
    const maxBinding = screen.getByTestId("resource-field-default-max-hp");
    fireEvent.change(maxBinding, { target: { value: "25" } });
    const last = lastCallPayload(onChange);
    expect(last?.kind).toBe("resource");
    if (last?.kind === "resource") {
      expect(last.default.max).toBe(25);
      expect(last.default.current).toBe(10);
    }
  });

  it("commits min + max bound changes through onChange", () => {
    const { onChange } = renderEditor();
    const minInput = screen.getByTestId("resource-field-min-hp");
    fireEvent.change(minInput, { target: { value: "2" } });
    const last = lastCallPayload(onChange);
    expect(last?.kind).toBe("resource");
    if (last?.kind === "resource") expect(last.min).toBe(2);
  });

  it("commits reset rule changes through onChange", async () => {
    const user = userEvent.setup();
    const { onChange } = renderEditor({ field: makeField({ resetTo: "max" }) });
    await user.click(screen.getByTestId("resource-field-reset-to-min-hp"));
    const last = lastCallPayload(onChange);
    expect(last?.kind).toBe("resource");
    if (last?.kind === "resource") expect(last.resetTo).toBe("min");
  });
});