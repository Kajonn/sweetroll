import { d20Document } from "../../src/systems/implementation/package/fixtures/index.js";
export function derivedTemplateDocument() {
  const d = structuredClone(d20Document);
  d.schemaVersion = "1.2";
  d.slots = [
    { id: "inventory", label: "Inventory", accepts: ["item"], maxEntries: 4 },
  ];
  d.sheets[0]!.sections[0]!.elements.push({
    kind: "slot",
    id: "inventory_element",
    slotId: "inventory",
  });
  d.templates = [
    {
      id: "sword",
      kind: "item",
      label: "Longsword",
      fields: [
        {
          id: "damage_bonus",
          kind: "integer",
          label: "Damage bonus",
          default: 1,
          required: true,
          min: 0,
          max: 10,
          step: 1,
        },
        {
          id: "name",
          kind: "text",
          label: "Inscription",
          default: "Binding name",
          required: false,
          minLength: 0,
          maxLength: 200,
        },
        {
          id: "fuel",
          kind: "resource",
          label: "Fuel",
          default: { current: 2, max: 3 },
          min: 0,
          max: 3,
          step: 1,
          resetTo: "max",
        },
      ],
      grantedActions: [
        {
          id: "sword_hit",
          kind: "roll",
          label: "Hit",
          expressionId: "sword_hit_expr",
          inputs: [],
          outputTemplate: "Hit {total}",
        },
        {
          id: "sword_damage",
          kind: "roll",
          label: "Damage",
          expressionId: "sword_damage_expr",
          inputs: [],
          outputTemplate: "Damage {total}",
        },
        {
          id: "sword_salute",
          kind: "roll",
          label: "Salute",
          expressionId: "sword_salute_expr",
          inputs: [],
          outputTemplate: "You salute",
          nominal: true,
        },
        {
          id: "sword_refuel",
          kind: "resourceBump",
          label: "Refuel",
          resourceId: "fuel",
          operation: { kind: "delta", amount: 1 },
        },
        {
          id: "sword_pool",
          kind: "roll",
          label: "Pool",
          expressionId: "sword_pool_expr",
          inputs: [],
          outputTemplate: "Pool {total}",
          pushPolicy: {
            version: "1.0",
            maxAttempts: 2,
            successThreshold: 1,
            allowOnSuccess: true,
            groups: [
              { groupId: "attribute", lockedFaces: [], reportedFaces: [1] },
            ],
          },
        },
      ],
    },
  ];
  d.expressions.push(
    {
      id: "sword_salute_expr",
      context: "roll",
      resultType: "number",
      source: "d20",
      fallback: 0,
    },
    {
      id: "sword_hit_expr",
      context: "roll",
      resultType: "number",
      source: "d20 + fields.modifier + fields.damage_bonus",
      fallback: 0,
    },
    {
      id: "sword_damage_expr",
      context: "roll",
      resultType: "number",
      source: "d8 + fields.damage_bonus",
      fallback: 0,
    },
    {
      id: "sword_pool_expr",
      context: "roll",
      resultType: "number",
      source:
        'countSuccesses(group("attribute", "Attribute", dice(fields.ability,6)),6)',
      fallback: 0,
    },
  );
  d.entities.push({ id: "npc", label: "NPC", fields: [] });
  d.sheets.push({
    id: "npc_sheet",
    label: "NPC",
    targetEntityId: "npc",
    sections: [
      {
        id: "npc_section",
        label: "Inventory",
        elements: [
          { kind: "heading", id: "npc_inventory", text: "NPC", level: 2 },
        ],
      },
    ],
  });
  return d;
}
