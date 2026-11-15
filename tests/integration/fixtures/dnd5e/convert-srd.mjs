// Converts the SRD 5.1 JSON published by the 5e-bits project into the compact
// `srd-5.1.json` read by `document.ts`. Run it only to refresh that file:
//
//   node tests/integration/fixtures/dnd5e/convert-srd.mjs <directory with 5e-SRD-*.json>
//
// Source: https://github.com/5e-bits/5e-database, `src/2014/en` (MIT-licensed
// conversion of the System Reference Document 5.1 by Wizards of the Coast LLC,
// which is available under CC BY 4.0). No rules text is written here by hand
// except the short class-resource table below, which restates SRD class rules.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const sourceDirectory = process.argv[2];
if (!sourceDirectory) throw new Error("Pass the directory that holds the 5e-SRD-*.json files.");
const load = (name) => JSON.parse(readFileSync(join(sourceDirectory, `5e-SRD-${name}.json`), "utf8"));
const id = (index) => {
  const value = index.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const safe = /^[a-z]/.test(value) ? value : `x_${value}`;
  if (safe.length > 64) throw new Error(`ID too long: ${safe}`);
  return safe;
};
const text = (parts, limit = 10_000) => {
  const joined = (Array.isArray(parts) ? parts : [parts]).filter((part) => typeof part === "string").join("\n").trim();
  if (joined.length > limit) throw new Error(`Text longer than ${limit}: ${joined.slice(0, 60)}`);
  return joined;
};
const abilities = ["str", "dex", "con", "int", "wis", "cha"];
const modifier = (score) => Math.floor((score - 10) / 2);
const signed = (value) => (value >= 0 ? `+${value}` : `${value}`);
/** "2d10+8" → { dice: 2, die: 10, flat: 8 }; "5" → { dice: 0, die: 4, flat: 5 }; anything else → null. */
function parseDice(source) {
  const match = /^(?:(\d+)d(\d+))?\s*(?:([+-])?\s*(\d+))?(\s*\+\s*MOD)?$/.exec(String(source).trim());
  if (!match || (match[1] === undefined && match[4] === undefined)) return null;
  return {
    dice: Number(match[1] ?? 0), die: Number(match[2] ?? 4),
    flat: Number(match[4] ?? 0) * (match[3] === "-" ? -1 : 1), mod: match[5] !== undefined,
  };
}

// --- Classes and levels -----------------------------------------------------
// Limited-use class features shown as sheet resources. `value(level, specific)`
// gives the table part of the maximum; `charisma: true` adds the Charisma
// modifier (minimum total 1), as the SRD does for these two features.
const classResources = {
  barbarian: [{ name: "Rage", value: (_, s) => Math.min(s.rage_count, 99) }],
  bard: [{ name: "Bardic Inspiration", value: () => 0, charisma: true }],
  cleric: [{ name: "Channel Divinity", value: (_, s) => s.channel_divinity_charges }],
  druid: [{ name: "Wild Shape", value: (level) => (level >= 2 ? 2 : 0) }],
  fighter: [
    { name: "Second Wind", value: () => 1 },
    { name: "Action Surge", value: (_, s) => s.action_surges },
    { name: "Indomitable", value: (_, s) => s.indomitable_uses },
  ],
  monk: [{ name: "Ki points", value: (_, s) => s.ki_points }],
  paladin: [
    { name: "Lay on Hands (hit points)", value: (level) => level * 5 },
    { name: "Channel Divinity", value: (level) => (level >= 3 ? 1 : 0) },
    { name: "Divine Sense", value: () => 1, charisma: true },
  ],
  ranger: [],
  rogue: [],
  sorcerer: [{ name: "Sorcery points", value: (_, s) => s.sorcery_points }],
  warlock: [],
  wizard: [{ name: "Arcane Recovery", value: () => 1 }],
};
// The class die rolled from the sheet: [name, dice, die, flat] per level.
const classRolls = {
  bard: ["Bardic Inspiration die", (_, s) => [1, s.bardic_inspiration_die, 0]],
  fighter: ["Second Wind (hit points regained)", (level) => [1, 10, level]],
  monk: ["Martial Arts damage die", (_, s) => [s.martial_arts.dice_count, s.martial_arts.dice_value, 0]],
  rogue: ["Sneak Attack damage", (_, s) => [s.sneak_attack.dice_count, s.sneak_attack.dice_value, 0]],
};
const speedBonus = { barbarian: (level) => (level >= 5 ? 10 : 0), monk: (_, s) => s.unarmored_movement };

