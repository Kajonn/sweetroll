import { readFileSync } from "node:fs";

import type {
  ActionInputV1, ActionV1, FieldV1, GrantedActionV1, ObjectTemplateV1, ReferenceDataV1, RollOutcomeV1,
  SheetElementV1, SheetSectionV1, SourceExpressionV1, SystemDocumentV1, ValidationV1,
} from "../../../../src/systems/implementation/package/schema/document.js";

/**
 * Fifth-edition fantasy rules built from the System Reference Document 5.1
 * (CC BY 4.0). `convert-srd.mjs` produces the two JSON files read here; this
 * module turns them into one Sweetroll system document. What the SRD contains
 * and this document cannot express is listed in docs/systems/dnd5e-srd.md.
 */
type Dice = { dice: number; die: number; flat: number };
type Named = { id: string; name: string; description: string };
type Srd = {
  classes: Array<{
    id: string; name: string; number: number; hit_die: number; saves: string[]; spell_ability: string; prepares: string;
    caster: string; unarmored: string; proficiencies: string; subclass: string; roll_name: string; progression: string;
  }>;
  levels: Array<{
    key: number; prof: number; notes: string; cantrips: number; spells_known: number; slots: number[];
    pact_slots: number; pact_slot_level: number; resources: Record<string, number>; roll: [number, number, number];
    speed_bonus: number; speed_bonus_unarmored: number;
  }>;
  races: Array<{ id: string; name: string; speed: number; size: string; bonuses: Record<string, number>; hp_per_level: number; languages: string; traits: string }>;
  skills: Array<Named & { ability: string }>;
  background: Named[];
  weapons: Array<{
    id: string; name: string; cost: string; weight: number; ranged: boolean; finesse: boolean;
    damage: Dice | null; two_handed: { dice: number; die: number } | null; damage_type: string; properties: string;
  }>;
  armor: Array<{ id: string; name: string; category: string; cost: string; weight: number; base: number; dex_cap: number; shield: boolean; notes: string }>;
  gear: Array<Named & { category: string; cost: string; weight: number; catalog: boolean }>;
  spells: Array<Named & {
    level: number; summary: string; roll_type: string;
    roll: Dice & { mod: boolean; dice_step: number; flat_step: number; by_character_level: boolean };
  }>;
  features: Array<Named & { level: number; source: string }>;
  magicItems: Array<Named & { summary: string }>;
  rules: Named[];
  conditions: Named[]; damageTypes: Named[]; schools: Named[]; alignments: Named[]; weaponProperties: Named[];
  languages: Named[]; abilityScores: Named[];
};
export type SrdMonster = { id: string; name: string; values: Record<string, unknown> };

const read = <T>(name: string): T => JSON.parse(readFileSync(new URL(name, import.meta.url), "utf8")) as T;
const srd = read<Srd>("./srd-5.1.json");
/** SRD stat blocks as initial values of the `monster` entity, for import through the API. */
export const srdMonsters = read<SrdMonster[]>("./srd-5.1-monsters.json");

const abilities = [
  ["str", "Strength"], ["dex", "Dexterity"], ["con", "Constitution"],
  ["int", "Intelligence"], ["wis", "Wisdom"], ["cha", "Charisma"],
] as const;
const EQUIPMENT_CAPACITY = 60;
// The 512-field budget is shared by every entity and template; weapons and classes use most of it.
const GEAR_TEMPLATE_LIMIT = 40;

// --- Small builders ---------------------------------------------------------
const expressions: SourceExpressionV1[] = [];
function expression(id: string, context: SourceExpressionV1["context"], source: string): string {
  const resultType = context === "roll" ? "number" : "boolean";
  expressions.push({ id, context, resultType, source, fallback: resultType === "number" ? 0 : false });
  return id;
}
function computed(id: string, label: string, source: string, valueType: "number" | "text" = "number", prefix = "c"): FieldV1 {
  const expressionId = `${prefix}_${id}`;
  expressions.push({ id: expressionId, context: "computed", resultType: valueType, source, fallback: valueType === "number" ? 0 : "" });
  return { kind: "computed", id, label, valueType, expressionId };
}
const integer = (id: string, label: string, initial: number, min: number, max: number): FieldV1 => (
  { kind: "integer", id, label, default: initial, min, max, step: 1, required: false });
const fixed = (id: string, label: string, value: number): FieldV1 => integer(id, label, value, value, value);
const longText = (id: string, label: string, maxLength = 2_000): FieldV1 => (
  { kind: "text", id, label, default: "", required: false, minLength: 0, maxLength });
const flag = (id: string, label: string, initial = false): FieldV1 => ({ kind: "boolean", id, label, default: initial, required: false });
const weight = (pounds: number): FieldV1 => (
  { kind: "decimal", id: "weight", label: "Weight (lb.)", default: pounds, min: 0, max: 10_000, step: 0.01, required: false });
const choice = (id: string, label: string, optionsFrom: string, initial: string | null): FieldV1 => (
  { kind: "singleChoice", id, label, required: false, default: initial, options: [], optionsFrom });
const choices = (id: string, label: string, optionsFrom: string): FieldV1 => (
  { kind: "multiChoice", id, label, required: false, default: [], options: [], optionsFrom });
const input = (id: string, label: string, valueType: "integer" | "boolean", initial: number | boolean): ActionInputV1 => (
  { id, label, valueType, required: false, default: initial });

// A d20 test with optional advantage or disadvantage. The pool is named so that
// outcomes can read the die that counted (a natural 20 or 1).
const d20Inputs = [
  input("advantage", "Advantage", "boolean", false), input("disadvantage", "Disadvantage", "boolean", false),
  input("bonus", "Other bonus or penalty", "integer", 0),
];
// Each branch names the same group; only one runs (design 6.4, S8).
const DISADVANTAGE = "inputs.disadvantage && !inputs.advantage";
const NATURAL = `if(${DISADVANTAGE}, keepLowest(rolled("d20"), 1), keepHighest(rolled("d20"), 1))`;
const D20 = `if(${DISADVANTAGE}, keepLowest(group("d20", "d20", dice(2, 20)), 1), `
  + `keepHighest(group("d20", "d20", dice(if(inputs.advantage && !inputs.disadvantage, 2, 1), 20)), 1))`;
const damageInputs = [input("critical", "Critical hit (roll the dice twice)", "boolean", false), input("bonus", "Other bonus or penalty", "integer", 0)];

type Roll = Extract<ActionV1, { kind: "roll" }>;
function check(id: string, label: string, modifier: string, outputTemplate = `${label}: {total}`): Roll {
  return { kind: "roll", id, label, expressionId: expression(`${id}_roll`, "roll", `${D20} + ${modifier} + inputs.bonus`), inputs: d20Inputs, outputTemplate };
}
function outcomes(prefix: string, bands: Array<[id: string, label: string, source: string]>): RollOutcomeV1[] {
  return bands.map(([id, label, source]) => ({ id, label, expressionId: expression(`${prefix}_${id}`, "outcome", source) }));
}
/**
 * An attack roll (design 6.4, S7). With a target, of either kind, the server
 * grades it against the target's Armor Class; without one it reports the
 * natural 20 or 1 and the table compares the total.
 */
