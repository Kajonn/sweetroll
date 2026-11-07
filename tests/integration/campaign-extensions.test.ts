import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { derivedTemplateDocument } from "../../src/systems/implementation/package/fixtures/campaign-derived.js";
import type { ExtensionDocumentV1 } from "../../src/systems/implementation/package/schema/index.js";
import { buildI6Harness, type I6Harness, type TestActor } from "./i6-app.js";

// System extensions, stage E4: campaigns are built on the system plus the
// union of the extensions the GM chose and those its characters brought
// (design 6.8, decisions X7–X10; plan 2026-11-07-system-extensions).

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl === undefined ? describe.skip : describe;

type Ref = { extensionId: string; versionId: string };

function pack(name: string, templateId: string, bonus = 1): ExtensionDocumentV1 {
  return {
    schemaVersion: "1.0",
    metadata: { name, description: "", language: "en" },
    expressions: [{ id: `${templateId}_expr`, context: "roll", resultType: "number", source: `d20 + fields.modifier + ${bonus}`, fallback: 0 }],
    templates: [{
      id: templateId,
      kind: "item",
      label: name,
      fields: [],
      grantedActions: [{ id: `${templateId}_hit`, kind: "roll", label: "Hit", expressionId: `${templateId}_expr`, inputs: [], outputTemplate: `${name} {total}` }],
    }],
  };
}

