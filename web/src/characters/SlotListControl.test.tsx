import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { SlotListControl, type SlotTemplate } from "./SlotListControl.js";

const SWORD_ENTRY_ID = "aaaaaaaa-1111-4111-8111-111111111111";
const STONE_ENTRY_ID = "cccccccc-3333-4333-8333-333333333333";

const templates: SlotTemplate[] = [
  {
    id: "longsword",
    label: "Longsword",
    kind: "item",
    grantedActions: [
      { id: "longsword_attack", label: "Longsword Attack", actionKind: "roll", inputs: [] },
    ],
  },
  {
    id: "torch",
    label: "Torch",
    kind: "item",
    grantedActions: [],
  },
];

const entries = [
  { entryId: SWORD_ENTRY_ID, templateId: "longsword", label: "Longsword", values: { weapon_bonus: 1 } },
  { entryId: STONE_ENTRY_ID, templateId: null, label: "Lucky Stone", values: { name: "Lucky Stone" } },
];

function callbacks() {
  return {
    onAddEntry: vi.fn(),
    onRemoveEntry: vi.fn(),
    onUpdateEntry: vi.fn(),
    onExecuteGranted: vi.fn(),
  };
}

function renderControl(overrides: Partial<Parameters<typeof SlotListControl>[0]> = {}) {
  const handlers = callbacks();
  render(
    <SlotListControl
      slotId="inventory"
      label="Inventory"
      accepts={["item"]}
      entries={entries}
      templates={templates}
      disabled={false}
      {...handlers}
      {...overrides}
    />,
  );
  return handlers;
}

describe("SlotListControl", () => {
  it("lists entries with their values and shows an empty state when bare", () => {
    renderControl();
    expect(screen.getByTestId("slot-list-inventory")).toBeVisible();
    expect(screen.getByTestId(`slot-entry-${SWORD_ENTRY_ID}`)).toHaveTextContent("Longsword");
    expect(screen.getByTestId(`slot-entry-${SWORD_ENTRY_ID}`)).toHaveTextContent("weapon_bonus: 1");
    expect(screen.getByTestId(`slot-entry-${STONE_ENTRY_ID}`)).toHaveTextContent("Lucky Stone");
    expect(screen.getByTestId(`slot-entry-${STONE_ENTRY_ID}`)).not.toHaveTextContent("name: Lucky Stone");
    expect(screen.queryByTestId(`slot-entry-rename-${STONE_ENTRY_ID}`)).not.toBeInTheDocument();

    renderControl({ entries: [] });
    expect(screen.getByTestId("slot-empty-inventory")).toHaveTextContent("No entries yet.");
  });

  it("adds a templated entry through the picker", async () => {
    const user = userEvent.setup();
    const handlers = renderControl();

    await user.click(screen.getByTestId("slot-add-inventory"));
    const picker = screen.getByTestId("slot-template-picker-inventory");
    expect(within(picker as unknown as HTMLElement).getByRole("option", { name: "Longsword" })).toBeInTheDocument();
    expect(within(picker as unknown as HTMLElement).getByRole("option", { name: "Custom entry" })).toBeInTheDocument();

    await user.selectOptions(picker as unknown as HTMLElement, "torch");
    await user.click(screen.getByTestId("slot-add-confirm-inventory"));
    expect(handlers.onAddEntry).toHaveBeenCalledWith("inventory", "torch", {});
  });

  it("adds a custom entry through the labeled fallback", async () => {
    const user = userEvent.setup();
    const handlers = renderControl();

    await user.click(screen.getByTestId("slot-add-inventory"));
    await user.selectOptions(screen.getByTestId("slot-template-picker-inventory") as unknown as HTMLElement, "");
    await user.type(screen.getByTestId("slot-custom-name-inventory"), "Lucky Stone");
    await user.click(screen.getByTestId("slot-add-confirm-inventory"));
    expect(handlers.onAddEntry).toHaveBeenCalledWith("inventory", null, { name: "Lucky Stone" });
  });

  it("asks for confirmation before removing an entry", async () => {
    const user = userEvent.setup();
    const handlers = renderControl();

    await user.click(screen.getByTestId(`slot-entry-remove-${SWORD_ENTRY_ID}`));
    expect(screen.getByRole("dialog")).toHaveTextContent("Remove Longsword?");
    expect(handlers.onRemoveEntry).not.toHaveBeenCalled();
    await user.click(screen.getByTestId(`slot-entry-remove-confirm-${SWORD_ENTRY_ID}`));
    expect(handlers.onRemoveEntry).toHaveBeenCalledWith(SWORD_ENTRY_ID);
  });

  it("submits a granted roll through the callback prop", async () => {
    const user = userEvent.setup();
    const handlers = renderControl();

    await user.click(screen.getByRole("button", { name: "Longsword Attack" }));
    expect(handlers.onExecuteGranted).toHaveBeenCalledWith(SWORD_ENTRY_ID, "longsword_attack", {});
  });

  it("renames a custom entry through the update callback", async () => {
    const user = userEvent.setup();
    const handlers = renderControl();

    await user.click(within(screen.getByTestId(`slot-entry-${STONE_ENTRY_ID}`)).getByRole("button", { name: "Rename" }));
    const rename = screen.getByTestId(`slot-entry-rename-${STONE_ENTRY_ID}`);
    await user.clear(within(rename).getByRole("textbox"));
    await user.type(within(rename).getByRole("textbox"), "Unlucky Stone");
    await user.click(within(rename).getByRole("button", { name: "Save name" }));
    expect(handlers.onUpdateEntry).toHaveBeenCalledWith(STONE_ENTRY_ID, { name: "Unlucky Stone" });
    expect(screen.queryByTestId(`slot-entry-rename-${STONE_ENTRY_ID}`)).not.toBeInTheDocument();
  });

  it("disables entry controls while keeping the list readable", () => {
    renderControl({ disabled: true });
    expect(screen.getByTestId("slot-add-inventory")).toBeDisabled();
    expect(screen.getByTestId(`slot-entry-remove-${SWORD_ENTRY_ID}`)).toBeDisabled();
    expect(screen.getByRole("button", { name: "Longsword Attack" })).toBeDisabled();
    expect(screen.getByTestId(`slot-entry-${SWORD_ENTRY_ID}`)).toHaveTextContent("Longsword");
  });
});