const rawClasses = load("Classes");
const rawLevels = load("Levels");
const subclasses = load("Subclasses");
const classes = rawClasses.map((entry, index) => {
  const proficiencies = entry.proficiencies.map((p) => p.name).filter((name) => !name.startsWith("Saving Throw"));
  const resources = classResources[entry.index];
  return {
    id: id(entry.index), name: entry.name, number: index + 1, hit_die: entry.hit_die,
    saves: entry.saving_throws.map((save) => save.index),
    spell_ability: entry.spellcasting?.spellcasting_ability.index ?? "none",
    // Paladins and rangers prepare/know spells from half their level; the SRD
    // lists prepared casters by class feature text.
    prepares: ["cleric", "druid", "wizard"].includes(entry.index) ? "full" : entry.index === "paladin" ? "half" : "none",
    proficiencies: text([
      `Proficiencies: ${proficiencies.join(", ") || "none"}.`,
      ...entry.proficiency_choices.map((choice) => `${choice.desc}.`),
    ]),
    subclass: subclasses.find((subclass) => subclass.class.index === entry.index)?.name ?? "",
    resources: [0, 1, 2].map((slot) => ({ name: resources[slot]?.name ?? "—", charisma: resources[slot]?.charisma === true })),
    roll_name: classRolls[entry.index]?.[0] ?? "—",
    progression: "",
  };
});
const levels = [];
for (const entry of classes) {
  const source = rawClasses[entry.number - 1].index;
  const featureLines = [];
  for (let level = 1; level <= 20; level += 1) {
    const row = rawLevels.find((candidate) => candidate.class.index === source && candidate.level === level && !candidate.subclass);
    const subclassRow = rawLevels.find((candidate) => candidate.class.index === source && candidate.level === level && candidate.subclass);
    const specific = row.class_specific ?? {};
    const names = [...row.features, ...(subclassRow?.features ?? [])].map((feature) => feature.name);
    if (names.length > 0) featureLines.push(`Level ${level}: ${names.join(", ")}`);
    entry.progression = text(featureLines);
    const roll = classRolls[source]?.[1](level, specific) ?? [0, 4, 0];
    const notes = Object.entries(specific).flatMap(([key, value]) => {
      if (typeof value === "object" && value.dice_count === undefined) return [];
      const shown = typeof value === "object" ? `${value.dice_count}d${value.dice_value}` : value === 9999 ? "unlimited" : value;
      return [`${key.replaceAll("_", " ")}: ${shown}`];
    });
    levels.push({
      key: entry.number * 100 + level, class: entry.id, level, prof: row.prof_bonus,
      notes: notes.join("; ") || "—",
      cantrips: row.spellcasting?.cantrips_known ?? 0, spells_known: row.spellcasting?.spells_known ?? 0,
      slots: [1, 2, 3, 4, 5, 6, 7, 8, 9].map((slot) => row.spellcasting?.[`spell_slots_level_${slot}`] ?? 0),
      resources: [0, 1, 2].map((slot) => classResources[source][slot]?.value(level, specific) ?? 0),
      roll, speed_bonus: speedBonus[source]?.(level, specific) ?? 0,
      rage_damage: specific.rage_damage_bonus ?? 0,
    });
  }
}

