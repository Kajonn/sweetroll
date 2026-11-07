import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "pg";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createCampaignsModule, type Campaigns } from "../../src/campaigns/index.js";
import { createCampaignPersistenceRepository } from "../../src/campaigns/persistence.js";
import { createSceneEventHub, type SceneEventHub } from "../../src/campaigns/scene-events.js";
import type { DisplayProjection } from "../../src/campaigns/display.js";
import { DEFAULT_CAMPAIGN_LIMITS } from "../../src/platform/config.js";
import { buildI6Harness, ctxFor, type I6Harness } from "./i6-app.js";
import { createI3Pool } from "./i3-app.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl === undefined ? describe.skip : describe;

type StreamEvent = { event: string; data: unknown };

/** Minimal fetch-reader SSE client (the display uses the same transport). */
async function openStream(url: string, secret: string) {
  const controller = new AbortController();
  const response = await fetch(url, {
    headers: { "x-display-secret": secret },
    signal: controller.signal,
  });
  const events: StreamEvent[] = [];
  let ended = false;
  let comments = 0;
  if (response.ok && response.body !== null) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let index: number;
          while ((index = buffer.indexOf("\n\n")) >= 0) {
            const block = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            if (block.startsWith(":")) {
              comments++;
              continue;
            }
            const event = /^event: (.*)$/m.exec(block)?.[1] ?? "message";
            const data = /^data: (.*)$/m.exec(block)?.[1] ?? "null";
            events.push({ event, data: JSON.parse(data) });
          }
        }
      } catch {
        // aborted
      } finally {
        ended = true;
      }
    })();
  } else {
    ended = true;
  }
  return {
    response,
    events,
    scenes: () => events.filter((e) => e.event === "scene").map((e) => e.data as DisplayProjection),
    ended: () => ended,
    comments: () => comments,
    close: () => controller.abort(),
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const settle = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms));