function attack(prefix: string, label: string, modifier: string, outputTemplate: string, targetEntity: "character" | "monster"): Roll {
  const detail = `${prefix}_armor_class`;
  expressions.push({ id: detail, context: "outcome", resultType: "number", source: "target.armor_class", fallback: 0 });
  return {
    ...check(prefix, label, modifier, outputTemplate),
    target: { entityId: targetEntity, otherEntityIds: [targetEntity === "monster" ? "character" : "monster"], optional: true },
    outcomes: outcomes(prefix, [
      ["critical", "Critical hit (natural 20)", `${NATURAL} == 20`],
      ["fumble", "Miss (natural 1)", `${NATURAL} == 1`],
      ["hit", "Hit", "roll.total >= target.armor_class"],
      ["miss", "Miss", "roll.total < target.armor_class"],
      ["compare", "Hits if it equals or exceeds the target's Armor Class", "true"],
    ]),
    details: [{ id: "armor_class", label: "Target Armor Class", expressionId: detail }],
  };
}
const reset = (id: string, label: string, resourceId: string): ActionV1 => (
  { kind: "resourceBump", id, label, resourceId, operation: { kind: "reset" } });
const show = (prefix: string, ids: string[]): SheetElementV1[] => ids.map((fieldId) => ({ kind: "field", id: `${prefix}_${fieldId}`, fieldId }));
const use = (prefix: string, ids: string[]): SheetElementV1[] => ids.map((actionId) => ({ kind: "action", id: `${prefix}_use_${actionId}`, actionId }));
const meter = (prefix: string, ids: string[]): SheetElementV1[] => ids.map((resourceId) => ({ kind: "resource", id: `${prefix}_${resourceId}`, resourceId }));

// Consumables whose effect is a die roll.
const itemRolls: Record<string, [label: string, source: string, result: string]> = {
  acid_vial: ["Acid damage", "2d6", "acid damage"],
  alchemists_fire_flask: ["Fire damage", "d4", "fire damage"],
  holy_water_flask: ["Radiant damage", "2d6", "radiant damage to a fiend or undead"],
};
// Gear with rules text or found in an equipment pack gets a catalog entry; the rest is chosen from a list.
const catalogGear = srd.gear.filter((item) => item.catalog)
  .sort((left, right) => Number(right.id in itemRolls) - Number(left.id in itemRolls)).slice(0, GEAR_TEMPLATE_LIMIT);
const otherGear = srd.gear.filter((item) => !catalogGear.includes(item));
// Classes that share a spell slot progression share one table; 0 means no spell slots.
const SLOT_LEVELS = [1, 2, 3, 4, 5, 6, 7, 8, 9];
const slotTables: number[][][] = [];
function slotTableOf(classNumber: number): number {
  const table = srd.levels.filter((row) => Math.floor(row.key / 100) === classNumber).map((row) => row.slots);
  if (table.every((slots) => slots.every((count) => count === 0))) return 0;
  const known = slotTables.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(table));
  return known >= 0 ? known + 1 : slotTables.push(table);
}

// Limited-use class features, carried by the class entry (design 6.4, S11):
// each class has up to three, in this order. Bardic Inspiration and Divine
// Sense add the Charisma modifier (at least 1 use); `offset` is added first.
const RESOURCE_NAMES: Record<string, string> = {
  rage: "Rage", bardic_inspiration: "Bardic Inspiration", channel_divinity: "Channel Divinity", wild_shape: "Wild Shape",
  second_wind: "Second Wind", action_surge: "Action Surge", indomitable: "Indomitable", ki: "Ki points",
  lay_on_hands: "Lay on Hands (hit points)", divine_sense: "Divine Sense", sorcery_points: "Sorcery points", arcane_recovery: "Arcane Recovery",
};
const CHARISMA_RESOURCES: Record<string, number> = { bardic_inspiration: 0, divine_sense: 1 };
const RESOURCE_SLOTS = [1, 2, 3] as const;
const classResources = new Map(srd.classes.map((entry) => {
  const rows = srd.levels.filter((row) => Math.floor(row.key / 100) === entry.number);
  const used = Object.keys(RESOURCE_NAMES).filter((id) => rows.some((row) => (row.resources[id] ?? 0) > 0));
  if (used.length > RESOURCE_SLOTS.length) throw Error(`${entry.id} has more than three class resources`);
  return [entry.number, used];
}));

