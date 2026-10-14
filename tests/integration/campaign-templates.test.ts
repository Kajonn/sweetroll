import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildI6Harness, ctxFor, type I6Harness } from "./i6-app.js";
import { compileDocument } from "../../src/systems/implementation/rules/compile-document.js";
import { d20Document } from "../../src/systems/implementation/package/fixtures/index.js";
import type { CampaignResult } from "../../src/campaigns/index.js";
import type { CampaignTemplateView } from "../../src/campaigns/templates.js";
import type {
  CharacterCommand,
  CharacterResult,
} from "../../src/characters/index.js";
const describeDB = process.env.TEST_DATABASE_URL ? describe : describe.skip;
function value<T>(result: CampaignResult<T> | CharacterResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}
describeDB("data-only campaign templates", () => {
  let h: I6Harness;
  let pause = false;
  let signal: () => void;
  let resume: () => void;
  beforeAll(async () => {
    const document = structuredClone(d20Document);
    document.slots = [
      {
        id: "inventory",
        label: "Inventory",
        accepts: ["item", "spell", "talent", "effect"],
      },
    ];
    document.slots.push({
      id: "limited",
      label: "Limited",
      accepts: ["item"],
      maxEntries: 1,
    });
    document.sheets[0]!.sections[0]!.elements.push({
      kind: "slot",
      id: "inventory_element",
      slotId: "inventory",
    });
    h = await buildI6Harness({
      document,
      wrapRuntime: (runtime) => ({
        ...runtime,
        resolve: async (request) => {
          if (
            pause &&
            request.intent.kind === "observe" &&
            Object.values(request.state?.entries ?? {}).some(
              (e) => e.source?.kind === "campaign",
            )
          ) {
            pause = false;
            signal();
            await new Promise<void>((r) => {
              resume = r;
            });
          }
          return runtime.resolve(request);
        },
      }),
    });
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
        title: "Template test",
        description: "",
        idempotencyKey: randomUUID(),
      }),
    );
    for (const [who, role] of [
      ["player", "player"],
      ["other", "co_gm"],
    ] as const)
      await h.pool.query(
        "INSERT INTO campaign_members(campaign_id,user_id,role,status,generation) VALUES($1,$2,$3,'active',1)",
        [c.campaignId, h.users[who].actorId, role],
      );
    return c.campaignId;
  }
  async function template(
    campaignId: string,
    kind: CampaignTemplateView["kind"] = "item",
  ) {
    return value(
      await h.campaigns.createTemplate(ctxFor(h.users.gm), {
        campaignId,
        kind,
        content: {
          name: "Tower key",
          notes: "Opens gate",
          ...(kind === "item" ? { defaultQuantity: 3 } : {}),
        },
        expectedTemplateRevision: 0,
        idempotencyKey: randomUUID(),
      }),
    );
  }
  async function hero(campaignId: string) {
    const rev = value(
      await h.campaigns.open(ctxFor(h.users.gm), { campaignId }),
    ).revision;
    const response = await h.app.inject({
      method: "POST",
      url: `/campaigns/${campaignId}/characters`,
      headers: { cookie: h.users.gm.cookie },
      payload: {
        name: "Hero",
        entityDefinitionId: "character",
        controllerUserIds: [h.users.player.actorId],
        expectedCampaignRevision: rev,
        idempotencyKey: randomUUID(),
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().character.characterId as string;
  }
  function add(
    characterId: string,
    t: CampaignTemplateView,
    revision = 1,
  ): CharacterCommand {
    return {
      kind: "addEntry",
      characterId,
      entry: {
        entryId: randomUUID(),
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
      expectedRevision: revision,
      idempotencyKey: randomUUID(),
    };
  }
  it("allows GM/co-GM publication, denies player writes and outside reads, and paginates before disclosure", async () => {
    const id = await campaign();
    const t = await template(id);
    const co = value(
      await h.campaigns.createTemplate(ctxFor(h.users.other), {
        campaignId: id,
        kind: "spell",
        content: { name: "Spark" },
        expectedTemplateRevision: 0,
        idempotencyKey: randomUUID(),
      }),
    );
    expect(co.kind).toBe("spell");
    expect(
      await h.campaigns.createTemplate(ctxFor(h.users.player), {
        campaignId: id,
        kind: "item",
        content: { name: "Denied" },
        expectedTemplateRevision: 0,
        idempotencyKey: randomUUID(),
      }),
    ).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(
      await h.campaigns.openTemplate(ctxFor(h.users.outsider), {
        campaignId: id,
        templateId: t.templateId,
      }),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
    const page = value(
      await h.campaigns.listTemplates(ctxFor(h.users.player), {
        campaignId: id,
        limit: 1,
      }),
    );
    expect(page.templates).toHaveLength(1);
    expect(page.nextCursor).not.toBeNull();
    const next = value(
      await h.campaigns.listTemplates(ctxFor(h.users.player), {
        campaignId: id,
        limit: 1,
        cursor: page.nextCursor,
      }),
    );
    expect(next.templates).toHaveLength(1);
    expect(next.templates[0]!.templateId).not.toBe(
      page.templates[0]!.templateId,
    );
    expect(
      await h.campaigns.listTemplates(ctxFor(h.users.player), {
        campaignId: await campaign(),
        cursor: page.nextCursor,
      }),
    ).toMatchObject({ ok: false, error: { code: "bad_request" } });
    expect(
      await h.campaigns.openTemplate(ctxFor(h.users.gm), {
        campaignId: await campaign(),
        templateId: t.templateId,
      }),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
  });
  it("separates immutable content revision from archive/recover and preserves local copies", async () => {
    const id = await campaign();
    const t = await template(id);
    const char = await hero(id);
    const command = add(char, t);
    const placed = value(
      await h.characters.apply(ctxFor(h.users.player), command),
    );
    const copy = Object.values(placed.character.state.entries!)[0]!;
    expect(copy).toMatchObject({
      templateId: null,
      source: { kind: "campaign", contentRevision: 1 },
      values: { name: "Tower key", notes: "Opens gate" },
      quantity: 3,
      snapshot: { kind: "item" },
    });
    const updated = value(
      await h.campaigns.updateTemplate(ctxFor(h.users.other), {
        campaignId: id,
        templateId: t.templateId,
        content: { name: "Silver key", defaultQuantity: 2 },
        expectedTemplateRevision: 1,
        idempotencyKey: randomUUID(),
      }),
    );
    expect(updated).toMatchObject({ revision: 2, contentRevision: 2 });
    expect(
      value(await h.characters.open(ctxFor(h.users.player), char)).state
        .entries?.[copy.entryId]?.values.name,
    ).toBe("Tower key");
    expect(
      value(
        await h.characters.apply(ctxFor(h.users.player), add(char, updated, 2)),
      ).character.revision,
    ).toBe(3);
    const archived = value(
      await h.campaigns.archiveTemplate(ctxFor(h.users.gm), {
        campaignId: id,
        templateId: t.templateId,
        expectedTemplateRevision: 2,
        idempotencyKey: randomUUID(),
      }),
    );
    expect(archived).toMatchObject({
      revision: 3,
      contentRevision: 2,
      status: "archived",
    });
    expect(
      value(
        await h.campaigns.listTemplates(ctxFor(h.users.player), {
          campaignId: id,
        }),
      ).templates,
    ).toEqual([]);
    expect(
      await h.campaigns.openTemplate(ctxFor(h.users.player), {
        campaignId: id,
        templateId: t.templateId,
      }),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(
      await h.characters.apply(ctxFor(h.users.player), add(char, updated, 3)),
    ).toMatchObject({ ok: false, error: { code: "conflict" } });
    // A committed retry remains revision 1 after edit/archive.
    const replay = value(
      await h.characters.apply(ctxFor(h.users.player), command),
    );
    expect(replay.character.reconciliation.replayed).toBe(true);
    expect(Object.values(replay.character.state.entries!)[0]?.values.name).toBe(
      "Tower key",
    );
    const edit = value(
      await h.characters.apply(ctxFor(h.users.player), {
        kind: "updateEntryValues",
        characterId: char,
        entryId: copy.entryId,
        values: { notes: "Used once" },
        quantity: 2,
        expectedRevision: 3,
        idempotencyKey: randomUUID(),
      }),
    );
    expect(
      edit.character.state.entries?.[copy.entryId]?.snapshot?.values.notes,
    ).toBe("Opens gate");
    const recovered = value(
      await h.campaigns.recoverTemplate(ctxFor(h.users.gm), {
        campaignId: id,
        templateId: t.templateId,
        expectedTemplateRevision: 3,
        idempotencyKey: randomUUID(),
      }),
    );
    expect(recovered).toMatchObject({
      revision: 4,
      contentRevision: 2,
      status: "active",
    });
    expect(
      (
        await h.pool.query(
          "SELECT content_revision FROM campaign_item_template_revisions WHERE template_id=$1 ORDER BY content_revision",
          [t.templateId],
        )
      ).rows,
    ).toEqual([{ content_revision: 1 }, { content_revision: 2 }]);
    expect(
      JSON.stringify(
        value(
          await h.characters.exportCharacter(ctxFor(h.users.player), {
            characterId: char,
          }),
        ),
      ),
    ).toContain("Used once");
  });
  it.each(["item", "spell", "talent", "effect"] as const)(
    "places a compatible %s snapshot without granting actions",
    async (kind) => {
      const id = await campaign();
      const t = await template(id, kind);
      const char = await hero(id);
      const result = value(
        await h.characters.apply(ctxFor(h.users.player), add(char, t)),
      );
      expect(
        Object.values(result.character.state.entries!)[0]?.snapshot?.kind,
      ).toBe(kind);
      expect(
        result.character.projection.sheets
          .flatMap((s) => s.sections.flatMap((s) => s.elements))
          .filter((e) => e.kind === "action" && e.entryId !== undefined),
      ).toEqual([]);
    },
  );
  it("enforces compatibility, capacity, current GM authority and untrusted snapshots", async () => {
    const id = await campaign();
    const item = await template(id);
    const spell = await template(id, "spell");
    const char = await hero(id);
    const wrong = add(char, spell);
    if (wrong.kind === "addEntry") wrong.entry.slotId = "limited";
    expect(
      await h.characters.apply(ctxFor(h.users.player), wrong),
    ).toMatchObject({ ok: false, error: { code: "invalid_value" } });
    const first = add(char, item);
    if (first.kind === "addEntry") first.entry.slotId = "limited";
    value(await h.characters.apply(ctxFor(h.users.gm), first));
    const full = add(char, item, 2);
    if (full.kind === "addEntry") full.entry.slotId = "limited";
    expect(await h.characters.apply(ctxFor(h.users.other), full)).toMatchObject(
      { ok: false, error: { code: "invalid_value" } },
    );
    const forged = add(char, item, 2);
    if (forged.kind === "addEntry")
      Object.assign(forged.entry, {
        snapshot: { kind: "item", values: { name: "Injected" } },
      });
    expect(
      await h.characters.apply(ctxFor(h.users.player), forged),
    ).toMatchObject({ ok: false, error: { code: "bad_request" } });
    const http = await h.app.inject({
      method: "POST",
      url: `/characters/${char}/entries`,
      headers: { cookie: h.users.player.cookie },
      payload:
        forged.kind === "addEntry"
          ? {
              entry: forged.entry,
              expectedRevision: 2,
              idempotencyKey: randomUUID(),
            }
          : null,
    });
    expect(http.statusCode).toBe(400);
    expect(
      await h.campaigns.listTemplates(ctxFor(h.users.player), {
        campaignId: id,
        status: "archived",
      }),
    ).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(
      await h.campaigns.archiveTemplate(ctxFor(h.users.player), {
        campaignId: id,
        templateId: item.templateId,
        expectedTemplateRevision: 1,
        idempotencyKey: randomUUID(),
      }),
    ).toMatchObject({ ok: false, error: { code: "forbidden" } });
    const second = await template(id);
    const edits = await Promise.all(
      [item, second].map((t) =>
        h.campaigns.updateTemplate(ctxFor(h.users.gm), {
          campaignId: id,
          templateId: t.templateId,
          content: { name: "Independent" },
          expectedTemplateRevision: 1,
          idempotencyKey: randomUUID(),
        }),
      ),
    );
    expect(edits.every((r) => r.ok)).toBe(true);
  });
  it("serializes concurrent catalog writes, retries and receipt reauthorization", async () => {
    const id = await campaign();
    const input = {
      campaignId: id,
      kind: "item" as const,
      content: { name: "Coin" },
      expectedTemplateRevision: 0,
      idempotencyKey: randomUUID(),
    };
    const [a, b] = await Promise.all([
      h.campaigns.createTemplate(ctxFor(h.users.gm), input),
      h.campaigns.createTemplate(ctxFor(h.users.gm), input),
    ]);
    expect(value(a)).toEqual(value(b));
    const t = value(a);
    const edit = {
      campaignId: id,
      templateId: t.templateId,
      content: { name: "Copper" },
      expectedTemplateRevision: 1,
      idempotencyKey: randomUUID(),
    };
    const results = await Promise.all([
      h.campaigns.updateTemplate(ctxFor(h.users.gm), edit),
      h.campaigns.updateTemplate(ctxFor(h.users.other), {
        ...edit,
        content: { name: "Silver" },
        idempotencyKey: randomUUID(),
      }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({
      error: { code: "conflict" },
    });
    expect(
      await h.campaigns.createTemplate(ctxFor(h.users.gm), {
        ...input,
        content: { name: "Different" },
      }),
    ).toMatchObject({ ok: false, error: { code: "idempotency_mismatch" } });
    await h.pool.query(
      "UPDATE campaign_members SET status='removed',generation=generation+1 WHERE campaign_id=$1 AND user_id=$2",
      [id, h.users.gm.actorId],
    );
    expect(
      await h.campaigns.createTemplate(ctxFor(h.users.gm), input),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
  });
  it("denies standalone, wrong campaign, stale revision, forged values and revoked placement/replay", async () => {
    const id = await campaign();
    const t = await template(id);
    const char = await hero(id);
    const single = value(
      await h.characters.create(ctxFor(h.users.player), {
        systemVersionId: h.versionId,
        entityDefinitionId: "character",
        name: "Independent",
        idempotencyKey: randomUUID(),
      }),
    );
    expect(
      await h.characters.apply(
        ctxFor(h.users.player),
        add(single.characterId, t),
      ),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(
      await h.characters.apply(
        ctxFor(h.users.player),
        add(char, { ...t, campaignId: await campaign() }),
      ),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(
      await h.characters.apply(
        ctxFor(h.users.player),
        add(char, { ...t, revision: 9 }),
      ),
    ).toMatchObject({ ok: false, error: { code: "conflict" } });
    const forged = add(char, t);
    if (forged.kind === "addEntry")
      forged.entry.values = { name: "Forged", actions: [] };
    expect(
      await h.characters.apply(ctxFor(h.users.player), forged),
    ).toMatchObject({ ok: false, error: { code: "bad_request" } });
    const command = add(char, t);
    value(await h.characters.apply(ctxFor(h.users.player), command));
    const revision = value(
      await h.campaigns.open(ctxFor(h.users.gm), { campaignId: id }),
    ).revision;
    value(
      await h.campaigns.removeMember(ctxFor(h.users.gm), {
        campaignId: id,
        userId: h.users.player.actorId,
        expectedCampaignRevision: revision,
        idempotencyKey: randomUUID(),
      }),
    );
    expect(
      await h.characters.apply(ctxFor(h.users.player), command),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(
      await h.characters.listEntryTemplates(ctxFor(h.users.player), {
        characterId: char,
      }),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
  });
  it("rechecks the selected template inside the character commit transaction after a racing archive", async () => {
    const id = await campaign();
    const t = await template(id);
    const char = await hero(id);
    pause = true;
    const paused = new Promise<void>((r) => {
      signal = r;
    });
    const pending = h.characters.apply(ctxFor(h.users.player), add(char, t));
    await paused;
    value(
      await h.campaigns.archiveTemplate(ctxFor(h.users.gm), {
        campaignId: id,
        templateId: t.templateId,
        expectedTemplateRevision: 1,
        idempotencyKey: randomUUID(),
      }),
    );
    resume();
    expect(await pending).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
    const current = value(
      await h.characters.open(ctxFor(h.users.player), char),
    );
    expect(current.revision).toBe(1);
    expect(current.state.entries).toEqual({});
  });
  it("keeps snapshots on returned and duplicated sheets while removing live catalog access", async () => {
    const id = await campaign();
    const t = await template(id);
    const own = value(
      await h.characters.create(ctxFor(h.users.player), {
        systemVersionId: h.versionId,
        entityDefinitionId: "character",
        name: "Return me",
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
      await h.characters.apply(
        ctxFor(h.users.player),
        add(own.characterId, t, adopted.revision),
      ),
    );
    const entry = Object.values(placed.character.state.entries!)[0]!;
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
    expect(returned.state.entries?.[entry.entryId]).toEqual(entry);
    expect(
      value(
        await h.characters.listEntryTemplates(ctxFor(h.users.player), {
          characterId: own.characterId,
        }),
      ).some((t) => t.source?.kind === "campaign"),
    ).toBe(false);
    expect(
      await h.campaigns.listTemplates(ctxFor(h.users.player), {
        campaignId: id,
      }),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
    const copied = value(
      await h.characters.duplicate(ctxFor(h.users.player), {
        characterId: own.characterId,
        idempotencyKey: randomUUID(),
      }),
    );
    expect(copied.state.entries?.[entry.entryId]).toEqual(entry);
    const edited = value(
      await h.characters.apply(ctxFor(h.users.player), {
        kind: "updateEntryValues",
        characterId: own.characterId,
        entryId: entry.entryId,
        values: { notes: "Kept after return" },
        expectedRevision: returned.revision,
        idempotencyKey: randomUUID(),
      }),
    );
    expect(edited.character.state.entries?.[entry.entryId]?.values.notes).toBe(
      "Kept after return",
    );
  });
  it("blocks campaign and standalone migration and rollback without discarding entries", async () => {
    const target = randomUUID();
    const document = structuredClone(d20Document);
    document.slots = [
      {
        id: "inventory",
        label: "Inventory",
        accepts: ["item", "spell", "talent", "effect"],
      },
    ];
    document.sheets[0]!.sections[0]!.elements.push({
      kind: "slot",
      id: "inventory_element",
      slotId: "inventory",
    });
    const compiled = compileDocument(document, {
      systemId: h.systemId,
      versionId: target,
      semanticVersion: "2.0.0",
    });
    if (!compiled.ok) throw new Error("fixture compile failed");
    await h.pool.query(
      "INSERT INTO system_versions(id,system_id,semantic_version,checksum,package_json,lifecycle) VALUES($1,$2,'2.0.0',$3,$4,'published')",
      [target, h.systemId, compiled.value.integrity.checksum, compiled.value],
    );
    const id = await campaign();
    const t = await template(id);
    const char = await hero(id);
    value(await h.characters.apply(ctxFor(h.users.player), add(char, t)));
    expect(
      await h.campaigns.previewUpgrade(ctxFor(h.users.gm), {
        campaignId: id,
        targetVersionId: target,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "conflict", message: expect.stringMatching(/entries/i) },
    });
    expect(
      await h.campaigns.commitUpgrade(ctxFor(h.users.gm), {
        campaignId: id,
        targetVersionId: target,
        expectedCampaignRevision: value(
          await h.campaigns.open(ctxFor(h.users.gm), { campaignId: id }),
        ).revision,
        idempotencyKey: randomUUID(),
      }),
    ).toMatchObject({ ok: false, error: { code: "conflict" } });
    const own = value(
      await h.characters.create(ctxFor(h.users.player), {
        systemVersionId: h.versionId,
        entityDefinitionId: "character",
        name: "Migration guard",
        idempotencyKey: randomUUID(),
      }),
    );
    const preview = value(
      await h.characters.previewMigration(ctxFor(h.users.player), {
        characterId: own.characterId,
        targetVersionId: target,
      }),
    );
    const migrated = value(
      await h.characters.commitMigration(ctxFor(h.users.player), {
        characterId: own.characterId,
        previewId: preview.previewId,
        expectedRevision: own.revision,
        idempotencyKey: randomUUID(),
      }),
    );
    const migration = (
      await h.pool.query(
        "SELECT id FROM character_migrations WHERE character_id=$1",
        [own.characterId],
      )
    ).rows[0].id;
    const changed = value(
      await h.characters.apply(ctxFor(h.users.player), {
        kind: "addEntry",
        characterId: own.characterId,
        entry: {
          entryId: randomUUID(),
          slotId: "inventory",
          templateId: null,
          values: { name: "Keep me" },
        },
        expectedRevision: migrated.character.revision,
        idempotencyKey: randomUUID(),
      }),
    );
    expect(
      await h.characters.rollbackMigration(ctxFor(h.users.player), {
        characterId: own.characterId,
        migrationId: migration,
        idempotencyKey: randomUUID(),
      }),
    ).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(
      await h.characters.previewMigration(ctxFor(h.users.player), {
        characterId: own.characterId,
        targetVersionId: h.versionId,
      }),
    ).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(
      value(await h.characters.open(ctxFor(h.users.player), own.characterId))
        .state,
    ).toEqual(changed.character.state);
  });
  it("publishes through HTTP and rejects client definitions without leaking catalog data", async () => {
    const id = await campaign();
    const path = `/campaigns/${id}/item-templates`;
    const create = await h.app.inject({
      method: "POST",
      url: path,
      headers: { cookie: h.users.gm.cookie },
      payload: {
        kind: "item",
        content: { name: "HTTP key" },
        expectedTemplateRevision: 0,
        idempotencyKey: randomUUID(),
      },
    });
    expect(create.statusCode, create.body).toBe(201);
    const denied = await h.app.inject({
      method: "GET",
      url: path,
      headers: { cookie: h.users.outsider.cookie },
    });
    expect(denied.statusCode).toBe(404);
    expect(denied.body).not.toContain("HTTP key");
    const forged = await h.app.inject({
      method: "POST",
      url: path,
      headers: { cookie: h.users.gm.cookie },
      payload: {
        kind: "item",
        content: { name: "Poison", actions: [{ expression: "d20" }] },
        expectedTemplateRevision: 0,
        idempotencyKey: randomUUID(),
      },
    });
    expect(forged.statusCode).toBe(400);
    const exportDoc = value(
      await h.campaigns.exportCampaign(ctxFor(h.users.gm), {
        campaignId: id,
        idempotencyKey: randomUUID(),
      }),
    );
    expect(exportDoc.templates?.[0]?.content.name).toBe("HTTP key");
  });
});
