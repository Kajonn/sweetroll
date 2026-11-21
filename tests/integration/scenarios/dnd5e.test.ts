import { randomUUID } from "node:crypto";

import { expect } from "vitest";

import { dnd5eBudget, dnd5eDocument, srdMonsters } from "../fixtures/dnd5e/document.js";

// What this scenario covers beyond the first build (SRD gaps plan 2026-11-16, all
// stages): one template per weapon sharing formulas (S1), rules tables for
// players (S2), monster presets (S3), characters that start full (S4), rests
// (S5), applying a roll (S6), attacks on either kind of target (S7), class
// features on the class entry (S11) and non-player entities in campaigns only (S10).
import { scenario, type ScenarioActor } from "./runner.js";

/**
 * The fifth-edition SRD 5.1 system, authored, published and played only
 * through public API v1: a rules author, a GM and four players. Dice are
 * rolled by the server, so every graded roll is checked against its own dice.
 * A character's classes are entries: adding a class entry is multiclassing.
 * docs/systems/dnd5e-srd.md lists what the SRD has and this system lacks.
 */
type Resource = { current: number; max: number };
type Sheet = {
  characterId: string; revision: number; values: Record<string, unknown>; derivedValues: Record<string, number | string>;
  entries: Array<{ entryId: string; templateId: string | null; values: Record<string, unknown>; derivedValues?: Record<string, number | string> }>;
  validations: Array<{ validationId: string; severity: string }>;
};
type Die = { sides: number; value: number; groupId: string };
type Roll = {
  total: number; output: string; dice: Die[]; outcome?: { id: string; label: string };
  details?: Array<{ id: string; value: number }>;
};
type Command = { characterId: string; revision: number; roll: Roll | null };
type Hero = { owner: ScenarioActor; path: `/characters/${string}`; characterId: string; revision: number; classEntries: string[] };
type ClassLevels = [classId: string, level: number];

const scopes = {
  author: ["systems:read", "systems:write"],
  gm: ["systems:read", "characters:read", "characters:write", "campaigns:read", "campaigns:write"],
  player: ["characters:read", "characters:write", "campaigns:read", "campaigns:write"],
} as const;
const d20 = (roll: Roll) => roll.dice.filter((die) => die.groupId === "d20").map((die) => die.value);