// --- Reference data ---------------------------------------------------------
const rolls = (spell: Srd["spells"][number]): boolean => spell.roll.dice > 0 || spell.roll.flat > 0;
const reference = (id: string, label: string, entries: Named[]): ReferenceDataV1 => ({
  id, label, records: entries.map((entry) => ({ id: entry.id, label: entry.name, values: { description: entry.description } })),
});
const referenceData: ReferenceDataV1[] = [
  {
    id: "classes", label: "Classes", keyColumn: "key",
    columns: {
      key: "text", number: "number", slot_table: "number", hit_die: "number", ...Object.fromEntries(abilities.map(([id]) => [`save_${id}`, "boolean" as const])),
      spell_ability: "text", prepares: "text", caster: "text", unarmored: "text", proficiencies: "text", subclass: "text",
      progression: "text", roll_name: "text",
      ...Object.fromEntries(RESOURCE_SLOTS.flatMap((slot) => [
        [`res${slot}_name`, "text" as const], [`res${slot}_cha`, "boolean" as const], [`res${slot}_offset`, "number" as const],
      ])),
    },
    records: srd.classes.map((entry) => ({
      id: entry.id, label: entry.name,
      values: {
        key: entry.id, number: entry.number, slot_table: slotTableOf(entry.number), hit_die: entry.hit_die,
        ...Object.fromEntries(abilities.map(([id]) => [`save_${id}`, entry.saves.includes(id)])),
        spell_ability: entry.spell_ability, prepares: entry.prepares, caster: entry.caster, unarmored: entry.unarmored,
        proficiencies: entry.proficiencies, subclass: entry.subclass, progression: entry.progression, roll_name: entry.roll_name,
        ...Object.fromEntries(RESOURCE_SLOTS.flatMap((slot) => {
          const id = classResources.get(entry.number)![slot - 1];
          return [[`res${slot}_name`, id === undefined ? "" : RESOURCE_NAMES[id]!], [`res${slot}_cha`, id !== undefined && id in CHARISMA_RESOURCES],
            [`res${slot}_offset`, id === undefined ? 0 : CHARISMA_RESOURCES[id] ?? 0]];
        })),
      },
    })),
  },
  {
    // One row per class and level; the key is the class number times 100 plus the level.
    id: "levels", label: "Class levels", keyColumn: "key",
    columns: {
      key: "number", notes: "text", cantrips: "number", spells_known: "number", pact_slots: "number", pact_slot_level: "number",
      ...Object.fromEntries(RESOURCE_SLOTS.map((slot) => [`res${slot}`, "number" as const])),
      roll_dice: "number", roll_die: "number", roll_flat: "number", speed_bonus: "number", speed_bonus_unarmored: "number",
    },
    records: srd.levels.map((row) => ({
      id: `row_${row.key}`, label: `${srd.classes[Math.floor(row.key / 100) - 1]!.name} ${row.key % 100}`,
      values: {
        key: row.key, notes: row.notes, cantrips: row.cantrips, spells_known: row.spells_known,
        pact_slots: row.pact_slots, pact_slot_level: row.pact_slot_level,
        ...Object.fromEntries(RESOURCE_SLOTS.map((slot) => {
          const id = classResources.get(Math.floor(row.key / 100))![slot - 1];
          return [`res${slot}`, id === undefined ? 0 : row.resources[id] ?? 0];
        })),
        roll_dice: row.roll[0], roll_die: row.roll[1], roll_flat: row.roll[2],
        speed_bonus: row.speed_bonus, speed_bonus_unarmored: row.speed_bonus_unarmored,
      },
    })),
  },
  {
    // Spell slots per level for each distinct progression (full casters, paladin, ranger).
    id: "spell_slots", label: "Spell slots", keyColumn: "key",
    columns: { key: "number", ...Object.fromEntries(SLOT_LEVELS.map((slot) => [`slots_${slot}`, "number" as const])) },
    records: slotTables.flatMap((table, index) => table.map((slots, levelIndex) => ({
      id: `slots_${index + 1}_${levelIndex + 1}`, label: `Table ${index + 1}, level ${levelIndex + 1}`,
      values: { key: (index + 1) * 100 + levelIndex + 1, ...Object.fromEntries(slots.map((count, slot) => [`slots_${slot + 1}`, count])) },
    }))),
  },
  {
    id: "races", label: "Races", keyColumn: "key",
    columns: {
      key: "text", speed: "number", size: "text", ...Object.fromEntries(abilities.map(([id]) => [id, "number" as const])),
      hp_per_level: "number", languages: "text", traits: "text",
    },
    records: srd.races.map((race) => ({
      id: race.id, label: race.name,
      values: { key: race.id, speed: race.speed, size: race.size, ...race.bonuses, hp_per_level: race.hp_per_level, languages: race.languages, traits: race.traits },
    })),
  },
  {
    id: "spells", label: "Spells", keyColumn: "key",
    columns: {
      key: "text", level: "number", summary: "text", description: "text", rolls: "boolean",
    },
    records: srd.spells.map((spell) => ({
      id: spell.id, label: spell.name,
      values: {
        key: spell.id, level: spell.level, summary: spell.summary,
        description: spell.description, rolls: rolls(spell),
      },
    })),
  },
  {
    // Damage or healing dice of the spells that roll any, with the increase per slot level above the spell's own.
    id: "spell_rolls", label: "Spell damage and healing", keyColumn: "key",
    columns: {
      key: "text", result: "text", dice: "number", die: "number", flat: "number", add_modifier: "boolean", dice_step: "number",
      flat_step: "number", by_character_level: "boolean",
    },
    records: srd.spells.filter(rolls).map((spell) => ({
      id: `${spell.id}_roll`.slice(0, 64), label: spell.name, values: {
        key: spell.id, result: spell.roll_type, dice: spell.roll.dice, die: spell.roll.die, flat: spell.roll.flat, add_modifier: spell.roll.mod,
        dice_step: spell.roll.dice_step, flat_step: spell.roll.flat_step, by_character_level: spell.roll.by_character_level,
      },
    })),
  },
  {
    id: "features", label: "Class features and feats", keyColumn: "key",
    columns: { key: "text", source: "text", level: "number", description: "text" },
    records: srd.features.map((feature) => ({
      id: feature.id, label: feature.name, values: { key: feature.id, source: feature.source, level: feature.level, description: feature.description },
    })),
  },
  {
    id: "gear", label: "Adventuring gear, tools, mounts and vehicles", keyColumn: "key",
    columns: { key: "text", category: "text", cost: "text", weight: "number", description: "text" },
    records: otherGear.map((item) => ({
      id: item.id, label: item.name, values: { key: item.id, category: item.category, cost: item.cost, weight: item.weight, description: item.description },
    })),
  },
  {
    id: "magic_items", label: "Magic items", keyColumn: "key", columns: { key: "text", summary: "text", description: "text" },
    records: srd.magicItems.map((item) => ({
      id: item.id, label: item.name, values: { key: item.id, summary: item.summary, description: item.description },
    })),
  },
  {
    id: "weapons", label: "Weapons", keyColumn: "number",
    columns: {
      number: "number", ranged: "boolean", finesse: "boolean", dice: "number", die: "number", flat: "number",
      two_handed_dice: "number", two_handed_die: "number", damage_type: "text", properties: "text", cost: "text", weight: "number",
    },
    records: srd.weapons.map((weapon, index) => ({
      id: weapon.id, label: weapon.name, values: {
        number: index + 1, ranged: weapon.ranged, finesse: weapon.finesse,
        dice: weapon.damage?.dice ?? 0, die: weapon.damage?.die ?? 4, flat: weapon.damage?.flat ?? 0,
        two_handed_dice: weapon.two_handed?.dice ?? 0, two_handed_die: weapon.two_handed?.die ?? 4,
        damage_type: weapon.damage_type || "no", properties: weapon.properties, cost: weapon.cost, weight: weapon.weight,
      },
    })),
  },
  {
    id: "skills", label: "Skills", records: srd.skills.map((skill) => ({
      id: skill.id, label: skill.name, values: { ability: skill.ability, description: skill.description },
    })),
  },
  {
    // Design 6.1 (S3): every SRD stat block is a ready-made monster.
    id: "bestiary", label: "Monsters", records: srdMonsters.map((monster) => ({
      id: monster.id, label: monster.name,
      values: Object.fromEntries(Object.entries(monster.values).map(([fieldId, value]) => [fieldId,
        typeof value === "object" && value !== null && "max" in value ? (value as { max: number }).max : value as string | number | boolean])),
    })),
  },
  reference("rules", "Rules", srd.rules),
  reference("abilities", "Ability scores", srd.abilityScores),
  reference("conditions", "Conditions", srd.conditions),
  reference("alignments", "Alignments", srd.alignments),
  reference("backgrounds", "Backgrounds", srd.background),
  reference("damage_types", "Damage types", srd.damageTypes),
  reference("magic_schools", "Schools of magic", srd.schools),
  reference("languages", "Languages", srd.languages),
  reference("weapon_properties", "Weapon properties", srd.weaponProperties),
];

// --- Player character -------------------------------------------------------
// A character's classes are entries in the `class_list` slot: adding a class is
// adding an entry. Everything a class contributes is a computed field of its
// entry (see `classTemplate`), and the character sums those over the slot.
const ofRace = (column: string) => `lookup("races", fields.race, "${column}")`;
const classes = (field: string) => `sum("class_list", "${field}")`;
const ARMOR = 'sumWhere("equipment", "armor_base", "equipped")';
const SHIELD = 'sumWhere("equipment", "shield_bonus", "equipped")';
// Bards add half their proficiency bonus to ability checks that lack it (Jack of All Trades, level 2).
const halfProficiency = "fields.half_proficiency";
const skillBonus = (skill: Srd["skills"][number]) => `fields.${skill.ability}_mod + if(has(fields.skill_expertise, "${skill.id}"), 2 * fields.proficiency_bonus, `
  + `if(has(fields.skill_proficiencies, "${skill.id}"), fields.proficiency_bonus, ${halfProficiency}))`;
// Calculated maxima start full and fill when they first rise from 0 (design 6.3, S4).
function resource(id: string, label: string, maximum: string): FieldV1 {
  expressions.push({ id: `c_${id}_max`, context: "computed", resultType: "number", source: maximum, fallback: 0 });
  return { kind: "resource", id, label, default: { current: 0, max: 0 }, min: 0, max: 999, step: 1, maxExpressionId: `c_${id}_max`, resetTo: "max", startFull: true };
}
const condition = (id: string, label: string, source: string): FieldV1 => {
  expressions.push({ id: `c_${id}`, context: "computed", resultType: "boolean", source, fallback: false });
  return { kind: "computed", id, label, valueType: "boolean", expressionId: `c_${id}` };
};
// The table of a full caster is also the multiclass spellcaster table.
const FULL_CASTER_TABLE = slotTableOf(srd.classes.find((entry) => entry.id === "wizard")!.number);