// --- Races (each SRD subrace is merged into its race) -----------------------
const traits = load("Traits");
const rawSubraces = load("Subraces");
const races = load("Races").map((race) => {
  const subrace = rawSubraces.find((candidate) => candidate.race.index === race.index);
  const bonuses = Object.fromEntries(abilities.map((ability) => [ability, 0]));
  for (const bonus of [...race.ability_bonuses, ...(subrace?.ability_bonuses ?? [])]) bonuses[bonus.ability_score.index] += bonus.bonus;
  const traitIndexes = [...race.traits, ...(subrace?.racial_traits ?? [])].map((trait) => trait.index);
  return {
    id: id(subrace?.index ?? race.index), name: subrace ? `${race.name} (${subrace.name})` : race.name,
    speed: race.speed, size: race.size, bonuses,
    hp_per_level: traitIndexes.includes("dwarven-toughness") ? 1 : 0,
    languages: race.language_desc,
    traits: text([
      ...(race.index === "half-elf" ? ["Ability Score Increase: two ability scores other than Charisma each increase by 1. Add them to your base scores."] : []),
      `Size: ${race.size_description}`,
      ...traitIndexes.map((index) => {
        const trait = traits.find((candidate) => candidate.index === index);
        return `${trait.name}: ${trait.desc.join(" ")}`;
      }),
    ]),
  };
});

// --- Equipment --------------------------------------------------------------
const equipment = load("Equipment");
const cost = (entry) => (entry.cost ? `${entry.cost.quantity} ${entry.cost.unit}` : "—");
const weapons = equipment.filter((entry) => entry.equipment_category.index === "weapon").map((entry) => {
  const properties = entry.properties.map((property) => property.index);
  const damage = entry.damage ? parseDice(entry.damage.damage_dice) : null;
  const twoHanded = entry.two_handed_damage ? parseDice(entry.two_handed_damage.damage_dice) : null;
  const range = entry.weapon_range === "Ranged" || properties.includes("thrown")
    ? `range ${(entry.throw_range ?? entry.range).normal}/${(entry.throw_range ?? entry.range).long} ft.` : "";
  return {
    id: id(entry.index), name: entry.name, category: entry.category_range, cost: cost(entry), weight: entry.weight ?? 0,
    ranged: entry.weapon_range === "Ranged", finesse: properties.includes("finesse"),
    damage: damage && { dice: damage.dice, die: damage.die, flat: damage.flat },
    two_handed: twoHanded && { dice: twoHanded.dice, die: twoHanded.die },
    damage_type: entry.damage?.damage_type.name.toLowerCase() ?? "",
    properties: text([
      [entry.category_range, entry.properties.map((property) => property.name).join(", "), range].filter(Boolean).join("; "),
      ...(entry.special ?? []),
    ], 2_000),
  };
});
const armor = equipment.filter((entry) => entry.equipment_category.index === "armor").map((entry) => ({
  id: id(entry.index), name: entry.name, category: entry.armor_category, cost: cost(entry), weight: entry.weight ?? 0,
  base: entry.armor_class.base,
  // 99 means no limit on the Dexterity modifier.
  dex_cap: entry.armor_class.dex_bonus ? entry.armor_class.max_bonus ?? 99 : 0,
  shield: entry.armor_category === "Shield",
  notes: [
    `${entry.armor_category} armor`, entry.str_minimum > 0 ? `Strength ${entry.str_minimum} required` : "",
    entry.stealth_disadvantage ? "disadvantage on Stealth checks" : "",
  ].filter(Boolean).join("; "),
}));
const packContents = new Set(equipment.flatMap((entry) => (entry.contents ?? []).map((content) => content.item.index)));
const gear = equipment.filter((entry) => !["weapon", "armor"].includes(entry.equipment_category.index)).map((entry) => {
  const category = entry.gear_category?.name ?? entry.tool_category ?? entry.vehicle_category ?? entry.equipment_category.name;
  const contents = (entry.contents ?? []).map((content) => `${content.quantity} × ${content.item.name}`).join(", ");
  const kind = entry.gear_category?.index;
  return {
    id: id(entry.index), name: entry.name, category, cost: cost(entry), weight: entry.weight ?? 0,
    description: text([...(entry.desc ?? []), contents ? `Contents: ${contents}.` : "",
      entry.speed ? `Speed ${entry.speed.quantity} ${entry.speed.unit}.` : "", entry.capacity ? `Capacity ${entry.capacity}.` : ""].filter(Boolean), 2_000),
    // Items that get their own catalog template (the rest use the generic one).
    catalog: kind === "ammunition" || kind === "kits" || kind === "equipment-packs"
      || (kind === "standard-gear" && (packContents.has(entry.index) || (entry.desc ?? []).length > 0)),
  };
});

