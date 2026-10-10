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
    fields: [{ id: "weapon_bonus", label: "Weapon bonus", kind: "integer", default: 0,
      required: true, min: 0, max: 10, step: 1 }],
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
    expect(screen.queryByTestId(`slot-entry-personal-${STONE_ENTRY_ID}`)).not.toBeInTheDocument();

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
    expect(handlers.onAddEntry).toHaveBeenCalledWith("inventory", null, { name: "Lucky Stone" }, 1);
  });

  it("creates personal details and quantity and edits them together", async () => {
    const user = userEvent.setup();
    const handlers = renderControl();
    await user.click(screen.getByTestId("slot-add-inventory"));
    await user.selectOptions(screen.getByTestId("slot-template-picker-inventory"), "");
    await user.type(screen.getByLabelText("Entry name"), "Ancient key");
    await user.type(screen.getByLabelText("Description"), "Opens the tower");
    await user.type(screen.getByLabelText("Notes"), "Found by Ada");
    await user.clear(screen.getByLabelText("Quantity"));
    await user.type(screen.getByLabelText("Quantity"), "3");
    await user.click(screen.getByTestId("slot-add-confirm-inventory"));
    expect(handlers.onAddEntry).toHaveBeenCalledWith("inventory", null,
      { name: "Ancient key", description: "Opens the tower", notes: "Found by Ada" }, 3);
    const row = within(screen.getByTestId(`slot-entry-${STONE_ENTRY_ID}`));
    expect(row.getByText("Personal")).toBeVisible();
    await user.click(row.getByRole("button", { name: "Edit entry" }));
    await user.type(row.getByLabelText("Description"), "A charm");
    await user.type(row.getByLabelText("Notes"), "Keep safe");
    await user.clear(row.getByLabelText("Quantity"));
    await user.type(row.getByLabelText("Quantity"), "2");
    await user.click(row.getByRole("button", { name: "Save entry" }));
    expect(handlers.onUpdateEntry).toHaveBeenCalledWith(STONE_ENTRY_ID,
      { name: "Lucky Stone", description: "A charm", notes: "Keep safe" }, 2);
  });

  it("exposes populated personal textareas by their accessible names", async () => {
    const user = userEvent.setup();
    const handlers = renderControl({ entries: [{
      entryId: STONE_ENTRY_ID, templateId: null, label: "Lucky Stone", quantity: 3,
      values: { name: "Lucky Stone", description: "A charm from the tower", notes: "Found by Ada" },
    }] });
    const row = within(screen.getByTestId(`slot-entry-${STONE_ENTRY_ID}`));
    await user.click(row.getByRole("button", { name: "Edit entry" }));
    expect(row.getByRole("textbox", { name: "Description" })).toHaveValue("A charm from the tower");
    const notes = row.getByRole("textbox", { name: "Notes" });
    expect(notes).toHaveValue("Found by Ada");
    await user.clear(notes);
    await user.type(notes, "Keep safe");
    await user.click(row.getByRole("button", { name: "Save entry" }));
    expect(handlers.onUpdateEntry).toHaveBeenCalledWith(STONE_ENTRY_ID,
      { name: "Lucky Stone", description: "A charm from the tower", notes: "Keep safe" }, 3);
  });

  it("keeps the personal form and data visible when saving fails", async () => {
    const user = userEvent.setup();
    renderControl({ onAddEntry: vi.fn().mockRejectedValue(new Error("Access revoked")) });
    await user.click(screen.getByTestId("slot-add-inventory"));
    await user.selectOptions(screen.getByTestId("slot-template-picker-inventory"), "");
    await user.type(screen.getByLabelText("Entry name"), "Tower key");
    await user.clear(screen.getByLabelText("Quantity"));
    await user.type(screen.getByLabelText("Quantity"), "0");
    expect(screen.getByTestId("slot-add-confirm-inventory")).toBeDisabled();
    await user.clear(screen.getByLabelText("Quantity"));
    await user.type(screen.getByLabelText("Quantity"), "2");
    await user.click(screen.getByTestId("slot-add-confirm-inventory"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Access revoked");
    expect(screen.getByLabelText("Entry name")).toHaveValue("Tower key");
    expect(screen.getByRole("dialog")).toBeVisible();
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

    await user.click(within(screen.getByTestId(`slot-entry-${STONE_ENTRY_ID}`)).getByRole("button", { name: "Edit entry" }));
    const rename = screen.getByTestId(`slot-entry-personal-${STONE_ENTRY_ID}`);
    await user.clear(within(rename).getByLabelText("Entry name"));
    await user.type(within(rename).getByLabelText("Entry name"), "Unlucky Stone");
    await user.click(within(rename).getByRole("button", { name: "Save entry" }));
    expect(handlers.onUpdateEntry).toHaveBeenCalledWith(STONE_ENTRY_ID, { name: "Unlucky Stone" }, 1);
    expect(screen.queryByTestId(`slot-entry-personal-${STONE_ENTRY_ID}`)).not.toBeInTheDocument();
  });

  it("edits a templated value and item quantity through the update callback", async () => {
    const user = userEvent.setup();
    const handlers = renderControl();
    await user.click(screen.getByTestId(`slot-entry-edit-${SWORD_ENTRY_ID}`));
    const bonus = screen.getByTestId(`slot-entry-field-${SWORD_ENTRY_ID}-weapon_bonus`);
    await user.clear(bonus);
    await user.type(bonus, "3");
    const quantity = screen.getByTestId(`slot-entry-quantity-${SWORD_ENTRY_ID}`);
    await user.clear(quantity);
    await user.type(quantity, "2");
    await user.click(screen.getByRole("button", { name: "Save values" }));
    expect(handlers.onUpdateEntry).toHaveBeenCalledWith(SWORD_ENTRY_ID, { weapon_bonus: 3 }, 2);
  });

  it("disables entry controls while keeping the list readable", () => {
    renderControl({ disabled: true });
    expect(screen.getByTestId("slot-add-inventory")).toBeDisabled();
    expect(screen.getByTestId(`slot-entry-remove-${SWORD_ENTRY_ID}`)).toBeDisabled();
    expect(screen.getByRole("button", { name: "Longsword Attack" })).toBeDisabled();
    expect(screen.getByTestId(`slot-entry-${SWORD_ENTRY_ID}`)).toHaveTextContent("Longsword");
  });
});

it('edits a data-only campaign spell without adding an item quantity',async()=>{
 const user=userEvent.setup();const source={kind:'campaign' as const,campaignId:STONE_ENTRY_ID,templateId:SWORD_ENTRY_ID,templateRevision:1,contentRevision:1};
 const handlers=renderControl({accepts:['spell'],entries:[{entryId:STONE_ENTRY_ID,templateId:null,label:'Spark',source,values:{name:'Spark',notes:'Old'}}]});
 await user.click(screen.getByRole('button',{name:'Edit entry'}));expect(screen.queryByRole('spinbutton',{name:'Quantity'})).toBeNull();
 await user.clear(screen.getByRole('textbox',{name:'Notes'}));await user.type(screen.getByRole('textbox',{name:'Notes'}),'Local');await user.click(screen.getByRole('button',{name:'Save entry'}));
 expect(handlers.onUpdateEntry).toHaveBeenCalledWith(STONE_ENTRY_ID,{name:'Spark',notes:'Local'},undefined);
});
