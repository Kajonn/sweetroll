import { describe, expect, it } from "vitest";

import type {
  ObjectTemplateV1,
  SlotDefinitionV1,
} from "../package/schema/index.js";
import type { CharacterEntryV1 } from "../package/schema/dynamic.js";
import { buildEntryScope, validateEntryForSlot } from "./entries.js";

const swordTemplate: ObjectTemplateV1 = {
  id: "longsword",
  label: "Longsword",
  kind: "item",
  fields: [
    {
      kind: "integer",
      id: "bonus",
      label: "Bonus",
      default: 0,
      required: true,
      min: 0,
      max: 10,
      step: 1,
    },
  ],
  grantedActions: [],
};

const spellTemplate: ObjectTemplateV1 = {
  id: "fireball",
  label: "Fireball",
  kind: "spell",
  fields: [],
  grantedActions: [],
};

const inventorySlot: SlotDefinitionV1 = {
  id: "inventory",
  label: "Inventory",
  accepts: ["item"],
  maxEntries: 2,
};

function entry(overrides: Partial<CharacterEntryV1> = {}): CharacterEntryV1 {
  return {
    entryId: "123e4567-e89b-12d3-a456-426614174000",
    slotId: "inventory",
    templateId: "longsword",
    values: { bonus: 1 },
    ...overrides,
  };
}

describe("validateEntryForSlot", () => {
  it("accepts a valid templated entry", () => {
    expect(
      validateEntryForSlot(entry(), [inventorySlot], [swordTemplate], 0),
    ).toEqual({ ok: true });
  });

  it("rejects an entry with an unknown slotId", () => {
    const result = validateEntryForSlot(
      entry({ slotId: "missing_slot" }),
      [inventorySlot],
      [swordTemplate],
      0,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("unknown_slot");
  });

  it("rejects a template kind the slot does not accept", () => {
    const result = validateEntryForSlot(
      entry({ templateId: "fireball" }),
      [inventorySlot],
      [swordTemplate, spellTemplate],
      0,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("kind_not_accepted");
  });

  it("rejects a custom entry carrying granted actions (data-only lock)", () => {
    const result = validateEntryForSlot(
      entry({
        templateId: null,
        values: { name: "Lucky Stone", actions: [{ id: "sneaky_attack" }] },
      }),
      [inventorySlot],
      [swordTemplate],
      0,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("custom_entry_with_actions");
  });

  it("accepts a plain custom entry without actions", () => {
    expect(
      validateEntryForSlot(
        entry({ templateId: null, values: { name: "Lucky Stone" } }),
        [inventorySlot],
        [swordTemplate],
        0,
      ),
    ).toEqual({ ok: true });
  });

  it("accepts bounded personal details in every supported slot kind", () => {
    for (const kind of ["item", "spell", "talent", "effect"] as const) {
      expect(validateEntryForSlot(entry({ templateId: null,
        values: { name: "Ancient key", description: "Opens the tower", notes: "Found by Ada" }, quantity: 2 }),
        [{ ...inventorySlot, accepts: [kind] }], [], 0)).toEqual({ ok: true });
    }
  });

  it.each([
    { name: " " }, { name: "x".repeat(201) }, { name: 4 },
    { name: "Key", description: "x".repeat(2001) },
    { name: "Key", notes: "x".repeat(2001) }, { name: "Key", notes: {} },
    { name: "Key", kind: "spell" }, { name: "Key", formula: "d20" },
  ])("rejects invalid or unbounded personal data %j", (values) => {
    expect(validateEntryForSlot(entry({ templateId: null, values }), [inventorySlot], [], 0))
      .toMatchObject({ ok: false, code: "entry_values_invalid" });
  });

  it("rejects entry values violating template field types", () => {
    const result = validateEntryForSlot(
      entry({ values: { bonus: "lots" } }),
      [inventorySlot],
      [swordTemplate],
      0,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("entry_values_invalid");
  });

  it("rejects entry values with unknown field ids", () => {
    const result = validateEntryForSlot(
      entry({ values: { bogus_field: 1 } }),
      [inventorySlot],
      [swordTemplate],
      0,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("entry_values_invalid");
  });

  it("rejects an entry when the slot is full", () => {
    const result = validateEntryForSlot(
      entry(),
      [inventorySlot],
      [swordTemplate],
      2,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("slot_full");
  });
});

describe("buildEntryScope", () => {
  it("merges character and entry values with entry winning on collision", () => {
    expect(
      buildEntryScope({ strength_mod: 2, bonus: 0 }, { bonus: 1 }),
    ).toEqual({ strength_mod: 2, bonus: 1 });
  });
});
