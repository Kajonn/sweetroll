import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { derivedTemplateDocument } from "../../src/systems/implementation/package/fixtures/campaign-derived.js";
import type { ExtensionDocumentV1 } from "../../src/systems/implementation/package/schema/index.js";
import { buildI6Harness, type I6Harness, type TestActor } from "./i6-app.js";

// System extensions, stage E5: composition changes for characters and
// campaigns (design 6.7/6.8; plan 2026-11-07-system-extensions). One command
// upgrades the base or adds, removes or upgrades one extension; revert
// restores the composition recorded before the most recent change.

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl === undefined ? describe.skip : describe;

type Ref = { extensionId: string; versionId: string };

/** `edge` is the template default an upgrade changes; `withEdge: false` is a breaking removal. */
function pack(name: string, templateId: string, edge: number, withEdge = true): ExtensionDocumentV1 {
  return {
    schemaVersion: "2.0",
    metadata: { name, description: "", language: "en" },
    expressions: [{ id: `${templateId}_expr`, context: "roll", resultType: "number", source: "d20 + fields.modifier", fallback: 0 }],
    templates: [{
      id: templateId,
      kind: "item",
      label: name,
      fields: withEdge ? [{ id: "edge", kind: "integer", label: "Edge", default: edge, required: true, min: 0, max: 10, step: 1 }] : [],
      grantedActions: [{ id: `${templateId}_hit`, kind: "roll", label: "Hit", expressionId: `${templateId}_expr`, inputs: [], outputTemplate: `${name} {total}` }],
    }],
  };
}

