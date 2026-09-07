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
    await user.tab();
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("commits decimal and multi-choice values", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<>
      <FieldControl field={{ ...strength, id: "weight-element", fieldId: "weight", label: "Weight", fieldKind: "decimal", value: 1.5, constraints: { min: 0, step: 0.1 } }} tentativeValue={null} disabled={false} pending={false} onCommit={onCommit} />
      <FieldControl field={{ ...text, id: "tags-element", fieldId: "tags", label: "Tags", fieldKind: "multiChoice", value: ["brave"], constraints: { options: [{ id: "brave", label: "Brave" }, { id: "swift", label: "Swift" }] } }} tentativeValue={null} disabled={false} pending={false} onCommit={onCommit} />
    </>);

    await user.clear(screen.getByRole("spinbutton", { name: "Weight" }));
    await user.type(screen.getByRole("spinbutton", { name: "Weight" }), "2.75");
    await user.tab();
    await user.click(screen.getByRole("checkbox", { name: "Swift" }));

    expect(onCommit).toHaveBeenCalledWith("weight", 2.75);
    expect(onCommit).toHaveBeenCalledWith("tags", ["brave", "swift"]);
  });

  it("preserves numeric drafts and surfaces commit failures without duplicate submissions", async () => {
    const user = userEvent.setup();
    let reject!: (error: Error) => void;
    const onCommit = vi.fn().mockImplementation(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
    render(<FieldControl field={strength} tentativeValue={null} disabled={false} pending={false} onCommit={onCommit} />);
    const input = screen.getByRole("spinbutton", { name: "Strength" });

    await user.clear(input);
    await user.type(input, "15");
    await user.keyboard("{Enter}");
    await user.keyboard("{Enter}");
    expect(onCommit).toHaveBeenCalledTimes(1);

    reject(new Error("Account changed. Reopen this character."));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not save this change: Account changed. Reopen this character.");
    expect(input).toHaveValue(15);
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("surfaces synchronous commit failures while keeping the draft", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn((): void => { throw new Error("Session closed."); });
    render(<FieldControl field={strength} tentativeValue={null} disabled={false} pending={false} onCommit={onCommit} />);
    const input = screen.getByRole("spinbutton", { name: "Strength" });

    await user.clear(input);
    await user.type(input, "12");
    await user.tab();
    expect(onCommit).toHaveBeenCalledWith("strength", 12);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not save this change: Session closed.");
    expect(input).toHaveValue(12);
  });
  it("shows diagnostics for read-only and unavailable fields", () => {
    render(<>
      <FieldControl field={{ ...text, id: "computed", fieldId: "armor", label: "Armor", fieldKind: "computed", value: 12, editable: false, constraints: {}, validations: [{ validationId: "armor-error", severity: "warning", message: "Armor is stale", targetDefinitionId: "armor" }] }} tentativeValue={null} disabled={false} pending={false} onCommit={vi.fn()} />
      <FieldControl field={{ ...text, id: "image", fieldId: "portrait", label: "Portrait", fieldKind: "image", value: null, editable: false, constraints: {}, validations: [{ validationId: "portrait-error", severity: "error", message: "Portrait is required", targetDefinitionId: "portrait" }] }} tentativeValue={null} disabled={false} pending={false} onCommit={vi.fn()} />
    </>);

    expect(screen.getByText("Armor is stale")).toBeVisible();
    expect(screen.getByText("Portrait is required")).toBeVisible();
  });
});