describeWithDatabase("scene streaming (SSE snapshots, image revisions, fan-out)", () => {
  let h: I6Harness;
  let hubA: SceneEventHub;
  let hubB: SceneEventHub;
  let campaignsB: Campaigns;
  let poolB: ReturnType<typeof createI3Pool>;
  let base: string;
  let mediaDir: string;
  let displayDir: string;
  let pngBase64: string;
  const listenerName = `scene-events-a-${randomUUID().slice(0, 8)}`;
  const renders: string[] = [];
  const served: string[] = [];

  beforeAll(async () => {
    mediaDir = await mkdtemp(join(tmpdir(), "sweetroll-stream-media-"));
    displayDir = await mkdtemp(join(tmpdir(), "sweetroll-stream-deriv-"));
    process.env.SWEETROLL_MEDIA_DIR = mediaDir;
    process.env.SWEETROLL_DISPLAY_DIR = displayDir;
    hubA = createSceneEventHub({
      connection: { connectionString: databaseUrl, application_name: listenerName },
      retryBaseMs: 100,
    });
    await hubA.start();
    h = await buildI6Harness({
      sceneEvents: hubA,
      displayObserver: {
        onRender: (sceneId, rev) => renders.push(`${sceneId}:${rev}`),
        onSceneImageServed: (sceneId, rev) => served.push(`${sceneId}:${rev}`),
      },
      displayStream: { heartbeatMs: 200 },
    });
    // Second application instance on the same database: its own pool, its
    // own LISTEN connection and its own derivative cache path is shared here
    // only through the filesystem env (deterministic bytes either way).
    poolB = createI3Pool(h.databaseUrl, h.schema);
    hubB = createSceneEventHub({ connection: { connectionString: databaseUrl }, retryBaseMs: 100 });
    await hubB.start();
    campaignsB = createCampaignsModule({
      pool: poolB,
      limits: DEFAULT_CAMPAIGN_LIMITS,
      charactersPlacement: h.placement,
      sceneEvents: hubB,
      scanImage: async () => "clean" as const,
    });
    await h.app.listen({ host: "127.0.0.1", port: 0 });
    const address = h.app.server.address();
    if (address === null || typeof address === "string") throw new Error("expected TCP address");
    base = `http://127.0.0.1:${address.port}`;
    pngBase64 = (
      await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 10, g: 120, b: 220, alpha: 1 } } })
        .png()
        .toBuffer()
    ).toString("base64");
  });

  afterAll(async () => {
    campaignsB?.closeDisplayStreams();
    await h?.close();
    await hubA?.close();
    await hubB?.close();
    await poolB?.end();
    delete process.env.SWEETROLL_MEDIA_DIR;
    delete process.env.SWEETROLL_DISPLAY_DIR;
    await rm(mediaDir, { recursive: true, force: true });
    await rm(displayDir, { recursive: true, force: true });
  });

  async function setup() {
    const created = await h.campaigns.create(ctxFor(h.users.gm), {
      systemVersionId: h.versionId,
      title: `Stream ${randomUUID()}`,
      description: "",
      idempotencyKey: randomUUID(),
    });
    if (!created.ok) throw new Error("campaign create failed");
    const campaignId = created.value.campaignId;
    const upload = async () => {
      const uploaded = await h.campaigns.uploadImage(ctxFor(h.users.gm), {
        campaignId,
        name: "map",
        contentType: "image/png",
        dataBase64: pngBase64,
        idempotencyKey: randomUUID(),
      });
      if (!uploaded.ok) throw new Error("upload failed");
      return uploaded.value.fileId;
    };
    const fileId = await upload();
    const scene = await h.campaigns.createScene(ctxFor(h.users.gm), {
      campaignId,
      backgroundFileId: fileId,
      idempotencyKey: randomUUID(),
    });
    if (!scene.ok) throw new Error("scene create failed");
    const paired = await h.campaigns.pairDisplay(ctxFor(h.users.gm), { campaignId });
    if (!paired.ok) throw new Error("pair failed");
    const redeemed = await h.campaigns.redeemDisplayCode({ code: paired.value.code });
    if (!redeemed.ok) throw new Error("redeem failed");
    return {
      campaignId,
      fileId,
      upload,
      sceneId: scene.value.sceneId,
      display: redeemed.value,
      eventsUrl: `${base}/displays/${redeemed.value.displayId}/scenes/${scene.value.sceneId}/events`,
    };
  }

  async function currentRevision(sceneId: string): Promise<number> {
    const rows = await h.pool.query("SELECT revision FROM scenes WHERE id=$1", [sceneId]);
    return rows.rows[0].revision as number;
  }

  it("limits live pairing codes per campaign across concurrent replicas", async () => {
    const { campaignId } = await setup();
    const ctx = ctxFor(h.users.gm);
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      (index % 2 ? h.campaigns : campaignsB).pairDisplay(ctx, { campaignId }),
    ));
    const minted = results.filter((result) => result.ok);
    expect(minted).toHaveLength(5);
    expect(results.filter((result) => !result.ok).map((result) => result.error.code))
      .toEqual(["conflict", "conflict", "conflict"]);
    expect((await h.campaigns.redeemDisplayCode({ code: minted[0]!.value.code })).ok).toBe(true);
    expect((await h.campaigns.pairDisplay(ctx, { campaignId })).ok).toBe(true);
    await h.pool.query("UPDATE display_codes SET expires_at = now() - interval '1 minute' WHERE campaign_id = $1", [campaignId]);
    expect((await h.campaigns.pairDisplay(ctx, { campaignId })).ok).toBe(true);
    const count = await h.pool.query("SELECT code_hash FROM display_codes WHERE campaign_id = $1", [campaignId]);
    expect(count.rowCount).toBe(1);
  });

  it("streams complete snapshots; token moves keep the image revision and render nothing", async () => {
    const s = await setup();
    const stream = await openStream(s.eventsUrl, s.display.secret);
    expect(stream.response.status).toBe(200);
    expect(stream.response.headers.get("content-type")).toMatch(/^text\/event-stream/);
    expect(stream.response.headers.get("cache-control")).toBe("no-store");
    await waitFor(() => stream.scenes().length === 1);
    expect(stream.scenes()[0]).toMatchObject({ sceneId: s.sceneId, sceneRevision: 1, imageRevision: 1, tokens: [] });

    const reveal = await h.campaigns.applyFogEdit(ctxFor(h.users.gm), {
      sceneId: s.sceneId,
      expectedSceneRevision: 1,
      op: { mode: "reveal", runs: [{ x: 0.5, y: 0.5, r: 0.3 }] },
      idempotencyKey: randomUUID(),
    });
    if (!reveal.ok) throw new Error("reveal failed");
    await waitFor(() => stream.scenes().length === 2);
    expect(stream.scenes()[1]).toMatchObject({ sceneRevision: 2, imageRevision: 2 });

    // Concurrent image requests for one version share a single render.
    const imageUrl = `${base}${stream.scenes()[1]!.imageUrl}`;
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => fetch(imageUrl, { headers: { "x-display-secret": s.display.secret } })),
    );
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    const bodies = await Promise.all(responses.map(async (r) => Buffer.from(await r.arrayBuffer())));
    expect(bodies.every((b) => b.equals(bodies[0]!))).toBe(true);
    expect(renders.filter((r) => r === `${s.sceneId}:2`)).toHaveLength(1);

    // Pixels on both sides of the fog boundary (r = 0.3 around the centre).
    const { data, info } = await sharp(bodies[0]!).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const pixel = (x: number, y: number) => {
      const i = (y * info.width + x) * 4;
      return [data[i], data[i + 1], data[i + 2]];
    };
    expect(pixel(32 + 17, 32)).toEqual([10, 120, 220]); // inside (17/64 ≈ 0.27)
    expect(pixel(32 + 21, 32)).toEqual([0, 0, 0]); // outside (21/64 ≈ 0.33)

    const placed = await h.campaigns.placeToken(ctxFor(h.users.gm), {
      sceneId: s.sceneId,
      expectedSceneRevision: 2,
      label: "Scout",
      x: 0.5,
      y: 0.5,
      size: 0.1,
      visible: true,
      imageFileId: s.fileId,
      idempotencyKey: randomUUID(),
    });
    if (!placed.ok) throw new Error("place failed");
    const tokenId = placed.value.tokens[0]!.tokenId;
    await waitFor(() => stream.scenes().length === 3);
    const tokenUrl = stream.scenes()[2]!.tokens[0]!.imageUrl;
    expect(tokenUrl).toBe(`/displays/${s.display.displayId}/scenes/${s.sceneId}/tokens/${tokenId}/image?file=${s.fileId}`);

    const rendersBefore = renders.length;
    const servedBefore = served.length;
    const moved = await h.campaigns.moveToken(ctxFor(h.users.gm), {
      sceneId: s.sceneId,
      tokenId,
      expectedSceneRevision: 3,
      x: 0.55,
      y: 0.45,
      idempotencyKey: randomUUID(),
    });
    if (!moved.ok) throw new Error("move failed");
    await waitFor(() => stream.scenes().length === 4);
    const afterMove = stream.scenes()[3]!;
    expect(afterMove).toMatchObject({ sceneRevision: 4, imageRevision: 2, imageUrl: stream.scenes()[1]!.imageUrl });
    expect(afterMove.tokens[0]).toMatchObject({ x: 0.55, y: 0.45, imageUrl: tokenUrl });
    // Token-only edit: no render, and the map URL is unchanged so the
    // display has nothing to download.
    expect(renders.length).toBe(rendersBefore);
    expect(served.length).toBe(servedBefore);

    // A stable token URL with the wrong file key reads as missing.
    const wrongFile = await fetch(`${base}${tokenUrl!.replace(s.fileId, randomUUID())}`, {
      headers: { "x-display-secret": s.display.secret },
    });
    expect(wrongFile.status).toBe(404);
    const rightFile = await fetch(`${base}${tokenUrl}`, { headers: { "x-display-secret": s.display.secret } });
    expect(rightFile.status).toBe(200);

    // Heartbeats arrive as comments.
    await waitFor(() => stream.comments() >= 2);
    stream.close();
  });

  it("never streams hidden or fog-covered tokens", async () => {
    const s = await setup();
    const stream = await openStream(s.eventsUrl, s.display.secret);
    await waitFor(() => stream.scenes().length === 1);
    const hidden = await h.campaigns.placeToken(ctxFor(h.users.gm), {
      sceneId: s.sceneId,
      expectedSceneRevision: 1,
      label: "Hidden",
      x: 0.5,
      y: 0.5,
      size: 0.1,
      visible: false,
      imageFileId: s.fileId,
      idempotencyKey: randomUUID(),
    });
    if (!hidden.ok) throw new Error("place failed");
    await waitFor(() => stream.scenes().length === 2);
    // Visible token but still under fog (scene starts fully fogged).
    const fogged = await h.campaigns.placeToken(ctxFor(h.users.gm), {
      sceneId: s.sceneId,
      expectedSceneRevision: 2,
      label: "Fogged",
      x: 0.2,
      y: 0.2,
      size: 0.1,
      visible: true,
      imageFileId: s.fileId,
      idempotencyKey: randomUUID(),
    });
    if (!fogged.ok) throw new Error("place failed");
    await waitFor(() => stream.scenes().length === 3);
    expect(stream.scenes().every((p) => p.tokens.length === 0)).toBe(true);
    const raw = JSON.stringify(stream.events);
    expect(raw).not.toContain("Hidden");
    expect(raw).not.toContain("Fogged");
    for (const token of fogged.value.tokens) {
      const response = await fetch(
        `${base}/displays/${s.display.displayId}/scenes/${s.sceneId}/tokens/${token.tokenId}/image?file=${s.fileId}`,
        { headers: { "x-display-secret": s.display.secret } },
      );
      expect(response.status).toBe(404);
    }
    stream.close();
  });

  it("rejects wrong-campaign and wrong-secret credentials and ends the stream on revocation", async () => {
    const s = await setup();
    const other = await setup();
    const wrongCampaign = await openStream(
      `${base}/displays/${other.display.displayId}/scenes/${s.sceneId}/events`,
      other.display.secret,
    );
    expect(wrongCampaign.response.status).toBe(404);
    expect(await wrongCampaign.response.json()).toMatchObject({ error: { code: "not_found" } });
    const wrongSecret = await openStream(s.eventsUrl, "not-the-secret");
    expect(wrongSecret.response.status).toBe(404);
    const noSecret = await fetch(s.eventsUrl);
    expect(noSecret.status).toBe(404);

    const stream = await openStream(s.eventsUrl, s.display.secret);
    await waitFor(() => stream.scenes().length === 1);
    const revoked = await h.campaigns.revokeDisplay(ctxFor(h.users.gm), { displayId: s.display.displayId });
    expect(revoked.ok).toBe(true);
    await waitFor(() => stream.events.some((e) => e.event === "revoked") && stream.ended());
    const reconnect = await openStream(s.eventsUrl, s.display.secret);
    expect(reconnect.response.status).toBe(404);
    const image = await fetch(`${base}${stream.scenes()[0]!.imageUrl}`, {
      headers: { "x-display-secret": s.display.secret },
    });
    expect(image.status).toBe(404);
  });

  it("sends nothing for rolled-back or conflicting writes", async () => {
    const s = await setup();
    const stream = await openStream(s.eventsUrl, s.display.secret);
    await waitFor(() => stream.scenes().length === 1);

    // A scene write that rolls back (NOTIFY is queued in the transaction).
    const repo = createCampaignPersistenceRepository(h.pool);
    const client = await h.pool.connect();
    try {
      await client.query("BEGIN");
      const updated = await repo.updateSceneTokens(client, { sceneId: s.sceneId, tokens: [], expectedRevision: 1 });
      expect(updated?.revision).toBe(2);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    // A stale-revision command conflicts and writes nothing.
    const stale = await h.campaigns.applyFogEdit(ctxFor(h.users.gm), {
      sceneId: s.sceneId,
      expectedSceneRevision: 7,
      op: { mode: "reveal", runs: [{ x: 0.5, y: 0.5, r: 0.1 }] },
      idempotencyKey: randomUUID(),
    });
    expect(stale).toMatchObject({ ok: false, error: { code: "conflict" } });
    await settle();
    expect(stream.scenes()).toHaveLength(1);
    expect(await currentRevision(s.sceneId)).toBe(1);
    stream.close();
  });

  it("commits one bounded brush batch as one revision and one event; oversized batches write nothing", async () => {
    const s = await setup();
    const stream = await openStream(s.eventsUrl, s.display.secret);
    await waitFor(() => stream.scenes().length === 1);
    const runs = Array.from({ length: 512 }, (_, i) => ({ x: (i % 32) / 32, y: Math.floor(i / 32) / 16, r: 0.02 }));
    const tooMany = await h.campaigns.applyFogEdit(ctxFor(h.users.gm), {
      sceneId: s.sceneId,
      expectedSceneRevision: 1,
      op: { mode: "reveal", runs: [...runs, { x: 0.5, y: 0.5, r: 0.02 }] },
      idempotencyKey: randomUUID(),
    });
    expect(tooMany).toMatchObject({ ok: false, error: { code: "bad_request" } });
    const httpTooMany = await h.app.inject({
      method: "POST",
      url: `/scenes/${s.sceneId}/fog-edits`,
      headers: { cookie: h.users.gm.cookie },
      payload: {
        expectedSceneRevision: 1,
        op: { mode: "reveal", runs: [...runs, { x: 0.5, y: 0.5, r: 0.02 }] },
        idempotencyKey: randomUUID(),
      },
    });
    expect(httpTooMany.statusCode).toBe(400);

    const key = randomUUID();
    const batch = await h.campaigns.applyFogEdit(ctxFor(h.users.gm), {
      sceneId: s.sceneId,
      expectedSceneRevision: 1,
      op: { mode: "reveal", runs },
      idempotencyKey: key,
    });
    expect(batch).toMatchObject({ ok: true, value: { revision: 2 } });
    // A lost-response retry with the same key and payload replays the result.
    const retry = await h.campaigns.applyFogEdit(ctxFor(h.users.gm), {
      sceneId: s.sceneId,
      expectedSceneRevision: 1,
      op: { mode: "reveal", runs },
      idempotencyKey: key,
    });
    expect(retry).toMatchObject({ ok: true, value: { revision: 2 } });
    await waitFor(() => stream.scenes().length === 2);
    await settle();
    expect(stream.scenes()).toHaveLength(2);
    expect(await currentRevision(s.sceneId)).toBe(2);
    stream.close();
  });

  it("delivers writes across two application instances on one database", async () => {
    const s = await setup();
    const onA = await openStream(s.eventsUrl, s.display.secret);
    await waitFor(() => onA.scenes().length === 1);
    // Display connected to B (module-level stream, no HTTP needed).
    const onB = await campaignsB.openDisplayStream({ ...s.display, sceneId: s.sceneId });
    if (!onB.ok) throw new Error("expected stream on B");
    const chunksB: string[] = [];
    onB.value.attach({ write: (c) => (chunksB.push(c), true), onDrain: () => {}, end: () => {} });

    // Write through B, observe on A.
    const viaB = await campaignsB.applyFogEdit(ctxFor(h.users.gm), {
      sceneId: s.sceneId,
      expectedSceneRevision: 1,
      op: { mode: "reveal", runs: [{ x: 0.5, y: 0.5, r: 0.2 }] },
      idempotencyKey: randomUUID(),
    });
    expect(viaB.ok).toBe(true);
    await waitFor(() => onA.scenes().length === 2);
    expect(onA.scenes()[1]).toMatchObject({ sceneRevision: 2, imageRevision: 2 });

    // Write through A, observe on B.
    const viaA = await h.campaigns.placeToken(ctxFor(h.users.gm), {
      sceneId: s.sceneId,
      expectedSceneRevision: 2,
      label: "Rogue",
      x: 0.5,
      y: 0.5,
      size: 0.1,
      visible: true,
      imageFileId: null,
      idempotencyKey: randomUUID(),
    });
    expect(viaA.ok).toBe(true);
    await waitFor(() => chunksB.filter((c) => c.startsWith("event: scene")).length === 3);
    expect(chunksB.at(-1)).toContain('"sceneRevision":3');
    expect(chunksB.at(-1)).toContain("Rogue");

    // Background replacement through B: new image revision, tokens cleared.
    const newFile = await s.upload();
    const replaced = await campaignsB.updateScene(ctxFor(h.users.gm), {
      sceneId: s.sceneId,
      expectedSceneRevision: 3,
      backgroundFileId: newFile,
      idempotencyKey: randomUUID(),
    });
    expect(replaced.ok).toBe(true);
    await waitFor(() => onA.scenes().length === 4);
    expect(onA.scenes()[3]).toMatchObject({ sceneRevision: 4, imageRevision: 3, tokens: [] });
    const oldImage = await fetch(`${base}${onA.scenes()[1]!.imageUrl}`, {
      headers: { "x-display-secret": s.display.secret },
    });
    expect(oldImage.status).toBe(404);
    onA.close();
    onB.value.close();
  });

  it("closes streams on listener loss, refuses new ones, then recovers", async () => {
    const s = await setup();
    const stream = await openStream(s.eventsUrl, s.display.secret);
    await waitFor(() => stream.scenes().length === 1);
    const admin = new Client({ connectionString: databaseUrl });
    await admin.connect();
    try {
      await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1", [
        listenerName,
      ]);
    } finally {
      await admin.end();
    }
    await waitFor(() => stream.ended());
    // Until LISTEN is restored, new streams are refused (displays retry).
    const refused = await fetch(s.eventsUrl, { headers: { "x-display-secret": s.display.secret } });
    if (refused.status === 503) {
      expect(await refused.json()).toMatchObject({ error: { code: "unavailable" } });
    } else {
      // The hub may already have reconnected (retry base 100 ms).
      expect(refused.status).toBe(200);
      await refused.body?.cancel();
    }
    await waitFor(() => hubA.listening, 5000);
    const reconnected = await openStream(s.eventsUrl, s.display.secret);
    expect(reconnected.response.status).toBe(200);
    await waitFor(() => reconnected.scenes().length === 1);
    const moved = await h.campaigns.applyFogEdit(ctxFor(h.users.gm), {
      sceneId: s.sceneId,
      expectedSceneRevision: 1,
      op: { mode: "reveal", runs: [{ x: 0.5, y: 0.5, r: 0.2 }] },
      idempotencyKey: randomUUID(),
    });
    expect(moved.ok).toBe(true);
    await waitFor(() => reconnected.scenes().length === 2);
    reconnected.close();
  });
});
