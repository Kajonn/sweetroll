import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildI6Harness, ctxFor, type I6Harness } from "./i6-app.js";
import { derivedTemplateDocument } from "../fixtures/derived-template.js";
import type { CampaignResult } from "../../src/campaigns/index.js";
import type {
  CharacterResult,
  CharacterView,
} from "../../src/characters/index.js";
import type { CampaignTemplateView } from "../../src/campaigns/templates.js";
function value<T>(r: CampaignResult<T> | CharacterResult<T>): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}
const db = process.env.TEST_DATABASE_URL ? describe : describe.skip;
db("derived campaign templates", () => {
  let h: I6Harness;
  beforeAll(async () => {
    const d = derivedTemplateDocument();
    h = await buildI6Harness({ document: d });
    await h.pool.query("UPDATE systems SET access='public' WHERE id=$1", [
      h.systemId,
    ]);
  });
  afterAll(async () => {
    await h?.close();
  });
  async function campaign() {
    const c = value(
      await h.campaigns.create(ctxFor(h.users.gm), {
        systemVersionId: h.versionId,
        title: "Derived test",
        description: "",
        idempotencyKey: randomUUID(),
      }),
    );
    await h.pool.query(
      "INSERT INTO campaign_members(campaign_id,user_id,role,status,generation) VALUES($1,$2,'player','active',1),($1,$3,'co_gm','active',1)",
      [c.campaignId, h.users.player.actorId, h.users.other.actorId],
    );
    return c.campaignId;
  }
  async function template(id: string) {
    return value(
      await h.campaigns.createTemplate(ctxFor(h.users.gm), {
        campaignId: id,
        kind: "item",
        baseTemplateId: "sword",
        content: {
          name: "Captain's sword",
          defaultValues: { damage_bonus: 4 },
          defaultQuantity: 2,
        },
        expectedTemplateRevision: 0,
        idempotencyKey: randomUUID(),
      }),
    );
  }
  async function hero(id: string, entityDefinitionId = "character") {
    const r = await h.app.inject({
      method: "POST",
      url: `/campaigns/${id}/characters`,
      headers: { cookie: h.users.gm.cookie },
      payload: {
        name: "Hero",
        entityDefinitionId,
        controllerUserIds: [h.users.player.actorId],
        expectedCampaignRevision: value(
          await h.campaigns.open(ctxFor(h.users.gm), { campaignId: id }),
        ).revision,
        idempotencyKey: randomUUID(),
      },
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().character as CharacterView;
  }
  async function place(
    ch: CharacterView,
    t: CampaignTemplateView,
    key = randomUUID(),
    entryId = randomUUID(),
  ) {
    return h.characters.apply(ctxFor(h.users.player), {
      kind: "addEntry",
      characterId: ch.characterId,
      entry: {
        entryId,
        slotId: "inventory",
        templateId: null,
        values: {},
        source: {
          kind: "campaign",
          campaignId: t.campaignId,
          templateId: t.templateId,
          templateRevision: t.revision,
          contentRevision: t.contentRevision,
        },
      },
      expectedRevision: ch.revision,
      idempotencyKey: key,
    });
  }
  async function act(ch: CharacterView, entryId: string, actionId: string) {
    return h.characters.apply(ctxFor(h.users.player), {
      kind: "executeAction",
      characterId: ch.characterId,
      entryId,
      actionId,
      inputs: {},
      expectedRevision: ch.revision,
      idempotencyKey: randomUUID(),
    });
  }
  it("authorizes base discovery, validates typed defaults and freezes source through revision/lifecycle writes", async () => {
    const id = await campaign(),
      path = `/campaigns/${id}/item-templates`;
    expect(
      (
        await h.app.inject({
          method: "GET",
          url: `${path}/bases`,
          headers: { cookie: h.users.player.cookie },
        })
      ).statusCode,
    ).toBe(403);
    const bases = await h.app.inject({
      method: "GET",
      url: `${path}/bases`,
      headers: { cookie: h.users.gm.cookie },
    });
    expect(bases.statusCode, bases.body).toBe(200);
    expect(bases.json().templates[0].id).toBe("sword");
    for (const extra of [
      { baseTemplateId: "missing" },
      { kind: "spell" },
      { content: { name: "Bad", defaultValues: { damage_bonus: 11 } } },
      { content: { name: "Bad", defaultValues: { damage_bonus: "4" } } },
      { content: { name: "Bad", defaultValues: { unknown: 3 } } },
      { content: { name: "Bad", actions: [] } },
      { versionId: h.otherVersionId },
    ]) {
      const r = await h.app.inject({
        method: "POST",
        url: path,
        headers: { cookie: h.users.gm.cookie },
        payload: {
          kind: "item",
          baseTemplateId: "sword",
          content: { name: "Bad" },
          expectedTemplateRevision: 0,
          idempotencyKey: randomUUID(),
          ...extra,
        },
      });
      expect(r.statusCode, r.body).toBe(400);
    }
    expect(
      value(
        await h.campaigns.listTemplates(ctxFor(h.users.gm), { campaignId: id }),
      ).templates,
    ).toHaveLength(0);
    const t = await template(id);
    expect(t.content.base).toMatchObject({
      versionId: h.versionId,
      templateId: "sword",
    });
    const body = {
      campaignId: id,
      templateId: t.templateId,
      expectedTemplateRevision: 1,
      content: { name: "Revised", defaultValues: { damage_bonus: 7 } },
      idempotencyKey: randomUUID(),
    };
    const revised = value(
      await h.campaigns.updateTemplate(ctxFor(h.users.other), body),
    );
    expect(revised.content.base).toEqual(t.content.base);
    expect(revised.contentRevision).toBe(2);
    expect(
      value(await h.campaigns.updateTemplate(ctxFor(h.users.other), body)),
    ).toEqual(revised);
    const archived = value(
      await h.campaigns.archiveTemplate(ctxFor(h.users.gm), {
        campaignId: id,
        templateId: t.templateId,
        expectedTemplateRevision: 2,
        idempotencyKey: randomUUID(),
      }),
    );
    expect(archived.contentRevision).toBe(2);
    expect(archived.content).toEqual(revised.content);
  });
  it("materializes exact copies, executes all supported actions and keeps existing copies after catalog edits/archive", async () => {
    const id = await campaign(),
      t = await template(id),
      ch = await hero(id),
      key = randomUUID(),
      entryId = randomUUID();
    const first = value(await place(ch, t, key, entryId));
    expect(value(await place(ch, t, key, entryId)).character.state).toEqual(
      first.character.state,
    );
    const copy = first.character.state.entries![entryId]!;
    expect(copy.values).toMatchObject({
      damage_bonus: 4,
      name: "Binding name",
      fuel: { current: 2, max: 3 },
    });
    expect(copy.snapshot).toMatchObject({
      values: { name: "Captain's sword" },
      base: t.content.base,
    });
    expect(
      first.character.projection.sheets[0]!.sections[0]!.elements.find(
        (e) => e.kind === "slot",
      ),
    ).toMatchObject({
      entries: [{ label: "Captain's sword", definition: { id: "sword" } }],
    });
    const hit = value(await act(first.character, entryId, "sword_hit"));
    expect(hit.roll?.bindings).toEqual(
      expect.arrayContaining([
        { scope: "fields", definitionId: "modifier", value: 0 },
        { scope: "fields", definitionId: "damage_bonus", value: 4 },
      ]),
    );
    const damage = value(await act(hit.character, entryId, "sword_damage"));
    expect(damage.roll?.bindings).toContainEqual({
      scope: "fields",
      definitionId: "damage_bonus",
      value: 4,
    });
    const salute = value(await act(damage.character, entryId, "sword_salute"));
    expect(salute.roll).toBeNull();
    expect(salute.nominal?.output).toBe("You salute");
    const refuel = value(await act(salute.character, entryId, "sword_refuel"));
    expect(refuel.character.state.entries![entryId]!.values.fuel).toEqual({
      current: 3,
      max: 3,
    });
    const revised = value(
      await h.campaigns.updateTemplate(ctxFor(h.users.gm), {
        campaignId: id,
        templateId: t.templateId,
        expectedTemplateRevision: 1,
        content: { name: "New sword", defaultValues: { damage_bonus: 7 } },
        idempotencyKey: randomUUID(),
      }),
    );
    expect(await place(refuel.character, t)).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
    const second = value(await place(refuel.character, revised));
    expect(second.character.state.entries![entryId]).toEqual(
      refuel.character.state.entries![entryId],
    );
    expect(
      Object.values(second.character.state.entries!).find(
        (e) => e.entryId !== entryId,
      )?.values.damage_bonus,
    ).toBe(7);
    value(
      await h.campaigns.archiveTemplate(ctxFor(h.users.gm), {
        campaignId: id,
        templateId: t.templateId,
        expectedTemplateRevision: 2,
        idempotencyKey: randomUUID(),
      }),
    );
    expect((await act(second.character, entryId, "sword_hit")).ok).toBe(true);
    const npc = await hero(id, "npc");
    expect(
      value(
        await h.characters.listEntryTemplates(ctxFor(h.users.player), {
          characterId: npc.characterId,
        }),
      ).filter((t) => t.source?.kind === "campaign"),
    ).toHaveLength(0);
  });
  it("retains derived pushes on returned/duplicated sheets, denies old scopes, and serializes competing pushes", async () => {
    const id = await campaign(),
      t = await template(id);
    const own = value(
      await h.characters.create(ctxFor(h.users.player), {
        systemVersionId: h.versionId,
        entityDefinitionId: "character",
        name: "Return",
        idempotencyKey: randomUUID(),
      }),
    );
    const adopted = value(
      await h.campaigns.adoptCampaignCharacter(ctxFor(h.users.player), {
        campaignId: id,
        characterId: own.characterId,
        expectedCampaignRevision: value(
          await h.campaigns.open(ctxFor(h.users.gm), { campaignId: id }),
        ).revision,
        expectedCharacterRevision: own.revision,
        acknowledgedDisclosure: true,
        idempotencyKey: randomUUID(),
      }),
    );
    const placed = value(
        await place({ ...own, revision: adopted.revision }, t),
      ),
      entryId = Object.keys(placed.character.state.entries!)[0]!;
    const root = value(await act(placed.character, entryId, "sword_pool"));
    expect(root.roll?.push?.attempt).toBe(0);
    const oldId = root.roll!.push!.rollId;
    value(
      await h.campaigns.removeMember(ctxFor(h.users.gm), {
        campaignId: id,
        userId: h.users.player.actorId,
        expectedCampaignRevision: value(
          await h.campaigns.open(ctxFor(h.users.gm), { campaignId: id }),
        ).revision,
        idempotencyKey: randomUUID(),
      }),
    );
    const returned = value(
      await h.characters.open(ctxFor(h.users.player), own.characterId),
    );
    expect(returned.campaignId).toBeNull();
    expect(
      (
        await h.characters.apply(ctxFor(h.users.player), {
          kind: "pushRoll",
          characterId: own.characterId,
          parentRollId: oldId,
          expectedRevision: returned.revision,
          idempotencyKey: randomUUID(),
        })
      ).ok,
    ).toBe(false);
    const fresh = value(await act(returned, entryId, "sword_pool"));
    const parentId = fresh.roll!.push!.rollId;
    const push = () =>
      h.characters.apply(ctxFor(h.users.player), {
        kind: "pushRoll",
        characterId: own.characterId,
        parentRollId: parentId,
        expectedRevision: fresh.character.revision,
        idempotencyKey: randomUUID(),
      });
    const raced = await Promise.all([push(), push()]);
    expect(raced.filter((r) => r.ok)).toHaveLength(1);
    expect(
      (
        await h.pool.query(
          "SELECT count(*)::int AS n FROM character_rolls WHERE parent_roll_id=$1",
          [parentId],
        )
      ).rows[0].n,
    ).toBe(1);
    const duplicate = value(
      await h.characters.duplicate(ctxFor(h.users.player), {
        characterId: own.characterId,
        idempotencyKey: randomUUID(),
      }),
    );
    expect((await act(duplicate, entryId, "sword_hit")).ok).toBe(true);
    expect(
      value(
        await h.characters.listEntryTemplates(ctxFor(h.users.player), {
          characterId: own.characterId,
        }),
      ).some((t) => t.source?.kind === "campaign"),
    ).toBe(false);
    expect(
      (await h.characters.open(ctxFor(h.users.gm), own.characterId)).ok,
    ).toBe(false);
  });
});
