import type {
  ActionInputV1, ActionV1, FieldV1, GrantedActionV1, ObjectTemplateV1, ReferenceDataV1, SheetElementV1, SourceExpressionV1, SystemDocumentV1,
} from "../../../../src/systems/implementation/package/schema/document.js";

/**
 * Ember Trail: a small, original test system written for Sweetroll's own
 * scenario. It uses no third-party game text, so it carries no licence of its
 * own. It exercises the rules features of the SRD gaps plan (2026-11-16):
 * weapons sharing formulas (S1), rules tables (S2), beast presets (S3), start
 * full resources (S4), a camp action that resets several resources (S5),
 * applying a roll (S6), attacks on either kind of target or none (S7), one
 * group name per branch (S8), hidden sheet parts (S9), beasts only in
 * campaigns (S10) and path resources computed from the character's stored
 * fields (S11). Paths work like classes: a hero adds one entry per path.
 */
const expressions: SourceExpressionV1[] = [];
function expression(id: string, context: SourceExpressionV1["context"], source: string, resultType: "number" | "boolean" | "text" = context === "roll" ? "number" : "boolean"): string {
  expressions.push({ id, context, resultType, source, fallback: resultType === "number" ? 0 : resultType === "text" ? "" : false });
  return id;
}
function computed(id: string, label: string, source: string, valueType: "number" | "text" | "boolean" = "number", prefix = "c"): FieldV1 {
  const expressionId = expression(`${prefix}_${id}`, "computed", source, valueType);
  return { kind: "computed", id, label, valueType, expressionId };
}
const integer = (id: string, label: string, initial: number, min: number, max: number): FieldV1 => (
  { kind: "integer", id, label, default: initial, min, max, step: 1, required: false });
const fixed = (id: string, label: string, value: number): FieldV1 => integer(id, label, value, value, value);
const flag = (id: string, label: string, initial = false): FieldV1 => ({ kind: "boolean", id, label, default: initial, required: false });
const text = (id: string, label: string): FieldV1 => ({ kind: "text", id, label, default: "", required: false, minLength: 0, maxLength: 500 });
const input = (id: string, label: string, valueType: "integer" | "boolean", initial: number | boolean): ActionInputV1 => (
  { id, label, valueType, required: false, default: initial });
/** A resource whose maximum is calculated; it starts full and fills when it first rises from 0 (S4). */
function resource(id: string, label: string, maximum: string, prefix = "c"): FieldV1 {
  const maxExpressionId = expression(`${prefix}_${id}_max`, "computed", maximum, "number");
  return { kind: "resource", id, label, default: { current: 0, max: 0 }, min: 0, max: 99, step: 1, maxExpressionId, resetTo: "max", startFull: true };
}
// Definition IDs are unique across the document, so each sheet prefixes its elements.
const show = (sheet: string, ids: string[]): SheetElementV1[] => ids.map((fieldId) => ({ kind: "field", id: `${sheet}_show_${fieldId}`, fieldId }));
const meter = (sheet: string, ids: string[]): SheetElementV1[] => ids.map((resourceId) => ({ kind: "resource", id: `${sheet}_meter_${resourceId}`, resourceId }));
const use = (sheet: string, ids: string[]): SheetElementV1[] => ids.map((actionId) => ({ kind: "action", id: `${sheet}_use_${actionId}`, actionId }));

// A d20 test with an edge (roll two, keep the higher) or a snag (keep the
// lower). Each branch names the same group; only one runs (S8).
const testInputs = [input("edge", "Edge", "boolean", false), input("snag", "Snag", "boolean", false), input("bonus", "Bonus", "integer", 0)];
const SNAG = "inputs.snag && !inputs.edge";
const D20 = `if(${SNAG}, keepLowest(group("d20", "d20", dice(2, 20)), 1), keepHighest(group("d20", "d20", dice(if(inputs.edge && !inputs.snag, 2, 1), 20)), 1))`;
const NATURAL = `if(${SNAG}, keepLowest(rolled("d20"), 1), keepHighest(rolled("d20"), 1))`;

