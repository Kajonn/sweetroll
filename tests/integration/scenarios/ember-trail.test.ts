import { randomUUID } from "node:crypto";

import { expect } from "vitest";

import { emberTrailDocument } from "../fixtures/ember-trail/document.js";
import { scenario, type ScenarioActor } from "./runner.js";

/**
 * Ember Trail, an original test system, authored, published and played only
 * through public API v1. It covers the rules features of the SRD gaps plan
 * (2026-11-16) end to end: shared weapon formulas (S1), rules tables (S2),
 * beast presets (S3), start-full resources (S4), a camp batch (S5), applying
 * a roll (S6), attacks on either kind of target or none (S7), one group per
 * branch (S8), hidden sheet parts (S9), beasts only in campaigns (S10) and
 * path resources calculated from stored fields (S11).
 */
type Resource = { current: number; max: number };
type Sheet = {
  characterId: string; revision: number; values: Record<string, unknown>; derivedValues: Record<string, number | string | boolean>;
  entries: Array<{ entryId: string; templateId: string | null; values: Record<string, unknown>; derivedValues?: Record<string, number | string> }>;
};
type Die = { sides: number; value: number; groupId: string };
type Roll = { total: number; output: string; dice: Die[]; outcome?: { id: string }; details?: Array<{ id: string; value: number }> };
type Command = { characterId: string; revision: number; roll: Roll | null };
type Hero = { owner: ScenarioActor; path: `/characters/${string}`; characterId: string; revision: number };

const scopes = {
  author: ["systems:read", "systems:write"],
  gm: ["systems:read", "characters:read", "characters:write", "campaigns:read", "campaigns:write"],
  player: ["characters:read", "characters:write", "campaigns:read", "campaigns:write"],
} as const;
const d20 = (roll: Roll) => roll.dice.filter((die) => die.groupId === "d20").map((die) => die.value);
const grade = (roll: Roll, guard: number) => d20(roll)[0] === 20 ? "blaze" : roll.total >= guard ? "hit" : "miss";