const characterFields: FieldV1[] = [
  choice("race", "Race", "races", "human"),
  computed("level", "Character level", classes("level")),
  integer("xp", "Experience points", 0, 0, 1_000_000),
  choice("alignment", "Alignment", "alignments", null),
  longText("background", "Background", 120),
  ...abilities.map(([id, label]) => integer(`${id}_base`, `${label} (before racial increase)`, 10, 1, 30)),
  ...abilities.map(([id, label]) => computed(id, label, `fields.${id}_base + ${ofRace(id)}`)),
  ...abilities.map(([id, label]) => computed(`${id}_mod`, `${label} modifier`, `floor((fields.${id} - 10) / 2)`)),
  computed("proficiency_bonus", "Proficiency bonus", "2 + floor((max(1, fields.level) - 1) / 4)"),
  computed("half_proficiency", "Bonus to checks without proficiency", `if(${classes("jack_of_all_trades")} > 0, floor(fields.proficiency_bonus / 2), 0)`),
  choices("extra_saves", "Additional saving throw proficiencies", "abilities"),
  ...abilities.map(([id, label]) => computed(`save_${id}`, `${label} saving throw`,
    `fields.${id}_mod + if(${classes(`save_${id}`)} > 0 || has(fields.extra_saves, "${id}"), fields.proficiency_bonus, 0)`)),
  choices("skill_proficiencies", "Skill proficiencies", "skills"),
  choices("skill_expertise", "Expertise (double proficiency)", "skills"),
  ...srd.skills.map((skill) => computed(`skill_${skill.id}`, `${skill.name} (${skill.ability.toUpperCase()})`, skillBonus(skill))),
  computed("passive_perception", "Passive Wisdom (Perception)", "10 + fields.skill_perception"),
  computed("initiative", "Initiative", `fields.dex_mod + ${halfProficiency}`),
  integer("ac_bonus", "Other Armor Class bonus", 0, -10, 20),
  // Unarmored Defense and Draconic Resilience do not combine: the best one a class grants applies.
  computed("armor_class", "Armor Class",
    `if(${ARMOR} > 0, ${ARMOR} + min(fields.dex_mod, sumWhere("equipment", "dex_cap", "equipped")), `
    + `10 + fields.dex_mod + max(if(${classes("unarmored_con")} > 0, fields.con_mod, 0), `
    + `if(${classes("unarmored_wis")} > 0 && ${SHIELD} == 0, fields.wis_mod, 0), if(${classes("draconic")} > 0, 3, 0))) `
    + `+ ${SHIELD} + sumWhere("equipment", "armor_magic", "equipped") + fields.ac_bonus`),
  computed("speed", "Speed (ft.)", `${ofRace("speed")} + ${classes("speed_bonus")} + if(${ARMOR} + ${SHIELD} > 0, 0, ${classes("speed_bonus_unarmored")})`),
  computed("size", "Size", ofRace("size"), "text"),
  integer("hp_adjustment", "Hit point maximum adjustment", 0, -200, 400),
  // Fixed hit points per level, as the SRD allows instead of rolling; rolled totals go into the adjustment.
  // A sheet without a class has none, so the first class fills them.
  resource("hp", "Hit points",
    `if(fields.level == 0, 0, max(1, ${classes("hit_points")} + fields.level * (fields.con_mod + ${ofRace("hp_per_level")}) + fields.hp_adjustment))`),
  integer("temp_hp", "Temporary hit points", 0, 0, 999),
  resource("hit_dice", "Hit dice", "fields.level"),
  { kind: "resource", id: "death_successes", label: "Death save successes", default: { current: 0, max: 3 }, min: 0, max: 3, step: 1, resetTo: "min" },
  { kind: "resource", id: "death_failures", label: "Death save failures", default: { current: 0, max: 3 }, min: 0, max: 3, step: 1, resetTo: "min" },
  flag("inspiration", "Inspiration"),
  integer("exhaustion", "Exhaustion level", 0, 0, 6),
  choices("conditions", "Conditions", "conditions"),
  // With several spellcasting classes these show the best ability; a spell entry can name another.
  computed("spell_mod", "Spellcasting ability modifier (best)",
    `max(if(${classes("casts_int")} > 0, fields.int_mod, -5), if(${classes("casts_wis")} > 0, fields.wis_mod, -5), if(${classes("casts_cha")} > 0, fields.cha_mod, -5))`),
  computed("spell_save_dc", "Spell save DC", "if(fields.spell_mod == -5, 0, 8 + fields.proficiency_bonus + fields.spell_mod)"),
  computed("spell_attack_bonus", "Spell attack bonus", "if(fields.spell_mod == -5, 0, fields.proficiency_bonus + fields.spell_mod)"),
  computed("cantrips_known", "Cantrips known", classes("cantrips")),
  computed("spells_available", "Spells known or prepared",
    `${classes("spells_known")} + ${classes("prepared_levels")} + ${classes("prepares_int")} * fields.int_mod `
    + `+ ${classes("prepares_wis")} * fields.wis_mod + ${classes("prepares_cha")} * fields.cha_mod`),
  // One spellcasting class uses its own table. Two or more add their caster
  // levels (half for paladin and ranger) and use the full caster table.
  computed("caster_classes", "Spellcasting classes", classes("is_caster")),
  computed("slot_row", "Spell slot table row",
    `if(fields.caster_classes == 1, ${classes("slot_row")}, `
    + `if(fields.caster_classes > 1 && ${classes("caster_level")} > 0, ${FULL_CASTER_TABLE * 100} + min(20, ${classes("caster_level")}), 0))`),
  ...SLOT_LEVELS.map((slot) => resource(`slots_${slot}`, `Level ${slot} spell slots`,
    `if(fields.slot_row < 100, 0, lookup("spell_slots", fields.slot_row, "slots_${slot}"))`)),
  resource("pact_slots", "Pact Magic slots", classes("pact_slots")),
  computed("pact_slot_level", "Pact Magic slot level", classes("pact_slot_level")),
  // What the sheet shows (design 6.3, S9).
  condition("casts_spells", "Casts spells", "fields.caster_classes > 0 || fields.pact_slots.max > 0"),
  ...SLOT_LEVELS.map((slot) => condition(`has_slots_${slot}`, `Has level ${slot} slots`, `fields.slots_${slot}.max > 0`)),
  condition("has_pact_magic", "Has Pact Magic", "fields.pact_slots.max > 0"),
  condition("dying", "At 0 hit points", "fields.level > 0 && fields.hp.current == 0"),
  computed("race_traits", "Racial traits", ofRace("traits"), "text"),
  computed("race_languages", "Languages (race)", ofRace("languages"), "text"),
  longText("proficiencies", "Other proficiencies and languages"),
  ...(["cp", "sp", "ep", "gp", "pp"] as const).map((coin) => integer(coin, `Coins (${coin})`, 0, 0, 10_000_000)),
  computed("carried_weight", "Carried weight (lb.)",
    `sum("equipment", "weight") + (fields.cp + fields.sp + fields.ep + fields.gp + fields.pp) / 50`),
  computed("carrying_capacity", "Carrying capacity (lb.)", "fields.str * 15"),
  longText("personality", "Personality traits, ideals, bonds and flaws"),
  longText("notes", "Notes", 10_000),
];

