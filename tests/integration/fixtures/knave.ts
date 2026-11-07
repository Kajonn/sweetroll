import type {
  ActionV1, FieldV1, IntegerFieldV1, ObjectTemplateV1, SheetElementV1, SourceExpressionV1, SystemDocumentV1,
} from "../../../src/systems/implementation/package/schema/document.js";

const abilities = [
  ["strength", "Strength"], ["dexterity", "Dexterity"], ["constitution", "Constitution"],
  ["intelligence", "Intelligence"], ["wisdom", "Wisdom"], ["charisma", "Charisma"],
] as const;

function integer(id: string, label: string, initial: number, min: number, max: number): IntegerFieldV1 {
  return { kind: "integer", id, label, default: initial, min, max, step: 1, required: true };
}

const defenses = [
  ...abilities.map(([id, label]) => ({ id: `${id}_defense`, label: `${label} defense`, bonus: id })),
  { id: "armor_defense", label: "Armor defense", bonus: "armor_bonus" },
  { id: "item_capacity", label: "Item slot capacity", bonus: "constitution" },
];

const saves = abilities.map(([id, label]) => ({
  id: `save_${id}`, label: `${label} save`, source: `d20 + fields.${id}`,
}));
const combatRolls = [
  { id: "melee", label: "Melee attack", source: "d20 + fields.strength" },
  { id: "ranged", label: "Ranged attack", source: "d20 + fields.wisdom" },
  { id: "initiative", label: "Side initiative", source: "d6" },
  { id: "morale", label: "Morale check", source: "2d6" },
  { id: "reaction", label: "Reaction check", source: "2d6" },
  { id: "overnight_healing", label: "Overnight healing", source: "d8 + fields.constitution" },
];
const rollDefinitions = [
  ...saves, ...combatRolls,
  { id: "dagger_damage", label: "Dagger damage", source: "d6" },
];

function roll(id: string, label: string): Extract<ActionV1, { kind: "roll" }> {
  return { kind: "roll", id, label, expressionId: `${id}_expr`, inputs: [], outputTemplate: "Rolled {total}" };
}

const fields: FieldV1[] = [
  ...abilities.map(([id, label]) => integer(id, `${label} bonus`, 1, 1, 10)),
  ...defenses.map(({ id, label }): FieldV1 => ({
    kind: "computed", id, label, valueType: "number", expressionId: `${id}_expr`,
  })),
  integer("armor_bonus", "Armor bonus", 1, 1, 10),
  integer("level", "Level", 1, 1, 10),
  integer("xp", "Experience", 0, 0, 10_000),
  integer("copper", "Copper pieces", 0, 0, 1_000_000),
  { kind: "resource", id: "hp", label: "Hit points", default: { current: 1, max: 1 }, min: -1, max: 80, step: 1, resetTo: "max" },
  { kind: "text", id: "background", label: "Background", default: "", required: false, minLength: 0, maxLength: 120 },
];

const templates: ObjectTemplateV1[] = [
  {
    kind: "item", id: "dagger", label: "Dagger", description: "Light one-handed weapon.",
    fields: [
      integer("dagger_slots", "Slots", 1, 1, 1),
      integer("dagger_quality", "Quality", 3, 0, 3),
    ],
    grantedActions: [roll("dagger_damage", "Dagger damage")],
  },
  {
    kind: "item", id: "brigandine", label: "Brigandine",
    fields: [
      integer("brigandine_slots", "Slots", 2, 2, 2),
      integer("brigandine_defense", "Armor defense", 13, 13, 13),
      integer("brigandine_quality", "Quality", 4, 0, 4),
    ],
    grantedActions: [],
  },
  {
    kind: "item", id: "rations", label: "Rations",
    fields: [integer("ration_days", "Days of food", 2, 0, 2)], grantedActions: [],
  },
  {
    kind: "spell", id: "counterspell_book", label: "Counterspell spellbook",
    description: "Contest the other caster's Intelligence with an opposed save to interrupt a spell cast nearby.",
    fields: [integer("counterspell_slots", "Slots", 1, 1, 1)], grantedActions: [],
  },
];

const rollExpressions: SourceExpressionV1[] = rollDefinitions.map(({ id, source }) => ({
  id: `${id}_expr`, context: "roll", resultType: "number", source, fallback: 0,
}));

function sheetFields(ids: string[]): SheetElementV1[] {
  return ids.map((fieldId) => ({ kind: "field", id: `show_${fieldId}`, fieldId }));
}

function sheetActions(ids: string[]): SheetElementV1[] {
  return ids.map((actionId) => ({ kind: "action", id: `use_${actionId}`, actionId }));
}

