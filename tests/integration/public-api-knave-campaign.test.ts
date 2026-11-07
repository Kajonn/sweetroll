import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { knaveCharacter, knaveDocument } from "./fixtures/knave.js";
import { buildI6Harness, type I6Harness } from "./i6-app.js";

/**
 * One complete Knave campaign driven only through public API v1. Six
 * accounts each use their own token: a system creator, a GM and four
 * players. The system creator authors and publishes the rules; every
 * player builds a character; the GM prepares items and scenes, invites the
 * table and runs a session where every roll comes from a different account.
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
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
type Account = { name: string; actorId: string; token: string };

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

describe.skipIf(!databaseUrl)("Knave campaign through public API v1 with six accounts", () => {
  let h: I6Harness;
  let mediaDir: string;
  let displayDir: string;
  let png: (color: string) => Promise<string>;
  let creator: Account;
  let gm: Account;
  let players: Account[];

  beforeAll(async () => {
    mediaDir = await mkdtemp(join(tmpdir(), "sweetroll-knave-campaign-media-"));
    displayDir = await mkdtemp(join(tmpdir(), "sweetroll-knave-campaign-display-"));
    process.env.SWEETROLL_MEDIA_DIR = mediaDir;
    process.env.SWEETROLL_DISPLAY_DIR = displayDir;
    h = await buildI6Harness({ publicApi: true });
    png = async (color) => (await sharp({ create: { width: 48, height: 32, channels: 3, background: color } })
      .png().toBuffer()).toString("base64");

    const signIn = async (code: string) => {
      const response = await h.app.inject({ method: "POST", url: "/dev/signin", payload: { code, redirectUri: "http://localhost/cb" } });
      expect(response.statusCode, response.body).toBe(200);
      const header = response.headers["set-cookie"];
      const cookie = (Array.isArray(header) ? header[0] : header ?? "").split(";")[0] ?? "";
      return { actorId: response.json<{ userId: string }>().userId, cookie };
    };
    const account = async (name: string, actor: { actorId: string; cookie: string }, requested: readonly string[]) => {
      const issued = await h.app.inject({
        method: "POST", url: "/me/personal-tokens",
        headers: { cookie: actor.cookie, origin: "http://localhost", host: "localhost" },
        payload: { label: `${name} script`, scopes: requested, expiresInDays: 1 },
      });
      expect(issued.statusCode, issued.body).toBe(201);
      return { name, actorId: actor.actorId, token: issued.json<{ token: string }>().token };
    };
    creator = await account("Creator", h.users.other, scopes.creator);
    gm = await account("GM", h.users.gm, scopes.gm);
    players = [
      await account("Bob", h.users.player, scopes.player),
      await account("Dan", h.users.outsider, scopes.player),
      await account("Eve", await signIn("code-eve"), scopes.player),
      await account("Finn", await signIn("code-finn"), scopes.player),
    ];
    expect(new Set([creator, gm, ...players].map((entry) => entry.actorId)).size).toBe(6);
  });

  afterAll(async () => {
    await h?.close();
    delete process.env.SWEETROLL_MEDIA_DIR;
    delete process.env.SWEETROLL_DISPLAY_DIR;
    if (mediaDir) await rm(mediaDir, { recursive: true, force: true });
    if (displayDir) await rm(displayDir, { recursive: true, force: true });
  });

  function call(who: Account, method: Method, path: string, payload?: object) {
    return h.app.inject({
      method, url: `/api/v1${path}`, headers: { authorization: `Bearer ${who.token}` }, ...(payload ? { payload } : {}),
    });
  }

  async function api<T = Record<string, unknown>>(who: Account, method: Method, path: string, payload?: object, status?: number) {
    const response = await call(who, method, path, payload);
    const expected = status ?? (method === "POST" && response.statusCode === 201 ? 201 : 200);
    expect(response.statusCode, `${who.name} ${method} ${path}: ${response.body}`).toBe(expected);
    return response.json<T>();
  }

  /** Each phase is a separate script run; the per-account minute quota restarts. */
  async function nextPhase() {
    await h.pool.query("DELETE FROM public_api_rate_limits");
  }

  it("authors Knave, builds four characters, prepares a campaign and plays a session", async () => {
    // ---------------------------------------------------------------------
    // 1. The system creator authors, illustrates, publishes and shares Knave.
    // ---------------------------------------------------------------------
    expect(await api(creator, "POST", "/systems/validate", { document: knaveDocument })).toEqual({ valid: true, diagnostics: [] });
    const created = await api<{ system: { systemId: string }; draft: { revision: number } }>(creator, "POST", "/systems", {
      name: knaveDocument.metadata.name, idempotencyKey: randomUUID(),
    }, 201);
    const systemId = created.system.systemId;
    const saved = await api<{ draft: { revision: number } }>(creator, "PUT", `/systems/${systemId}/draft`, {
      expectedRevision: created.draft.revision, document: knaveDocument,
    });
    const daggerArt = await api<{ revision: number; image: { fileId: string } }>(creator, "PUT", `/systems/${systemId}/templates/dagger/image`, {
      description: "Dagger", contentType: "image/png", dataBase64: await png("#52636b"),
      expectedRevision: saved.draft.revision, idempotencyKey: randomUUID(),
    });
    const { versionId } = await api<{ versionId: string }>(creator, "POST", `/systems/${systemId}/publish`, {
      expectedRevision: daggerArt.revision, semanticVersion: "1.0.0", releaseNotes: "Campaign edition", idempotencyKey: randomUUID(),
    }, 201);
    expect(await api(creator, "PUT", `/systems/${systemId}/sharing`, { access: "link" })).toEqual({ systemId, access: "link" });
    // The creator only authors rules: no character or campaign scopes.
    expect((await call(creator, "GET", "/campaigns")).statusCode).toBe(403);
    expect((await call(gm, "GET", `/systems/${systemId}`)).statusCode).toBe(404);

    // ---------------------------------------------------------------------
    // 2. Four players each build and equip a standalone Knave.
    // ---------------------------------------------------------------------
    await nextPhase();
    const options = await api<{ entities: Array<{ id: string; slots: Array<{ id: string }> }>; templates: Array<{ id: string }> }>(
      players[0]!, "GET", `/characters/creation-options?systemVersionId=${versionId}`);
    expect(options.entities.map((entity) => entity.id)).toEqual(["knave"]);
    const sheets: Sheet[] = [];
    const daggers: string[] = [];
    for (const [index, player] of players.entries()) {
      const hero = heroes[index]!;
      let { characterId, revision } = await api<{ characterId: string; revision: number }>(player, "POST", "/characters", {
        name: hero.name, systemVersionId: versionId, entityDefinitionId: "knave", initialValues: hero.values, idempotencyKey: randomUUID(),
      }, 201);
      const daggerId = randomUUID();
      daggers.push(daggerId);
      ({ revision } = await api<Command>(player, "POST", `/characters/${characterId}/entries`, {
        entryId: daggerId, templateId: "dagger", slotId: "readied_gear", expectedRevision: revision, idempotencyKey: randomUUID(),
      }));
      ({ revision } = await api<Command>(player, "POST", `/characters/${characterId}/entries`, {
        entryId: randomUUID(), templateId: index % 2 === 0 ? "rations" : "brigandine",
        slotId: index % 2 === 0 ? "pack" : "readied_gear", expectedRevision: revision, idempotencyKey: randomUUID(),
      }));
      await api(player, "PUT", `/characters/${characterId}/portrait`, {
        description: `${hero.name} portrait`, contentType: "image/png", dataBase64: await png(["#a33", "#3a3", "#33a", "#aa3"][index]!),
        expectedCharacterRevision: revision, expectedPortraitRevision: 0, idempotencyKey: randomUUID(),
      });
      const sheet = await api<Sheet>(player, "GET", `/characters/${characterId}`);
      expect(sheet).toMatchObject({ name: hero.name, ownerId: player.actorId, campaign: null, values: hero.values });
      expect(sheet.entries).toHaveLength(2);
      sheets.push(sheet);
    }
    // Standalone sheets stay private to their owners.
    expect((await call(players[1]!, "GET", `/characters/${sheets[0]!.characterId}`)).statusCode).toBe(404);
    expect((await call(gm, "GET", `/characters/${sheets[0]!.characterId}`)).statusCode).toBe(404);

    // ---------------------------------------------------------------------
    // 3. The GM prepares the campaign: notes, items, an NPC and two scenes.
    // ---------------------------------------------------------------------
    await nextPhase();
    let campaign = await api<{ campaignId: string; revision: number }>(gm, "POST", "/campaigns", {
      systemVersionId: versionId, title: "The Drowned Abbey", description: "A Knave one-shot", idempotencyKey: randomUUID(),
    }, 201);
    const campaignId = campaign.campaignId;
    const campaignPath = `/campaigns/${campaignId}`;
    const revisionOf = async (who: Account = gm) => (await api<{ revision: number }>(who, "GET", campaignPath)).revision;

    const lantern = await api<{ templateId: string; revision: number }>(gm, "POST", `${campaignPath}/item-templates`, {
      kind: "item", content: { name: "Hooded lantern", description: "Burns for six turns.", defaultQuantity: 1 }, idempotencyKey: randomUUID(),
    }, 201);
    await api(gm, "PUT", `${campaignPath}/item-templates/${lantern.templateId}/image`, {
      description: "Lantern", contentType: "image/png", dataBase64: await png("#e0b040"),
      expectedTemplateRevision: lantern.revision, idempotencyKey: randomUUID(),
    });
    const key = await api<{ templateId: string }>(gm, "POST", `${campaignPath}/item-templates`, {
      kind: "item", content: { name: "Abbey key", description: "Opens the crypt gate.", defaultQuantity: 1 }, idempotencyKey: randomUUID(),
    }, 201);
    const relic = await api<{ templateId: string }>(gm, "POST", `${campaignPath}/item-templates`, {
      kind: "item", audience: "gm_only", content: { name: "Drowned relic", notes: "Cursed: -1 to saves." }, idempotencyKey: randomUUID(),
    }, 201);
    const silvered = await api<{ templateId: string; content: { base?: { templateId: string } } }>(gm, "POST", `${campaignPath}/item-templates`, {
      kind: "item", baseTemplateId: "dagger", content: { name: "Silvered dagger" }, idempotencyKey: randomUUID(),
    }, 201);
    expect(silvered.content.base).toMatchObject({ templateId: "dagger", versionId });
    await api(gm, "POST", `${campaignPath}/content`, {
      title: "Session zero", body: "The abbey flooded a century ago.", audience: "all_players", tags: ["lore"], idempotencyKey: randomUUID(),
    }, 201);
    const secret = await api<{ contentId: string }>(gm, "POST", `${campaignPath}/content`, {
      title: "The abbot lives", body: "He waits in the crypt.", audience: "gm_only", idempotencyKey: randomUUID(),
    }, 201);

    const npc = await api<Sheet>(gm, "POST", `${campaignPath}/characters`, {
      name: "Brother Silt", entityDefinitionId: "knave", initialValues: { ...knaveCharacter.initialValues, background: "Drowned monk" },
      expectedCampaignRevision: await revisionOf(), idempotencyKey: randomUUID(),
    }, 201);
    expect(npc.campaign).toMatchObject({ campaignId, controllers: [] });

    const maps = [];
    for (const [name, color] of [["Abbey courtyard", "#335577"], ["Flooded crypt", "#112233"]] as const) {
      maps.push(await api<{ fileId: string }>(gm, "POST", `${campaignPath}/images`, {
        name, contentType: "image/png", dataBase64: await png(color), idempotencyKey: randomUUID(),
      }, 201));
    }
    const tokenArt = await api<{ fileId: string }>(gm, "POST", `${campaignPath}/images`, {
      name: "Monk token", contentType: "image/png", dataBase64: await png("#777777"), idempotencyKey: randomUUID(),
    }, 201);
    let courtyard = await api<Scene>(gm, "POST", `${campaignPath}/scenes`, { backgroundFileId: maps[0]!.fileId, idempotencyKey: randomUUID() }, 201);
    let crypt = await api<Scene>(gm, "POST", `${campaignPath}/scenes`, { backgroundFileId: maps[1]!.fileId, idempotencyKey: randomUUID() }, 201);
    const edit = async (scene: Scene, method: Method, path: string, payload: object) => api<Scene>(gm, method, path, {
      ...payload, expectedSceneRevision: scene.revision, idempotencyKey: randomUUID(),
    });
    courtyard = await edit(courtyard, "POST", `/scenes/${courtyard.sceneId}/fog-edits`, {
      op: { mode: "reveal", runs: [{ x: 0.2, y: 0.8, r: 0.25 }] },
    });
    crypt = await edit(crypt, "POST", `/scenes/${crypt.sceneId}/tokens`, {
      label: "Brother Silt", x: 0.8, y: 0.2, size: 0.08, visible: false, imageFileId: tokenArt.fileId,
    });
    expect((await api<{ scenes: unknown[] }>(gm, "GET", `${campaignPath}/scenes`)).scenes).toHaveLength(2);

    // ---------------------------------------------------------------------
    // 4. The GM invites each player, who joins and brings their character.
    // ---------------------------------------------------------------------
    await nextPhase();
    for (const [index, player] of players.entries()) {
      const invitation = await api<{ token: string }>(gm, "POST", `${campaignPath}/invitations`, {
        intendedRole: "player", expectedCampaignRevision: await revisionOf(), idempotencyKey: randomUUID(),
      }, 201);
      const review = await api<{ campaignTitle: string; invitationRevision: number; accessRevision: number }>(
        player, "POST", "/invitations/review", { token: invitation.token });
      expect(review.campaignTitle).toBe("The Drowned Abbey");
      await api(player, "POST", "/invitations/accept", {
        campaignId, token: invitation.token, expectedInvitationRevision: review.invitationRevision,
        reviewedAccessRevision: review.accessRevision, idempotencyKey: randomUUID(),
      });
      const sheet = sheets[index]!;
      const adopted = await api<Sheet>(player, "POST", `${campaignPath}/characters/${sheet.characterId}/adopt`, {
        expectedCampaignRevision: await revisionOf(player), expectedCharacterRevision: sheet.revision,
        acknowledgedDisclosure: true, idempotencyKey: randomUUID(),
      });
      expect(adopted.campaign).toMatchObject({ campaignId, controllers: [player.actorId] });
      sheets[index] = adopted;
    }
    const members = await api<{ members: Array<{ userId: string; role: string; displayName: string | null }> }>(gm, "GET", `${campaignPath}/members`);
    expect(members.members.map((member) => member.displayName).sort()).toEqual(["Ada", "Bob", "Dan", "Eve", "Finn"]);
    const roster = await api<{ characters: Array<{ characterId: string }> }>(gm, "GET", `${campaignPath}/characters`);
    expect(roster.characters).toHaveLength(5);
    // Players see their own sheet and the shared lore, nothing else.
    for (const [index, player] of players.entries()) {
      const own = await api<{ characters: Array<{ characterId: string }> }>(player, "GET", `${campaignPath}/characters`);
      expect(own.characters.map((character) => character.characterId)).toEqual([sheets[index]!.characterId]);
      expect((await call(player, "GET", `/characters/${sheets[(index + 1) % 4]!.characterId}`)).statusCode).toBe(404);
      expect((await call(player, "GET", `/content/${secret.contentId}`)).statusCode).toBe(404);
      const notes = await api<{ content: Array<{ title: string }> }>(player, "GET", `${campaignPath}/content`);
      expect(notes.content.map((note) => note.title)).toEqual(["Session zero"]);
      const visible = await api<{ templates: Array<{ templateId: string }> }>(player, "GET", `${campaignPath}/item-templates`);
      expect(visible.templates.map((template) => template.templateId)).not.toContain(relic.templateId);
    }

    // ---------------------------------------------------------------------
    // 5. The session: scene, tokens, items and rolls from every account.
    // ---------------------------------------------------------------------
    await nextPhase();
    for (const [index, sheet] of sheets.entries()) {
      courtyard = await edit(courtyard, "POST", `/scenes/${courtyard.sceneId}/tokens`, {
        label: sheet.name, x: 0.1 + index * 0.05, y: 0.85, size: 0.06, visible: true, imageFileId: null,
      });
    }
    courtyard = await edit(courtyard, "POST", `/scenes/${courtyard.sceneId}/tokens`, {
      label: "Lurking eel", x: 0.5, y: 0.5, size: 0.1, visible: false, imageFileId: tokenArt.fileId,
    });
    expect(courtyard.tokens.filter((token) => token.visible)).toHaveLength(4);
    // Only the GM manages scenes; players cannot read or move tokens.
    const mara = courtyard.tokens.find((token) => token.label === "Mara Flint")!;
    expect((await call(players[0]!, "GET", `/scenes/${courtyard.sceneId}`)).statusCode).toBe(404);
    expect((await call(players[0]!, "PATCH", `/scenes/${courtyard.sceneId}/tokens/${mara.tokenId}`, {
      x: 0.9, y: 0.9, expectedSceneRevision: courtyard.revision, idempotencyKey: randomUUID(),
    })).statusCode).toBe(404);

    // Initiative: every player rolls for their own hero, the GM for the NPC.
    const rolls: Array<{ by: Account; command: Command }> = [];
    const roll = async (who: Account, index: number | "npc", actionId: string, extra: object = {}) => {
      const sheet = index === "npc" ? npc : sheets[index]!;
      const command = await api<Command>(who, "POST", `/characters/${sheet.characterId}/actions/${actionId}`, {
        inputs: {}, expectedRevision: sheet.revision, idempotencyKey: randomUUID(), ...extra,
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
    expect((await call(players[1]!, "POST", `/characters/${sheets[0]!.characterId}/actions/melee`, {
      inputs: {}, expectedRevision: sheets[0]!.revision, idempotencyKey: randomUUID(),
    })).statusCode).toBe(404);

    // The party advances; the GM moves tokens and reveals the path.
    for (const token of courtyard.tokens.filter((entry) => entry.visible)) {
      courtyard = await edit(courtyard, "PATCH", `/scenes/${courtyard.sceneId}/tokens/${token.tokenId}`, { x: token.x + 0.2, y: 0.6 });
    }
    courtyard = await edit(courtyard, "POST", `/scenes/${courtyard.sceneId}/fog-edits`, {
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
    const bitten = await api<Command>(gm, "POST", `/characters/${sheets[0]!.characterId}/resources/hp/bump`, {
      direction: "down", expectedRevision: sheets[0]!.revision, idempotencyKey: randomUUID(),
    });
    sheets[0]!.revision = bitten.revision;
    courtyard = await edit(courtyard, "DELETE", `/scenes/${courtyard.sceneId}/tokens/${courtyard.tokens.find((t) => t.label === "Lurking eel")!.tokenId}`, {});

    // Loot: players take campaign items from the catalog the browser offers.
    const placeCampaignItem = async (who: Account, index: number, templateId: string) => {
      const sheet = sheets[index]!;
      const catalog = await api<{ templates: Array<{ source?: { kind: string; templateId?: string } }> }>(
        who, "GET", `/characters/${sheet.characterId}/templates`);
      const choice = catalog.templates.find((entry) => entry.source?.kind === "campaign" && entry.source.templateId === templateId);
      expect(choice, `${templateId} offered to ${who.name}`).toBeDefined();
      const placed = await api<Command>(who, "POST", `/characters/${sheet.characterId}/entries`, {
        entryId: randomUUID(), slotId: "pack", templateId: null, source: choice!.source,
        expectedRevision: sheet.revision, idempotencyKey: randomUUID(),
      });
      sheet.revision = placed.revision;
    };
    await placeCampaignItem(players[0]!, 0, lantern.templateId);
    await placeCampaignItem(players[1]!, 1, silvered.templateId);
    // The GM hands the abbey key to Tamsin.
    await placeCampaignItem(gm, 2, key.templateId);
    // GM-only items are never offered to a player sheet.
    const tamsinCatalog = await api<{ templates: Array<{ source?: { templateId?: string } }> }>(
      players[2]!, "GET", `/characters/${sheets[2]!.characterId}/templates`);
    expect(tamsinCatalog.templates.map((entry) => entry.source?.templateId)).not.toContain(relic.templateId);

    // Brann suggests an item; the GM approves it and Brann picks it up.
    const proposal = await api<{ proposalId: string; revision: number }>(players[3]!, "POST", `${campaignPath}/item-proposals`, {
      kind: "item", content: { name: "Eel-skin cloak", description: "Slick and waterproof." }, idempotencyKey: randomUUID(),
    }, 201);
    const decision = await api<{ template: { templateId: string } }>(gm, "POST", `${campaignPath}/item-proposals/${proposal.proposalId}/approve`, {
      expectedProposalRevision: proposal.revision, idempotencyKey: randomUUID(),
    });
    await placeCampaignItem(players[3]!, 3, decision.template.templateId);

    // Into the crypt: new background art, the hidden NPC token, last rolls.
    crypt = await edit(crypt, "POST", `/scenes/${crypt.sceneId}/fog-edits`, { op: { mode: "reveal", runs: [{ x: 0.5, y: 0.5, r: 0.5 }] } });
    for (const sheet of sheets) {
      crypt = await edit(crypt, "POST", `/scenes/${crypt.sceneId}/tokens`, {
        label: sheet.name, x: 0.2, y: 0.8, size: 0.06, visible: true, imageFileId: null,
      });
    }
    const silt = crypt.tokens.find((token) => token.label === "Brother Silt")!;
    crypt = await edit(crypt, "PATCH", `/scenes/${crypt.sceneId}/tokens/${silt.tokenId}`, { x: 0.5, y: 0.4 });
    expect(crypt.tokens).toHaveLength(5);
    await roll(players[0]!, 0, "overnight_healing", { audience: "owner_only" });
    await roll(players[1]!, 1, "reaction", { audience: "campaign" });
    await roll(players[2]!, 2, "save_intelligence", { audience: "campaign" });
    await roll(players[3]!, 3, "ranged", { audience: "campaign" });
    await roll(gm, "npc", "reaction", { audience: "campaign" });

    // ---------------------------------------------------------------------
    // 6. Afterwards: sheets, activity audiences and the GM export agree.
    // ---------------------------------------------------------------------
    await nextPhase();
    const names = (sheet: Sheet) => sheet.entries.map((entry) => entry.values.name ?? entry.templateId).sort();
    const final = await Promise.all(players.map((player, index) => api<Sheet>(player, "GET", `/characters/${sheets[index]!.characterId}`)));
    expect(names(final[0]!)).toEqual(["Hooded lantern", "dagger", "rations"].sort());
    expect(final[0]!.values.hp).toEqual({ current: 5, max: 6 });
    expect(final[1]!.entries.find((entry) => entry.source?.templateId === silvered.templateId)).toMatchObject({ slotId: "pack" });
    expect(names(final[2]!)).toContain("Abbey key");
    expect(names(final[3]!)).toContain("Eel-skin cloak");
    for (const sheet of final) {
      expect(sheet.entries.filter((entry) => entry.source?.kind === "campaign").every((entry) => entry.templateId === null)).toBe(true);
    }
    // The GM sees every sheet exactly as its controller does.
    for (const sheet of final) expect(await api<Sheet>(gm, "GET", `/characters/${sheet.characterId}`)).toEqual(sheet);

    type Activity = { events: Array<{ kind: string; actorId: string; sourceRollId: string | null }> };
    const rollEvents = (activity: Activity) => activity.events.filter((event) => event.kind === "roll_executed");
    const gmFeed = rollEvents(await api<Activity>(gm, "GET", `${campaignPath}/activity?limit=100`));
    // Every roll except the owner-only healing roll reaches the GM, from five accounts.
    expect(gmFeed).toHaveLength(rolls.length - 1);
    expect(new Set(gmFeed.map((event) => event.actorId))).toEqual(new Set([gm, ...players].map((who) => who.actorId)));
    // Players see campaign-audience rolls plus all of their own, never others' GM-only rolls.
    for (const player of players) {
      const feed = rollEvents(await api<Activity>(player, "GET", `${campaignPath}/activity?limit=100`));
      const expected = rolls.filter(({ by, command }) => command.roll!.audience === "campaign" || by.actorId === player.actorId).length;
      expect(feed.filter((event) => event.sourceRollId !== null), `${player.name} feed`).toHaveLength(expected);
    }
    // Brann's character activity shows the GM his three rolls, including the dagger's granted action.
    const brannActivity = await api<{ events: Array<{ kind: string; rollId: string | null }> }>(
      gm, "GET", `/characters/${sheets[3]!.characterId}/activity?limit=100`);
    expect(brannActivity.events.filter((event) => event.rollId !== null))
      .toHaveLength(rolls.filter(({ by }) => by.actorId === players[3]!.actorId).length);

    const exported = await api<{ campaign: { title: string }; members: unknown[]; templates: Array<{ templateId: string }>; rolls: Array<{ actorId: string }> }>(
      gm, "POST", `${campaignPath}/exports`, { idempotencyKey: randomUUID() });
    expect(exported.campaign.title).toBe("The Drowned Abbey");
    expect(exported.members).toHaveLength(5);
    expect(exported.templates.map((template) => template.templateId)).toEqual(expect.arrayContaining([
      lantern.templateId, key.templateId, relic.templateId, silvered.templateId, decision.template.templateId,
    ]));
    expect(new Set(exported.rolls.map((entry) => entry.actorId)).size).toBe(5);

    campaign = await api(gm, "POST", `${campaignPath}/archive`, { expectedCampaignRevision: await revisionOf(), idempotencyKey: randomUUID() });
    expect(campaign).toMatchObject({ status: "archived" });
    expect((await call(players[0]!, "POST", `/characters/${sheets[0]!.characterId}/actions/melee`, {
      inputs: {}, expectedRevision: final[0]!.revision, idempotencyKey: randomUUID(),
    })).statusCode).toBe(409);
  });
});