const diceInputs = [input("count", "Number of dice", "integer", 1), input("sides", "Sides", "integer", 6), input("modifier", "Modifier", "integer", 0)];
const characterActions: ActionV1[] = [
  ...abilities.map(([id, label]) => check(`check_${id}`, `${label} check`, `fields.${id}_mod`)),
  ...abilities.map(([id, label]) => check(`save_${id}_roll`, `${label} saving throw`, `fields.save_${id}`)),
  ...srd.skills.map((skill) => check(`skill_${skill.id}_roll`, skill.name, `fields.skill_${skill.id}`)),
  check("initiative_roll", "Initiative", "fields.initiative"),
  {
    kind: "roll", id: "death_save", label: "Death saving throw", inputs: [], outputTemplate: "Death saving throw: {total}",
    expressionId: expression("death_save_roll", "roll", 'group("d20", "d20", dice(1, 20))'),
    outcomes: outcomes("death_save", [
      ["revive", "Natural 20: regain 1 hit point", 'rolled("d20") == 20'],
      ["two_failures", "Natural 1: two failures", 'rolled("d20") == 1'],
      ["success", "Success", "roll.total >= 10"],
      ["failure", "Failure", "true"],
    ]),
  },
  {
    kind: "roll", id: "roll_dice", label: "Roll any dice", inputs: diceInputs, outputTemplate: "{inputs.count}d{inputs.sides}: {total}",
    expressionId: expression("roll_dice_roll", "roll", "dice(inputs.count, inputs.sides) + inputs.modifier"),
  },
  // Rests in one command each (design 6.4, S5). Hit dice and class features
  // are restored on their own: half the hit dice is not a fixed amount, and
  // class features belong to the class entries.
  {
    kind: "resourceBatch", id: "long_rest", label: "Long rest",
    steps: [
      { resourceId: "hp", operation: { kind: "reset" } },
      ...SLOT_LEVELS.map((slot) => ({ resourceId: `slots_${slot}`, operation: { kind: "reset" as const } })),
      { resourceId: "pact_slots", operation: { kind: "reset" } },
      { resourceId: "death_successes", operation: { kind: "reset" } },
      { resourceId: "death_failures", operation: { kind: "reset" } },
    ],
  },
  { kind: "resourceBatch", id: "short_rest", label: "Short rest (Pact Magic)", steps: [{ resourceId: "pact_slots", operation: { kind: "reset" } }] },
  reset("restore_hit_dice", "Restore all hit dice", "hit_dice"),
];

const characterSections: SheetSectionV1[] = [
  {
    id: "sec_identity", label: "Character", elements: [
      ...show("pc", ["race", "level", "xp", "background", "alignment", "size", "proficiency_bonus", "inspiration"]),
      { kind: "slot", id: "pc_classes", slotId: "class_list" },
    ],
  },
  {
    id: "sec_ability_scores", label: "Abilities and saving throws", elements: abilities.flatMap(([id]) => [
      ...show("pc", [`${id}_base`, id, `${id}_mod`]), ...use("pc", [`check_${id}`]),
      ...show("pc", [`save_${id}`]), ...use("pc", [`save_${id}_roll`]),
    ]).concat(show("pc", ["extra_saves"])),
  },
  {
    id: "sec_skills", label: "Skills", elements: [
      ...show("pc", ["skill_proficiencies", "skill_expertise"]),
      ...srd.skills.flatMap((skill) => [...show("pc", [`skill_${skill.id}`]), ...use("pc", [`skill_${skill.id}_roll`])]),
      ...show("pc", ["passive_perception"]),
    ],
  },
  {
    id: "sec_combat", label: "Combat", elements: [
      ...show("pc", ["armor_class", "ac_bonus", "initiative"]), ...use("pc", ["initiative_roll"]), ...show("pc", ["speed"]),
      ...meter("pc", ["hp"]), ...show("pc", ["temp_hp", "hp_adjustment"]), ...meter("pc", ["hit_dice"]),
      ...use("pc", ["long_rest", "short_rest", "restore_hit_dice"]),
      ...[...meter("pc", ["death_successes", "death_failures"]), ...use("pc", ["death_save"])].map((element) => ({ ...element, visibleWhen: "dying" })),
      ...show("pc", ["conditions", "exhaustion"]), ...use("pc", ["roll_dice"]),
    ],
  },
  {
    id: "sec_class", label: "Features and feats", elements: [
      { kind: "slot", id: "pc_features", slotId: "feature_list" },
    ],
  },
  {
    id: "sec_spellcasting", label: "Spellcasting", visibleWhen: "casts_spells", elements: [
      ...show("pc", ["spell_mod", "spell_save_dc", "spell_attack_bonus", "cantrips_known", "spells_available"]),
      ...SLOT_LEVELS.flatMap((slot) => meter("pc", [`slots_${slot}`]).map((element) => ({ ...element, visibleWhen: `has_slots_${slot}` }))),
      ...[...meter("pc", ["pact_slots"]), ...show("pc", ["pact_slot_level"])].map((element) => ({ ...element, visibleWhen: "has_pact_magic" })),
      { kind: "slot", id: "pc_spells", slotId: "spell_list" },
    ],
  },
  {
    id: "sec_equipment", label: "Equipment", elements: [
      { kind: "slot", id: "pc_equipment", slotId: "equipment" },
      ...show("pc", ["carried_weight", "carrying_capacity", "cp", "sp", "ep", "gp", "pp"]),
    ],
  },
  {
    id: "sec_background", label: "Traits and notes", elements: show("pc", ["race_traits", "race_languages", "proficiencies", "personality", "notes"]),
  },
];

function validation(id: string, targetId: string, message: string, source: string): ValidationV1 {
  expressions.push({ id: `v_${id}`, context: "validation", resultType: "boolean", source, fallback: true });
  return { id, severity: "warning", message, targetEntityId: "character", targetId, expressionId: `v_${id}` };
}
const validations: ValidationV1[] = [
  validation("attunement_limit", "carried_weight", "A character can be attuned to at most three magic items.", 'countWhere("equipment", "attuned") <= 3'),
  validation("carrying_limit", "carrying_capacity", "Carried weight exceeds carrying capacity (Strength score × 15).", "fields.carried_weight <= fields.carrying_capacity"),
  validation("first_class", "level", "Add a class and mark exactly one class as the first class.", 'countWhere("class_list", "first") == 1'),
  validation("level_limit", "level", "A character's class levels add up to at most 20.", "fields.level <= 20"),
];