describeWithDatabase("Campaigns built with extensions (E4)", () => {
  let h: I6Harness;
  let gm: TestActor;
  let player: TestActor;
  let other: TestActor;

  beforeAll(async () => {
    h = await buildI6Harness({ document: derivedTemplateDocument() });
    gm = h.users.gm;
    player = h.users.player;
    other = h.users.other;
    await h.pool.query("UPDATE systems SET access = 'public' WHERE id = $1", [h.systemId]);
  });

  afterAll(async () => {
    await h?.close();
  });

  async function call(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, user: TestActor, payload?: object) {
    return h.app.inject({ method, url, headers: { cookie: user.cookie }, ...(payload === undefined ? {} : { payload }) });
  }

  /** Publishes an extension owned by `owner`; further versions via `republish`. */
  async function extension(owner: TestActor, name: string, templateId: string, access: "private" | "link" | "public" = "link") {
    const created = await call("POST", `/systems/${h.systemId}/extensions`, owner, { baseVersionId: h.versionId, name, idempotencyKey: randomUUID() });
    expect(created.statusCode, created.body).toBe(201);
    const extensionId = created.json().workspace.extension.extensionId as string;
    let revision = 1;
    const publish = async (semanticVersion: string, bonus: number): Promise<Ref> => {
      const saved = await call("PUT", `/extensions/${extensionId}/draft`, owner, { expectedRevision: revision, document: pack(name, templateId, bonus) });
      expect(saved.statusCode, saved.body).toBe(200);
      revision = saved.json().workspace.draft.revision;
      const published = await call("POST", `/extensions/${extensionId}/publish`, owner, {
        expectedRevision: revision, semanticVersion, releaseNotes: "", acknowledgeBreaking: false, idempotencyKey: randomUUID(),
      });
      expect(published.statusCode, published.body).toBe(200);
      return { extensionId, versionId: published.json().version.versionId };
    };
    const first = await publish("1.0.0", 1);
    if (access !== "private") expect((await call("PATCH", `/systems/${extensionId}`, owner, { access })).statusCode).toBe(200);
    return { ...first, republish: publish };
  }

  async function campaign(): Promise<string> {
    const created = await call("POST", "/campaigns", gm, { systemVersionId: h.versionId, title: `Ext ${randomUUID()}`, idempotencyKey: randomUUID() });
    expect(created.statusCode, created.body).toBe(201);
    const campaignId = created.json().campaign.campaignId as string;
    for (const member of [player, other]) {
      await h.pool.query("INSERT INTO campaign_members (campaign_id, user_id, role, status, generation) VALUES ($1, $2, 'player', 'active', 1)", [campaignId, member.actorId]);
    }
    return campaignId;
  }

  async function revision(campaignId: string): Promise<number> {
    return (await call("GET", `/campaigns/${campaignId}/extensions`, gm)).json().extensions.revision;
  }

  async function addExtension(campaignId: string, ref: Ref, user = gm) {
    return call("POST", `/campaigns/${campaignId}/extensions`, user, { ...ref, expectedCampaignRevision: await revision(campaignId), idempotencyKey: randomUUID() });
  }

  async function removeExtension(campaignId: string, extensionId: string) {
    return call("DELETE", `/campaigns/${campaignId}/extensions/${extensionId}`, gm, { expectedCampaignRevision: await revision(campaignId), idempotencyKey: randomUUID() });
  }

  async function standalone(owner: TestActor, extensions: Ref[]) {
    const created = await call("POST", "/characters", owner, {
      systemVersionId: h.versionId, entityDefinitionId: "character", name: "Hero", extensions, idempotencyKey: randomUUID(),
    });
    expect(created.statusCode, created.body).toBe(201);
    return created.json().character as { characterId: string; revision: number };
  }

  async function adopt(campaignId: string, owner: TestActor, character: { characterId: string; revision: number }, expectedCampaignRevision?: number) {
    return call("POST", `/campaigns/${campaignId}/characters/${character.characterId}/adopt`, owner, {
      expectedCampaignRevision: expectedCampaignRevision ?? await revision(campaignId),
      expectedCharacterRevision: character.revision,
      acknowledgedDisclosure: true,
      idempotencyKey: randomUUID(),
    });
  }

  async function characterExtensions(characterId: string): Promise<string[]> {
    return (await h.pool.query<{ extension_id: string }>("SELECT extension_id FROM character_extensions WHERE character_id = $1 ORDER BY extension_id", [characterId]))
      .rows.map((row) => row.extension_id);
  }

  const ids = (refs: Ref[]) => refs.map((ref) => ref.extensionId).sort();

  it("unites the GM's and the characters' extensions and shares them with every attached character", async () => {
    const gmPack = await extension(gm, "GM pack", "gm_blade");
    const playerPack = await extension(other, "Player pack", "player_blade");
    const campaignId = await campaign();

    const before = await call("POST", `/campaigns/${campaignId}/characters`, gm, {
      name: "Early", entityDefinitionId: "character", expectedCampaignRevision: await revision(campaignId), idempotencyKey: randomUUID(),
    });
    expect(before.statusCode, before.body).toBe(201);
    const early = before.json().character.characterId as string;

    expect((await addExtension(campaignId, gmPack, player)).statusCode).toBe(404);
    const added = await addExtension(campaignId, gmPack);
    expect(added.statusCode, added.body).toBe(200);
    expect(added.json().extensions.extensions).toEqual([expect.objectContaining({ extensionId: gmPack.extensionId, addedBy: "campaign", name: "GM pack", semanticVersion: "1.0.0" })]);
    expect(await characterExtensions(early)).toEqual([gmPack.extensionId]);

    const hero = await standalone(player, [{ extensionId: playerPack.extensionId, versionId: playerPack.versionId }]);
    const adopted = await adopt(campaignId, player, hero);
    expect(adopted.statusCode, adopted.body).toBe(200);
    const listed = (await call("GET", `/campaigns/${campaignId}/extensions`, player)).json().extensions.extensions;
    expect(listed.map((entry: { extensionId: string; addedBy: string; addedByCharacterId: string | null }) => [entry.extensionId, entry.addedBy, entry.addedByCharacterId]).sort())
      .toEqual([[gmPack.extensionId, "campaign", null], [playerPack.extensionId, "character", hero.characterId]].sort());
    const both = ids([gmPack, playerPack]);
    expect(await characterExtensions(hero.characterId)).toEqual(both);
    expect(await characterExtensions(early)).toEqual(both);

    // A campaign-created character gets the whole set, and can use both packs.
    const created = await call("POST", `/campaigns/${campaignId}/characters`, gm, {
      name: "Late", entityDefinitionId: "character", controllerUserIds: [other.actorId], expectedCampaignRevision: await revision(campaignId), idempotencyKey: randomUUID(),
    });
    expect(created.statusCode, created.body).toBe(201);
    const late = created.json().character;
    expect(late.extensions.map((ref: Ref) => ref.extensionId)).toEqual(both);
    const templates = (await call("GET", `/characters/${late.characterId}/templates`, other)).json().templates
      .filter((template: { extensionId?: string }) => template.extensionId !== undefined)
      .map((template: { id: string }) => template.id).sort();
    expect(templates).toEqual(["gm_blade", "player_blade"]);

    // Campaign rules-version changes wait for E5 once extensions are in use.
    expect((await call("GET", `/campaigns/${campaignId}/version-check?targetVersionId=${h.versionId}`, gm)).statusCode).toBe(409);
  });

  it("blocks a different version of an extension the campaign already uses (X8), also concurrently", async () => {
    const shared = await extension(gm, "Shared pack", "shared_blade", "public");
    const second = await shared.republish("1.1.0", 2);
    const campaignId = await campaign();
    expect((await addExtension(campaignId, shared)).statusCode).toBe(200);
    expect((await addExtension(campaignId, second)).statusCode).toBe(409);

    const newer = await standalone(player, [second]);
    const refused = await adopt(campaignId, player, newer);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.message).toMatch(/another version/);
    expect(await characterExtensions(newer.characterId)).toEqual([shared.extensionId]);

    // Two fresh campaigns: concurrent adoptions of characters with different
    // versions of one extension leave exactly one attached.
    const raceCampaign = await campaign();
    const a = await standalone(player, [shared]);
    const b = await standalone(other, [second]);
    const expected = await revision(raceCampaign);
    const results = await Promise.all([adopt(raceCampaign, player, a, expected), adopt(raceCampaign, other, b, expected)]);
    expect(results.map((result) => result.statusCode).sort()).toEqual([200, 409]);
    const set = (await call("GET", `/campaigns/${raceCampaign}/extensions`, gm)).json().extensions.extensions;
    expect(set).toHaveLength(1);
  });

  it("lets members use a private extension inside the campaign only (X10)", async () => {
    const secret = await extension(other, "Secret pack", "secret_blade", "link");
    const hero = await standalone(other, [secret]);
    const campaignId = await campaign();
    expect((await adopt(campaignId, other, hero)).statusCode).toBe(200);
    expect((await call("PATCH", `/systems/${secret.extensionId}`, other, { access: "private" })).statusCode).toBe(200);

    // The player cannot use it outside the campaign …
    expect((await call("POST", "/characters", player, {
      systemVersionId: h.versionId, entityDefinitionId: "character", name: "Copy", extensions: [secret], idempotencyKey: randomUUID(),
    })).statusCode).toBe(404);
    // … nor can the GM add it to another campaign …
    expect((await addExtension(await campaign(), secret)).statusCode).toBe(404);
    // … but a campaign character controlled by the player places and rolls it.
    const created = await call("POST", `/campaigns/${campaignId}/characters`, gm, {
      name: "Inside", entityDefinitionId: "character", controllerUserIds: [player.actorId], expectedCampaignRevision: await revision(campaignId), idempotencyKey: randomUUID(),
    });
    expect(created.statusCode, created.body).toBe(201);
    const characterId = created.json().character.characterId as string;
    const entryId = randomUUID();
    const placed = await call("POST", `/characters/${characterId}/entries`, player, {
      entry: { entryId, slotId: "inventory", templateId: "secret_blade", extensionId: secret.extensionId, values: {} }, expectedRevision: 1, idempotencyKey: randomUUID(),
    });
    expect(placed.statusCode, placed.body).toBe(200);
    const rolled = await call("POST", `/characters/${characterId}/actions/secret_blade_hit`, player, { entryId, expectedRevision: 2, idempotencyKey: randomUUID() });
    expect(rolled.statusCode, rolled.body).toBe(200);
    expect(rolled.json().result.roll.output).toMatch(/^Secret pack \d+$/);
    expect((await call("GET", `/extensions/${secret.extensionId}`, player)).statusCode).toBe(404);
  });

  it("refuses removal while used (X9) and removes from every attached character afterwards", async () => {
    const used = await extension(gm, "Used pack", "used_blade");
    const unused = await extension(gm, "Unused pack", "unused_blade");
    const campaignId = await campaign();
    expect((await addExtension(campaignId, used)).statusCode).toBe(200);
    expect((await addExtension(campaignId, unused)).statusCode).toBe(200);
    const created = await call("POST", `/campaigns/${campaignId}/characters`, gm, {
      name: "Holder", entityDefinitionId: "character", expectedCampaignRevision: await revision(campaignId), idempotencyKey: randomUUID(),
    });
    const characterId = created.json().character.characterId as string;
    const entryId = randomUUID();
    expect((await call("POST", `/characters/${characterId}/entries`, gm, {
      entry: { entryId, slotId: "inventory", templateId: "used_blade", extensionId: used.extensionId, values: {} }, expectedRevision: 1, idempotencyKey: randomUUID(),
    })).statusCode).toBe(200);

    const blocked = await removeExtension(campaignId, used.extensionId);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.message).toMatch(/1 character/);
    const removedUnused = await removeExtension(campaignId, unused.extensionId);
    expect(removedUnused.statusCode, removedUnused.body).toBe(200);
    expect(await characterExtensions(characterId)).toEqual([used.extensionId]);

    expect((await call("DELETE", `/characters/${characterId}/entries/${entryId}`, gm, { expectedRevision: 2, idempotencyKey: randomUUID() })).statusCode).toBe(200);
    expect((await removeExtension(campaignId, used.extensionId)).statusCode).toBe(200);
    expect(await characterExtensions(characterId)).toEqual([]);

    const kinds = (await h.pool.query<{ kind: string }>("SELECT kind FROM campaign_activity_events WHERE campaign_id = $1 ORDER BY occurred_at", [campaignId])).rows.map((row) => row.kind);
    expect(kinds.filter((kind) => kind.startsWith("extension_"))).toEqual(["extension_added", "extension_added", "extension_removed", "extension_removed"]);
  });

  it("replays add commands idempotently and rejects foreign extensions", async () => {
    const replayable = await extension(gm, "Replay pack", "replay_blade");
    const campaignId = await campaign();
    const body = { ...replayable, expectedCampaignRevision: await revision(campaignId), idempotencyKey: randomUUID() };
    const first = await call("POST", `/campaigns/${campaignId}/extensions`, gm, body);
    const second = await call("POST", `/campaigns/${campaignId}/extensions`, gm, body);
    expect(first.statusCode, first.body).toBe(200);
    expect(second.json().extensions).toEqual(first.json().extensions);
    expect((await call("POST", `/campaigns/${campaignId}/extensions`, gm, { ...body, versionId: randomUUID() })).statusCode).toBe(409);

    // An extension of another system never joins this campaign.
    const created = await call("POST", `/systems/${h.otherSystemId}/extensions`, other, { baseVersionId: h.otherVersionId, name: "Foreign", idempotencyKey: randomUUID() });
    expect(created.statusCode, created.body).toBe(201);
    const foreignId = created.json().workspace.extension.extensionId as string;
    const foreignDoc: ExtensionDocumentV1 = { schemaVersion: "1.0", metadata: { name: "Foreign", description: "", language: "en" }, expressions: [], templates: [] };
    expect((await call("PUT", `/extensions/${foreignId}/draft`, other, { expectedRevision: 1, document: foreignDoc })).statusCode).toBe(200);
    const published = await call("POST", `/extensions/${foreignId}/publish`, other, { expectedRevision: 2, semanticVersion: "1.0.0", releaseNotes: "", acknowledgeBreaking: false, idempotencyKey: randomUUID() });
    expect(published.statusCode, published.body).toBe(200);
    await call("PATCH", `/systems/${foreignId}`, other, { access: "public" });
    expect((await addExtension(campaignId, { extensionId: foreignId, versionId: published.json().version.versionId })).statusCode).toBe(404);
  });
});