// --- Spells -----------------------------------------------------------------
const spells = load("Spells").map((spell) => {
  const damage = Array.isArray(spell.damage) ? spell.damage[0] : spell.damage;
  const table = damage?.damage_at_slot_level ?? spell.heal_at_slot_level ?? damage?.damage_at_character_level;
  const cantripScaling = damage?.damage_at_character_level !== undefined;
  const steps = table ? Object.keys(table).map(Number).sort((a, b) => a - b) : [];
  const first = steps.length > 0 ? parseDice(table[steps[0]]) : null;
  const second = steps.length > 1 ? parseDice(table[steps[1]]) : null;
  const roll = first === null ? { dice: 0, die: 4, flat: 0, mod: false, dice_step: 0, flat_step: 0, by_character_level: false } : {
    dice: first.dice, die: first.die, flat: first.flat, mod: first.mod,
    // Cantrips multiply their dice at character levels 5, 11 and 17 instead.
    dice_step: cantripScaling || !second ? 0 : second.dice - first.dice,
    flat_step: cantripScaling || !second ? 0 : second.flat - first.flat,
    by_character_level: cantripScaling && second !== null && second.dice === first.dice * 2,
  };
  const rollType = spell.heal_at_slot_level ? "hit points regained" : damage?.damage_type ? `${damage.damage_type.name.toLowerCase()} damage` : damage ? "damage" : "—";
  return {
    id: id(spell.index), name: spell.name, level: spell.level,
    summary: [
      [
        spell.level === 0 ? `${spell.school.name} cantrip` : `Level ${spell.level} ${spell.school.name.toLowerCase()}`,
        `${spell.casting_time}${spell.ritual ? " (ritual)" : ""}`, spell.range,
        `${spell.components.join(", ")}${spell.material ? ` (${spell.material.replace(/\.$/, "")})` : ""}`,
      ].join(" · "),
      `Duration: ${spell.concentration ? "Concentration, " : ""}${spell.duration.toLowerCase()}`,
      spell.attack_type ? `${spell.attack_type[0].toUpperCase()}${spell.attack_type.slice(1)} spell attack` : "",
      spell.dc ? `Saving throw: ${spell.dc.dc_type.name}` : "",
      `Classes: ${spell.classes.map((entry) => entry.name).join(", ")}`,
    ].filter(Boolean).join("\n"),
    roll, roll_type: rollType,
    description: text([...spell.desc, ...(spell.higher_level ?? []).map((line) => `At Higher Levels. ${line}`)]),
  };
});

