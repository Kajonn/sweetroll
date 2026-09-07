import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { FieldControl } from "./FieldControl.js";

const text = {
  kind: "field" as const, id: "name-element", fieldId: "name", label: "Name", fieldKind: "text" as const,
  value: "Aria", editable: true, constraints: { required: true }, validations: [],
};
const strength = {
  kind: "field" as const, id: "strength-element", fieldId: "strength", label: "Strength", fieldKind: "integer" as const,
  value: 10, editable: true, constraints: { min: 1, max: 20, step: 1 }, validations: [],
};

describe("FieldControl", () => {
  it("commits text, choice, and boolean controls with their shared field ID", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<>
      <FieldControl field={text} tentativeValue={null} disabled={false} pending={false} onCommit={onCommit} />
      <FieldControl field={{ ...text, id: "origin-element", fieldId: "origin", label: "Origin", fieldKind: "singleChoice", value: "human", constraints: { options: [{ id: "human", label: "Human" }, { id: "elf", label: "Elf" }] } }} tentativeValue={null} disabled={false} pending={false} onCommit={onCommit} />
      <FieldControl field={{ ...text, id: "ready-element", fieldId: "ready", label: "Ready", fieldKind: "boolean", value: false, constraints: {} }} tentativeValue={null} disabled={false} pending={false} onCommit={onCommit} />
    </>);

    await user.clear(screen.getByRole("textbox", { name: "Name" }));
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Briar");
    await user.tab();
    await user.selectOptions(screen.getByRole("combobox", { name: "Origin" }), "elf");
    await user.click(screen.getByRole("checkbox", { name: "Ready" }));

    expect(onCommit).toHaveBeenCalledWith("name", "Briar");
    expect(onCommit).toHaveBeenCalledWith("origin", "elf");
    expect(onCommit).toHaveBeenCalledWith("ready", true);
  });

  it("keeps invalid numeric drafts local and commits valid values on Enter or blur", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<FieldControl field={strength} tentativeValue={null} disabled={false} pending={false} onCommit={onCommit} />);
    const input = screen.getByRole("spinbutton", { name: "Strength" });

    await user.clear(input);
    await user.type(input, "twenty");
    await user.keyboard("{Enter}");
    expect(onCommit).not.toHaveBeenCalled();

    await user.clear(input);
    await user.type(input, "15");
    await user.keyboard("{Enter}");
    expect(onCommit).toHaveBeenCalledWith("strength", 15);
  });
});