describeWithDatabase("Composition changes (E5)", () => {
  let h: I6Harness;
  let gm: TestActor;
  let player: TestActor;

  beforeAll(async () => {
    h = await buildI6Harness({ document: derivedTemplateDocument() });
    gm = h.users.gm;
    player = h.users.player;
    await h.pool.query("UPDATE systems SET access = 'public' WHERE id = $1", [h.systemId]);
  });

  afterAll(async () => {
    await h?.close();
  });

  async function call(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, user: TestActor, payload?: object) {
    return h.app.inject({ method, url, headers: { cookie: user.cookie }, ...(payload === undefined ? {} : { payload }) });
  }

  /** Publishes a public extension owned by the GM; later versions via `publish`. */
  async function extension(name: string, templateId: string) {
    const created = await call("POST", `/systems/${h.systemId}/extensions`, gm, { baseVersionId: h.versionId, name, idempotencyKey: randomUUID() });
    expect(created.statusCode, created.body).toBe(201);
    const extensionId = created.json().workspace.extension.extensionId as string;
    let revision = 1;
    const publish = async (semanticVersion: string, edge: number, withEdge = true): Promise<Ref> => {
      const saved = await call("PUT", `/extensions/${extensionId}/draft`, gm, { expectedRevision: revision, document: pack(name, templateId, edge, withEdge) });
      expect(saved.statusCode, saved.body).toBe(200);
      revision = saved.json().workspace.draft.revision;
      const published = await call("POST", `/extensions/${extensionId}/publish`, gm, {
        expectedRevision: revision, semanticVersion, releaseNotes: "", acknowledgeBreaking: !withEdge, idempotencyKey: randomUUID(),
      });
      expect(published.statusCode, published.body).toBe(200);
      revision = published.json().workspace?.draft?.revision ?? revision;
      return { extensionId, versionId: published.json().version.versionId };
    };
    expect((await call("PATCH", `/systems/${extensionId}`, gm, { access: "public" })).statusCode).toBe(200);
    return { first: await publish("1.0.0", 3), publish };
  }

  const composition = (extensions: Ref[]) => ({ systemVersionId: h.versionId, extensions });

  async function addEntry(user: TestActor, characterId: string, revision: number, ref: Ref, templateId: string) {
    const entryId = randomUUID();
    const placed = await call("POST", `/characters/${characterId}/entries`, user, {
      entry: {
        entryId, slotId: "inventory", templateId, extensionId: ref.extensionId,
        source: { kind: "system", templateId, extensionId: ref.extensionId }, values: {},
      },
      expectedRevision: revision,
      idempotencyKey: randomUUID(),
    });
    expect(placed.statusCode, placed.body).toBe(200);
    return { entryId, revision: placed.json().result.character.revision as number };
  }

  it("upgrades, adds and removes extensions on a character, follows defaults and reverts", async () => {
    const frost = await extension("Frost pack", "frost_blade");
    const created = await call("POST", "/characters", player, {
      systemVersionId: h.versionId, entityDefinitionId: "character", name: "Frost hero", extensions: [frost.first], idempotencyKey: randomUUID(),
    });
    expect(created.statusCode, created.body).toBe(201);
    const characterId = created.json().character.characterId as string;
    const placed = await addEntry(player, characterId, created.json().character.revision, frost.first, "frost_blade");
    let revision = placed.revision;
    const frost2 = await frost.publish("1.1.0", 4);
    const fire = await extension("Fire pack", "fire_blade");

    const options = await call("GET", `/characters/${characterId}/composition-options`, player);
    expect(options.statusCode, options.body).toBe(200);
    expect(options.json().options).toMatchObject({
      current: { systemVersion: { versionId: h.versionId }, extensions: [{ extensionId: frost.first.extensionId, name: "Frost pack", version: { versionId: frost.first.versionId }, upgrades: [{ versionId: frost2.versionId }] }] },
      revertTo: null,
    });
    expect(options.json().options.available.map((choice: { name: string }) => choice.name)).toEqual(["Fire pack"]);

    // Two changes at once are refused.
    const both = await call("POST", `/characters/${characterId}/composition-check`, player, { target: composition([frost2, fire.first]) });
    expect(both.statusCode, both.body).toBe(400);

    const checked = await call("POST", `/characters/${characterId}/composition-check`, player, { target: composition([frost2]) });
    expect(checked.statusCode, checked.body).toBe(200);
    expect(checked.json().check).toMatchObject({
      direction: "upgrade",
      change: { kind: "extension_upgrade", extensionId: frost.first.extensionId, fromVersionId: frost.first.versionId, toVersionId: frost2.versionId },
      report: { ok: true, changedEntries: [{ entryId: placed.entryId, templateId: "frost_blade", updatedFields: ["edge"] }] },
    });

    const upgraded = await call("POST", `/characters/${characterId}/composition`, player, { target: composition([frost2]), expectedRevision: revision, idempotencyKey: randomUUID() });
    expect(upgraded.statusCode, upgraded.body).toBe(200);
    let character = upgraded.json().result.character;
    expect(character.extensions).toEqual([frost2]);
    expect(character.state.entries[placed.entryId].values.edge).toBe(4);
    revision = character.revision;
    const activity = await call("GET", `/characters/${characterId}/activity`, player);
    expect(activity.json().events[0]).toMatchObject({
      kind: "extension_upgraded",
      payload: { change: { kind: "extension_upgrade" }, from: composition([frost.first]), to: composition([frost2]) },
    });

    // Removing the extension that the entry comes from is blocked.
    const removal = await call("POST", `/characters/${characterId}/composition-check`, player, { target: composition([]) });
    expect(removal.statusCode, removal.body).toBe(200);
    expect(removal.json().check).toMatchObject({
      change: { kind: "extension_remove" },
      report: {
        ok: false,
        blockers: [{ code: "breaking_change", definitionId: `/templates/${frost.first.extensionId}:frost_blade`, message: 'Template "frost_blade" was removed.' }],
      },
    });
    expect((await call("POST", `/characters/${characterId}/composition`, player, { target: composition([]), expectedRevision: revision, idempotencyKey: randomUUID() })).statusCode).toBe(409);

    // Revert restores the previous composition and the old default.
    const reverted = await call("POST", `/characters/${characterId}/composition`, player, { target: composition([frost.first]), expectedRevision: revision, idempotencyKey: randomUUID() });
    expect(reverted.statusCode, reverted.body).toBe(200);
    character = reverted.json().result.character;
    expect(character.extensions).toEqual([frost.first]);
    expect(character.state.entries[placed.entryId].values.edge).toBe(3);
    revision = character.revision;
    expect((await call("GET", `/characters/${characterId}/composition-options`, player)).json().options.revertTo).toBeNull();

    // Add a second extension, then remove it again (unused).
    const added = await call("POST", `/characters/${characterId}/composition`, player, { target: composition([frost.first, fire.first]), expectedRevision: revision, idempotencyKey: randomUUID() });
    expect(added.statusCode, added.body).toBe(200);
    expect(added.json().result.character.extensions.map((ref: Ref) => ref.extensionId).sort())
      .toEqual([frost.first.extensionId, fire.first.extensionId].sort());
    revision = added.json().result.character.revision;
    const after = (await call("GET", `/characters/${characterId}/composition-options`, player)).json().options;
    expect(after.revertTo.extensions.map((choice: { extensionId: string }) => choice.extensionId)).toEqual([frost.first.extensionId]);

    // Another user cannot see or change the composition.
    expect((await call("GET", `/characters/${characterId}/composition-options`, gm)).statusCode).toBe(404);
    expect((await call("POST", `/characters/${characterId}/composition-check`, gm, { target: composition([frost.first]) })).statusCode).toBe(404);
  });

  it("upgrades an extension campaign-wide, blocked by one character, then reverts", async () => {
    const storm = await extension("Storm pack", "storm_blade");
    const created = await call("POST", "/campaigns", gm, { systemVersionId: h.versionId, title: `Storm ${randomUUID()}`, idempotencyKey: randomUUID() });
    expect(created.statusCode, created.body).toBe(201);
    const campaignId = created.json().campaign.campaignId as string;
    await h.pool.query("INSERT INTO campaign_members (campaign_id, user_id, role, status, generation) VALUES ($1, $2, 'player', 'active', 1)", [campaignId, player.actorId]);
    const revision = async () => (await call("GET", `/campaigns/${campaignId}/extensions`, gm)).json().extensions.revision as number;
    expect((await call("POST", `/campaigns/${campaignId}/extensions`, gm, { ...storm.first, expectedCampaignRevision: await revision(), idempotencyKey: randomUUID() })).statusCode).toBe(200);

    const characterIn = async (name: string) => {
      const response = await call("POST", `/campaigns/${campaignId}/characters`, gm, {
        name, entityDefinitionId: "character", controllerUserIds: [player.actorId], expectedCampaignRevision: await revision(), idempotencyKey: randomUUID(),
      });
      expect(response.statusCode, response.body).toBe(201);
      return response.json().character as { characterId: string; revision: number };
    };
    const armed = await characterIn("Armed");
    const unarmed = await characterIn("Unarmed");
    const placed = await addEntry(player, armed.characterId, armed.revision, storm.first, "storm_blade");

    // A breaking version (the entry's field is removed) blocks only the armed character.
    const breaking = await storm.publish("2.0.0", 3, false);
    const options = (await call("GET", `/campaigns/${campaignId}/composition-options`, gm)).json().options;
    expect(options.current.extensions[0].upgrades.map((choice: { versionId: string }) => choice.versionId)).toEqual([breaking.versionId]);
    const blockedCheck = await call("POST", `/campaigns/${campaignId}/composition-check`, gm, { target: composition([breaking]) });
    expect(blockedCheck.statusCode, blockedCheck.body).toBe(200);
    const check = blockedCheck.json().check;
    expect(check).toMatchObject({ ok: false, change: { kind: "extension_upgrade", toVersionId: breaking.versionId } });
    const byId = new Map(check.characters.map((entry: { characterId: string; ok: boolean }) => [entry.characterId, entry.ok]));
    expect(byId.get(armed.characterId)).toBe(false);
    expect(byId.get(unarmed.characterId)).toBe(true);
    const refused = await call("POST", `/campaigns/${campaignId}/composition`, gm, { target: composition([breaking]), expectedCampaignRevision: await revision(), idempotencyKey: randomUUID() });
    expect(refused.statusCode, refused.body).toBe(409);
    expect((await call("POST", `/campaigns/${campaignId}/composition-check`, player, { target: composition([breaking]) })).statusCode).toBe(404);

    // A compatible later version moves the campaign and both characters.
    const compatible = await storm.publish("2.1.0", 5);
    const moved = await call("POST", `/campaigns/${campaignId}/composition`, gm, { target: composition([compatible]), expectedCampaignRevision: await revision(), idempotencyKey: randomUUID() });
    expect(moved.statusCode, moved.body).toBe(200);
    const stored = await h.pool.query<{ extension_version_id: string; added_by: string }>(
      "SELECT extension_version_id, added_by FROM campaign_extensions WHERE campaign_id = $1", [campaignId]);
    expect(stored.rows).toEqual([{ extension_version_id: compatible.versionId, added_by: "campaign" }]);
    const armedView = (await call("GET", `/characters/${armed.characterId}`, player)).json().character;
    expect(armedView.extensions).toEqual([compatible]);
    expect(armedView.state.entries[placed.entryId].values.edge).toBe(5);
    const activity = await call("GET", `/campaigns/${campaignId}/activity`, gm);
    expect(activity.json().events.map((event: { kind: string }) => event.kind)).toContain("extension_upgraded");

    // Revert restores the previous composition for the campaign and its characters.
    const reverted = await call("POST", `/campaigns/${campaignId}/composition`, gm, { target: composition([storm.first]), expectedCampaignRevision: await revision(), idempotencyKey: randomUUID() });
    expect(reverted.statusCode, reverted.body).toBe(200);
    const restored = (await call("GET", `/characters/${armed.characterId}`, player)).json().character;
    expect(restored.extensions).toEqual([storm.first]);
    expect(restored.state.entries[placed.entryId].values.edge).toBe(3);
    expect((await call("GET", `/campaigns/${campaignId}/composition-options`, gm)).json().options.revertTo).toBeNull();
  });
});
