import { randomUUID } from "node:crypto";

import { expect } from "vitest";

import { knaveCharacter, knaveDocument } from "../fixtures/knave.js";
import { scenario, type ScenarioActor, type WriteRequest } from "./runner.js";

/**
 * One complete Knave campaign driven only through public API v1. Six
 * accounts each use their own token: a system creator, a GM and four
 * players. The system creator authors and publishes the rules; every
 * player builds a character; the GM prepares items and scenes, invites the
 * table and runs a session where every roll comes from a different account.
 */
type Sheet = {
  characterId: string; revision: number; name: string; ownerId: string | null;
  campaign: { campaignId: string; controllers: string[] } | null;
  values: Record<string, unknown>; derivedValues: Record<string, unknown>;
  entries: Array<{ entryId: string; templateId: string | null; slotId: string; values: Record<string, unknown>; quantity?: number;
    source?: { kind: string; templateId?: string } }>;
};
type Command = { characterId: string; revision: number; roll: { actionId: string; total: number; audience: string } | null };
type Scene = { sceneId: string; revision: number; fog: unknown[];
  tokens: Array<{ tokenId: string; label: string; x: number; y: number; visible: boolean; imageFileId: string | null }> };

const scopes = {
  creator: ["systems:read", "systems:write"],
  gm: ["systems:read", "characters:read", "characters:write", "campaigns:read", "campaigns:write"],
  player: ["characters:read", "characters:write", "campaigns:read", "campaigns:write"],
} as const;

const heroes = [
  { name: "Mara Flint", values: { ...knaveCharacter.initialValues } },
  { name: "Oswin Reed", values: { ...knaveCharacter.initialValues, strength: 3, dexterity: 2, charisma: 1, background: "Hedge knight" } },
  { name: "Tamsin Vale", values: { ...knaveCharacter.initialValues, intelligence: 3, wisdom: 3, strength: 1, background: "Lapsed acolyte" } },
  { name: "Brann Ashe", values: { ...knaveCharacter.initialValues, dexterity: 3, constitution: 2, hp: { current: 5, max: 5 }, background: "Poacher" } },
];