// --- Monsters and other non-player characters ------------------------------
// A stat block is entered (or imported through the API) as plain values.
// Three attack slots cover all but four SRD stat blocks; further attacks stay in the action text.
const ATTACKS = [1, 2, 3];
const monsterFields: FieldV1[] = [
  longText("summary", "Size, type and alignment", 200),
  integer("armor_class", "Armor Class", 10, 0, 40),
  longText("armor_note", "Armor", 200),
  { kind: "resource", id: "hp", label: "Hit points", default: { current: 1, max: 1 }, min: 0, max: 2_000, step: 1, resetTo: "max" },
  longText("hit_dice", "Hit dice", 40),
  longText("speed", "Speed", 200),
  ...abilities.map(([id, label]) => integer(id, label, 10, 1, 30)),
  ...abilities.map(([id, label]) => computed(`${id}_mod`, `${label} modifier`, `floor((fields.${id} - 10) / 2)`, "number", "m")),
  ...abilities.map(([id, label]) => integer(`save_${id}_bonus`, `${label} saving throw proficiency`, 0, 0, 20)),
  longText("skills", "Skills", 500), longText("senses", "Senses", 500), longText("languages", "Languages", 500),
  longText("challenge", "Challenge", 10), integer("xp", "Experience points", 0, 0, 1_000_000),
  integer("proficiency_bonus", "Proficiency bonus", 2, 2, 9),
  longText("defenses", "Vulnerabilities, resistances and immunities", 1_000),
  longText("traits", "Traits", 10_000), longText("actions", "Actions", 10_000),
  longText("reactions", "Reactions", 4_000), longText("legendary", "Legendary actions", 4_000),
  { kind: "resource", id: "legendary_actions", label: "Legendary actions left", default: { current: 0, max: 0 }, min: 0, max: 5, step: 1, resetTo: "max" },
  ...ATTACKS.flatMap((slot) => [
    longText(`attack_${slot}_name`, `Attack ${slot}`, 60),
    integer(`attack_${slot}_hit`, `Attack ${slot} bonus to hit`, 0, -5, 30),
    integer(`attack_${slot}_dice`, `Attack ${slot} damage dice`, 0, 0, 40),
    integer(`attack_${slot}_die`, `Attack ${slot} damage die sides`, 4, 1, 100),
    integer(`attack_${slot}_flat`, `Attack ${slot} damage bonus`, 0, -10, 100),
    longText(`attack_${slot}_type`, `Attack ${slot} damage type`, 120),
  ]),
  choices("conditions", "Conditions", "conditions"),
  longText("notes", "Notes", 10_000),
];
const monsterActions: ActionV1[] = [
  ...abilities.map(([id, label]): ActionV1 => {
    const roll = check(`monster_check_${id}`, `${label} check or saving throw`, `fields.${id}_mod + if(inputs.saving_throw, fields.save_${id}_bonus, 0)`, `${label}: {total}`);
    return { ...roll, inputs: [input("saving_throw", "Saving throw", "boolean", false), ...roll.inputs] };
  }),
  check("monster_initiative", "Initiative", "fields.dex_mod"),
  ...ATTACKS.flatMap((slot): ActionV1[] => [
    attack(`monster_attack_${slot}`, `Attack ${slot}`, `fields.attack_${slot}_hit`, `{fields.attack_${slot}_name}: {total} to hit`, "character"),
    {
      kind: "roll", id: `monster_damage_${slot}`, label: `Attack ${slot} damage`, inputs: damageInputs,
      outputTemplate: `{fields.attack_${slot}_name}: {total} {fields.attack_${slot}_type} damage`,
      expressionId: expression(`monster_damage_${slot}_roll`, "roll",
        `dice(if(inputs.critical, 2, 1) * fields.attack_${slot}_dice, fields.attack_${slot}_die) + fields.attack_${slot}_flat + inputs.bonus`),
    },
  ]),
  {
    kind: "roll", id: "monster_roll_dice", label: "Roll any dice", inputs: diceInputs, outputTemplate: "{inputs.count}d{inputs.sides}: {total}",
    expressionId: expression("monster_roll_dice_roll", "roll", "dice(inputs.count, inputs.sides) + inputs.modifier"),
  },
  reset("monster_restore_hp", "Restore hit points", "hp"),
  reset("monster_restore_legendary", "Restore legendary actions", "legendary_actions"),
];
const monsterSections: SheetSectionV1[] = [
  {
    id: "stat_block", label: "Stat block", elements: [
      ...show("npc", ["summary", "armor_class", "armor_note"]), ...meter("npc", ["hp"]), ...use("npc", ["monster_restore_hp"]),
      ...show("npc", ["hit_dice", "speed", "challenge", "xp", "proficiency_bonus", "conditions"]),
      ...use("npc", ["monster_initiative", "monster_roll_dice"]),
    ],
  },
  {
    id: "monster_abilities", label: "Abilities and saving throws", elements: abilities.flatMap(([id]) => [
      ...show("npc", [id, `${id}_mod`, `save_${id}_bonus`]), ...use("npc", [`monster_check_${id}`]),
    ]),
  },
  {
    id: "monster_attacks", label: "Attacks", elements: ATTACKS.flatMap((slot) => [
      ...show("npc", ["name", "hit", "dice", "die", "flat", "type"].map((part) => `attack_${slot}_${part}`)),
      ...use("npc", [`monster_attack_${slot}`, `monster_damage_${slot}`]),
    ]),
  },
  {
    id: "monster_details", label: "Traits and actions", elements: [
      ...show("npc", ["skills", "senses", "languages", "defenses", "traits", "actions", "reactions", "legendary"]),
      ...meter("npc", ["legendary_actions"]), ...use("npc", ["monster_restore_legendary"]), ...show("npc", ["notes"]),
    ],
  },
];

// --- Catalog templates ------------------------------------------------------
const itemText = (id: string, label: string, dataset: string, key: string, column: string, prefix: string): FieldV1 => (
  computed(id, label, `lookup("${dataset}", item.${key}, "${column}")`, "text", prefix));
// One template per weapon (design 6.4, S1). The templates share their attack
// and damage formulas, which read the weapon's row of the `weapons` table.
const weapon = (column: string) => `lookup("weapons", item.weapon_number, "${column}")`;
const WEAPON_ABILITY = `if(${weapon("finesse")}, max(fields.str_mod, fields.dex_mod), if(${weapon("ranged")}, fields.dex_mod, fields.str_mod))`;
const WEAPON_TO_HIT = `${WEAPON_ABILITY} + if(item.proficient, fields.proficiency_bonus, 0) + item.magic_bonus`;
const weaponAttack: GrantedActionV1 = { ...attack("w_attack", "Attack", WEAPON_TO_HIT, "{total} to hit", "monster"), id: "attack" };
const weaponDamage = (id: string, label: string, dice: string, die: string, flat: string): GrantedActionV1 => ({
  kind: "roll", id, label, inputs: damageInputs, outputTemplate: "{total} damage",
  expressionId: expression(`w_${id}`, "roll", `dice(if(inputs.critical, 2, 1) * ${dice}, ${die}) + ${flat} + ${WEAPON_ABILITY} + item.magic_bonus + inputs.bonus`),
});
const oneHanded = weaponDamage("damage", "Damage", weapon("dice"), weapon("die"), weapon("flat"));
const twoHanded = weaponDamage("damage_two_handed", "Damage (two hands)", weapon("two_handed_dice"), weapon("two_handed_die"), "0");
function weaponTemplate(entry: Srd["weapons"][number], index: number): ObjectTemplateV1 {
  const damage = entry.damage ? `${entry.damage.dice}d${entry.damage.die}${entry.damage.flat ? ` + ${entry.damage.flat}` : ""}`.replace("1d1 + ", "") : "";
  return {
    kind: "item", id: entry.id, label: entry.name, quantityFields: ["weight"],
    description: `${entry.properties}${damage ? `\nDamage ${damage} ${entry.damage_type}` : ""}${entry.two_handed ? `, ${entry.two_handed.dice}d${entry.two_handed.die} with two hands` : ""}. Cost ${entry.cost}.`,
    fields: [fixed("weapon_number", "Weapon", index + 1), flag("proficient", "Proficient", true), integer("magic_bonus", "Magic bonus", 0, 0, 3), weight(entry.weight)],
    grantedActions: [
      weaponAttack,
      ...(entry.damage ? [{ ...oneHanded, label: `Damage (${entry.damage_type})` }] : []),
      ...(entry.two_handed ? [{ ...twoHanded, label: `Damage with two hands (${entry.damage_type})` }] : []),
    ],
  };
}
function armorTemplate(entry: Srd["armor"][number]): ObjectTemplateV1 {
  return {
    kind: "item", id: entry.id, label: entry.name, quantityFields: ["weight"], description: `${entry.notes}. Cost ${entry.cost}.`,
    fields: [
      flag("equipped", entry.shield ? "Wielded" : "Worn", true),
      ...(entry.shield ? [fixed("shield_bonus", "Armor Class bonus", 2)] : [
        fixed("armor_base", "Base Armor Class", entry.base), fixed("dex_cap", "Maximum Dexterity modifier (99 = no limit)", entry.dex_cap),
      ]),
      integer("armor_magic", "Magic bonus", 0, 0, 3), weight(entry.weight),
    ],
    grantedActions: [],
  };
}
function itemRoll(templateId: string, name: string, [label, source, result]: [string, string, string]): GrantedActionV1 {
  return {
    kind: "roll", id: "use", label, inputs: [], outputTemplate: `${name}: {total} ${result}`,
    expressionId: expression(`i_${templateId}_use`, "roll", source),
  };
}
function gearTemplate(item: Srd["gear"][number]): ObjectTemplateV1 {
  const roll = itemRolls[item.id];
  return {
    kind: "item", id: item.id, label: item.name, quantityFields: ["weight"],
    description: [item.description, `Cost ${item.cost}.`].filter(Boolean).join("\n").slice(0, 2_000),
    fields: [weight(item.weight)], grantedActions: roll ? [itemRoll(item.id, item.name, roll)] : [],
  };
}
// The SRD potions of healing (magic items) are common enough to be catalog entries.
const potions: ObjectTemplateV1[] = ([
  ["potion_of_healing", "Potion of Healing", "2d4 + 2"], ["potion_of_greater_healing", "Potion of Greater Healing", "4d4 + 4"],
  ["potion_of_superior_healing", "Potion of Superior Healing", "8d4 + 8"], ["potion_of_supreme_healing", "Potion of Supreme Healing", "10d4 + 20"],
] as const).map(([id, name, source]) => ({
  kind: "item", id, label: name, quantityFields: ["weight"], description: `You regain ${source} hit points when you drink this potion.`,
  fields: [weight(0.5)], grantedActions: [itemRoll(id, name, ["Drink", source, "hit points regained"])],
}));