scenario("Ember Trail: publish, build two heroes and fight a wolf", async ({ actor, phase }) => {
  const author = await actor("cara", scopes.author);
  const gm = await actor("ada", scopes.gm);
  const bob = await actor("bob", scopes.player);
  const dan = await actor("dan", scopes.player);

  await phase("Publish the rules");
  expect(await author.json("POST /systems/validate", { document: emberTrailDocument })).toEqual({ valid: true, diagnostics: [] });
  const created = await author.command<{ system: { systemId: string }; draft: { revision: number } }>("POST /systems", { name: "Ember Trail" }, 201);
  const system = `/systems/${created.system.systemId}` as const;
  const saved = await author.json<{ draft: { revision: number } }>(`PUT ${system}/draft`, { document: emberTrailDocument, expectedRevision: created.draft.revision });
  const { versionId } = await author.command<{ versionId: string }>(`POST ${system}/publish`, {
    expectedRevision: saved.draft.revision, semanticVersion: "1.0.0", releaseNotes: "First trail",
  }, 201);
  await author.json(`PUT ${system}/sharing`, { access: "link" });
  const exported = await author.json(`GET /system-versions/${versionId}/export`);
  await author.command("POST /systems", { source: { kind: "import", content: JSON.stringify(exported) } }, 201);

  const sheetOf = (hero: Hero, reader: ScenarioActor = hero.owner) => reader.json<Sheet>(`GET ${hero.path}`);
  const place = async (hero: Hero, slotId: string, templateId: string, values?: Record<string, unknown>) => {
    const entryId = randomUUID();
    const placed = await hero.owner.command<Command>(`POST ${hero.path}/entries`, {
      entryId, slotId, templateId, expectedRevision: hero.revision, ...(values === undefined ? {} : { values }),
    });
    hero.revision = placed.revision;
    return entryId;
  };
  const act = async (hero: Hero, actionId: string, body: object = {}, who: ScenarioActor = hero.owner): Promise<Roll> => {
    const command = await who.command<Command>(`POST ${hero.path}/actions/${actionId}`, { inputs: {}, expectedRevision: hero.revision, ...body });
    hero.revision = command.revision;
    return command.roll!;
  };
  const build = async (owner: ScenarioActor, name: string, initialValues: Record<string, unknown>): Promise<Hero> => {
    const { characterId, revision } = await owner.command<{ characterId: string; revision: number }>("POST /characters", {
      name, systemVersionId: versionId, entityDefinitionId: "hero", initialValues,
    }, 201);
    return { owner, characterId, revision, path: `/characters/${characterId}` };
  };

  await phase("Build two heroes");
  const warden = await build(bob, "Rook", { might: 3, grace: 1 });
  // Without a path the hero has no level, so health and grit are 0 and stay hidden.
  expect((await sheetOf(warden)).values).toMatchObject({ hp: { current: 0, max: 0 }, grit: { current: 0, max: 0 } });
  // A path is an entry: health rises from 0 and starts full (S4); the knack's uses come from rank + stored Grace (S11).
  const wardenPath = await place(warden, "path_list", "path", { path: "warden", rank: 2 });
  let sheet = await sheetOf(warden);
  expect(sheet.derivedValues).toMatchObject({ level: 2, guard: 11 });
  expect(sheet.values).toMatchObject({ hp: { current: 12, max: 12 }, grit: { current: 2, max: 2 } });
  expect(sheet.entries.find((entry) => entry.entryId === wardenPath)).toMatchObject({
    values: { knack_uses: { current: 3, max: 3 } }, derivedValues: { hp: 8, knack: "Stand firm" },
  });
  // Two weapons are their own templates sharing one strike and one damage formula (S1).
  const hatchet = await place(warden, "gear", "hatchet");
  const spear = await place(warden, "gear", "spear");
  await place(warden, "gear", "leather");
  expect((await sheetOf(warden)).derivedValues.guard).toBe(13);

  const scout = await build(dan, "Wren", { might: 1, grace: 3 });
  await place(scout, "path_list", "path", { path: "scout", rank: 1 });
  expect((await sheetOf(scout)).values).toMatchObject({ hp: { current: 6, max: 6 } });

  await phase("Gather at the camp");
  const { campaignId } = await gm.command<{ campaignId: string }>("POST /campaigns", { systemVersionId: versionId, title: "Ash road" }, 201);
  const campaign = `/campaigns/${campaignId}` as const;
  const revisionOf = async (who: ScenarioActor = gm) => (await who.json<{ revision: number }>(`GET ${campaign}`)).revision;
  // A beast is the GM's campaign character, made from a preset (S3); a player cannot create one alone (S10).
  const wolfSheet = await gm.command<Sheet>(`POST ${campaign}/characters`, {
    name: "Ash wolf", entityDefinitionId: "beast", presetId: "ash_wolf", expectedCampaignRevision: await revisionOf(),
  }, 201);
  const wolf: Hero = { owner: gm, characterId: wolfSheet.characterId, revision: wolfSheet.revision, path: `/characters/${wolfSheet.characterId}` };
  expect((await sheetOf(wolf)).values).toMatchObject({ guard: 12, hp: { current: 6, max: 6 }, bite_die: 6, bite_bonus: 2 });
  await bob.status("POST /characters", 422, {
    name: "Pet wolf", systemVersionId: versionId, entityDefinitionId: "beast", presetId: "ash_wolf", idempotencyKey: randomUUID(),
  });
  // Rules tables are readable by anyone who may use the version or read the sheet (S2).
  const tables = await bob.json<{ datasets: Array<{ datasetId: string }> }>(`GET ${warden.path}/reference-data`);
  expect(tables.datasets.map((dataset) => dataset.datasetId)).toEqual(expect.arrayContaining(["paths", "bestiary", "lore"]));
  const lore = await dan.json<{ dataset: { records: Array<{ id: string; values: { description: string } }> } }>(`GET /system-versions/${versionId}/reference-data/lore`);
  expect(lore.dataset.records.find((record) => record.id === "camp")!.values.description).toContain("grit");
  await dan.status(`GET ${warden.path}/reference-data`, 404);

  for (const hero of [warden, scout]) {
    const invitation = await gm.command<{ token: string }>(`POST ${campaign}/invitations`, { intendedRole: "player", expectedCampaignRevision: await revisionOf() }, 201);
    const review = await hero.owner.json<{ invitationRevision: number; accessRevision: number }>("POST /invitations/review", { token: invitation.token });
    await hero.owner.command("POST /invitations/accept", {
      campaignId, token: invitation.token, expectedInvitationRevision: review.invitationRevision, reviewedAccessRevision: review.accessRevision,
    });
    const adopted = await hero.owner.command<Sheet>(`POST ${campaign}/characters/${hero.characterId}/adopt`, {
      expectedCampaignRevision: await revisionOf(hero.owner), expectedCharacterRevision: hero.revision, acknowledgedDisclosure: true,
    });
    hero.revision = adopted.revision;
  }

  await phase("Fight the wolf");
  const table = { audience: "campaign" };
  // The wolf bites the warden (guard 13): graded by the server against the target (S7).
  const bite = await act(wolf, "bite", { ...table, targetCharacterId: warden.characterId });
  expect(bite.total).toBe(d20(bite)[0]! + 2);
  expect(bite.details).toEqual([expect.objectContaining({ id: "guard", value: 13 })]);
  expect(bite.outcome!.id).toBe(grade(bite, 13));
  // With an edge the hero rolls two d20s and keeps the higher; with a snag, the lower (S8).
  const edged = await act(warden, "test_might", { ...table, inputs: { edge: true } });
  expect(d20(edged)).toHaveLength(2);
  expect(edged.total).toBe(Math.max(...d20(edged)) + 3);
  const snagged = await act(warden, "test_might", { ...table, inputs: { snag: true } });
  expect(snagged.total).toBe(Math.min(...d20(snagged)) + 3);
  // Both weapons strike with the shared formula; the spear's damage uses its own die (S1).
  const swing = await act(warden, "w_strike", { ...table, entryId: hatchet, targetCharacterId: wolf.characterId });
  expect(swing.total).toBe(d20(swing)[0]! + 3);
  expect(swing.outcome!.id).toBe(grade(swing, 12));
  const thrust = await act(warden, "w_strike", { ...table, entryId: spear, targetCharacterId: scout.characterId });
  expect(thrust.details).toEqual([expect.objectContaining({ id: "guard", value: 13 })]);
  expect(thrust.outcome!.id).toBe(grade(thrust, 13));
  const untargeted = await act(warden, "w_strike", { ...table, entryId: spear });
  expect(untargeted.details).toBeUndefined();
  expect(untargeted.outcome!.id).toBe(d20(untargeted)[0] === 20 ? "blaze" : "compare");
  const wound = await act(warden, "damage", { ...table, entryId: spear });
  expect(wound.dice.map((die) => die.sides)).toEqual([8]);
  expect(wound.total).toBe(wound.dice[0]!.value + 3);

  // Rolls never change sheets on their own: the GM applies the bite's damage to the warden (S6).
  const chomp = await act(wolf, "bite_damage", table);
  const applicable = await gm.json<{ rolls: Array<{ rollId: string; output: string }> }>(`GET ${warden.path}/applicable-rolls`);
  const damageRoll = applicable.rolls.find((candidate) => candidate.output === chomp.output)!;
  ({ revision: warden.revision } = await gm.command<Command>(`POST ${warden.path}/resources/hp/apply-roll`, {
    rollId: damageRoll.rollId, direction: "subtract", expectedRevision: warden.revision,
  }));
  expect((await sheetOf(warden)).values.hp).toEqual({ current: 12 - chomp.total, max: 12 } satisfies Resource);
  // The down section is shown only while health is 0 (S9). The API returns the
  // values either way; the flag that drives the section is a computed field.
  expect((await sheetOf(warden)).derivedValues.down).toBe(false);
  ({ revision: warden.revision } = await bob.command<Command>(`POST ${warden.path}/resources/hp/adjust`, { delta: -20, expectedRevision: warden.revision }));
  expect((await sheetOf(warden)).derivedValues.down).toBe(true);

  // Making camp restores health and grit in one command (S5).
  await act(warden, "spend_grit");
  await act(warden, "camp");
  expect((await sheetOf(warden)).values).toMatchObject({ hp: { current: 12, max: 12 }, grit: { current: 2, max: 2 } });

  await phase("Take a second path");
  // A higher rank raises the maximum without filling it; a second path is one more entry.
  ({ revision: warden.revision } = await bob.command<Command>(`PATCH ${warden.path}/entries/${wardenPath}`, { values: { rank: 3 }, expectedRevision: warden.revision }));
  sheet = await sheetOf(warden, gm);
  expect(sheet.values.hp).toEqual({ current: 12, max: 16 });
  expect(sheet.entries.find((entry) => entry.entryId === wardenPath)!.values.knack_uses).toEqual({ current: 3, max: 4 });
  await place(warden, "path_list", "path", { path: "scout", rank: 1 });
  expect((await sheetOf(warden)).derivedValues.level).toBe(4);
  expect((await sheetOf(warden)).values.hp).toEqual({ current: 12, max: 18 });
}, 60_000);
