import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { ComputedFieldV1, FieldV1 } from "../../state/documentFieldTypes.js";
import { ComputedFieldEditor } from "./ComputedFieldEditor.js";

function makeField(overrides: Partial<ComputedFieldV1> = {}): ComputedFieldV1 {
  return {
    kind: "computed",
    id: "modifier",
    label: "Modifier",
    valueType: "number",
    expressionId: "modifier_expr",
    ...overrides,
  };
}

function renderEditor(
  overrides: Partial<React.ComponentProps<typeof ComputedFieldEditor>> = {},
) {
  const onChange = vi.fn();
  const field = overrides.field ?? makeField();
  const props: React.ComponentProps<typeof ComputedFieldEditor> = {
    field,
    onChange,
    ...overrides,
  };
  const view = render(<ComputedFieldEditor {...props} />);
  return { ...view, onChange };
}

function lastCallPayload(onChange: ReturnType<typeof vi.fn>): FieldV1 | undefined {
  const calls = onChange.mock.calls;
  return calls[calls.length - 1]?.[0];
}

describe("ComputedFieldEditor", () => {
  it("renders the result-type select, label input, and expression textarea", () => {
    renderEditor();
    expect(screen.getByTestId("computed-field-modifier")).toBeInTheDocument();
    expect(screen.getByTestId("computed-field-label-modifier")).toHaveValue("Modifier");
    expect(screen.getByTestId("computed-field-value-type-modifier")).toHaveValue("number");
    expect(screen.getByTestId("computed-field-source-modifier")).toBeInTheDocument();
  });

  it("renders the unsupported fallback for non-computed kinds", () => {
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
    expect(screen.getByTestId("computed-field-unsupported")).toBeInTheDocument();
  });

  it("shows the 'no issues' marker when the source is empty", () => {
    renderEditor();
    expect(screen.getByTestId("computed-field-no-diagnostic-modifier")).toBeInTheDocument();
  });

  it("renders a diagnostic with code 'invalid_syntax' when bad input is typed", async () => {
    const user = userEvent.setup();
    renderEditor();
    const textarea = screen.getByTestId("computed-field-source-modifier");
    await user.type(textarea, "$");
    const diagnostic = screen.getByTestId("computed-field-diagnostic-modifier");
    expect(diagnostic).toBeInTheDocument();
    expect(diagnostic).toHaveAttribute("data-code", "invalid_syntax");
  });

  it("commits label changes through onChange", () => {
    const { onChange } = renderEditor();
    const input = screen.getByTestId("computed-field-label-modifier");
    fireEvent.change(input, { target: { value: "Score" } });
    const last = lastCallPayload(onChange);
    expect(last?.kind).toBe("computed");
    if (last?.kind === "computed") expect(last.label).toBe("Score");
  });

  it("commits result-type changes through onChange", () => {
    const { onChange } = renderEditor();
    const select = screen.getByTestId("computed-field-value-type-modifier");
    fireEvent.change(select, { target: { value: "text" } });
    const last = lastCallPayload(onChange);
    expect(last?.kind).toBe("computed");
    if (last?.kind === "computed") expect(last.valueType).toBe("text");
  });
});