const usesResource: FieldV1 = { kind: "resource", id: "uses", label: "Uses or charges", default: { current: 0, max: 0 }, min: 0, max: 100, step: 1, resetTo: "max" };
const usesActions: GrantedActionV1[] = [
  { kind: "resourceBump", id: "spend", label: "Use one", resourceId: "uses", operation: { kind: "delta", amount: -1 } },
  { kind: "resourceBump", id: "restore", label: "Restore all", resourceId: "uses", operation: { kind: "reset" } },
];
const spell = (column: string) => `lookup("spell_rolls", item.spell, "${column}")`;
const UPCAST = 'max(0, inputs.slot_level - lookup("spells", item.spell, "level"))';
const SPELL_MOD = 'if(item.ability == "int", fields.int_mod, if(item.ability == "wis", fields.wis_mod, if(item.ability == "cha", fields.cha_mod, fields.spell_mod)))';
const CANTRIP_TIER = "1 + if(fields.level >= 5, 1, 0) + if(fields.level >= 11, 1, 0) + if(fields.level >= 17, 1, 0)";
// One entry per class the character has levels in. Its computed fields are
// what the class contributes at that level; the character sheet sums them.
const row = (column: string) => `lookup("levels", item.row, "${column}")`;
const ofClass = (column: string) => `lookup("classes", item.class, "${column}")`;
const classNumber = (id: string, label: string, source: string): FieldV1 => computed(id, label, source, "number", "k");
const classText = (id: string, label: string, source: string): FieldV1 => computed(id, label, source, "text", "k");
const isAbility = (column: string, ability: string) => `${ofClass(column)} == "${ability}"`;
const STORED_CHA_MOD = 'floor((fields.cha_base + lookup("races", fields.race, "cha") - 10) / 2)';
const classTemplate: ObjectTemplateV1 = {
  kind: "effect", id: "class_levels", label: "Class",
  description: "Choose the class and its level after adding the entry. Add one entry per class to multiclass.",
  fields: [
    choice("class", "Class", "classes", "fighter"), integer("level", "Class level", 1, 1, 20),
    flag("first", "First class (saving throws and full first hit die)", true),
    classText("subclass", "Subclass", ofClass("subclass")),
    classText("table", "Class table", row("notes")),
    classText("progression", "Features by level", ofClass("progression")),
    classText("proficiencies", "Proficiencies", ofClass("proficiencies")),
    classText("roll_name", "Class die", ofClass("roll_name")),
    classText("spell_ability", "Spellcasting ability", ofClass("spell_ability")),
    classNumber("row", "Class table row", `${ofClass("number")} * 100 + item.level`),
    classNumber("hit_die", "Hit die (sides)", ofClass("hit_die")),
    // Fixed hit points: the full die at the first character level, the average after that. Draconic Resilience adds 1 per level.
    classNumber("hit_points", "Hit points from this class",
      'item.level * (item.hit_die / 2 + 1) + if(item.first, item.hit_die / 2 - 1, 0) + if(item.class == "sorcerer", item.level, 0)'),
    ...abilities.map(([id, label]) => classNumber(`save_${id}`, `${label} saving throw proficiency`, `if(item.first && ${ofClass(`save_${id}`)}, 1, 0)`)),
    classNumber("is_caster", "Has the Spellcasting feature", `if(${ofClass("caster")} == "none", 0, 1)`),
    classNumber("caster_level", "Levels counted for multiclass spell slots",
      `if(${ofClass("caster")} == "full", item.level, if(${ofClass("caster")} == "half", floor(item.level / 2), 0))`),
    classNumber("slot_row", "Spell slot table row", `if(${ofClass("caster")} == "none", 0, ${ofClass("slot_table")} * 100 + item.level)`),
    classNumber("pact_slots", "Pact Magic slots", row("pact_slots")), classNumber("pact_slot_level", "Pact Magic slot level", row("pact_slot_level")),
    classNumber("cantrips", "Cantrips known", row("cantrips")), classNumber("spells_known", "Spells known", row("spells_known")),
    classNumber("prepared_levels", "Levels counted for prepared spells",
      `if(${ofClass("prepares")} == "full", item.level, if(${ofClass("prepares")} == "half", floor(item.level / 2), 0))`),
    ...(["int", "wis", "cha"] as const).flatMap((ability) => [
      classNumber(`casts_${ability}`, `Casts with ${ability.toUpperCase()}`, `if(${isAbility("spell_ability", ability)}, 1, 0)`),
      classNumber(`prepares_${ability}`, `Prepares with ${ability.toUpperCase()}`,
        `if(${ofClass("prepares")} != "none" && ${isAbility("spell_ability", ability)}, 1, 0)`),
    ]),
    classNumber("unarmored_con", "Unarmored Defense (Constitution)", `if(${isAbility("unarmored", "con")}, 1, 0)`),
    classNumber("unarmored_wis", "Unarmored Defense (Wisdom)", `if(${isAbility("unarmored", "wis")}, 1, 0)`),
    classNumber("draconic", "Draconic Resilience", `if(${isAbility("unarmored", "draconic")}, 1, 0)`),
    classNumber("speed_bonus", "Speed bonus", row("speed_bonus")),
    classNumber("speed_bonus_unarmored", "Speed bonus without armor", row("speed_bonus_unarmored")),
    classNumber("jack_of_all_trades", "Jack of All Trades", 'if(item.class == "bard" && item.level >= 2, 1, 0)'),
    // Class features with limited uses (S11). A template formula reads the
    // character's stored fields, so the Charisma modifier is worked out here.
    ...RESOURCE_SLOTS.flatMap((slot): FieldV1[] => {
      expressions.push({
        id: `k_res${slot}_max`, context: "computed", resultType: "number", fallback: 0,
        source: `if(${ofClass(`res${slot}_cha`)}, if(${row(`res${slot}`)} > 0, max(1, ${ofClass(`res${slot}_offset`)} + ${STORED_CHA_MOD}), 0), ${row(`res${slot}`)})`,
      });
      return [
        classText(`res${slot}_name`, `Class feature ${slot}`, ofClass(`res${slot}_name`)),
        { kind: "resource", id: `res${slot}`, label: `Class feature ${slot} uses`, default: { current: 0, max: 0 }, min: 0, max: 999, step: 1,
          resetTo: "max", maxExpressionId: `k_res${slot}_max`, startFull: true },
      ];
    }),
  ],
  grantedActions: [
    {
      kind: "roll", id: "class_roll", label: "Class die", inputs: [input("bonus", "Other bonus or penalty", "integer", 0)],
      outputTemplate: "{item.roll_name}: {total}",
      expressionId: expression("k_class_roll", "roll", `dice(${row("roll_dice")}, ${row("roll_die")}) + ${row("roll_flat")} + inputs.bonus`),
    },
    {
      kind: "roll", id: "spend_hit_dice", label: "Spend hit dice (short rest)", inputs: [input("count", "Hit dice spent", "integer", 1)],
      outputTemplate: "Regain {total} hit points",
      expressionId: expression("k_spend_hit_dice", "roll", "max(0, dice(inputs.count, item.hit_die) + inputs.count * fields.con_mod)"),
    },
    ...RESOURCE_SLOTS.flatMap((slot): GrantedActionV1[] => [
      { kind: "resourceBump", id: `spend_res${slot}`, label: `Use class feature ${slot}`, resourceId: `res${slot}`, operation: { kind: "delta", amount: -1 } },
      { kind: "resourceBump", id: `restore_res${slot}`, label: `Restore class feature ${slot}`, resourceId: `res${slot}`, operation: { kind: "reset" } },
    ]),
  ],
};

