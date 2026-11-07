import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildI6Harness, ctxFor, type I6Harness } from "./i6-app.js";
import { derivedTemplateDocument } from "../../src/systems/implementation/package/fixtures/campaign-derived.js";
import type { CampaignResult } from "../../src/campaigns/index.js";
import type { CharacterResult, CharacterView } from "../../src/characters/index.js";
import type { SystemDocumentV1 } from "../../src/systems/implementation/package/schema/document.js";

// Design 6.7, plan stage 3: a campaign moves with all attached characters and
// template bases, or not at all.

function value<T>(result: CampaignResult<T> | CharacterResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

const db = process.env.TEST_DATABASE_URL ? describe : describe.skip;

db("campaign system version upgrade and revert", () => {
  let h: I6Harness;
  let v2: string;
  let v3: string;

  async function publish(document: SystemDocumentV1, semanticVersion: string): Promise<string> {
    const gm = { cookie: h.users.gm.cookie };
    const opened = await h.app.inject({ method: "GET", url: `/systems/${h.systemId}`, headers: gm });
    const draftRevision = opened.json().workspace.draft.revision as number;
    const save = await h.app.inject({
      method: "PUT",
      url: `/systems/${h.systemId}/draft`,
      headers: gm,
      payload: { expectedRevision: draftRevision, document },
    });
    expect(save.statusCode, save.body).toBe(200);
    const published = await h.app.inject({
      method: "POST",
      url: `/systems/${h.systemId}/publish`,
      headers: gm,
      payload: {
        expectedRevision: save.json().workspace.draft.revision as number,
        semanticVersion,
        releaseNotes: "",
        idempotencyKey: randomUUID(),
        acknowledgeBreaking: true,
      },
    });
    expect(published.statusCode, published.body).toBe(200);
    return published.json().version.versionId as string;
  }

  beforeAll(async () => {
    h = await buildI6Harness({ document: derivedTemplateDocument() });
    // v2: the sword's default damage bonus changes and a shield is added.
    const second = derivedTemplateDocument();
    const sword = second.templates!.find((t) => t.id === "sword")!;
    const bonus = sword.fields.find((f) => f.id === "damage_bonus")!;
    if (bonus.kind === "integer") bonus.default = 2;
    second.templates!.push({ id: "shield", kind: "item", label: "Shield", fields: [], grantedActions: [] });
    v2 = await publish(second, "1.1.0");
    // v3: the sword loses its inscription field, which breaks campaign templates based on it.
    const third = derivedTemplateDocument();
    const brokenSword = third.templates!.find((t) => t.id === "sword")!;
    brokenSword.fields = brokenSword.fields.filter((f) => f.id !== "name");
    v3 = await publish(third, "2.0.0");
  });

  afterAll(async () => {
    await h?.close();
  });

  async function campaign(): Promise<string> {
    const created = value(
      await h.campaigns.create(ctxFor(h.users.gm), {
        systemVersionId: h.versionId,
        title: "Versioned campaign",
        description: "",
        idempotencyKey: randomUUID(),
      }),
    );
    await h.pool.query(
      "INSERT INTO campaign_members(campaign_id,user_id,role,status,generation) VALUES($1,$2,'player','active',1)",
      [created.campaignId, h.users.player.actorId],
    );
    return created.campaignId;
  }

  async function revision(campaignId: string): Promise<number> {
    return value(await h.campaigns.open(ctxFor(h.users.gm), { campaignId })).revision;
  }

  async function hero(campaignId: string, name: string): Promise<CharacterView> {
    const response = await h.app.inject({
      method: "POST",
      url: `/campaigns/${campaignId}/characters`,
      headers: { cookie: h.users.gm.cookie },
      payload: {
        name,
        entityDefinitionId: "character",
        controllerUserIds: [h.users.player.actorId],
        expectedCampaignRevision: await revision(campaignId),
        idempotencyKey: randomUUID(),
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().character as CharacterView;
  }

  async function swordTemplate(campaignId: string) {
    return value(
      await h.campaigns.createTemplate(ctxFor(h.users.gm), {
        campaignId,
        kind: "item",
        baseTemplateId: "sword",
        content: { name: "Captain's sword", defaultValues: { damage_bonus: 4 } },
        expectedTemplateRevision: 0,
        idempotencyKey: randomUUID(),
      }),
    );
  }

  async function place(character: CharacterView, template: Awaited<ReturnType<typeof swordTemplate>>, entryId = randomUUID()) {
    return h.characters.apply(ctxFor(h.users.player), {
      kind: "addEntry",
      characterId: character.characterId,
      entry: {
        entryId,
        slotId: "inventory",
        templateId: null,
        values: {},
        source: {
          kind: "campaign",
          campaignId: template.campaignId,
          templateId: template.templateId,
          templateRevision: template.revision,
          contentRevision: template.contentRevision,
        },
      },
      expectedRevision: character.revision,
      idempotencyKey: randomUUID(),
    });
  }

  const gmHeaders = () => ({ cookie: h.users.gm.cookie });
  const openCharacter = async (characterId: string) =>
    value(await h.characters.open(ctxFor(h.users.player), characterId));
  const change = async (campaignId: string, targetVersionId: string, expectedCampaignRevision: number) =>
    h.app.inject({
      method: "POST",
      url: `/campaigns/${campaignId}/version`,
      headers: gmHeaders(),
      payload: { targetVersionId, expectedCampaignRevision, idempotencyKey: randomUUID() },
    });

  it("moves the campaign, its characters and template bases together and reverts them", async () => {
    const campaignId = await campaign();
    const armed = await hero(campaignId, "Armed");
    const unarmed = await hero(campaignId, "Unarmed");
    const template = await swordTemplate(campaignId);
    const entryId = randomUUID();
    value(await place(armed, template, entryId));

    expect((await h.app.inject({ method: "GET", url: `/campaigns/${campaignId}/version-options`, headers: { cookie: h.users.player.cookie } })).statusCode).toBe(404);
    const options = await h.app.inject({ method: "GET", url: `/campaigns/${campaignId}/version-options`, headers: gmHeaders() });
    expect(options.statusCode, options.body).toBe(200);
    expect(options.json().options.current.versionId).toBe(h.versionId);
    expect(options.json().options.revertTo).toBeNull();
    expect(options.json().options.upgrades.map((u: { versionId: string }) => u.versionId)).toEqual([v3, v2]);

    const checked = await h.app.inject({ method: "GET", url: `/campaigns/${campaignId}/version-check?targetVersionId=${v2}`, headers: gmHeaders() });
    expect(checked.statusCode, checked.body).toBe(200);
    expect(checked.json().check).toMatchObject({ ok: true, direction: "upgrade", fromVersionId: h.versionId, toVersionId: v2 });
    expect(checked.json().check.characters).toHaveLength(2);
    expect(checked.json().check.templates).toEqual([{ templateId: template.templateId, name: "Captain's sword", ok: true, blockers: [] }]);

    // Attached characters move only with their campaign.
    expect((await h.app.inject({ method: "GET", url: `/characters/${armed.characterId}/version-options`, headers: { cookie: h.users.player.cookie } })).statusCode).toBe(404);

    const before = await revision(campaignId);
    expect((await change(campaignId, v2, before - 1)).statusCode).toBe(409);
    const upgraded = await change(campaignId, v2, before);
    expect(upgraded.statusCode, upgraded.body).toBe(200);
    expect(upgraded.json().campaign).toMatchObject({ systemVersionId: v2, revision: before + 1 });

    const armedAfter = await openCharacter(armed.characterId);
    expect(armedAfter.systemVersionId).toBe(v2);
    const entry = armedAfter.state.entries![entryId]!;
    // The campaign override is kept; the base pin follows the campaign.
    expect(entry.values.damage_bonus).toBe(4);
    expect(entry.snapshot).toMatchObject({ base: { versionId: v2, templateId: "sword" } });
    expect((await openCharacter(unarmed.characterId)).systemVersionId).toBe(v2);

    const rebased = value(await h.campaigns.openTemplate(ctxFor(h.users.gm), { campaignId, templateId: template.templateId }));
    expect(rebased.contentRevision).toBe(template.contentRevision + 1);
    expect(rebased.content.base).toMatchObject({ versionId: v2, templateId: "sword" });
    expect(rebased.content.defaultValues).toMatchObject({ damage_bonus: 4 });
    // Placement works again at the new version.
    value(await place(await openCharacter(unarmed.characterId), rebased));

    // Players see the rules change in the campaign feed.
    const feed = value(await h.campaigns.listActivity(ctxFor(h.users.player), { campaignId }));
    expect(feed.events[0]).toMatchObject({ kind: "system_version_upgraded", actorId: h.users.gm.actorId });

    const afterOptions = await h.app.inject({ method: "GET", url: `/campaigns/${campaignId}/version-options`, headers: gmHeaders() });
    expect(afterOptions.json().options.revertTo.versionId).toBe(h.versionId);
    const reverted = await change(campaignId, h.versionId, before + 1);
    expect(reverted.statusCode, reverted.body).toBe(200);
    expect(reverted.json().campaign.systemVersionId).toBe(h.versionId);
    expect((await openCharacter(armed.characterId)).systemVersionId).toBe(h.versionId);
    const back = value(await h.campaigns.openTemplate(ctxFor(h.users.gm), { campaignId, templateId: template.templateId }));
    expect(back.content.base).toMatchObject({ versionId: h.versionId });
  });

  it("blocks the whole campaign when one template or character cannot move", async () => {
    const campaignId = await campaign();
    const armed = await hero(campaignId, "Armed");
    const template = await swordTemplate(campaignId);
    value(await place(armed, template));
    const armedBefore = await openCharacter(armed.characterId);

    const checked = await h.app.inject({ method: "GET", url: `/campaigns/${campaignId}/version-check?targetVersionId=${v3}`, headers: gmHeaders() });
    expect(checked.statusCode, checked.body).toBe(200);
    expect(checked.json().check.ok).toBe(false);
    expect(checked.json().check.templates[0]).toMatchObject({ ok: false, blockers: [{ code: "breaking_change" }] });
    expect(checked.json().check.characters[0]).toMatchObject({ ok: false });

    const blocked = await change(campaignId, v3, await revision(campaignId));
    expect(blocked.statusCode, blocked.body).toBe(409);
    const unchanged = await openCharacter(armed.characterId);
    expect(unchanged.systemVersionId).toBe(h.versionId);
    expect(unchanged.revision).toBe(armedBefore.revision);
    expect(value(await h.campaigns.open(ctxFor(h.users.gm), { campaignId })).systemVersionId).toBe(h.versionId);
  });

  it("allows a breaking version that no campaign character or template uses", async () => {
    const campaignId = await campaign();
    await hero(campaignId, "Unarmed");
    const moved = await change(campaignId, v3, await revision(campaignId));
    expect(moved.statusCode, moved.body).toBe(200);
    expect(moved.json().campaign.systemVersionId).toBe(v3);
  });
});