/** One attack for heroes and beasts: graded against a target of either kind, or none (S7). */
function strike(prefix: string, modifier: string, targetEntity: "hero" | "beast"): Extract<ActionV1, { kind: "roll" }> {
  return {
    kind: "roll", id: `${prefix}_strike`, label: "Strike", inputs: testInputs, outputTemplate: "Strike: {total}",
    expressionId: expression(`${prefix}_strike_roll`, "roll", `${D20} + ${modifier} + inputs.bonus`),
    target: { entityId: targetEntity, otherEntityIds: [targetEntity === "hero" ? "beast" : "hero"], optional: true },
    outcomes: [
      { id: "blaze", label: "Blaze (natural 20)", expressionId: expression(`${prefix}_o_blaze`, "outcome", `${NATURAL} == 20`) },
      { id: "hit", label: "Hit", expressionId: expression(`${prefix}_o_hit`, "outcome", "roll.total >= target.guard") },
      { id: "miss", label: "Miss", expressionId: expression(`${prefix}_o_miss`, "outcome", "roll.total < target.guard") },
      { id: "compare", label: "Compare with the target's guard", expressionId: expression(`${prefix}_o_compare`, "outcome", "true") },
    ],
    details: [{ id: "guard", label: "Target guard", expressionId: expression(`${prefix}_d_guard`, "outcome", "target.guard", "number") }],
  };
}

const referenceData: ReferenceDataV1[] = [
  {
    id: "paths", label: "Paths", keyColumn: "key", columns: { key: "text", hp: "number", knack: "text" },
    records: [
      { id: "warden", label: "Warden", values: { key: "warden", hp: 4, knack: "Stand firm" } },
      { id: "scout", label: "Scout", values: { key: "scout", hp: 2, knack: "Vanish" } },
    ],
  },
  {
    // S3: every stat block is a ready-made beast.
    id: "bestiary", label: "Bestiary",
    records: [
      { id: "ash_wolf", label: "Ash wolf", values: { guard: 12, hp: 6, bite_die: 6, bite_bonus: 2 } },
      { id: "cinder_boar", label: "Cinder boar", values: { guard: 13, hp: 11, bite_die: 8, bite_bonus: 3 } },
    ],
  },
  {
    id: "lore", label: "Trail lore",
    records: [
      { id: "camp", label: "Making camp", values: { description: "A camp restores health and grit." } },
      { id: "embers", label: "Embers", values: { description: "Embers glow where the trail turns." } },
    ],
  },
];

const PATHS = (field: string) => `sum("path_list", "${field}")`;
const heroFields: FieldV1[] = [
  integer("might", "Might", 1, 0, 5),
  integer("grace", "Grace", 1, 0, 5),
  computed("level", "Level", PATHS("rank")),
  computed("guard", "Guard", '10 + fields.grace + sumWhere("gear", "guard_bonus", "worn")'),
  resource("hp", "Health", `if(${PATHS("rank")} > 0, 4 + ${PATHS("hp")}, 0)`),
  resource("grit", "Grit", "if(fields.level > 0, 2, 0)"),
  computed("down", "Down", "fields.level > 0 && fields.hp.current == 0", "boolean"),
  text("notes", "Notes"),
];
const beastFields: FieldV1[] = [
  integer("guard", "Guard", 10, 0, 30),
  { kind: "resource", id: "hp", label: "Health", default: { current: 1, max: 1 }, min: 0, max: 200, step: 1, resetTo: "max" },
  integer("bite_die", "Bite die", 4, 2, 12),
  integer("bite_bonus", "Bite bonus", 0, 0, 10),
];

const heroActions: ActionV1[] = [
  {
    kind: "roll", id: "test_might", label: "Test Might", inputs: testInputs, outputTemplate: "Might: {total}",
    expressionId: expression("test_might_roll", "roll", `${D20} + fields.might + inputs.bonus`),
  },
  // S5: one command resets health and grit.
  { kind: "resourceBatch", id: "camp", label: "Make camp", steps: [
    { resourceId: "hp", operation: { kind: "reset" } }, { resourceId: "grit", operation: { kind: "reset" } },
  ] },
  { kind: "resourceBump", id: "spend_grit", label: "Spend grit", resourceId: "grit", operation: { kind: "delta", amount: -1 } },
];
const beastActions: ActionV1[] = [
  { ...strike("beast", "fields.bite_bonus", "hero"), id: "bite" },
  {
    kind: "roll", id: "bite_damage", label: "Bite damage", inputs: [], outputTemplate: "Bite: {total} damage",
    expressionId: expression("bite_damage_roll", "roll", "dice(1, fields.bite_die) + fields.bite_bonus"),
  },
];

