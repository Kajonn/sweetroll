import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { DefinitionIdInput } from "./DefinitionIdInput.js";

function renderInput(
  overrides: Partial<React.ComponentProps<typeof DefinitionIdInput>> = {},
) {
  const onChange = vi.fn();
  const props: React.ComponentProps<typeof DefinitionIdInput> = {
    value: "name",
    onChange,
    ...overrides,
  };
  const view = render(<DefinitionIdInput {...props} />);
  return { ...view, onChange };
}

describe("DefinitionIdInput", () => {
  it("renders the current id and an accessible label", () => {
    renderInput({ value: "strength" });
    expect(screen.getByTestId("definition-id-input")).toHaveValue("strength");
    expect(screen.getByLabelText(/id/i)).toBeInTheDocument();
  });

  it("does not show a footer when the id is not referenced elsewhere", () => {
    renderInput({ value: "name" });
    expect(screen.queryByTestId("definition-id-references")).not.toBeInTheDocument();
  });

  it("shows a 'Referenced by N' footer when referencedBy > 0", () => {
    renderInput({ value: "name", referencedBy: 3 });
    const footer = screen.getByTestId("definition-id-references");
    expect(footer).toHaveTextContent(/3/);
  });

  it("warns when renaming an ID referenced elsewhere", async () => {
    const user = userEvent.setup();
    const { onChange } = renderInput({ value: "name", referencedBy: 2 });
    const input = screen.getByTestId("definition-id-input");
    await user.clear(input);
    await user.type(input, "full_name");

    const dialog = await screen.findByTestId("definition-id-rename-confirm");
    expect(dialog).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("commits the rename after confirming the dialog", async () => {
    const user = userEvent.setup();
    const { onChange } = renderInput({ value: "name", referencedBy: 2 });
    const input = screen.getByTestId("definition-id-input");
    await user.clear(input);
    await user.type(input, "full_name");
    await screen.findByTestId("definition-id-rename-confirm");

    await user.click(screen.getByTestId("definition-id-rename-confirm-submit"));
    expect(onChange).toHaveBeenCalledWith("full_name");
  });

  it("cancels the rename and keeps the original id", async () => {
    const user = userEvent.setup();
    const { onChange } = renderInput({ value: "name", referencedBy: 2 });
    const input = screen.getByTestId("definition-id-input");
    await user.clear(input);
    await user.type(input, "full_name");
    await screen.findByTestId("definition-id-rename-confirm");

    await user.click(screen.getByTestId("definition-id-rename-confirm-cancel"));
    expect(onChange).not.toHaveBeenCalled();
    expect(input).toHaveValue("name");
  });

  it("commits a new value without confirmation when no references exist", async () => {
    const user = userEvent.setup();
    const { onChange } = renderInput({ value: "name" });
    const input = screen.getByTestId("definition-id-input");
    await user.clear(input);
    await user.type(input, "full_name");
    expect(screen.queryByTestId("definition-id-rename-confirm")).not.toBeInTheDocument();
    expect(onChange).toHaveBeenLastCalledWith("full_name");
  });

  it("flags an invalid id with a descriptive message", () => {
    renderInput({ value: "Name" });
    expect(screen.getByTestId("definition-id-input")).toBeInvalid();
  });

  it("accepts ids matching the schema pattern", () => {
    renderInput({ value: "name_2" });
    expect(screen.getByTestId("definition-id-input")).toBeValid();
  });
});