// --- Monsters ---------------------------------------------------------------
const entries = (list) => text((list ?? []).map((entry) => {
  const usage = entry.usage?.type === "per day" ? ` (${entry.usage.times}/Day)`
    : entry.usage?.type === "recharge on roll" ? ` (Recharge ${entry.usage.min_value}–6)` : "";
  return `${entry.name}${usage}. ${entry.desc}`;
}));
const fraction = (rating) => ({ 0.125: "1/8", 0.25: "1/4", 0.5: "1/2" }[rating] ?? String(rating));
const monsters = load("Monsters").map((monster) => {
  const saves = Object.fromEntries(abilities.map((ability, index) => {
    const score = [monster.strength, monster.dexterity, monster.constitution, monster.intelligence, monster.wisdom, monster.charisma][index];
    const proficient = monster.proficiencies.find((entry) => entry.proficiency.index === `saving-throw-${ability}`);
    return [ability, proficient?.value ?? modifier(score)];
  }));
  const skills = monster.proficiencies.filter((entry) => entry.proficiency.index.startsWith("skill-"))
    .map((entry) => `${entry.proficiency.name.replace("Skill: ", "")} ${signed(entry.value)}`).join(", ");
  const defenses = [
    ["Damage vulnerabilities", monster.damage_vulnerabilities], ["Damage resistances", monster.damage_resistances],
    ["Damage immunities", monster.damage_immunities], ["Condition immunities", monster.condition_immunities.map((entry) => entry.name)],
  ].filter(([, list]) => list.length > 0).map(([label, list]) => `${label}: ${list.join(", ")}`).join("\n");
  const attacks = (monster.actions ?? []).filter((action) => typeof action.attack_bonus === "number").slice(0, 3).map((action) => {
    const [primary, ...extra] = (action.damage ?? []).filter((part) => part.damage_dice !== undefined);
    const parsed = primary ? parseDice(primary.damage_dice) : null;
    const rest = extra.map((part) => `${part.damage_dice} ${part.damage_type?.name.toLowerCase() ?? ""}`.trim());
    return {
      name: action.name, hit: action.attack_bonus, dice: parsed?.dice ?? 0, die: parsed?.die ?? 4, flat: parsed?.flat ?? 0,
      type: [primary?.damage_type?.name.toLowerCase() ?? "see the action text", ...rest.map((part) => `plus ${part}`)].join(" "),
    };
  });
  const armorClass = monster.armor_class[0];
  const armorNote = armorClass.type === "armor" ? (armorClass.armor ?? []).map((entry) => entry.name.toLowerCase()).join(", ") || "armor"
    : armorClass.type === "dex" ? "" : `${armorClass.type} armor`;
  const scores = [monster.strength, monster.dexterity, monster.constitution, monster.intelligence, monster.wisdom, monster.charisma];
  const senses = Object.entries(monster.senses).map(([sense, value]) => `${sense.replaceAll("_", " ")} ${value}`).join(", ");
  // `values` matches the fields of the `monster` entity in document.ts.
  return {
    id: id(monster.index), name: monster.name,
    values: {
      summary: `${monster.size} ${monster.type}${monster.subtype ? ` (${monster.subtype})` : ""}, ${monster.alignment}`,
      armor_class: armorClass.value, armor_note: armorNote,
      hp: { current: monster.hit_points, max: monster.hit_points }, hit_dice: monster.hit_points_roll,
      speed: Object.entries(monster.speed).map(([mode, value]) => (mode === "walk" ? value : mode === "hover" ? "hover" : `${mode} ${value}`)).join(", "),
      ...Object.fromEntries(abilities.flatMap((ability, index) => [
        [ability, scores[index]], [`save_${ability}_bonus`, saves[ability] - modifier(scores[index])],
      ])),
      skills, senses, languages: monster.languages ?? "", challenge: fraction(monster.challenge_rating), xp: monster.xp,
      proficiency_bonus: monster.proficiency_bonus, defenses,
      traits: entries(monster.special_abilities), actions: entries(monster.actions),
      reactions: entries(monster.reactions), legendary: entries(monster.legendary_actions),
      legendary_actions: { current: (monster.legendary_actions ?? []).length > 0 ? 3 : 0, max: (monster.legendary_actions ?? []).length > 0 ? 3 : 0 },
      ...Object.fromEntries(attacks.flatMap((attack, index) => Object.entries(attack).map(([key, value]) => [`attack_${index + 1}_${key}`, value]))),
    },
  };
});