// S1: every weapon is its own template; they share the strike and damage formulas.
const weaponStrike: GrantedActionV1 = strike("w", "fields.might", "beast");
const weaponDamage: GrantedActionV1 = {
  kind: "roll", id: "damage", label: "Damage", inputs: [], outputTemplate: "{total} damage",
  expressionId: expression("w_damage_roll", "roll", "dice(1, item.die) + fields.might"),
};
const weapon = (id: string, label: string, die: number): ObjectTemplateV1 => ({
  kind: "item", id, label, fields: [fixed("die", "Damage die", die)], grantedActions: [weaponStrike, weaponDamage],
});

// Paths work like classes: one entry per path. S11: the knack's uses are a
// resource of the entry, calculated from the rank and the hero's stored Grace.
const pathTemplate: ObjectTemplateV1 = {
  kind: "effect", id: "path", label: "Path", description: "Add one entry per path the hero follows.",
  fields: [
    { kind: "singleChoice", id: "path", label: "Path", required: false, default: "warden", options: [], optionsFrom: "paths" },
    integer("rank", "Rank", 1, 1, 5),
    computed("hp", "Health from this path", 'lookup("paths", item.path, "hp") * item.rank', "number", "p"),
    computed("knack", "Knack", 'lookup("paths", item.path, "knack")', "text", "p"),
    resource("knack_uses", "Knack uses", "item.rank + fields.grace", "p"),
  ],
  grantedActions: [{ kind: "resourceBump", id: "use_knack", label: "Use knack", resourceId: "knack_uses", operation: { kind: "delta", amount: -1 } }],
};

export const emberTrailDocument: SystemDocumentV1 = {
  schemaVersion: "2.0",
  metadata: { name: "Ember Trail", description: "A small original test system for Sweetroll's scenarios.", language: "en", defaultDice: "d20" },
  entities: [
    { id: "hero", label: "Hero", kind: "playable", fields: heroFields },
    { id: "beast", label: "Beast", kind: "npc", presetsFrom: "bestiary", fields: beastFields },
  ],
  referenceData,
  sheets: [
    {
      id: "hero_sheet", label: "Hero", targetEntityId: "hero", sections: [
        { id: "sec_hero", label: "Hero", elements: [
          ...show("h", ["might", "grace", "level", "guard"]), ...meter("h", ["hp", "grit"]), ...use("h", ["test_might", "camp", "spend_grit"]),
          { kind: "slot", id: "h_paths", slotId: "path_list" }, { kind: "slot", id: "h_gear", slotId: "gear" },
        ] },
        // S9: only shown while the hero is down.
        { id: "sec_down", label: "Down", visibleWhen: "down", elements: show("h", ["notes"]) },
      ],
    },
    {
      id: "beast_sheet", label: "Beast", targetEntityId: "beast", sections: [
        { id: "sec_beast", label: "Beast", elements: [...show("b", ["guard", "bite_die", "bite_bonus"]), ...meter("b", ["hp"]), ...use("b", ["bite", "bite_damage"])] },
      ],
    },
  ],
  expressions,
  actions: [...heroActions, ...beastActions],
  validations: [],
  templates: [
    pathTemplate,
    weapon("hatchet", "Hatchet", 6),
    weapon("spear", "Spear", 8),
    { kind: "item", id: "leather", label: "Leather coat", fields: [flag("worn", "Worn", true), fixed("guard_bonus", "Guard bonus", 2)], grantedActions: [] },
  ],
  slots: [
    { id: "path_list", label: "Paths", accepts: ["effect"], maxEntries: 4 },
    { id: "gear", label: "Gear", accepts: ["item"], maxEntries: 10 },
  ],
};
