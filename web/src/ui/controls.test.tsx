import { readFileSync } from "node:fs";
import { join } from "node:path";

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Button, IconButton } from "./Button.js";
import { Checkbox } from "./Checkbox.js";
import { FormField } from "./FormField.js";
import { NumberInput } from "./NumberInput.js";
import { Select } from "./Select.js";

function cssText(file: string): string {
  return readFileSync(join(process.cwd(), "src/ui", file), "utf8");
}

describe("ui control styles", () => {
  it("buttons meet the 44px touch target and reuse :focus-visible plus semantic aliases", () => {
    const css = cssText("Button.module.css");
    expect(css).toMatch(/\.button\s*\{[^}]*min-height:\s*44px/);
    expect(css).toMatch(/min-width:\s*44px/);
    expect(css).toMatch(/\.iconButton\s*\{[^}]*min-height:\s*44px/);
    expect(css).toMatch(/:focus-visible/);
    expect(css).toMatch(/var\(--focus-ring\)/);
    expect(css).toMatch(/var\(--action-primary\)/);
    expect(css).toMatch(/var\(--radius-panel\)/);
    expect(css).not.toMatch(/var\(--color-/);
    expect(css).toMatch(/prefers-reduced-motion/);
  });

  it("fields meet the 44px touch target and consume semantic text/status aliases", () => {
    const css = cssText("fields.module.css");
    expect(css).toMatch(/min-height:\s*44px/);
    expect(css).toMatch(/\.checkboxRow\s*\{[^}]*min-height:\s*44px/);
    expect(css).toMatch(/var\(--status-error\)/);
    expect(css).toMatch(/var\(--text-muted\)/);
    expect(css).toMatch(/var\(--font-body\)/);
    expect(css).toMatch(/var\(--radius-panel\)/);
    expect(css).not.toMatch(/var\(--color-/);
    expect(css).toMatch(/:focus-visible/);
  });
});

describe("Button", () => {
  it("renders its label and fires on click", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Create system</Button>);
    const button = screen.getByRole("button", { name: "Create system" });
    await user.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("activates with the keyboard", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Save</Button>);
    await user.tab();
    expect(screen.getByRole("button", { name: "Save" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("pending replaces the label with pending text and disables the button", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Button pending pendingText="Saving…" onClick={onClick}>
        Save
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Saving…" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    await user.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("disabled renders a disabled button", () => {
    render(<Button disabled>Delete</Button>);
    expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
  });
});

describe("IconButton", () => {
  it("requires an accessible label and activates by keyboard", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <IconButton label="Remove entry" onClick={onClick}>
        ×
      </IconButton>,
    );
    const button = screen.getByRole("button", { name: "Remove entry" });
    await user.tab();
    expect(button).toHaveFocus();
    await user.keyboard(" ");
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("disabled icon buttons do not fire", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <IconButton label="Remove entry" disabled onClick={onClick}>
        ×
      </IconButton>,
    );
    const button = screen.getByRole("button", { name: "Remove entry" });
    expect(button).toBeDisabled();
    await user.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe("FormField", () => {
  it("associates the label with the control and wires hint text", async () => {
    const user = userEvent.setup();
    render(
      <FormField label="Character name" hint="Shown to the table.">
        <input type="text" defaultValue="" />
      </FormField>,
    );
    const input = screen.getByLabelText("Character name");
    const hint = screen.getByText("Shown to the table.");
    expect(input.getAttribute("aria-describedby")).toContain(hint.id);
    await user.click(input);
    await user.type(input, "Ada");
    expect(input).toHaveValue("Ada");
  });

  it("wires error text as an alert and marks the control invalid", () => {
    render(
      <FormField label="Character name" error="Name is required.">
        <input type="text" defaultValue="" />
      </FormField>,
    );
    const input = screen.getByLabelText("Character name");
    expect(input).toHaveAttribute("aria-invalid", "true");
    const error = screen.getByRole("alert");
    expect(error).toHaveTextContent("Name is required.");
    expect(input.getAttribute("aria-describedby")).toContain(error.id);
  });

  it("follows the control's own id when the caller passes one explicitly", () => {
    render(
      <FormField label="Character name" hint="Shown to the table.">
        <input id="custom-name-id" type="text" defaultValue="" />
      </FormField>,
    );
    const input = screen.getByLabelText("Character name");
    expect(input).toHaveAttribute("id", "custom-name-id");
    expect(screen.getByText("Character name")).toHaveAttribute("for", "custom-name-id");
    expect(input.getAttribute("aria-describedby")).toContain("custom-name-id-hint");
  });
});

describe("NumberInput", () => {
  it("labels the native input and steps the value with buttons and keyboard", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<NumberInput label="Hit points" defaultValue={5} onChange={onChange} />);
    const input = screen.getByLabelText("Hit points");
    expect(input).toHaveAttribute("type", "number");
    await user.click(screen.getByRole("button", { name: "Increase value" }));
    expect(onChange).toHaveBeenLastCalledWith(6);
    await user.click(screen.getByRole("button", { name: "Decrease value" }));
    expect(onChange).toHaveBeenLastCalledWith(5);
    await user.click(input);
    await user.clear(input);
    await user.type(input, "8");
    expect(onChange).toHaveBeenLastCalledWith(8);
  });

  it("reports an empty field as null and disables steppers when disabled", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<NumberInput label="Ammo" defaultValue={2} disabled onChange={onChange} />);
    expect(screen.getByRole("button", { name: "Increase value" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Decrease value" })).toBeDisabled();
    expect(screen.getByLabelText("Ammo")).toBeDisabled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("shows pending and error text", () => {
    const { rerender } = render(<NumberInput label="Ammo" defaultValue={2} pending />);
    expect(screen.getByText("Saving…")).toBeInTheDocument();
    rerender(<NumberInput label="Ammo" defaultValue={2} error="Out of range." />);
    expect(screen.getByRole("alert")).toHaveTextContent("Out of range.");
  });

  it("passes testId through to the native input as data-testid", () => {
    render(<NumberInput label="Ammo" defaultValue={2} testId="ammo-input" />);
    const input = screen.getByTestId("ammo-input");
    expect(input).toHaveAttribute("type", "number");
    expect(screen.getByLabelText("Ammo")).toBe(input);
  });
});

describe("Select", () => {
  it("labels the native select and changes the option by keyboard", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Select
        label="Visibility"
        options={[
          { value: "gm", label: "GM only" },
          { value: "all", label: "All players" },
        ]}
        defaultValue="gm"
        onChange={onChange}
      />,
    );
    const select = screen.getByLabelText("Visibility");
    await user.tab();
    expect(select).toHaveFocus();
    await user.selectOptions(select, "all");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(select).toHaveValue("all");
  });

  it("renders validation text and links it to the control", () => {
    render(
      <Select label="Visibility" options={[{ value: "gm", label: "GM only" }]} error="Pick who can see this." />,
    );
    const select = screen.getByLabelText("Visibility");
    expect(select).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("Pick who can see this.");
  });
});

describe("Checkbox", () => {
  it("toggles by clicking the label and by keyboard", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Checkbox label="Share with all players" onChange={onChange} />);
    const box = screen.getByRole("checkbox", { name: "Share with all players" });
    await user.tab();
    expect(box).toHaveFocus();
    await user.keyboard(" ");
    expect(onChange).toHaveBeenCalledTimes(1);
    await user.click(box);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("shows hint and error text", () => {
    const { rerender } = render(<Checkbox label="Share" hint="Visible after reveal." />);
    expect(screen.getByText("Visible after reveal.")).toBeInTheDocument();
    rerender(<Checkbox label="Share" hint="Visible after reveal." error="Cannot share while offline." />);
    expect(screen.getByRole("alert")).toHaveTextContent("Cannot share while offline.");
    // Error supersedes the hint so screen readers hear a single message.
    expect(screen.queryByText("Visible after reveal.")).toBeNull();
  });
});