scenario("Knave: author rules, build four characters and play The Drowned Abbey", async ({ actor, phase, png }) => {
  const creator = await actor("cara", scopes.creator);
  const gm = await actor("ada", scopes.gm);
  const players = await Promise.all((["bob", "dan", "eve", "finn"] as const).map((name) => actor(name, scopes.player)));
  expect(new Set([creator, gm, ...players].map((entry) => entry.actorId)).size).toBe(6);

  await phase("Publish Knave");
  expect(await creator.json("POST /systems/validate", { document: knaveDocument })).toEqual({ valid: true, diagnostics: [] });
  const created = await creator.command<{ system: { systemId: string }; draft: { revision: number } }>("POST /systems", {
    name: knaveDocument.metadata.name,
  }, 201);
  const systemId = created.system.systemId;
  const saved = await creator.json<{ draft: { revision: number } }>(`PUT /systems/${systemId}/draft`, {
    expectedRevision: created.draft.revision, document: knaveDocument,
  });
  const daggerArt = await creator.command<{ revision: number; image: { fileId: string } }>(`PUT /systems/${systemId}/templates/dagger/image`, {
    description: "Dagger", contentType: "image/png", dataBase64: await png("#52636b"),
    expectedRevision: saved.draft.revision,
  });
  const { versionId } = await creator.command<{ versionId: string }>(`POST /systems/${systemId}/publish`, {
    expectedRevision: daggerArt.revision, semanticVersion: "1.0.0", releaseNotes: "Campaign edition",
  }, 201);
  expect(await creator.json(`PUT /systems/${systemId}/sharing`, { access: "link" })).toEqual({ systemId, access: "link" });
  // The creator only authors rules: no character or campaign scopes.
  await creator.status("GET /campaigns", 403);
  await gm.status(`GET /systems/${systemId}`, 404);

  await phase("Build four heroes", { resetRateLimits: true });
  const options = await players[0]!.json<{ entities: Array<{ id: string; slots: Array<{ id: string }> }>; templates: Array<{ id: string }> }>(`GET /characters/creation-options?systemVersionId=${versionId}`);
  expect(options.entities.map((entity) => entity.id)).toEqual(["knave"]);
  const sheets: Sheet[] = [];
  const daggers: string[] = [];
  for (const [index, player] of players.entries()) {
    const hero = heroes[index]!;
    let { characterId, revision } = await player.command<{ characterId: string; revision: number }>("POST /characters", {
      name: hero.name, systemVersionId: versionId, entityDefinitionId: "knave", initialValues: hero.values,
    }, 201);
    const daggerId = randomUUID();
    daggers.push(daggerId);
    ({ revision } = await player.command<Command>(`POST /characters/${characterId}/entries`, {
      entryId: daggerId, templateId: "dagger", slotId: "readied_gear", expectedRevision: revision,
    }));
    ({ revision } = await player.command<Command>(`POST /characters/${characterId}/entries`, {
      entryId: randomUUID(), templateId: index % 2 === 0 ? "rations" : "brigandine",
      slotId: index % 2 === 0 ? "pack" : "readied_gear", expectedRevision: revision,
    }));
    await player.command(`PUT /characters/${characterId}/portrait`, {
      description: `${hero.name} portrait`, contentType: "image/png", dataBase64: await png(["#a33", "#3a3", "#33a", "#aa3"][index]!),
      expectedCharacterRevision: revision, expectedPortraitRevision: 0,
    });
    const sheet = await player.json<Sheet>(`GET /characters/${characterId}`);
    expect(sheet).toMatchObject({ name: hero.name, ownerId: player.actorId, campaign: null, values: hero.values });
    expect(sheet.entries).toHaveLength(2);
    sheets.push(sheet);
  }
  // Standalone sheets stay private to their owners.
  await players[1]!.status(`GET /characters/${sheets[0]!.characterId}`, 404);
  await gm.status(`GET /characters/${sheets[0]!.characterId}`, 404);

  await phase("Prepare The Drowned Abbey", { resetRateLimits: true });
  const campaign = await gm.command<{ campaignId: string; revision: number }>("POST /campaigns", {
    systemVersionId: versionId, title: "The Drowned Abbey", description: "A Knave one-shot",
  }, 201);
  const campaignId = campaign.campaignId;
  const campaignPath = `/campaigns/${campaignId}` as const;
  const revisionOf = async (who: ScenarioActor = gm) => (await who.json<{ revision: number }>(`GET ${campaignPath}`)).revision;

  const lantern = await gm.command<{ templateId: string; revision: number }>(`POST ${campaignPath}/item-templates`, {
    kind: "item", content: { name: "Hooded lantern", description: "Burns for six turns.", defaultQuantity: 1 },
  }, 201);
  await gm.command(`PUT ${campaignPath}/item-templates/${lantern.templateId}/image`, {
    description: "Lantern", contentType: "image/png", dataBase64: await png("#e0b040"),
    expectedTemplateRevision: lantern.revision,
  });
  const key = await gm.command<{ templateId: string }>(`POST ${campaignPath}/item-templates`, {
    kind: "item", content: { name: "Abbey key", description: "Opens the crypt gate.", defaultQuantity: 1 },
  }, 201);
  const relic = await gm.command<{ templateId: string }>(`POST ${campaignPath}/item-templates`, {
    kind: "item", audience: "gm_only", content: { name: "Drowned relic", notes: "Cursed: -1 to saves." },
  }, 201);
  const silvered = await gm.command<{ templateId: string; content: { base?: { templateId: string } } }>(`POST ${campaignPath}/item-templates`, {
    kind: "item", baseTemplateId: "dagger", content: { name: "Silvered dagger" },
  }, 201);
  expect(silvered.content.base).toMatchObject({ templateId: "dagger", versionId });
  await gm.command(`POST ${campaignPath}/content`, {
    title: "Session zero", body: "The abbey flooded a century ago.", audience: "all_players", tags: ["lore"],
  }, 201);
  const secret = await gm.command<{ contentId: string }>(`POST ${campaignPath}/content`, {
    title: "The abbot lives", body: "He waits in the crypt.", audience: "gm_only",
  }, 201);

  const npc = await gm.command<Sheet>(`POST ${campaignPath}/characters`, {
    name: "Brother Silt", entityDefinitionId: "knave", initialValues: { ...knaveCharacter.initialValues, background: "Drowned monk" },
    expectedCampaignRevision: await revisionOf(),
  }, 201);
  expect(npc.campaign).toMatchObject({ campaignId, controllers: [] });

  const maps = [];
  for (const [name, color] of [["Abbey courtyard", "#335577"], ["Flooded crypt", "#112233"]] as const) {
    maps.push(await gm.command<{ fileId: string }>(`POST ${campaignPath}/images`, {
      name, contentType: "image/png", dataBase64: await png(color),
    }, 201));
  }
  const tokenArt = await gm.command<{ fileId: string }>(`POST ${campaignPath}/images`, {
    name: "Monk token", contentType: "image/png", dataBase64: await png("#777777"),
  }, 201);
  let courtyard = await gm.command<Scene>(`POST ${campaignPath}/scenes`, { backgroundFileId: maps[0]!.fileId }, 201);
  let crypt = await gm.command<Scene>(`POST ${campaignPath}/scenes`, { backgroundFileId: maps[1]!.fileId }, 201);
  const edit = (scene: Scene, line: WriteRequest, payload: object) => gm.command<Scene>(line, {
    ...payload, expectedSceneRevision: scene.revision,
  });
  courtyard = await edit(courtyard, `POST /scenes/${courtyard.sceneId}/fog-edits`, {
    op: { mode: "reveal", runs: [{ x: 0.2, y: 0.8, r: 0.25 }] },
  });
  crypt = await edit(crypt, `POST /scenes/${crypt.sceneId}/tokens`, {
    label: "Brother Silt", x: 0.8, y: 0.2, size: 0.08, visible: false, imageFileId: tokenArt.fileId,
  });
  expect((await gm.json<{ scenes: unknown[] }>(`GET ${campaignPath}/scenes`)).scenes).toHaveLength(2);

  await phase("Invite players and adopt sheets", { resetRateLimits: true });
  for (const [index, player] of players.entries()) {
    const invitation = await gm.command<{ token: string }>(`POST ${campaignPath}/invitations`, {
      intendedRole: "player", expectedCampaignRevision: await revisionOf(),
    }, 201);
    const review = await player.json<{ campaignTitle: string; invitationRevision: number; accessRevision: number }>("POST /invitations/review", { token: invitation.token });
    expect(review.campaignTitle).toBe("The Drowned Abbey");
    await player.command("POST /invitations/accept", {
      campaignId, token: invitation.token, expectedInvitationRevision: review.invitationRevision,
      reviewedAccessRevision: review.accessRevision,
    });
    const sheet = sheets[index]!;
    const adopted = await player.command<Sheet>(`POST ${campaignPath}/characters/${sheet.characterId}/adopt`, {
      expectedCampaignRevision: await revisionOf(player), expectedCharacterRevision: sheet.revision,
      acknowledgedDisclosure: true,
    });
    expect(adopted.campaign).toMatchObject({ campaignId, controllers: [player.actorId] });
    sheets[index] = adopted;
  }
  const members = await gm.json<{ members: Array<{ userId: string; role: string; displayName: string | null }> }>(`GET ${campaignPath}/members`);
  expect(members.members.map((member) => member.displayName).sort()).toEqual(["Ada", "Bob", "Dan", "Eve", "Finn"]);
  const roster = await gm.json<{ characters: Array<{ characterId: string }> }>(`GET ${campaignPath}/characters`);
  expect(roster.characters).toHaveLength(5);
  // Players see their own sheet and the shared lore, nothing else.
  for (const [index, player] of players.entries()) {
    const own = await player.json<{ characters: Array<{ characterId: string }> }>(`GET ${campaignPath}/characters`);
    expect(own.characters.map((character) => character.characterId)).toEqual([sheets[index]!.characterId]);
    await player.status(`GET /characters/${sheets[(index + 1) % 4]!.characterId}`, 404);
    await player.status(`GET /content/${secret.contentId}`, 404);
    const notes = await player.json<{ content: Array<{ title: string }> }>(`GET ${campaignPath}/content`);
    expect(notes.content.map((note) => note.title)).toEqual(["Session zero"]);
    const visible = await player.json<{ templates: Array<{ templateId: string }> }>(`GET ${campaignPath}/item-templates`);
    expect(visible.templates.map((template) => template.templateId)).not.toContain(relic.templateId);
  }

  await phase("Play the session", { resetRateLimits: true });
  for (const [index, sheet] of sheets.entries()) {
    courtyard = await edit(courtyard, `POST /scenes/${courtyard.sceneId}/tokens`, {
      label: sheet.name, x: 0.1 + index * 0.05, y: 0.85, size: 0.06, visible: true, imageFileId: null,
    });
  }
  courtyard = await edit(courtyard, `POST /scenes/${courtyard.sceneId}/tokens`, {
    label: "Lurking eel", x: 0.5, y: 0.5, size: 0.1, visible: false, imageFileId: tokenArt.fileId,
  });
  expect(courtyard.tokens.filter((token) => token.visible)).toHaveLength(4);
  // Only the GM manages scenes; players cannot read or move tokens.
  const mara = courtyard.tokens.find((token) => token.label === "Mara Flint")!;
  await players[0]!.status(`GET /scenes/${courtyard.sceneId}`, 404);
  await players[0]!.status(`PATCH /scenes/${courtyard.sceneId}/tokens/${mara.tokenId}`, 404, {
    x: 0.9, y: 0.9, expectedSceneRevision: courtyard.revision, idempotencyKey: randomUUID(),
  });

  // Initiative: every player rolls for their own hero, the GM for the NPC.
  const rolls: Array<{ by: ScenarioActor; command: Command }> = [];
  const roll = async (who: ScenarioActor, index: number | "npc", actionId: string, extra: object = {}) => {
    const sheet = index === "npc" ? npc : sheets[index]!;
    const command = await who.command<Command>(`POST /characters/${sheet.characterId}/actions/${actionId}`, {
      inputs: {}, expectedRevision: sheet.revision, ...extra,
    });
    expect(command.roll).toMatchObject({ actionId });
    if (index === "npc") npc.revision = command.revision; else sheets[index]!.revision = command.revision;
    rolls.push({ by: who, command });
    return command;
  };
  for (const [index, player] of players.entries()) await roll(player, index, "initiative", { audience: "campaign" });
  await roll(gm, "npc", "initiative", { audience: "campaign" });
  expect(new Set(rolls.map((entry) => entry.by.actorId)).size).toBe(5);
  // A player cannot roll for another player's character.
  await players[1]!.status(`POST /characters/${sheets[0]!.characterId}/actions/melee`, 404, {
    inputs: {}, expectedRevision: sheets[0]!.revision, idempotencyKey: randomUUID(),
  });

  // The party advances; the GM moves tokens and reveals the path.
  for (const token of courtyard.tokens.filter((entry) => entry.visible)) {
    courtyard = await edit(courtyard, `PATCH /scenes/${courtyard.sceneId}/tokens/${token.tokenId}`, { x: token.x + 0.2, y: 0.6 });
  }
  courtyard = await edit(courtyard, `POST /scenes/${courtyard.sceneId}/fog-edits`, {
    op: { mode: "reveal", runs: [{ x: 0.4, y: 0.6, r: 0.2 }, { x: 0.5, y: 0.5, r: 0.15 }] },
  });
  expect(courtyard.tokens.find((token) => token.label === "Mara Flint")).toMatchObject({ y: 0.6 });
  expect(courtyard.fog).toHaveLength(2);

  // Combat: each account makes a different roll.
  await roll(players[0]!, 0, "melee", { audience: "campaign" });
  await roll(players[1]!, 1, "save_strength", { audience: "campaign" });
  await roll(players[2]!, 2, "save_wisdom", { audience: "gm_only" });
  await roll(players[3]!, 3, "dagger_damage", { audience: "campaign", entryId: daggers[3] });
  await roll(gm, "npc", "morale", { audience: "gm_only" });
  // The eel bites: the GM lowers Mara's hit points on her attached sheet.
  const bitten = await gm.command<Command>(`POST /characters/${sheets[0]!.characterId}/resources/hp/bump`, {
    direction: "down", expectedRevision: sheets[0]!.revision,
  });
  sheets[0]!.revision = bitten.revision;
  courtyard = await edit(courtyard, `DELETE /scenes/${courtyard.sceneId}/tokens/${courtyard.tokens.find((t) => t.label === "Lurking eel")!.tokenId}`, {});

  // Loot: players take campaign items from the catalog the browser offers.
  const placeCampaignItem = async (who: ScenarioActor, index: number, templateId: string) => {
    const sheet = sheets[index]!;
    const catalog = await who.json<{ templates: Array<{ source?: { kind: string; templateId?: string } }> }>(`GET /characters/${sheet.characterId}/templates`);
    const choice = catalog.templates.find((entry) => entry.source?.kind === "campaign" && entry.source.templateId === templateId);
    expect(choice, `${templateId} offered to ${who.name}`).toBeDefined();
    const placed = await who.command<Command>(`POST /characters/${sheet.characterId}/entries`, {
      entryId: randomUUID(), slotId: "pack", templateId: null, source: choice!.source,
      expectedRevision: sheet.revision,
    });
    sheet.revision = placed.revision;
  };
  await placeCampaignItem(players[0]!, 0, lantern.templateId);
  await placeCampaignItem(players[1]!, 1, silvered.templateId);
  // The GM hands the abbey key to Tamsin.
  await placeCampaignItem(gm, 2, key.templateId);
  // GM-only items are never offered to a player sheet.
  const tamsinCatalog = await players[2]!.json<{ templates: Array<{ source?: { templateId?: string } }> }>(`GET /characters/${sheets[2]!.characterId}/templates`);
  expect(tamsinCatalog.templates.map((entry) => entry.source?.templateId)).not.toContain(relic.templateId);

  // Brann suggests an item; the GM approves it and Brann picks it up.
  const proposal = await players[3]!.command<{ proposalId: string; revision: number }>(`POST ${campaignPath}/item-proposals`, {
    kind: "item", content: { name: "Eel-skin cloak", description: "Slick and waterproof." },
  }, 201);
  const decision = await gm.command<{ template: { templateId: string } }>(`POST ${campaignPath}/item-proposals/${proposal.proposalId}/approve`, {
    expectedProposalRevision: proposal.revision,
  });
  await placeCampaignItem(players[3]!, 3, decision.template.templateId);

  // Into the crypt: new background art, the hidden NPC token, last rolls.
  crypt = await edit(crypt, `POST /scenes/${crypt.sceneId}/fog-edits`, { op: { mode: "reveal", runs: [{ x: 0.5, y: 0.5, r: 0.5 }] } });
  for (const sheet of sheets) {
    crypt = await edit(crypt, `POST /scenes/${crypt.sceneId}/tokens`, {
      label: sheet.name, x: 0.2, y: 0.8, size: 0.06, visible: true, imageFileId: null,
    });
  }
  const silt = crypt.tokens.find((token) => token.label === "Brother Silt")!;
  crypt = await edit(crypt, `PATCH /scenes/${crypt.sceneId}/tokens/${silt.tokenId}`, { x: 0.5, y: 0.4 });
  expect(crypt.tokens).toHaveLength(5);
  await roll(players[0]!, 0, "overnight_healing", { audience: "owner_only" });
  await roll(players[1]!, 1, "reaction", { audience: "campaign" });
  await roll(players[2]!, 2, "save_intelligence", { audience: "campaign" });
  await roll(players[3]!, 3, "ranged", { audience: "campaign" });
  await roll(gm, "npc", "reaction", { audience: "campaign" });

  await phase("Verify sheets, visibility and export", { resetRateLimits: true });
  const names = (sheet: Sheet) => sheet.entries.map((entry) => entry.values.name ?? entry.templateId).sort();
  const final = await Promise.all(players.map((player, index) => player.json<Sheet>(`GET /characters/${sheets[index]!.characterId}`)));
  expect(names(final[0]!)).toEqual(["Hooded lantern", "dagger", "rations"].sort());
  expect(final[0]!.values.hp).toEqual({ current: 5, max: 6 });
  expect(final[1]!.entries.find((entry) => entry.source?.templateId === silvered.templateId)).toMatchObject({ slotId: "pack" });
  expect(names(final[2]!)).toContain("Abbey key");
  expect(names(final[3]!)).toContain("Eel-skin cloak");
  for (const sheet of final) {
    expect(sheet.entries.filter((entry) => entry.source?.kind === "campaign").every((entry) => entry.templateId === null)).toBe(true);
  }
  // The GM sees every sheet exactly as its controller does.
  for (const sheet of final) expect(await gm.json<Sheet>(`GET /characters/${sheet.characterId}`)).toEqual(sheet);

  type Activity = { events: Array<{ kind: string; actorId: string; sourceRollId: string | null }> };
  const rollEvents = (activity: Activity) => activity.events.filter((event) => event.kind === "roll_executed");
  const gmFeed = rollEvents(await gm.json<Activity>(`GET ${campaignPath}/activity?limit=100`));
  // Every roll except the owner-only healing roll reaches the GM, from five accounts.
  expect(gmFeed).toHaveLength(rolls.length - 1);
  expect(new Set(gmFeed.map((event) => event.actorId))).toEqual(new Set([gm, ...players].map((who) => who.actorId)));
  // Players see campaign-audience rolls plus all of their own, never others' GM-only rolls.
  for (const player of players) {
    const feed = rollEvents(await player.json<Activity>(`GET ${campaignPath}/activity?limit=100`));
    const expected = rolls.filter(({ by, command }) => command.roll!.audience === "campaign" || by.actorId === player.actorId).length;
    expect(feed.filter((event) => event.sourceRollId !== null), `${player.name} feed`).toHaveLength(expected);
  }
  // Brann's character activity shows the GM his three rolls, including the dagger's granted action.
  const brannActivity = await gm.json<{ events: Array<{ kind: string; rollId: string | null }> }>(`GET /characters/${sheets[3]!.characterId}/activity?limit=100`);
  expect(brannActivity.events.filter((event) => event.rollId !== null))
    .toHaveLength(rolls.filter(({ by }) => by.actorId === players[3]!.actorId).length);

  const exported = await gm.command<{ campaign: { title: string }; members: unknown[]; templates: Array<{ templateId: string }>; rolls: Array<{ actorId: string }> }>(`POST ${campaignPath}/exports`, {});
  expect(exported.campaign.title).toBe("The Drowned Abbey");
  expect(exported.members).toHaveLength(5);
  expect(exported.templates.map((template) => template.templateId)).toEqual(expect.arrayContaining([
    lantern.templateId, key.templateId, relic.templateId, silvered.templateId, decision.template.templateId,
  ]));
  expect(new Set(exported.rolls.map((entry) => entry.actorId)).size).toBe(5);

  const archived = await gm.command(`POST ${campaignPath}/archive`, { expectedCampaignRevision: await revisionOf() });
  expect(archived).toMatchObject({ status: "archived" });
  await players[0]!.status(`POST /characters/${sheets[0]!.characterId}/actions/melee`, 409, {
    inputs: {}, expectedRevision: final[0]!.revision, idempotencyKey: randomUUID(),
  });
});
