import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  type SheetEditorV1,
} from "./sheetTypes.js";
import { SheetEditor } from "./SheetEditor.js";

function makeSheet(): SheetEditorV1 {
  return {
    id: "main_sheet",
    label: "Main sheet",
    targetEntityId: "character",
    sections: [
      {
        id: "abilities",
        label: "Abilities",
        elements: [
          { kind: "field", id: "str", fieldId: "strength" },
          { kind: "field", id: "dex", fieldId: "dexterity" },
        ],
      },
      {
        id: "combat",
        label: "Combat",
        elements: [
          { kind: "resource", id: "hp", resourceId: "health" },
        ],
      },
    ],
  };
}

function renderSheet(
  overrides: Partial<React.ComponentProps<typeof SheetEditor>> = {},
) {
  const onChange = vi.fn();
  const sheet = overrides.sheet ?? makeSheet();
  const view = render(<SheetEditor sheet={sheet} onChange={onChange} {...overrides} />);
  return { ...view, onChange };
}

function lastCallPayload(
  onChange: ReturnType<typeof vi.fn>,
): SheetEditorV1 | undefined {
  const calls = onChange.mock.calls;
  return calls[calls.length - 1]?.[0];
}

describe("SheetEditor", () => {
  it("renders a single-column list of sections with their elements", () => {
    renderSheet();
    expect(screen.getByTestId("sheet-editor")).toBeInTheDocument();
    expect(screen.getByTestId("section-row-abilities")).toBeInTheDocument();
    expect(screen.getByTestId("section-row-combat")).toBeInTheDocument();
    expect(screen.getByTestId("element-row-abilities-0")).toBeInTheDocument();
    expect(screen.getByTestId("element-row-abilities-1")).toBeInTheDocument();
    expect(screen.getByTestId("element-row-combat-0")).toBeInTheDocument();
  });

  it("shows a numeric position badge on every section and element", () => {
    renderSheet();
    expect(screen.getByTestId("section-row-abilities-position")).toHaveTextContent("1");
    expect(screen.getByTestId("section-row-combat-position")).toHaveTextContent("2");
    expect(screen.getByTestId("element-row-abilities-0-position")).toHaveTextContent("1");
    expect(screen.getByTestId("element-row-abilities-1-position")).toHaveTextContent("2");
    expect(screen.getByTestId("element-row-combat-0-position")).toHaveTextContent("1");
  });

  it("moves the focused element down when Alt+ArrowDown is pressed", async () => {
    const user = userEvent.setup();
    const { onChange } = renderSheet();
    const handle = screen.getByTestId("element-row-abilities-0-handle");
    await user.click(handle);
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    expect(onChange).toHaveBeenCalled();
    const next = lastCallPayload(onChange);
    expect(next?.sections[0]?.elements.map((e) => e.id)).toEqual(["dex", "str"]);
  });

  it("moves the focused element up when Alt+ArrowUp is pressed", async () => {
    const user = userEvent.setup();
    const { onChange } = renderSheet();
    const handle = screen.getByTestId("element-row-abilities-1-handle");
    await user.click(handle);
    await user.keyboard("{Alt>}{ArrowUp}{/Alt}");
    const next = lastCallPayload(onChange);
    expect(next?.sections[0]?.elements.map((e) => e.id)).toEqual(["dex", "str"]);
  });

  it("moves the focused element down when the explicit 'Move down' button is clicked", async () => {
    const user = userEvent.setup();
    const { onChange } = renderSheet();
    await user.click(screen.getByTestId("element-row-abilities-0-move-down"));
    const next = lastCallPayload(onChange);
    expect(next?.sections[0]?.elements.map((e) => e.id)).toEqual(["dex", "str"]);
  });

  it("moves a section down when Alt+ArrowDown is pressed on its handle", async () => {
    const user = userEvent.setup();
    const { onChange } = renderSheet();
    const handle = screen.getByTestId("section-row-abilities-handle");
    await user.click(handle);
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    const next = lastCallPayload(onChange);
    expect(next?.sections.map((s) => s.id)).toEqual(["combat", "abilities"]);
  });

  it("does not move past the boundary when Alt+ArrowDown is pressed on the last element", async () => {
    const user = userEvent.setup();
    const { onChange } = renderSheet();
    const handle = screen.getByTestId("element-row-abilities-1-handle");
    await user.click(handle);
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not move when Alt+ArrowDown is pressed with no focused row", async () => {
    const user = userEvent.setup();
    const { onChange } = renderSheet();
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("ignores Alt+ArrowDown when focus is inside a text input", async () => {
    const user = userEvent.setup();
    const { onChange } = renderSheet();
    const sheetLabelInput = screen.getByTestId("sheet-label-main_sheet");
    sheetLabelInput.focus();
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("commits sheet label changes through onChange", () => {
    const { onChange } = renderSheet();
    const input = screen.getByTestId("sheet-label-main_sheet");
    fireEvent.change(input, { target: { value: "Player sheet" } });
    const next = lastCallPayload(onChange);
    expect(next?.label).toBe("Player sheet");
  });

  it("adds a new section when 'Add section' is clicked", async () => {
    const user = userEvent.setup();
    const { onChange } = renderSheet();
    await user.click(screen.getByTestId("sheet-add-section"));
    const next = lastCallPayload(onChange);
    expect(next?.sections).toHaveLength(3);
    expect(next?.sections[2]?.label.length).toBeGreaterThan(0);
    expect(next?.sections[2]?.elements).toEqual([]);
  });

  it("removes a section after the destructive confirmation", async () => {
    const user = userEvent.setup();
    const { onChange } = renderSheet();
    await user.click(screen.getByTestId("section-row-combat-remove"));
    expect(screen.getByTestId("section-remove-confirm")).toBeInTheDocument();
    await user.click(screen.getByTestId("section-remove-confirm-submit"));
    const next = lastCallPayload(onChange);
    expect(next?.sections.map((s) => s.id)).toEqual(["abilities"]);
  });

  it("does not remove a section when the confirmation is cancelled", async () => {
    const user = userEvent.setup();
    const { onChange } = renderSheet();
    await user.click(screen.getByTestId("section-row-combat-remove"));
    await user.click(screen.getByTestId("section-remove-confirm-cancel"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("renders the heading element form with text and level inputs", () => {
    const sheet: SheetEditorV1 = {
      id: "main_sheet",
      label: "Main sheet",
      targetEntityId: "character",
      sections: [
        {
          id: "abilities",
          label: "Abilities",
          elements: [{ kind: "heading", id: "head", text: "Stats", level: 2 }],
        },
      ],
    };
    renderSheet({ sheet });
    expect(screen.getByTestId("element-heading-text-head")).toHaveValue("Stats");
    expect(screen.getByTestId("element-heading-level-head")).toHaveValue("2");
  });

  it("renders a DefinitionIdInput for the bound field target", () => {
    renderSheet();
    const binding = screen.getByTestId("element-binding-str");
    expect(within(binding).getByTestId("definition-id-input")).toHaveValue(
      "strength",
    );
  });

  it("adds a heading element when the kind picker selects 'heading'", async () => {
    const user = userEvent.setup();
    const { onChange } = renderSheet();
    await user.click(screen.getByTestId("section-add-element-heading-abilities"));
    const next = lastCallPayload(onChange);
    const elements = next?.sections[0]?.elements ?? [];
    expect(elements.at(-1)?.kind).toBe("heading");
  });

  it("removes an element after the destructive confirmation", async () => {
    const user = userEvent.setup();
    const { onChange } = renderSheet();
    await user.click(screen.getByTestId("element-row-abilities-1-remove"));
    await user.click(screen.getByTestId("element-remove-confirm-submit"));
    const next = lastCallPayload(onChange);
    expect(next?.sections[0]?.elements.map((e) => e.id)).toEqual(["str"]);
  });
});
