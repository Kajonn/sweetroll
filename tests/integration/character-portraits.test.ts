import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ImageScanner } from "../../src/platform/image-processing.js";
import { buildI6Harness, ctxFor, type I6Harness } from "./i6-app.js";

const describeDB = process.env.TEST_DATABASE_URL ? describe : describe.skip;
describeDB("M1 character portraits", () => {
  let h: I6Harness, dir: string, png: string;
  let scan: ImageScanner = async () => "clean";
  beforeEach(() => {
    scan = async () => "clean";
  });
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "sweetroll-portraits-"));
    process.env.SWEETROLL_MEDIA_DIR = dir;
    h = await buildI6Harness({ scanImage: (bytes) => scan(bytes) });
    await h.pool.query("UPDATE systems SET access='public' WHERE id=$1", [
      h.systemId,
    ]);
    png = (
      await sharp({
        create: { width: 40, height: 20, channels: 3, background: "#235477" },
      })
        .png()
        .toBuffer()
    ).toString("base64");
  });
  afterAll(async () => {
    await h?.close();
    delete process.env.SWEETROLL_MEDIA_DIR;
    if (dir) await rm(dir, { recursive: true, force: true });
  });
  async function character() {
    const r = await h.characters.create(ctxFor(h.users.player), {
      name: "Portrait hero",
      systemVersionId: h.versionId,
      entityDefinitionId: "character",
      idempotencyKey: randomUUID(),
    });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    return r.value;
  }
  const body = (id: string, revision: number, portraitRevision = 0) => ({
    characterId: id,
    expectedCharacterRevision: revision,
    expectedPortraitRevision: portraitRevision,
    contentType: "image/png" as const,
    dataBase64: png,
    description: "A blue-cloaked explorer",
    idempotencyKey: randomUUID(),
  });
  it("uploads, replays, replaces and removes independently of rules state", async () => {
    const ch = await character(),
      input = body(ch.characterId, ch.revision);
    const first = await h.characters.setPortrait(ctxFor(h.users.player), input);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value).toMatchObject({
      revision: 1,
      portrait: { description: input.description, width: 40, height: 20 },
    });
    expect(
      await h.characters.setPortrait(ctxFor(h.users.player), input),
    ).toEqual(first);
    expect(
      await h.characters.open(ctxFor(h.users.player), ch.characterId),
    ).toMatchObject({ ok: true, value: { revision: ch.revision } });
    expect(
      await h.characters.setPortrait(ctxFor(h.users.player), {
        ...input,
        description: "Different",
      }),
    ).toMatchObject({ ok: false, error: { code: "idempotency_mismatch" } });
    expect(
      await h.characters.setPortrait(ctxFor(h.users.player), {
        ...input,
        idempotencyKey: randomUUID(),
      }),
    ).toMatchObject({ ok: false, error: { code: "conflict" } });
    const replaced = await h.characters.setPortrait(ctxFor(h.users.player), {
      ...body(ch.characterId, ch.revision, 1),
      description: "A new explorer",
    });
    expect(replaced).toMatchObject({ ok: true, value: { revision: 2 } });
    expect(
      await h.characters.openPortraitImage(ctxFor(h.users.player), {
        characterId: ch.characterId,
        fileId: first.value.portrait!.fileId,
        thumbnail: false,
      }),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
    const removed = await h.characters.removePortrait(ctxFor(h.users.player), {
      characterId: ch.characterId,
      expectedCharacterRevision: ch.revision,
      expectedPortraitRevision: 2,
      idempotencyKey: randomUUID(),
    });
    expect(removed).toEqual({
      ok: true,
      value: { revision: 3, portrait: null },
    });
  });
  it("denies another player and system author, including direct byte reads", async () => {
    const ch = await character();
    const added = await h.characters.setPortrait(
      ctxFor(h.users.player),
      body(ch.characterId, ch.revision),
    );
    if (!added.ok || !added.value.portrait)
      throw new Error("Portrait upload failed");
    for (const actor of [h.users.gm, h.users.other, h.users.outsider]) {
      expect(
        await h.characters.openPortrait(ctxFor(actor), {
          characterId: ch.characterId,
        }),
      ).toMatchObject({ ok: false, error: { code: "not_found" } });
      expect(
        await h.characters.openPortraitImage(ctxFor(actor), {
          characterId: ch.characterId,
          fileId: added.value.portrait.fileId,
          thumbnail: true,
        }),
      ).toMatchObject({ ok: false, error: { code: "not_found" } });
      expect(
        await h.characters.setPortrait(
          ctxFor(actor),
          body(ch.characterId, ch.revision, 1),
        ),
      ).toMatchObject({ ok: false, error: { code: "not_found" } });
    }
    const thumb = await h.characters.openPortraitImage(ctxFor(h.users.player), {
      characterId: ch.characterId,
      fileId: added.value.portrait.fileId,
      thumbnail: true,
    });
    expect(thumb.ok).toBe(true);
    if (thumb.ok)
      expect((await sharp(thumb.value.bytes).metadata()).format).toBe("webp");
  });
  it("retains current portrait after ownership transfer and denies old retries", async () => {
    const ch = await character(),
      input = body(ch.characterId, ch.revision);
    const added = await h.characters.setPortrait(ctxFor(h.users.player), input);
    if (!added.ok) throw new Error("Upload failed");
    const moved = await h.characters.manage(ctxFor(h.users.player), {
      kind: "transferOwnership",
      characterId: ch.characterId,
      expectedRevision: ch.revision,
      toUserId: h.users.other.actorId,
      idempotencyKey: randomUUID(),
    });
    expect(moved.ok).toBe(true);
    expect(
      await h.characters.openPortrait(ctxFor(h.users.other), {
        characterId: ch.characterId,
      }),
    ).toEqual(added);
    expect(
      await h.characters.setPortrait(ctxFor(h.users.player), input),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
  });
  it("duplicates a retained immutable image under independent character authority", async () => {
    const ch = await character();
    const added = await h.characters.setPortrait(
      ctxFor(h.users.player),
      body(ch.characterId, ch.revision),
    );
    if (!added.ok || !added.value.portrait) throw new Error("Upload failed");
    const copy = await h.characters.duplicate(ctxFor(h.users.player), {
      characterId: ch.characterId,
      idempotencyKey: randomUUID(),
    });
    if (!copy.ok) throw new Error(JSON.stringify(copy.error));
    expect(
      await h.characters.openPortrait(ctxFor(h.users.player), {
        characterId: copy.value.characterId,
      }),
    ).toEqual(added);
    await h.characters.removePortrait(ctxFor(h.users.player), {
      characterId: ch.characterId,
      expectedCharacterRevision: ch.revision,
      expectedPortraitRevision: 1,
      idempotencyKey: randomUUID(),
    });
    expect(
      await h.characters.openPortraitImage(ctxFor(h.users.player), {
        characterId: copy.value.characterId,
        fileId: added.value.portrait.fileId,
        thumbnail: false,
      }),
    ).toMatchObject({ ok: true });
    const assets = await h.pool.query(
      "SELECT count(*)::int count FROM character_image_assets WHERE id=$1",
      [added.value.portrait.fileId],
    );
    expect(assets.rows[0].count).toBe(1);
  });
  it("serves bounded private portrait HTTP workflows without caching", async () => {
    const ch = await character(),
      input = body(ch.characterId, ch.revision);
    const { characterId: _, ...payload } = input;
    const url = `/characters/${ch.characterId}/portrait`;
    const headers = { cookie: h.users.player.cookie };
    const initial = await h.app.inject({ method: "GET", url, headers });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({ revision: 0, portrait: null });
    const uploaded = await h.app.inject({
      method: "PUT",
      url,
      headers,
      payload,
    });
    expect(uploaded.statusCode).toBe(200);
    const fileId = uploaded.json().portrait.fileId;
    for (const suffix of [`/${fileId}`, `/${fileId}/thumbnail`, "/thumbnail"]) {
      const read = await h.app.inject({
        method: "GET",
        url: url + suffix,
        headers,
      });
      expect(read.statusCode).toBe(200);
      expect(read.headers["cache-control"]).toBe("private, no-store");
      expect(read.headers["x-content-type-options"]).toBe("nosniff");
      expect((await sharp(read.rawPayload).metadata()).width).toBeGreaterThan(
        0,
      );
      const denied = await h.app.inject({
        method: "GET",
        url: url + suffix,
        headers: { cookie: h.users.outsider.cookie },
      });
      expect(denied.statusCode).toBe(404);
      expect(denied.headers["cache-control"]).toBe("private, no-store");
    }
    expect(
      (
        await h.app.inject({
          method: "PUT",
          url,
          headers,
          payload: { ...payload, extra: true },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await h.app.inject({
          method: "PUT",
          url,
          headers,
          payload: { ...payload, dataBase64: "A".repeat(8 * 1024 * 1024) },
        })
      ).statusCode,
    ).toBe(413);
    expect(
      (
        await h.app.inject({
          method: "DELETE",
          url,
          headers,
          payload: {
            expectedCharacterRevision: ch.revision,
            expectedPortraitRevision: 1,
            idempotencyKey: randomUUID(),
          },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await h.app.inject({ method: "GET", url: `${url}/${fileId}`, headers }))
        .statusCode,
    ).toBe(404);
  });
  it("preserves the portrait on adoption/return and applies current campaign roles", async () => {
    const ch = await character();
    const added = await h.characters.setPortrait(
      ctxFor(h.users.player),
      body(ch.characterId, ch.revision),
    );
    const campaign = await h.campaigns.create(ctxFor(h.users.gm), {
      systemVersionId: h.versionId,
      title: "Portrait adventure",
      description: "",
      idempotencyKey: randomUUID(),
    });
    if (!campaign.ok) throw new Error("Campaign failed");
    const campaignId = campaign.value.campaignId;
    for (const user of [h.users.player, h.users.other])
      await h.pool.query(
        "INSERT INTO campaign_members(campaign_id,user_id,role,status,generation) VALUES ($1,$2,'player','active',1)",
        [campaignId, user.actorId],
      );
    const adopted = await h.campaigns.adoptCampaignCharacter(
      ctxFor(h.users.player),
      {
        campaignId,
        characterId: ch.characterId,
        expectedCampaignRevision: campaign.value.revision,
        expectedCharacterRevision: ch.revision,
        acknowledgedDisclosure: true,
        idempotencyKey: randomUUID(),
      },
    );
    expect(adopted.ok).toBe(true);
    expect(
      await h.characters.openPortrait(ctxFor(h.users.gm), {
        characterId: ch.characterId,
      }),
    ).toEqual(added);
    expect(
      await h.characters.openPortrait(ctxFor(h.users.other), {
        characterId: ch.characterId,
      }),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
    await h.pool.query(
      "UPDATE campaign_members SET role='co_gm' WHERE campaign_id=$1 AND user_id=$2",
      [campaignId, h.users.other.actorId],
    );
    expect(
      await h.characters.openPortrait(ctxFor(h.users.other), {
        characterId: ch.characterId,
      }),
    ).toEqual(added);
    const opened = await h.campaigns.open(ctxFor(h.users.gm), { campaignId });
    if (!opened.ok) throw new Error("Campaign unavailable");
    const returned = await h.campaigns.removeMember(ctxFor(h.users.gm), {
      campaignId,
      userId: h.users.player.actorId,
      expectedCampaignRevision: opened.value.revision,
      idempotencyKey: randomUUID(),
    });
    expect(returned.ok).toBe(true);
    expect(
      await h.characters.openPortrait(ctxFor(h.users.player), {
        characterId: ch.characterId,
      }),
    ).toEqual(added);
    for (const user of [h.users.gm, h.users.other])
      expect(
        await h.characters.openPortrait(ctxFor(user), {
          characterId: ch.characterId,
        }),
      ).toMatchObject({ ok: false, error: { code: "not_found" } });
  });
  it("preserves prior bytes on scan errors, stale commits and failed storage writes", async () => {
    const ch = await character();
    const added = await h.characters.setPortrait(
      ctxFor(h.users.player),
      body(ch.characterId, ch.revision),
    );
    const before = await readdir(join(dir, "portraits"));
    for (const mode of ["infected", "unavailable"] as const) {
      scan = async () => {
        if (mode === "unavailable") throw new Error("private scanner detail");
        return "infected";
      };
      expect(
        await h.characters.setPortrait(
          ctxFor(h.users.player),
          body(ch.characterId, ch.revision, 1),
        ),
      ).toMatchObject({
        ok: false,
        error: {
          code:
            mode === "infected" ? "unprocessable" : "temporarily_unavailable",
        },
      });
    }
    scan = async () => {
      await h.pool.query(
        "UPDATE characters SET revision=revision+1 WHERE id=$1",
        [ch.characterId],
      );
      return "clean";
    };
    expect(
      await h.characters.setPortrait(
        ctxFor(h.users.player),
        body(ch.characterId, ch.revision, 1),
      ),
    ).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect((await readdir(join(dir, "portraits"))).sort()).toEqual(
      before.sort(),
    );
    scan = async () => "clean";
    const blockedRoot = join(dir, "not-a-directory");
    await writeFile(blockedRoot, "blocked");
    process.env.SWEETROLL_MEDIA_DIR = blockedRoot;
    try {
      expect(
        await h.characters.setPortrait(
          ctxFor(h.users.player),
          body(ch.characterId, ch.revision + 1, 1),
        ),
      ).toMatchObject({ ok: false, error: { code: "internal" } });
    } finally {
      process.env.SWEETROLL_MEDIA_DIR = dir;
    }
    expect(
      await h.characters.openPortrait(ctxFor(h.users.player), {
        characterId: ch.characterId,
      }),
    ).toEqual(added);
  });
  it("serializes competing uploads without retaining losing files", async () => {
    const ch = await character(),
      before = await readdir(join(dir, "portraits"));
    const results = await Promise.all(
      [1, 2].map(() =>
        h.characters.setPortrait(
          ctxFor(h.users.player),
          body(ch.characterId, ch.revision),
        ),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toMatchObject([
      { ok: false, error: { code: "conflict" } },
    ]);
    expect(await readdir(join(dir, "portraits"))).toHaveLength(
      before.length + 2,
    );
  });
  it("enforces both owner count and byte quotas without orphaning failed uploads", async () => {
    const ch = await character();
    const example = (
      await h.pool.query(
        "SELECT id FROM character_image_assets WHERE created_by=$1 LIMIT 1",
        [h.users.player.actorId],
      )
    ).rows[0].id;
    for (const limit of ["count", "bytes"]) {
      const usage = (
        await h.pool.query(
          "SELECT count(*)::int count FROM character_image_assets WHERE created_by=$1",
          [h.users.player.actorId],
        )
      ).rows[0].count;
      const count = limit === "count" ? 256 - usage : 20;
      const seeded = await h.pool.query(
        `INSERT INTO character_image_assets(id,created_by,storage_key,media_type,width,height,size_bytes,thumbnail_bytes,checksum,thumbnail_checksum)
        SELECT gen_random_uuid(),created_by,gen_random_uuid(),media_type,width,height,$3,thumbnail_bytes,checksum,thumbnail_checksum
        FROM character_image_assets CROSS JOIN generate_series(1,$2) WHERE id=$1 RETURNING id`,
        [example, count, limit === "bytes" ? 5242880 : 1],
      );
      const files = await readdir(join(dir, "portraits"));
      try {
        expect(
          await h.characters.setPortrait(
            ctxFor(h.users.player),
            body(ch.characterId, ch.revision),
          ),
        ).toMatchObject({ ok: false, error: { code: "too_large" } });
        expect((await readdir(join(dir, "portraits"))).sort()).toEqual(
          files.sort(),
        );
        expect(
          await h.characters.openPortrait(ctxFor(h.users.player), {
            characterId: ch.characterId,
          }),
        ).toMatchObject({ ok: true, value: { revision: 0, portrait: null } });
      } finally {
        await h.pool.query(
          "DELETE FROM character_image_assets WHERE id=ANY($1::uuid[])",
          [seeded.rows.map((r) => r.id)],
        );
      }
    }
  });
  it("retains readable art on archive but rejects fresh mutations until recovery", async () => {
    const ch = await character();
    const added = await h.characters.setPortrait(
      ctxFor(h.users.player),
      body(ch.characterId, ch.revision),
    );
    const archived = await h.characters.manage(ctxFor(h.users.player), {
      kind: "archive",
      characterId: ch.characterId,
      expectedRevision: ch.revision,
      idempotencyKey: randomUUID(),
    });
    expect(archived.ok).toBe(true);
    expect(
      await h.characters.openPortrait(ctxFor(h.users.player), {
        characterId: ch.characterId,
      }),
    ).toEqual(added);
    expect(
      await h.characters.setPortrait(
        ctxFor(h.users.player),
        body(ch.characterId, ch.revision + 1, 1),
      ),
    ).toMatchObject({ ok: false, error: { code: "conflict" } });
    const recovered = await h.characters.manage(ctxFor(h.users.player), {
      kind: "recover",
      characterId: ch.characterId,
      expectedRevision: ch.revision + 1,
      idempotencyKey: randomUUID(),
    });
    expect(recovered.ok).toBe(true);
    expect(
      await h.characters.setPortrait(
        ctxFor(h.users.player),
        body(ch.characterId, ch.revision + 2, 1),
      ),
    ).toMatchObject({ ok: true });
  });
});