scenario("5e SRD: publish the rules, build a party and fight a goblin", async ({ actor, phase }) => {
  const author = await actor("cara", scopes.author);
  const gm = await actor("ada", scopes.gm);
  const bob = await actor("bob", scopes.player);
  const dan = await actor("dan", scopes.player);
  const eve = await actor("eve", scopes.player);
  const finn = await actor("finn", scopes.player);

  await phase("Publish the rules");
  // The whole SRD rules catalog is one document, well inside the 5 MiB limit.
  expect(dnd5eBudget.bytes).toBeGreaterThan(1024 * 1024);
  expect(dnd5eBudget.bytes).toBeLessThan(5 * 1024 * 1024);
  expect(dnd5eBudget).toMatchObject({ templates: 99, catalogGear: 40 });
  expect(dnd5eBudget.fields).toBeLessThanOrEqual(512);
  expect(dnd5eBudget.actions).toBeLessThanOrEqual(256);
  expect(await author.json("POST /systems/validate", { document: dnd5eDocument })).toEqual({ valid: true, diagnostics: [] });
  const created = await author.command<{ system: { systemId: string }; draft: { revision: number } }>("POST /systems", {
    name: dnd5eDocument.metadata.name,
  }, 201);
  const system = `/systems/${created.system.systemId}` as const;
  const saved = await author.json<{ draft: { revision: number } }>(`PUT ${system}/draft`, {
    document: dnd5eDocument, expectedRevision: created.draft.revision,
  });
  const { versionId } = await author.command<{ versionId: string }>(`POST ${system}/publish`, {
    expectedRevision: saved.draft.revision, semanticVersion: "1.0.0", releaseNotes: "SRD 5.1",
  }, 201);
  await author.json(`PUT ${system}/sharing`, { access: "link" });
  // The export of the published version imports again as a new system.
  const exported = await author.json<{ package: { referenceData: Array<{ id: string; records: unknown[] }> } }>(`GET /system-versions/${versionId}/export`);
  const recordCount = (id: string) => exported.package.referenceData.find((dataset) => dataset.id === id)?.records.length;
  expect(["spells", "classes", "levels", "races", "magic_items", "rules"].map(recordCount)).toEqual([319, 12, 240, 9, 362, 39]);
  await author.command("POST /systems", { source: { kind: "import", content: JSON.stringify(exported) } }, 201);

  async function place(hero: Hero, slotId: string, templateId: string, values?: Record<string, unknown>): Promise<string> {
    const entryId = randomUUID();
    const placed = await hero.owner.command<Command>(`POST ${hero.path}/entries`, {
      entryId, slotId, templateId, expectedRevision: hero.revision, ...(values === undefined ? {} : { values }),
    });
    hero.revision = placed.revision;
    return entryId;
  }
  // A character is created without a class; each class is an entry in the class list.
  const build = async (owner: ScenarioActor, name: string, initialValues: Record<string, unknown>, classLevels: ClassLevels[]): Promise<Hero> => {
    const { characterId, revision } = await owner.command<{ characterId: string; revision: number }>("POST /characters", {
      name, systemVersionId: versionId, entityDefinitionId: "character", initialValues,
    }, 201);
    const hero: Hero = { owner, characterId, revision, path: `/characters/${characterId}`, classEntries: [] };
    for (const [index, [classId, level]] of classLevels.entries()) {
      hero.classEntries.push(await place(hero, "class_list", "class_levels", { class: classId, level, first: index === 0 }));
    }
    return hero;
  };
  const sheetOf = (hero: Hero, reader: ScenarioActor = hero.owner) => reader.json<Sheet>(`GET ${hero.path}`);
  const act = async (hero: Hero, actionId: string, body: object = {}, who: ScenarioActor = hero.owner): Promise<Roll> => {
    const command = await who.command<Command>(`POST ${hero.path}/actions/${actionId}`, {
      inputs: {}, expectedRevision: hero.revision, ...body,
    });
    hero.revision = command.revision;
    return command.roll!;
  };

  await phase("Build a fighter, a wizard, a rogue and a cleric", { resetRateLimits: true });
  const fighter = await build(bob, "Brakka", {
    race: "human", str_base: 15, dex_base: 12, con_base: 14, skill_proficiencies: ["athletics", "perception"],
  }, [["fighter", 1]]);
  expect((await sheetOf(fighter)).derivedValues).toMatchObject({
    str: 16, str_mod: 3, dex_mod: 1, con_mod: 2, proficiency_bonus: 2, save_str: 5, save_con: 4, save_dex: 1,
    skill_athletics: 5, skill_perception: 2, skill_stealth: 1, passive_perception: 12, armor_class: 11, speed: 30,
    level: 1, spell_save_dc: 0, carrying_capacity: 240,
  });
  // The class entry shows what the class contributes; the sheet returns its computed fields.
  // Its class features are resources of the entry; they start full (S4, S11).
  const fighterClass = (await sheetOf(fighter)).entries.find((entry) => entry.entryId === fighter.classEntries[0])!;
  expect(fighterClass.values).toMatchObject({
    class: "fighter", level: 1, first: true, res1: { current: 1, max: 1 }, res2: { current: 0, max: 0 }, res3: { current: 0, max: 0 },
  });
  expect(fighterClass.derivedValues).toMatchObject({ subclass: "Champion", hit_die: 10, hit_points: 10, save_str: 1, save_dex: 0, res1_name: "Second Wind", res2_name: "Action Surge" });
  await place(fighter, "equipment", "chain_mail");
  const shield = await place(fighter, "equipment", "shield");
  // Every weapon is a catalog entry of its own (S1).
  const longsword = await place(fighter, "equipment", "longsword");
  expect((await sheetOf(fighter)).derivedValues).toMatchObject({ armor_class: 18, carried_weight: 64 });
  ({ revision: fighter.revision } = await bob.command<Command>(`PATCH ${fighter.path}/entries/${shield}`, {
    values: { equipped: false }, expectedRevision: fighter.revision,
  }));
  expect((await sheetOf(fighter)).derivedValues.armor_class).toBe(16);
  ({ revision: fighter.revision } = await bob.command<Command>(`PATCH ${fighter.path}/entries/${shield}`, {
    values: { equipped: true }, expectedRevision: fighter.revision,
  }));
  // The first class gave the sheet its hit points and filled them.
  expect((await sheetOf(fighter)).values).toMatchObject({ hp: { current: 12, max: 12 }, hit_dice: { current: 1, max: 1 } });

  const wizard = await build(dan, "Ilse", { race: "high_elf", int_base: 16, dex_base: 14, con_base: 12, skill_proficiencies: ["arcana"] }, [["wizard", 5]]);
  const wizardSheet = await sheetOf(wizard);
  expect(wizardSheet.derivedValues).toMatchObject({
    int: 17, level: 5, spell_mod: 3, spell_save_dc: 14, spell_attack_bonus: 6, cantrips_known: 4, spells_available: 8,
    skill_arcana: 6, save_int: 6, save_wis: 3, armor_class: 13,
  });
  expect(wizardSheet.values).toMatchObject({
    hp: { current: 27, max: 27 }, slots_1: { current: 4, max: 4 }, slots_2: { current: 3, max: 3 }, slots_3: { current: 2, max: 2 },
    slots_4: { current: 0, max: 0 }, pact_slots: { current: 0, max: 0 },
  });
  expect(wizardSheet.entries[0]!.values).toMatchObject({ res1: { current: 1, max: 1 } });
  expect(wizardSheet.entries[0]!.derivedValues).toMatchObject({ res1_name: "Arcane Recovery" });
  const fireball = await place(wizard, "spell_list", "spell", { spell: "fireball" });
  const fireBolt = await place(wizard, "spell_list", "spell", { spell: "fire_bolt" });
  // Fireball in a level 4 slot rolls 9d6; a level 5 caster's Fire Bolt rolls 2d10.
  const blast = await act(wizard, "spell_roll", { entryId: fireball, inputs: { slot_level: 4 } });
  expect(blast.dice.map((die) => die.sides)).toEqual(Array(9).fill(6));
  expect(blast.output).toBe(`${blast.total} fire damage`);
  expect((await act(wizard, "spell_roll", { entryId: fireBolt })).dice.map((die) => die.sides)).toEqual([10, 10]);
  const spellAttack = await act(wizard, "spell_attack", { entryId: fireBolt, inputs: { advantage: true } });
  expect(spellAttack.total).toBe(Math.max(...d20(spellAttack)) + 6);
  // The spell's looked-up text is part of its entry on the sheet.
  const fireballEntry = (await sheetOf(wizard)).entries.find((entry) => entry.entryId === fireball)!;
  expect(fireballEntry.values).toEqual({ spell: "fireball", prepared: true, ability: "best" });
  expect(fireballEntry.derivedValues).toMatchObject({ level: 3, roll_type: "fire damage" });
  expect(fireballEntry.derivedValues!.summary).toContain("Level 3 evocation · 1 action · 150 feet");
  expect(fireballEntry.derivedValues!.description).toContain("20-foot-radius sphere");

  const rogue = await build(eve, "Pim", {
    race: "lightfoot_halfling", dex_base: 15, skill_proficiencies: ["stealth", "acrobatics"], skill_expertise: ["stealth"],
  }, [["rogue", 3]]);
  await place(rogue, "equipment", "leather_armor");
  const rapier = await place(rogue, "equipment", "rapier");
  expect((await sheetOf(rogue)).derivedValues).toMatchObject({
    dex: 17, skill_stealth: 7, skill_acrobatics: 5, armor_class: 14, speed: 25,
  });
  expect((await sheetOf(rogue)).entries.find((entry) => entry.entryId === rogue.classEntries[0])!.derivedValues)
    .toMatchObject({ roll_name: "Sneak Attack damage", table: "sneak attack: 2d6" });
  expect((await sheetOf(rogue)).values.hp).toEqual({ current: 18, max: 18 });
  const sneakAttack = await act(rogue, "class_roll", { entryId: rogue.classEntries[0] });
  expect(sneakAttack.dice.map((die) => die.sides)).toEqual([6, 6]);
  expect(sneakAttack.output).toBe(`Sneak Attack damage: ${sneakAttack.total}`);
  // A finesse weapon uses Dexterity: +3, proficiency +2, and the lower die with disadvantage.
  const thrust = await act(rogue, "attack", { entryId: rapier, inputs: { disadvantage: true, bonus: 1 } });
  expect(d20(thrust)).toHaveLength(2);
  expect(thrust.total).toBe(Math.min(...d20(thrust)) + 6);
  expect(thrust.outcome!.id).toBe(Math.min(...d20(thrust)) === 20 ? "critical" : Math.min(...d20(thrust)) === 1 ? "fumble" : "compare");
  expect((await act(rogue, "damage", { entryId: rapier, inputs: { critical: true } })).dice.map((die) => die.sides)).toEqual([8, 8]);

  const cleric = await build(finn, "Odda", { race: "hill_dwarf", wis_base: 15, con_base: 13 }, [["cleric", 1]]);
  const cure = await place(cleric, "spell_list", "spell", { spell: "cure_wounds" });
  const clericSheet = await sheetOf(cleric);
  expect(clericSheet.derivedValues).toMatchObject({ wis: 16, con: 15, speed: 25, spell_save_dc: 13, spells_available: 4, save_wis: 5, save_cha: 2 });
  expect(clericSheet.values).toMatchObject({ hp: { current: 11, max: 11 }, slots_1: { current: 2, max: 2 } });
  const healing = await act(cleric, "spell_roll", { entryId: cure, inputs: { slot_level: 2 } });
  expect(healing.dice.map((die) => die.sides)).toEqual([8, 8]);
  expect(healing.total).toBe(healing.dice.reduce((sum, die) => sum + die.value, 0) + 3);
  // Four attuned magic items raise the attunement warning.
  for (const item of ["bag_of_holding", "cloak_of_protection", "ring_of_protection", "amulet_of_health"]) {
    await place(cleric, "equipment", "magic_item", { item, attuned: true });
  }
  expect((await sheetOf(cleric)).validations).toEqual([expect.objectContaining({ validationId: "attunement_limit", severity: "warning" })]);

  await phase("Check the other class tables", { resetRateLimits: true });
  const derived = async (owner: ScenarioActor, values: Record<string, unknown>, classLevels: ClassLevels[]) => {
    const sheet = await sheetOf(await build(owner, classLevels.map(([classId, level]) => `${classId} ${level}`).join(" / ") || "No class", { race: "human", ...values }, classLevels));
    // Entries come back in storage order; list them in the order the classes were given.
    const classEntries = classLevels.map(([classId]) => sheet.entries.find((entry) => entry.templateId === "class_levels" && entry.values.class === classId))
      .map((entry) => ({ ...entry?.values, ...entry?.derivedValues }));
    return { ...sheet.derivedValues, ...sheet.values, classes: classEntries, validations: sheet.validations.map((entry) => entry.validationId) } as Record<string, unknown>;
  };
  expect(await derived(bob, { dex_base: 13, con_base: 15 }, [["barbarian", 1]])).toMatchObject({
    armor_class: 15, hp: { current: 15, max: 15 }, classes: [{ res1_name: "Rage", res1: { current: 2, max: 2 } }],
  });
  expect(await derived(dan, { dex_base: 15, wis_base: 15 }, [["monk", 5]])).toMatchObject({
    armor_class: 16, speed: 40, proficiency_bonus: 3, classes: [{ res1_name: "Ki points", res1: { current: 5, max: 5 } }],
  });
  // Draconic Resilience: Armor Class 13 + Dexterity and one extra hit point per level.
  expect(await derived(eve, { cha_base: 15, dex_base: 13 }, [["sorcerer", 3]])).toMatchObject({
    armor_class: 15, hp: { current: 17, max: 17 }, slots_2: { current: 2, max: 2 }, spell_mod: 3,
    classes: [{ res1_name: "Sorcery points", res1: { current: 3, max: 3 } }],
  });
  expect(await derived(finn, { cha_base: 15 }, [["bard", 2]])).toMatchObject({
    half_proficiency: 1, skill_athletics: 1, initiative: 1,
    // Bardic Inspiration uses the Charisma modifier, read from the stored score on the class entry.
    classes: [{ res1_name: "Bardic Inspiration", res1: { current: 3, max: 3 } }],
  });
  expect(await derived(bob, { cha_base: 15 }, [["paladin", 3]])).toMatchObject({
    slots_1: { current: 3, max: 3 }, spells_available: 4,
    classes: [{
      res1_name: "Channel Divinity", res1: { current: 1, max: 1 }, res2_name: "Lay on Hands (hit points)", res2: { current: 15, max: 15 },
      res3_name: "Divine Sense", res3: { current: 4, max: 4 },
    }],
  });
  // Pact Magic is its own pool: a level 5 warlock has two level 3 slots and no Spellcasting slots.
  expect(await derived(dan, {}, [["warlock", 5]])).toMatchObject({
    slots_1: { current: 0, max: 0 }, slots_3: { current: 0, max: 0 }, pact_slots: { current: 2, max: 2 }, pact_slot_level: 3,
    spells_available: 6, cantrips_known: 3, validations: [], casts_spells: true, has_pact_magic: true, has_slots_1: false,
  });

  await phase("Multiclass by adding class entries", { resetRateLimits: true });
  // Fighter 5 / wizard 3: level 8, the fighter's saving throws, the wizard's own slot table.
  expect(await derived(eve, { con_base: 13, int_base: 15 }, [["fighter", 5], ["wizard", 3]])).toMatchObject({
    // The first class fills hit points (fighter 5: 44); the second raises the maximum only.
    level: 8, proficiency_bonus: 3, hp: { current: 44, max: 62 }, hit_dice: { current: 5, max: 8 },
    save_str: 3, save_con: 5, save_int: 3, save_wis: 0, caster_classes: 1,
    slots_1: { current: 4, max: 4 }, slots_2: { current: 2, max: 2 }, slots_3: { current: 0, max: 0 },
    classes: [
      { class: "fighter", res1: { current: 1, max: 1 }, res2: { current: 1, max: 1 }, res3: { current: 0, max: 0 } },
      { class: "wizard", res1_name: "Arcane Recovery", res1: { current: 1, max: 1 } },
    ],
    cantrips_known: 3, spells_available: 6, validations: [],
  });
  // Cleric 3 / wizard 2 cast as a level 5 spellcaster; each class prepares with its own ability.
  expect(await derived(finn, { wis_base: 15, int_base: 13 }, [["cleric", 3], ["wizard", 2]])).toMatchObject({
    // Cleric 3 filled 4/2 slots; the wizard raises level 2 to 3 without filling it, and level 3 rises from 0 and fills.
    level: 5, caster_classes: 2, slots_1: { current: 4, max: 4 }, slots_2: { current: 2, max: 3 }, slots_3: { current: 2, max: 2 },
    spell_mod: 3, spells_available: 3 + 3 + 2 + 2,
  });
  // Paladin 4 / sorcerer 3: half the paladin levels count, so the slots are those of a level 5 caster.
  expect(await derived(bob, { cha_base: 15, dex_base: 13 }, [["paladin", 4], ["sorcerer", 3]])).toMatchObject({
    slots_3: { current: 2, max: 2 }, slots_4: { current: 0, max: 0 }, armor_class: 15, save_wis: 3, save_con: 0,
    classes: [{ res2_name: "Lay on Hands (hit points)", res2: { current: 20, max: 20 } }, { res1_name: "Sorcery points", res1: { current: 3, max: 3 } }],
  });
  // Warlock 3 / bard 2 keeps Pact Magic beside the bard's slots.
  expect(await derived(dan, { cha_base: 15 }, [["warlock", 3], ["bard", 2]])).toMatchObject({
    pact_slots: { current: 2, max: 2 }, pact_slot_level: 2, slots_1: { current: 3, max: 3 }, slots_2: { current: 0, max: 0 }, half_proficiency: 1,
  });
  // Known limit: cleric 2 / paladin 3 shows Channel Divinity on both class entries; the SRD gives one use.
  expect(await derived(eve, {}, [["cleric", 2], ["paladin", 3]])).toMatchObject({
    classes: [{ res1_name: "Channel Divinity", res1: { max: 1 } }, { res1_name: "Channel Divinity", res1: { max: 1 } }],
  });
  // A sheet without a class, or with two first classes, carries a warning.
  expect((await derived(finn, {}, [])).validations).toEqual(["first_class"]);
  const twoFirsts = await build(bob, "Two firsts", { race: "human" }, [["fighter", 1]]);
  await place(twoFirsts, "class_list", "class_levels", { class: "rogue", level: 1, first: true });
  expect((await sheetOf(twoFirsts)).validations.map((entry) => entry.validationId)).toEqual(["first_class"]);

  await phase("Prepare the campaign and import SRD monsters", { resetRateLimits: true });
  const { campaignId } = await gm.command<{ campaignId: string }>("POST /campaigns", { systemVersionId: versionId, title: "Cragmaw Road" }, 201);
  const campaign = `/campaigns/${campaignId}` as const;
  const revisionOf = async (who: ScenarioActor = gm) => (await who.json<{ revision: number }>(`GET ${campaign}`)).revision;
  // Every SRD stat block is a preset of the monster entity (S3): the GM names it.
  const summon = async (id: string): Promise<Hero> => {
    const monster = srdMonsters.find((candidate) => candidate.id === id)!;
    const npc = await gm.command<Sheet>(`POST ${campaign}/characters`, {
      name: monster.name, entityDefinitionId: "monster", presetId: id, expectedCampaignRevision: await revisionOf(),
    }, 201);
    return { owner: gm, characterId: npc.characterId, revision: npc.revision, path: `/characters/${npc.characterId}`, classEntries: [] };
  };
  expect(srdMonsters).toHaveLength(334);
  // Every 20th preset is created as written, from Aboleth onward.
  for (const monster of srdMonsters.filter((_, index) => index % 20 === 0)) await summon(monster.id);
  const goblin = await summon("goblin");
  const dragon = await summon("adult_red_dragon");
  expect(await sheetOf(goblin)).toMatchObject({
    values: { armor_class: 15, hp: { current: 7, max: 7 }, attack_1_name: "Scimitar", challenge: "1/4" }, derivedValues: { dex_mod: 2 },
  });
  expect((await sheetOf(dragon)).values).toMatchObject({ hp: { current: 256, max: 256 }, legendary_actions: { current: 3, max: 3 }, attack_3_name: "Tail" });
  const options = await bob.json<{ entities: Array<{ id: string; kind: string; presets?: unknown[] }> }>(`GET /characters/creation-options?systemVersionId=${versionId}`);
  expect(options.entities.map(({ id, kind, presets }) => [id, kind, presets?.length])).toEqual([["character", "playable", undefined], ["monster", "npc", 334]]);
  // A monster is a GM's campaign character; a player cannot create one on their own (S10).
  await bob.status("POST /characters", 422, {
    name: "Pet dragon", systemVersionId: versionId, entityDefinitionId: "monster", presetId: "adult_red_dragon", idempotencyKey: randomUUID(),
  });
  // Rules tables are readable by everyone who can use the version or read a sheet (S2).
  const tables = await bob.json<{ datasets: Array<{ datasetId: string; records: number }> }>(`GET ${fighter.path}/reference-data`);
  expect(tables.datasets).toEqual(expect.arrayContaining([{ datasetId: "conditions", label: "Conditions", records: 15 }, expect.objectContaining({ datasetId: "rules", records: 39 })]));
  const conditions = await bob.json<{ dataset: { records: Array<{ id: string; values: { description: string } }> } }>(`GET /system-versions/${versionId}/reference-data/conditions`);
  expect(conditions.dataset.records.find((record) => record.id === "prone")!.values.description).toContain("crawl");
  await dan.status(`GET ${fighter.path}/reference-data`, 404);

  await phase("Invite the fighter and the wizard", { resetRateLimits: true });
  for (const hero of [fighter, wizard]) {
    const invitation = await gm.command<{ token: string }>(`POST ${campaign}/invitations`, {
      intendedRole: "player", expectedCampaignRevision: await revisionOf(),
    }, 201);
    const review = await hero.owner.json<{ invitationRevision: number; accessRevision: number }>("POST /invitations/review", { token: invitation.token });
    await hero.owner.command("POST /invitations/accept", {
      campaignId, token: invitation.token, expectedInvitationRevision: review.invitationRevision, reviewedAccessRevision: review.accessRevision,
    });
    const adopted = await hero.owner.command<Sheet>(`POST ${campaign}/characters/${hero.characterId}/adopt`, {
      expectedCampaignRevision: await revisionOf(hero.owner), expectedCharacterRevision: hero.revision, acknowledgedDisclosure: true,
    });
    hero.revision = adopted.revision;
  }

  await phase("Fight on the road", { resetRateLimits: true });
  const table = { audience: "campaign" };
  for (const [hero, action] of [[fighter, "initiative_roll"], [wizard, "initiative_roll"], [goblin, "monster_initiative"]] as const) {
    const initiative = await act(hero, action, table);
    expect(initiative.total).toBe(d20(initiative)[0]! + (hero === wizard ? 3 : hero === goblin ? 2 : 1));
  }
  // The goblin's scimitar (+4) against the fighter's Armor Class 18, graded by the server.
  const grade = (roll: Roll, armorClass: number) => {
    const natural = d20(roll)[0]!;
    return natural === 20 ? "critical" : natural === 1 ? "fumble" : roll.total >= armorClass ? "hit" : "miss";
  };
  const seen = new Set<string>();
  for (let round = 0; round < 6; round += 1) {
    const slash = await act(goblin, "monster_attack_1", { ...table, targetCharacterId: fighter.characterId });
    expect(slash.total).toBe(d20(slash)[0]! + 4);
    expect(slash.details).toEqual([expect.objectContaining({ id: "armor_class", value: 18 })]);
    expect(slash.outcome!.id).toBe(grade(slash, 18));
    expect(slash.output).toContain(`Scimitar: ${slash.total} to hit`);
    seen.add(slash.outcome!.id);
  }
  expect(seen.size).toBeGreaterThan(0);
  const cut = await act(goblin, "monster_damage_1", table);
  expect(cut.output).toBe(`Scimitar: ${cut.total} slashing damage`);
  expect(cut.total).toBe(cut.dice[0]!.value + 2);
  // Rolls never change sheets on their own: the GM applies the damage roll to the fighter (S6).
  const applicable = await gm.json<{ rolls: Array<{ rollId: string; output: string; total: number }> }>(`GET ${fighter.path}/applicable-rolls`);
  const damageRoll = applicable.rolls.find((candidate) => candidate.output === cut.output)!;
  expect(damageRoll.total).toBe(cut.total);
  ({ revision: fighter.revision } = await gm.command<Command>(`POST ${fighter.path}/resources/hp/apply-roll`, {
    rollId: damageRoll.rollId, direction: "subtract", expectedRevision: fighter.revision,
  }));
  expect((await sheetOf(fighter)).values.hp).toEqual({ current: 12 - cut.total, max: 12 });
  // A roll from outside the campaign, or one the player cannot see, cannot be applied.
  const privateRoll = await act(goblin, "monster_roll_dice", { audience: "gm_only", inputs: { count: 1, sides: 6, modifier: 0 } });
  const hidden = (await gm.json<{ rolls: Array<{ rollId: string; output: string }> }>(`GET ${fighter.path}/applicable-rolls`)).rolls
    .find((candidate) => candidate.output === privateRoll.output)!;
  await bob.status(`POST ${fighter.path}/resources/hp/apply-roll`, 404, {
    rollId: hidden.rollId, direction: "add", expectedRevision: fighter.revision, idempotencyKey: randomUUID(),
  });
  expect((await bob.json<{ rolls: Array<{ rollId: string }> }>(`GET ${fighter.path}/applicable-rolls`)).rolls.map((roll) => roll.rollId)).not.toContain(hidden.rollId);

  // The fighter answers: Strength +3, proficiency +2, against the goblin's Armor Class 15.
  const swing = await act(fighter, "attack", { ...table, entryId: longsword, targetCharacterId: goblin.characterId });
  expect(swing.total).toBe(d20(swing)[0]! + 5);
  expect(swing.outcome!.id).toBe(grade(swing, 15));
  // One attack action covers either kind of target, or none (S7).
  const sparring = await act(fighter, "attack", { ...table, entryId: longsword, targetCharacterId: wizard.characterId });
  expect(sparring.outcome!.id).toBe(grade(sparring, 13));
  const untargeted = await act(fighter, "attack", { ...table, entryId: longsword });
  expect(untargeted.details).toBeUndefined();
  expect(untargeted.outcome!.id).toBe(d20(untargeted)[0] === 20 ? "critical" : d20(untargeted)[0] === 1 ? "fumble" : "compare");
  const versatile = await act(fighter, "damage_two_handed", { ...table, entryId: longsword });
  expect(versatile.dice.map((die) => die.sides)).toEqual([10]);
  expect(versatile.total).toBe(versatile.dice[0]!.value + 3);
  ({ revision: goblin.revision } = await gm.command<Command>(`POST ${goblin.path}/resources/hp/adjust`, { delta: -7, expectedRevision: goblin.revision }));
  expect((await sheetOf(goblin)).values.hp).toEqual({ current: 0, max: 7 });

  // The wizard spends a level 3 slot; a long rest restores it and the fighter's hit points in one command (S5).
  ({ revision: wizard.revision } = await dan.command<Command>(`POST ${wizard.path}/resources/slots_3/bump`, { direction: "down", expectedRevision: wizard.revision }));
  expect((await sheetOf(wizard)).values.slots_3).toEqual({ current: 1, max: 2 } satisfies Resource);
  await act(wizard, "long_rest");
  expect((await sheetOf(wizard)).values.slots_3).toEqual({ current: 2, max: 2 } satisfies Resource);
  // The dragon's Dexterity saving throw adds its +6 proficiency to a +0 modifier.
  const save = await act(dragon, "monster_check_dex", { audience: "gm_only", inputs: { saving_throw: true } });
  expect(save.total).toBe(d20(save)[0]! + 6);
  const deathSave = await act(fighter, "death_save", table);
  expect(deathSave.outcome!.id).toBe(deathSave.total === 20 ? "revive" : deathSave.total === 1 ? "two_failures" : deathSave.total >= 10 ? "success" : "failure");
  await act(fighter, "long_rest");
  expect((await sheetOf(fighter)).values.hp).toEqual({ current: 12, max: 12 });

  await phase("Level up and multiclass in play", { resetRateLimits: true });
  // A new fighter level is an edit of the class entry.
  ({ revision: fighter.revision } = await bob.command<Command>(`PATCH ${fighter.path}/entries/${fighter.classEntries[0]}`, {
    values: { level: 2 }, expectedRevision: fighter.revision,
  }));
  const levelled = await sheetOf(fighter, gm);
  expect(levelled.derivedValues).toMatchObject({ level: 2 });
  // A higher maximum does not heal; Action Surge appears and starts full.
  expect(levelled.values).toMatchObject({ hp: { current: 12, max: 20 }, hit_dice: { max: 2 } });
  const fighterLevels = levelled.entries.find((entry) => entry.entryId === fighter.classEntries[0])!;
  expect(fighterLevels.derivedValues).toMatchObject({ table: "action surges: 1; indomitable uses: 0; extra attacks: 0" });
  expect(fighterLevels.values).toMatchObject({ res2: { current: 1, max: 1 } });
  // The third level goes to rogue: one more entry, with its own class die.
  const rogueLevel = await place(fighter, "class_list", "class_levels", { class: "rogue", level: 1, first: false });
  const multiclassed = await sheetOf(fighter);
  expect(multiclassed.derivedValues).toMatchObject({ level: 3, proficiency_bonus: 2, save_str: 5, save_dex: 1 });
  expect(multiclassed.values).toMatchObject({ hp: { max: 27 }, hit_dice: { max: 3 } });
  expect(multiclassed.validations).toEqual([]);
  expect((await act(fighter, "class_roll", { entryId: rogueLevel, audience: "owner_only" })).dice.map((die) => die.sides)).toEqual([6]);
  expect((await act(fighter, "spend_hit_dice", { entryId: rogueLevel, audience: "owner_only", inputs: { count: 1 } })).dice.map((die) => die.sides)).toEqual([8]);
  const rolls = (await gm.json<{ events: Array<{ kind: string }> }>(`GET ${campaign}/activity?limit=100`)).events.filter((event) => event.kind === "roll_executed");
  // Fifteen rolls reach the table: three initiative, six goblin attacks, the damage roll, three longsword
  // attacks, the two-handed damage and the death save. The GM also sees the two GM-only rolls.
  expect(rolls).toHaveLength(17);
  // The fighter's player sees the table's rolls and the two private rolls of the new rogue level.
  expect((await bob.json<{ events: Array<{ kind: string }> }>(`GET ${campaign}/activity?limit=100`)).events.filter((event) => event.kind === "roll_executed")).toHaveLength(17);
  // Applying the damage roll is recorded in the fighter's activity.
  const applied = (await bob.json<{ events: Array<{ kind: string; payload: Record<string, unknown> }> }>(`GET ${fighter.path}/activity?limit=100`)).events
    .find((event) => event.kind === "character_roll_applied")!;
  expect(applied.payload).toMatchObject({ resourceId: "hp", rollId: damageRoll.rollId, direction: "subtract", delta: -cut.total });
}, 120_000);