const genericTemplates: ObjectTemplateV1[] = [
  {
    // One entry per spell known or prepared; the spell is chosen from the SRD list.
    kind: "spell", id: "spell", label: "Spell", description: "Choose the spell after adding the entry.",
    fields: [
      choice("spell", "Spell", "spells", srd.spells[0]!.id), flag("prepared", "Prepared", true),
      // A multiclass caster names the ability of the class the spell belongs to.
      {
        kind: "singleChoice", id: "ability", label: "Spellcasting ability", required: false, default: "best",
        options: [{ id: "best", label: "The character's best" }, { id: "int", label: "Intelligence" }, { id: "wis", label: "Wisdom" }, { id: "cha", label: "Charisma" }],
      },
      computed("level", "Spell level (0 = cantrip)", 'lookup("spells", item.spell, "level")', "number", "s"),
      itemText("summary", "Casting", "spells", "spell", "summary", "s"), computed("roll_type", "Rolls", `if(lookup("spells", item.spell, "rolls"), ${spell("result")}, "no dice")`, "text", "s"),
      itemText("description", "Description", "spells", "spell", "description", "s"),
    ],
    grantedActions: [
      { ...attack("s_attack", "Spell attack", `fields.proficiency_bonus + ${SPELL_MOD}`, "Spell attack: {total} to hit", "monster"), id: "spell_attack" },
      {
        kind: "roll", id: "spell_roll", label: "Damage or healing",
        inputs: [input("slot_level", "Spell slot level (0 = the spell's own level)", "integer", 0), ...damageInputs],
        outputTemplate: "{total} {item.roll_type}",
        expressionId: expression("s_roll", "roll",
          // Only spells that roll have a row in `spell_rolls`; the other branch is never evaluated for them.
          `if(lookup("spells", item.spell, "rolls"), dice(if(inputs.critical, 2, 1) * (${spell("dice")} * if(${spell("by_character_level")}, ${CANTRIP_TIER}, 1) `
          + `+ ${spell("dice_step")} * ${UPCAST}), ${spell("die")}) + ${spell("flat")} + ${spell("flat_step")} * ${UPCAST} `
          + `+ if(${spell("add_modifier")}, ${SPELL_MOD}, 0) + inputs.bonus, 0)`),
      },
    ],
  },
  {
    kind: "talent", id: "feature", label: "Class feature or feat", description: "Choose the feature after adding the entry.",
    fields: [
      choice("feature", "Feature", "features", srd.features[0]!.id), itemText("source", "Source", "features", "feature", "source", "f"),
      computed("level", "Gained at level", 'lookup("features", item.feature, "level")', "number", "f"),
      itemText("description", "Description", "features", "feature", "description", "f"), usesResource,
    ],
    grantedActions: usesActions,
  },
  {
    kind: "item", id: "other_gear", label: "Other gear, tool, mount or vehicle", quantityFields: ["weight"],
    description: "Choose the item after adding the entry and enter its weight.",
    fields: [
      choice("item", "Item", "gear", otherGear[0]!.id), itemText("category", "Category", "gear", "item", "category", "g"),
      itemText("cost", "Cost", "gear", "item", "cost", "g"),
      computed("listed_weight", "Listed weight (lb.)", 'lookup("gear", item.item, "weight")', "number", "g"),
      itemText("description", "Description", "gear", "item", "description", "g"), weight(0),
    ],
    grantedActions: [],
  },
  {
    kind: "item", id: "magic_item", label: "Magic item", quantityFields: ["weight"], description: "Choose the item after adding the entry.",
    fields: [
      choice("item", "Item", "magic_items", srd.magicItems[0]!.id), itemText("summary", "Type and rarity", "magic_items", "item", "summary", "x"),
      itemText("description", "Description", "magic_items", "item", "description", "x"),
      flag("attuned", "Attuned"), usesResource, weight(0), longText("notes", "Notes"),
    ],
    grantedActions: usesActions,
  },
];

const { source } = read<{ source: Record<string, string> }>("./srd-5.1.json");
export const dnd5eDocument: SystemDocumentV1 = {
  schemaVersion: "2.0",
  metadata: {
    name: "5e SRD 5.1",
    description: `Fifth-edition fantasy roleplaying rules for Sweetroll. This work includes material taken from the ${source.title} (“SRD 5.1”) `
      + `by ${source.publisher} and available at ${source.url}. The SRD 5.1 is licensed under the Creative Commons Attribution 4.0 `
      + `International License available at https://creativecommons.org/licenses/by/4.0/legalcode. ${source.data}. `
      + "The adaptation adds digital sheets, formulas and roll actions; hit points use the fixed value per level. "
      + "Not affiliated with or endorsed by Wizards of the Coast.",
    language: "en",
    defaultDice: "d20",
  },
  entities: [
    { id: "character", label: "Player character", kind: "playable", fields: characterFields },
    { id: "monster", label: "Monster or NPC", kind: "npc", presetsFrom: "bestiary", fields: monsterFields },
  ],
  referenceData,
  sheets: [
    { id: "character_sheet", label: "Character sheet", targetEntityId: "character", sections: characterSections },
    { id: "monster_sheet", label: "Stat block", targetEntityId: "monster", sections: monsterSections },
  ],
  expressions,
  actions: [...characterActions, ...monsterActions],
  validations,
  templates: [classTemplate, ...srd.weapons.map(weaponTemplate), ...srd.armor.map(armorTemplate), ...catalogGear.map(gearTemplate), ...potions, ...genericTemplates],
  slots: [
    // Twelve classes exist; a character meets the ability requirements of a few at most.
    { id: "class_list", label: "Classes", accepts: ["effect"], maxEntries: 6 },
    { id: "equipment", label: "Equipment", accepts: ["item"], maxEntries: EQUIPMENT_CAPACITY },
    { id: "spell_list", label: "Spells", accepts: ["spell"], maxEntries: 80 },
    { id: "feature_list", label: "Features and feats", accepts: ["talent"], maxEntries: 60 },
  ],
};

/** Counts against the package limits, for the scenario and the gap document. */
export const dnd5eBudget = {
  bytes: Buffer.byteLength(JSON.stringify(dnd5eDocument), "utf8"),
  templates: dnd5eDocument.templates.length,
  fields: dnd5eDocument.entities.reduce((sum, entity) => sum + entity.fields.length, 0)
    + dnd5eDocument.templates.reduce((sum, template) => sum + template.fields.length, 0),
  actions: dnd5eDocument.actions.length + dnd5eDocument.templates.reduce((sum, template) => sum + template.grantedActions.length, 0),
  expressions: expressions.length,
  catalogGear: catalogGear.length,
  gearRecords: otherGear.length,
};