export const knaveDocument: SystemDocumentV1 = {
  schemaVersion: "1.0",
  metadata: {
    name: "Knave 1e",
    description: "Adapted for Sweetroll from Knave 1.0 by Ben Milton, Questing Beast Games (https://questingbeast.itch.io/knave), licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). This adaptation adds a digital sheet and roll actions, paraphrases table rules, and includes a sample equipment and spell catalog.",
    language: "en",
    defaultDice: "d20",
  },
  entities: [{ id: "knave", label: "Knave", kind: "playable", fields }],
  referenceData: [{
    id: "knave_rules", label: "Rules reference", records: [
      { id: "creation_rules", label: "Character creation", values: { rule: "For each ability, take the lowest of three d6s as the bonus. You may swap two bonuses. Roll a d8 for starting maximum HP and begin at full health. Start with two days of food, a weapon, and the gear determined at the table." } },
      { id: "save_rules", label: "Saves and stunts", values: { rule: "A save succeeds when d20 plus the relevant bonus exceeds 15. Use the opponent's defense in a contest. For advantage or disadvantage use the higher or lower of two d20s. Resolve stunts as contests." } },
      { id: "combat_rules", label: "Combat", values: { rule: "Roll d6 each round for initiative. Enemies act first on 1–3. Attacks must exceed the target's armor defense, then deal weapon damage. A natural 20 on an attack adds a damage die and wears the defender's armor. A natural 1 wears the attacker's weapon." } },
      { id: "health_rules", label: "Health", values: { rule: "At 0 HP you are unconscious. At −1 HP or below you die. Apply the healing roll after a meal and a full night's rest. Rest in a safe haven restores all HP." } },
      { id: "gear_rules", label: "Inventory and magic", values: { rule: "Your Constitution defense is your item slot capacity. Track the slots and quality of individual objects, and use the armor bonus for the gear you are wearing. Spellbooks occupy inventory space. Resolve their effects at the table." } },
      { id: "advancement_rules", label: "Advancement", values: { rule: "Gain a level at each 1,000 XP. Increase three different ability bonuses by one, up to +10. Roll one d8 per new level for maximum HP. If the total is lower than your old maximum, increase the old maximum by one instead." } },
    ],
  }],
  sheets: [{
    id: "knave_sheet", label: "Knave character sheet", targetEntityId: "knave",
    sections: [
      {
        id: "profile", label: "Character",
        elements: [
          ...sheetFields(["background", "level", "xp"]),
          { kind: "resource", id: "show_hp", resourceId: "hp" },
        ],
      },
      {
        id: "ability_scores", label: "Abilities and saves",
        elements: abilities.flatMap(([id]) => [
          ...sheetFields([id, `${id}_defense`]), ...sheetActions([`save_${id}`]),
        ]),
      },
      {
        id: "combat", label: "Combat and recovery",
        elements: [
          ...sheetFields(["armor_bonus", "armor_defense"]),
          ...sheetActions([...combatRolls.map(({ id }) => id), "recover_full"]),
        ],
      },
      {
        id: "equipment", label: "Equipment and spellbooks",
        elements: [
          ...sheetFields(["item_capacity", "copper"]),
          { kind: "slot", id: "show_pack", slotId: "pack" },
          { kind: "slot", id: "show_readied_gear", slotId: "readied_gear" },
        ],
      },
    ],
  }],
  expressions: [
    ...defenses.map(({ id, bonus }): SourceExpressionV1 => ({
      id: `${id}_expr`, context: "computed", resultType: "number", source: `10 + fields.${bonus}`, fallback: 11,
    })),
    ...rollExpressions,
  ],
  actions: [
    ...[...saves, ...combatRolls].map(({ id, label }) => roll(id, label)),
    { kind: "resourceBump", id: "recover_full", label: "Rest in a safe haven", resourceId: "hp", operation: { kind: "reset" } },
  ],
  validations: [],
  templates,
  slots: [
    { id: "pack", label: "Inventory", accepts: ["item", "spell"] },
    { id: "readied_gear", label: "Readied gear", accepts: ["item"] },
  ],
};

export const knaveCharacter = {
  name: "Mara Flint",
  initialValues: {
    strength: 2,
    dexterity: 1,
    constitution: 3,
    intelligence: 1,
    wisdom: 2,
    charisma: 1,
    armor_bonus: 3,
    level: 1,
    xp: 0,
    copper: 0,
    hp: { current: 6, max: 6 },
    background: "Former ferryman",
  },
};