// --- Reference text ---------------------------------------------------------
// The source repeats a feature for every class and level that grants it (for
// example Ability Score Improvement). Entries with the same text are merged.
const features = [];
for (const feature of load("Features")) {
  const description = text(feature.desc);
  const source = feature.subclass ? `${feature.class.name} (${feature.subclass.name})` : feature.class.name;
  const known = features.find((candidate) => candidate.description === description);
  if (known === undefined) features.push({ id: id(feature.index), name: feature.name, level: feature.level, source, description });
  else if (known.source !== source) known.source = "Several classes";
}
const feats = load("Feats").map((feat) => ({
  id: id(`feat-${feat.index}`), name: `Feat: ${feat.name}`, level: 0, source: "Feat",
  description: text([`Prerequisite: ${feat.prerequisites.map((p) => `${p.ability_score.name} ${p.minimum_score}`).join(", ")}`, ...feat.desc]),
}));
// The first description line is the item's type, rarity and attunement note.
// Full descriptions and the rule sections do not fit the 1 MiB document limit.
// Numbered variants ("Armor, +1") repeat their parent entry ("Armor, +1, +2, or +3") and are left out.
const magicItems = load("Magic-Items").filter((item) => !item.variant).map((item) => ({
  id: id(item.index), name: item.name, summary: text(item.desc[0] ?? "", 500),
}));
const simple = (name, describe = (entry) => text(entry.desc)) => load(name).map((entry) => ({
  id: id(entry.index), name: entry.name ?? entry.full_name, description: describe(entry),
}));
const skills = load("Skills").map((skill) => ({ id: id(skill.index), name: skill.name, ability: skill.ability_score.index, description: text(skill.desc) }));
const background = load("Backgrounds").map((entry) => ({
  id: id(entry.index), name: entry.name,
  description: text([
    `Skill Proficiencies: ${entry.starting_proficiencies.map((p) => p.name.replace("Skill: ", "")).join(", ")}`,
    `Languages: ${entry.language_options.choose} of your choice`,
    `Equipment: ${entry.starting_equipment.map((item) => `${item.quantity} × ${item.equipment.name}`).join(", ")}, and a pouch of ${entry.starting_gold?.quantity ?? 15} gp`,
    `${entry.feature.name}: ${entry.feature.desc.join(" ")}`,
  ]),
}));
const output = {
  source: {
    title: "System Reference Document 5.1", publisher: "Wizards of the Coast LLC",
    url: "https://dnd.wizards.com/resources/systems-reference-document",
    license: "CC BY 4.0, https://creativecommons.org/licenses/by/4.0/legalcode",
    data: "Structured data converted from https://github.com/5e-bits/5e-database (src/2014/en, MIT License)",
  },
  classes, levels, races, skills, background, weapons, armor, gear, spells, features: [...features, ...feats], magicItems,
  conditions: simple("Conditions"), damageTypes: simple("Damage-Types"), schools: simple("Magic-Schools", (entry) => entry.desc),
  alignments: simple("Alignments", (entry) => entry.desc), weaponProperties: simple("Weapon-Properties"),
  languages: simple("Languages", (entry) => `${entry.type} language. Typical speakers: ${entry.typical_speakers.join(", ")}.${entry.script ? ` Script: ${entry.script}.` : ""}`),
  abilityScores: simple("Ability-Scores"),
};
const directory = dirname(fileURLToPath(import.meta.url));
const target = join(directory, "srd-5.1.json");
writeFileSync(target, `${JSON.stringify(output)}\n`);
// Stat blocks are sheet values, not rules data: they are imported through the API.
writeFileSync(join(directory, "srd-5.1-monsters.json"), `${JSON.stringify(monsters)}\n`);
console.log(Object.entries(output).map(([key, value]) => `${key}: ${Array.isArray(value) ? value.length : 1}`).join(", "));
console.log(`${target}: ${readFileSync(target).length} bytes`);
