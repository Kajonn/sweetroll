import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { DisplayProjection } from "../../src/campaigns/display.js";
import { createSceneEventHub, type SceneEventHub } from "../../src/campaigns/scene-events.js";
import { namedDicePoolDocument } from "../../src/systems/implementation/package/fixtures/named-dice-pool.js";
import type { SystemDocumentV1 } from "../../src/systems/implementation/package/schema/index.js";
import { buildI6Harness, type I6Harness, type TestActor } from "./i6-app.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const allScopes = [
  "systems:read", "systems:write", "characters:read", "characters:write", "campaigns:read", "campaigns:write",
] as const;
type Scope = (typeof allScopes)[number];
type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Named dice pool with a push policy, so v1 can roll and push the same sheet. */
function pushableDocument(): SystemDocumentV1 {
  const document = namedDicePoolDocument();
  document.schemaVersion = "1.2";
  const action = document.actions.find((entry) => entry.kind === "roll");
  if (action?.kind !== "roll") throw new Error("fixture has no roll action");
  action.pushPolicy = {
    version: "1.0", maxAttempts: 2, successThreshold: 1, allowOnSuccess: true,
    groups: [{ groupId: "attribute", lockedFaces: [], reportedFaces: [1] }],
  };
  return document;
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Minimal SSE reader, the same transport the table display uses. */
async function openStream(url: string, secret: string) {
  const controller = new AbortController();
  const response = await fetch(url, { headers: { "x-display-secret": secret }, signal: controller.signal });
  const events: Array<{ event: string; data: unknown }> = [];
  let ended = false;
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
            if (block.startsWith(":")) continue;
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
    response, events,
    scenes: () => events.filter((entry) => entry.event === "scene").map((entry) => entry.data as DisplayProjection),
    ended: () => ended,
    close: () => controller.abort(),
  };
}

describe.skipIf(!databaseUrl)("public API v1 campaigns, play and scenes", () => {
  let h: I6Harness;
  let hub: SceneEventHub;
  let base: string;
  let mediaDir: string;
  let displayDir: string;
  let pngBase64: string;
  const renders: string[] = [];
  const tokens = {} as Record<"gm" | "player" | "other" | "outsider" | "readOnly" | "legacy" | "noCharacters", string>;

  beforeAll(async () => {
    mediaDir = await mkdtemp(join(tmpdir(), "sweetroll-api-campaign-media-"));
    displayDir = await mkdtemp(join(tmpdir(), "sweetroll-api-campaign-display-"));
    process.env.SWEETROLL_MEDIA_DIR = mediaDir;
    process.env.SWEETROLL_DISPLAY_DIR = displayDir;
    hub = createSceneEventHub({ connection: { connectionString: databaseUrl }, retryBaseMs: 100 });
    await hub.start();
    h = await buildI6Harness({
      publicApi: true, document: pushableDocument(), sceneEvents: hub,
      displayObserver: { onRender: (sceneId, revision) => renders.push(`${sceneId}:${revision}`) },
      displayStream: { heartbeatMs: 200 },
    });
    await h.app.listen({ host: "127.0.0.1", port: 0 });
    const address = h.app.server.address();
    if (address === null || typeof address === "string") throw new Error("expected TCP address");
    base = `http://127.0.0.1:${address.port}`;
    pngBase64 = (await sharp({
      create: { width: 64, height: 64, channels: 4, background: { r: 10, g: 120, b: 220, alpha: 1 } },
    }).png().toBuffer()).toString("base64");
    tokens.gm = await issue(h.users.gm, [...allScopes]);
    tokens.player = await issue(h.users.player, ["characters:read", "characters:write", "campaigns:read", "campaigns:write"]);
    tokens.other = await issue(h.users.other, ["characters:read", "characters:write", "campaigns:read", "campaigns:write"]);
    tokens.outsider = await issue(h.users.outsider, [...allScopes]);
    tokens.readOnly = await issue(h.users.gm, ["characters:read", "campaigns:read"]);
    tokens.legacy = await issue(h.users.gm, ["systems:read", "systems:write", "characters:read", "characters:write"]);
    tokens.noCharacters = await issue(h.users.player, ["campaigns:read", "campaigns:write"]);
    // Players create standalone sheets on the campaign version before adopting them.
    await json(tokens.gm, "PUT", `/systems/${h.systemId}/sharing`, { access: "link" });
  });

  // Each journey is a separate script run; the shared account quota restarts.
  beforeEach(async () => {
    await h.pool.query("DELETE FROM public_api_rate_limits");
  });

  afterAll(async () => {
    await h?.close();
    await hub?.close();
    delete process.env.SWEETROLL_MEDIA_DIR;
    delete process.env.SWEETROLL_DISPLAY_DIR;
    if (mediaDir) await rm(mediaDir, { recursive: true, force: true });
    if (displayDir) await rm(displayDir, { recursive: true, force: true });
  });

  async function issue(actor: TestActor, scopes: Scope[]) {
    const response = await h.app.inject({
      method: "POST", url: "/me/personal-tokens",
      headers: { cookie: actor.cookie, origin: "http://localhost", host: "localhost" },
      payload: { label: "Campaign script", scopes, expiresInDays: 7 },
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json<{ token: string }>().token;
  }

  function call(token: string, method: Method, path: string, payload?: object) {
    return h.app.inject({
      method, url: `/api/v1${path}`, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}),
    });
  }

  async function json<T = Record<string, unknown>>(token: string, method: Method, path: string, payload?: object, status = 200) {
    const response = await call(token, method, path, payload);
    expect(response.statusCode, `${method} ${path}: ${response.body}`).toBe(status);
    return response.json<T>();
  }

  type Campaign = { campaignId: string; revision: number; accessRevision: number };

  async function createCampaign(title: string) {
    return json<Campaign>(tokens.gm, "POST", "/campaigns", {
      systemVersionId: h.versionId, title, idempotencyKey: randomUUID(),
    }, 201);
  }

  async function revisionOf(campaignId: string, token = tokens.gm) {
    return (await json<Campaign>(token, "GET", `/campaigns/${campaignId}`)).revision;
  }

  /** GM invites through v1; the invitee reviews and accepts with its own token. */
  async function joinCampaign(campaignId: string, token: string) {
    const invitation = await json<{ invitationId: string; token: string }>(tokens.gm, "POST", `/campaigns/${campaignId}/invitations`, {
      intendedRole: "player", expectedCampaignRevision: await revisionOf(campaignId), idempotencyKey: randomUUID(),
    }, 201);
    expect(invitation.token).toEqual(expect.any(String));
    const review = await json<{ invitationRevision: number; accessRevision: number; campaignTitle: string }>(
      token, "POST", "/invitations/review", { token: invitation.token });
    const accepted = await json<{ membership: { userId: string; role: string } }>(token, "POST", "/invitations/accept", {
      campaignId, token: invitation.token, expectedInvitationRevision: review.invitationRevision,
      reviewedAccessRevision: review.accessRevision, idempotencyKey: randomUUID(),
    });
    expect(accepted.membership.role).toBe("player");
    return review;
  }

  it("enforces campaign scopes, both-scope placement and binary auth while older tokens keep working", async () => {
    const stored = await h.pool.query<{ scopes: string[] }>(
      "SELECT scopes FROM personal_access_tokens WHERE user_id = $1 ORDER BY created_at", [h.users.gm.actorId]);
    expect(stored.rows[0]?.scopes).toEqual(allScopes);

    expect((await json(tokens.legacy, "GET", "/systems")).systems).toEqual(expect.any(Array));
    const denied = await call(tokens.legacy, "GET", "/campaigns");
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ error: { code: "insufficient_scope" } });
    expect((await call(tokens.readOnly, "POST", "/campaigns", {
      systemVersionId: h.versionId, title: "Read only", idempotencyKey: randomUUID(),
    })).statusCode).toBe(403);
    expect((await json<{ campaigns: unknown[] }>(tokens.readOnly, "GET", "/campaigns")).campaigns).toEqual(expect.any(Array));

    const campaign = await createCampaign("Scopes");
    expect((await call(tokens.noCharacters, "POST", `/campaigns/${campaign.campaignId}/characters`, {
      name: "Blocked", entityDefinitionId: "character", expectedCampaignRevision: campaign.revision, idempotencyKey: randomUUID(),
    })).json()).toMatchObject({ error: { code: "insufficient_scope" } });

    const unauthenticated = await h.app.inject(`/api/v1/campaigns/${campaign.campaignId}/images/${randomUUID()}/original`);
    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.headers["www-authenticate"]).toBe("Bearer");
    expect((await call(tokens.legacy, "GET", `/campaigns/${campaign.campaignId}/images/${randomUUID()}/original`)).statusCode).toBe(403);

    // Known IDs stay indistinguishable from missing ones across accounts.
    for (const path of [`/campaigns/${campaign.campaignId}`, `/campaigns/${campaign.campaignId}/members`,
      `/campaigns/${randomUUID()}`]) {
      const response = await call(tokens.outsider, "GET", path);
      expect(response.statusCode, path).toBe(404);
      expect(response.json().error.code).toBe("not_found");
    }
    expect((await call(tokens.outsider, "PATCH", `/campaigns/${campaign.campaignId}`, {
      title: "Taken", expectedCampaignRevision: campaign.revision, idempotencyKey: randomUUID(),
    })).statusCode).toBe(404);
  });

  it("runs membership, adoption, rolls, pushes and return through two tokens", async () => {
    const campaign = await createCampaign("Night Road");
    expect(campaign).toMatchObject({ title: "Night Road", status: "active", ownerId: h.users.gm.actorId });
    const review = await joinCampaign(campaign.campaignId, tokens.player);
    expect(review.campaignTitle).toBe("Night Road");
    await joinCampaign(campaign.campaignId, tokens.other);

    // The membership is visible in the web app with the same labels.
    const members = await json<{ members: Array<{ userId: string; displayName: string | null; role: string }> }>(
      tokens.gm, "GET", `/campaigns/${campaign.campaignId}/members`);
    expect(members.members).toEqual(expect.arrayContaining([
      expect.objectContaining({ userId: h.users.player.actorId, role: "player", displayName: "Bob" }),
    ]));
    const browserMembers = await h.app.inject({ url: `/campaigns/${campaign.campaignId}/members`, headers: { cookie: h.users.gm.cookie } });
    expect(browserMembers.json().members.map((member: { userId: string }) => member.userId).sort())
      .toEqual(members.members.map((member) => member.userId).sort());

    const created = await json<{ characterId: string; revision: number }>(tokens.player, "POST", "/characters", {
      systemVersionId: h.versionId, entityDefinitionId: "character", name: "Wren", idempotencyKey: randomUUID(),
    }, 201);
    const sheetPath = `/characters/${created.characterId}`;
    const adopted = await json<{ revision: number; campaign: { campaignId: string; controllers: string[]; returnOwnerId: string } }>(
      tokens.player, "POST", `/campaigns/${campaign.campaignId}/characters/${created.characterId}/adopt`, {
        expectedCampaignRevision: await revisionOf(campaign.campaignId, tokens.player),
        expectedCharacterRevision: created.revision, acknowledgedDisclosure: true, idempotencyKey: randomUUID(),
      });
    expect(adopted.campaign).toEqual(expect.objectContaining({
      campaignId: campaign.campaignId, controllers: [h.users.player.actorId], returnOwnerId: h.users.player.actorId,
    }));
    const browserSheet = await h.app.inject({ url: sheetPath, headers: { cookie: h.users.player.cookie } });
    expect(browserSheet.json().character.campaignId).toBe(campaign.campaignId);

    // Controller rolls; the GM sees the sheet; other players and outsiders do not.
    const rollBody = { inputs: { bonus_dice: 1 }, audience: "gm_only", expectedRevision: adopted.revision, idempotencyKey: randomUUID() };
    type Command = { revision: number; roll: { rollId: string; audience: string; total: number; push?: { canPush?: boolean } } };
    const rolled = await json<Command>(tokens.player, "POST", `${sheetPath}/actions/test_pool`, rollBody);
    expect(rolled.roll).toMatchObject({ audience: "gm_only", rollId: expect.any(String) });
    const replayed = await json<Command>(tokens.player, "POST", `${sheetPath}/actions/test_pool`, rollBody);
    expect(replayed).toEqual(rolled);
    const mismatch = await call(tokens.player, "POST", `${sheetPath}/actions/test_pool`, { ...rollBody, inputs: { bonus_dice: 2 } });
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json().error.code).toBe("idempotency_mismatch");
    expect(await json(tokens.player, "GET", `${sheetPath}/rolls/${rolled.roll.rollId}`)).toMatchObject({
      rollId: rolled.roll.rollId, total: rolled.roll.total, audience: "gm_only",
    });
    expect((await json(tokens.gm, "GET", sheetPath)).revision).toBe(rolled.revision);
    expect((await json(tokens.gm, "GET", `${sheetPath}/rolls/${rolled.roll.rollId}`)).total).toBe(rolled.roll.total);
    for (const token of [tokens.other, tokens.outsider]) {
      expect((await call(token, "GET", sheetPath)).statusCode).toBe(404);
      expect((await call(token, "GET", `${sheetPath}/rolls/${rolled.roll.rollId}`)).statusCode).toBe(404);
      expect((await call(token, "POST", `${sheetPath}/actions/test_pool`, { ...rollBody, idempotencyKey: randomUUID() })).statusCode).toBe(404);
    }

    // Activity audiences match the browser history for each reader.
    type Activity = { events: Array<{ kind: string; sourceRollId: string | null }> };
    const rollIds = (activity: Activity) => activity.events.filter((event) => event.kind === "roll_executed").map((event) => event.sourceRollId);
    const gmActivity = await json<Activity>(tokens.gm, "GET", `/campaigns/${campaign.campaignId}/activity`);
    expect(rollIds(gmActivity)).toContain(rolled.roll.rollId);
    const otherActivity = await json<Activity>(tokens.other, "GET", `/campaigns/${campaign.campaignId}/activity`);
    expect(rollIds(otherActivity)).not.toContain(rolled.roll.rollId);
    const browserOther = await h.app.inject({ url: `/campaigns/${campaign.campaignId}/activity`, headers: { cookie: h.users.other.cookie } });
    expect(rollIds(browserOther.json())).toEqual(rollIds(otherActivity));
    const characterActivity = await json<{ events: Array<{ rollId: string | null; roll?: unknown }> }>(tokens.gm, "GET", `${sheetPath}/activity`);
    expect(characterActivity.events.some((event) => event.rollId === rolled.roll.rollId)).toBe(true);

    // Push the saved roll; a replay returns the original push.
    const options = await json<{ canPush: boolean; revision: number }>(tokens.player, "GET", `${sheetPath}/rolls/${rolled.roll.rollId}/push-options`);
    expect(options).toMatchObject({ canPush: true, revision: rolled.revision });
    const pushBody = { expectedRevision: rolled.revision, idempotencyKey: randomUUID() };
    const pushed = await json<Command>(tokens.player, "POST", `${sheetPath}/rolls/${rolled.roll.rollId}/push`, pushBody);
    expect(pushed.roll.rollId).not.toBe(rolled.roll.rollId);
    expect(await json<Command>(tokens.player, "POST", `${sheetPath}/rolls/${rolled.roll.rollId}/push`, pushBody)).toEqual(pushed);
    expect((await json(tokens.gm, "GET", `${sheetPath}/rolls/${pushed.roll.rollId}`)).rollId).toBe(pushed.roll.rollId);

    const renamed = await json<Command>(tokens.player, "PATCH", sheetPath, {
      command: "rename", name: "Wren the Bold", expectedRevision: pushed.revision, idempotencyKey: randomUUID(),
    });
    const exported = await json<{ name: string; revision: number }>(tokens.gm, "POST", `${sheetPath}/exports`);
    expect(exported).toMatchObject({ name: "Wren the Bold", revision: renamed.revision });
    expect((await json<{ templates: unknown[] }>(tokens.player, "GET", `${sheetPath}/templates`)).templates).toEqual(expect.any(Array));

    // The player leaves through the GM; the adopted sheet returns to them.
    await json(tokens.gm, "DELETE", `/campaigns/${campaign.campaignId}/members/${h.users.player.actorId}`, {
      expectedCampaignRevision: await revisionOf(campaign.campaignId), idempotencyKey: randomUUID(),
    });
    expect(await json(tokens.player, "GET", sheetPath)).toMatchObject({ ownerId: h.users.player.actorId, campaign: null });
    expect((await call(tokens.gm, "GET", sheetPath)).statusCode).toBe(404);
    expect((await call(tokens.player, "GET", `/campaigns/${campaign.campaignId}`)).statusCode).toBe(404);
  });

  it("places campaign characters and runs content, restricted templates and proposals", async () => {
    const campaign = await createCampaign("Harbor");
    await joinCampaign(campaign.campaignId, tokens.player);
    await joinCampaign(campaign.campaignId, tokens.other);

    const created = await json<{ characterId: string; revision: number; campaign: { controllers: string[] } }>(
      tokens.gm, "POST", `/campaigns/${campaign.campaignId}/characters`, {
        name: "Deckhand", entityDefinitionId: "character", initialValues: { attribute: 3 },
        expectedCampaignRevision: await revisionOf(campaign.campaignId), idempotencyKey: randomUUID(),
      }, 201);
    expect(created.campaign.controllers).toEqual([]);
    const assigned = await json<{ revision: number }>(tokens.gm, "POST",
      `/campaigns/${campaign.campaignId}/characters/${created.characterId}/assign`, {
        controllerUserIds: [], designateClaimants: [h.users.player.actorId],
        expectedCampaignRevision: await revisionOf(campaign.campaignId), expectedCharacterRevision: created.revision,
        idempotencyKey: randomUUID(),
      });
    const claimable = await json<{ characters: Array<{ characterId: string }> }>(
      tokens.player, "GET", `/campaigns/${campaign.campaignId}/claimable-characters`);
    expect(claimable.characters.map((character) => character.characterId)).toEqual([created.characterId]);
    const claimed = await json<{ campaign: { controllers: string[] } }>(tokens.player, "POST",
      `/campaigns/${campaign.campaignId}/characters/${created.characterId}/claim`, {
        expectedCampaignRevision: await revisionOf(campaign.campaignId, tokens.player),
        expectedCharacterRevision: assigned.revision, idempotencyKey: randomUUID(),
      });
    expect(claimed.campaign.controllers).toEqual([h.users.player.actorId]);
    const roster = await json<{ characters: Array<{ characterId: string }> }>(tokens.other, "GET", `/campaigns/${campaign.campaignId}/characters`);
    expect(roster.characters).toEqual([]);

    // Selected-player content reaches only the granted member.
    const note = await json<{ contentId: string; revision: number; grantedUserIds: string[] }>(tokens.gm, "POST",
      `/campaigns/${campaign.campaignId}/content`, {
        title: "Smuggler's cache", body: "Under the pier.", audience: "selected_players",
        grantedUserIds: [h.users.other.actorId], idempotencyKey: randomUUID(),
      }, 201);
    expect(note.grantedUserIds).toEqual([h.users.other.actorId]);
    expect((await json(tokens.other, "GET", `/content/${note.contentId}`)).body).toBe("Under the pier.");
    expect(await json(tokens.other, "GET", `/content/${note.contentId}`)).not.toHaveProperty("grantedUserIds");
    expect((await call(tokens.player, "GET", `/content/${note.contentId}`)).statusCode).toBe(404);
    const preview = await json<{ content: Array<{ contentId: string }> }>(tokens.gm, "POST",
      `/campaigns/${campaign.campaignId}/content-preview`, { targetUserId: h.users.player.actorId });
    expect(preview.content.map((entry) => entry.contentId)).not.toContain(note.contentId);
    expect((await call(tokens.player, "POST", `/campaigns/${campaign.campaignId}/content-preview`, {
      targetUserId: h.users.other.actorId,
    })).json()).toMatchObject({ error: { code: "forbidden" } });
    const browserPlayerContent = await h.app.inject({
      url: `/campaigns/${campaign.campaignId}/content`, headers: { cookie: h.users.player.cookie },
    });
    const apiPlayerContent = await json<{ content: Array<{ contentId: string }> }>(tokens.player, "GET", `/campaigns/${campaign.campaignId}/content`);
    expect(apiPlayerContent.content.map((entry) => entry.contentId))
      .toEqual(browserPlayerContent.json().content.map((entry: { contentId: string }) => entry.contentId));
    const hidden = await json<{ status: string; revision: number }>(tokens.gm, "DELETE", `/content/${note.contentId}`, {
      expectedContentRevision: note.revision, idempotencyKey: randomUUID(),
    });
    expect(hidden.status).toBe("deleted");
    expect((await call(tokens.other, "GET", `/content/${note.contentId}`)).statusCode).toBe(404);

    // A GM-only template stays invisible to players; a restricted one reaches only its grantee.
    const secret = await json<{ templateId: string }>(tokens.gm, "POST", `/campaigns/${campaign.campaignId}/item-templates`, {
      kind: "item", audience: "gm_only", content: { name: "Cursed compass" }, idempotencyKey: randomUUID(),
    }, 201);
    const generations = await h.pool.query<{ user_id: string; generation: number }>(
      "SELECT user_id, generation FROM campaign_members WHERE campaign_id = $1", [campaign.campaignId]);
    const otherGeneration = generations.rows.find((row) => row.user_id === h.users.other.actorId)!.generation;
    const restricted = await json<{ templateId: string; revision: number }>(tokens.gm, "POST", `/campaigns/${campaign.campaignId}/item-templates`, {
      kind: "item", audience: "selected_players", grants: [{ userId: h.users.other.actorId, generation: otherGeneration }],
      content: { name: "Signal mirror", description: "Flashes across the bay." }, idempotencyKey: randomUUID(),
    }, 201);
    const templateIds = async (token: string) => (await json<{ templates: Array<{ templateId: string }> }>(
      token, "GET", `/campaigns/${campaign.campaignId}/item-templates`)).templates.map((template) => template.templateId);
    expect(await templateIds(tokens.player)).not.toEqual(expect.arrayContaining([secret.templateId]));
    expect(await templateIds(tokens.player)).not.toContain(restricted.templateId);
    expect(await templateIds(tokens.other)).toContain(restricted.templateId);
    expect((await call(tokens.player, "GET", `/campaigns/${campaign.campaignId}/item-templates/${restricted.templateId}`)).statusCode).toBe(404);

    const art = await json<{ revision: number; image: { fileId: string } }>(tokens.gm, "PUT",
      `/campaigns/${campaign.campaignId}/item-templates/${restricted.templateId}/image`, {
        description: "Mirror", contentType: "image/png", dataBase64: pngBase64,
        expectedTemplateRevision: restricted.revision, idempotencyKey: randomUUID(),
      });
    const artPath = `/campaigns/${campaign.campaignId}/item-templates/${restricted.templateId}/image/${art.image.fileId}`;
    const bytes = await call(tokens.other, "GET", artPath);
    expect(bytes.statusCode).toBe(200);
    expect(bytes.headers["content-type"]).toBe("image/png");
    expect(bytes.headers["cache-control"]).toBe("private, no-store");
    expect((await call(tokens.other, "GET", `${artPath}/thumbnail`)).headers["content-type"]).toBe("image/webp");
    expect((await call(tokens.player, "GET", artPath)).statusCode).toBe(404);

    // A player proposes an item and the GM approves it through v1.
    const proposal = await json<{ proposalId: string; revision: number; status: string }>(tokens.player, "POST",
      `/campaigns/${campaign.campaignId}/item-proposals`, {
        kind: "item", content: { name: "Lucky hook" }, idempotencyKey: randomUUID(),
      }, 201);
    expect(proposal.status).toBe("pending");
    expect((await call(tokens.player, "POST", `/campaigns/${campaign.campaignId}/item-proposals/${proposal.proposalId}/approve`, {
      expectedProposalRevision: proposal.revision, idempotencyKey: randomUUID(),
    })).statusCode).toBe(403);
    const decision = await json<{ proposal: { status: string; approvedTemplateId: string }; template: { templateId: string } }>(
      tokens.gm, "POST", `/campaigns/${campaign.campaignId}/item-proposals/${proposal.proposalId}/approve`, {
        expectedProposalRevision: proposal.revision, idempotencyKey: randomUUID(),
      });
    expect(decision.proposal).toMatchObject({ status: "approved", approvedTemplateId: decision.template.templateId });
    expect(await templateIds(tokens.player)).toContain(decision.template.templateId);
    const browserTemplates = await h.app.inject({
      url: `/campaigns/${campaign.campaignId}/item-templates`, headers: { cookie: h.users.player.cookie },
    });
    expect(browserTemplates.json().templates.map((template: { templateId: string }) => template.templateId).sort())
      .toEqual((await templateIds(tokens.player)).sort());

    const exported = await json<{ exportVersion: number; content: Array<{ contentId: string }> }>(tokens.gm, "POST",
      `/campaigns/${campaign.campaignId}/exports`, { idempotencyKey: randomUUID() });
    expect(exported.exportVersion).toBe(1);
    expect((await call(tokens.player, "POST", `/campaigns/${campaign.campaignId}/exports`, {
      idempotencyKey: randomUUID(),
    })).statusCode).toBe(404);
  });

  it("serves every remaining system, character and campaign operation with its public schema", async () => {
    // Systems: versions, art bytes, deprecation, lifecycle and deletion.
    const versions = await json<{ versions: Array<{ versionId: string; lifecycle: string }> }>(
      tokens.gm, "GET", `/systems/${h.systemId}/versions`);
    expect(versions.versions.map((version) => version.versionId)).toContain(h.versionId);
    const spare = await json<{ system: { systemId: string } }>(tokens.gm, "POST", "/systems", { name: "Spare", idempotencyKey: randomUUID() }, 201);
    expect(await json(tokens.gm, "PATCH", `/systems/${spare.system.systemId}`, { lifecycle: "archived", access: "public" }))
      .toEqual({ systemId: spare.system.systemId, lifecycle: "archived", access: "public" });
    expect((await call(tokens.gm, "PATCH", `/systems/${spare.system.systemId}`, {})).statusCode).toBe(400);
    expect(await json(tokens.gm, "DELETE", `/systems/${spare.system.systemId}`)).toEqual({ systemId: spare.system.systemId });
    expect((await call(tokens.gm, "GET", `/systems/${spare.system.systemId}`)).statusCode).toBe(404);
    expect((await call(tokens.gm, "GET", `/system-versions/${h.versionId}/templates/missing/image/${randomUUID()}`)).statusCode).toBe(404);

    // Characters: portrait and entry bytes, duplicate, archive, recover and transfer.
    const hero = await json<{ characterId: string; revision: number }>(tokens.gm, "POST", "/characters", {
      systemVersionId: h.versionId, entityDefinitionId: "character", name: "Sweep", idempotencyKey: randomUUID(),
    }, 201);
    const heroPath = `/characters/${hero.characterId}`;
    const portrait = await json<{ portrait: { fileId: string } }>(tokens.gm, "PUT", `${heroPath}/portrait`, {
      description: "Hero", contentType: "image/png", dataBase64: pngBase64,
      expectedCharacterRevision: hero.revision, expectedPortraitRevision: 0, idempotencyKey: randomUUID(),
    });
    for (const suffix of ["/thumbnail", `/${portrait.portrait.fileId}`, `/${portrait.portrait.fileId}/thumbnail`]) {
      const bytes = await call(tokens.gm, "GET", `${heroPath}/portrait${suffix}`);
      expect(bytes.statusCode, suffix).toBe(200);
      expect(bytes.headers["cache-control"]).toBe("private, no-store");
    }
    expect((await call(tokens.outsider, "GET", `${heroPath}/portrait/thumbnail`)).statusCode).toBe(404);
    expect((await call(tokens.gm, "GET", `${heroPath}/entries/${randomUUID()}/image/thumbnail`)).statusCode).toBe(404);
    let revision = (await json<{ revision: number }>(tokens.gm, "GET", heroPath)).revision;
    for (const command of ["archive", "recover"] as const) {
      revision = (await json<{ revision: number }>(tokens.gm, "PATCH", heroPath, { command, expectedRevision: revision, idempotencyKey: randomUUID() })).revision;
    }
    await json(tokens.gm, "POST", `${heroPath}/duplicate`, { idempotencyKey: randomUUID() }, 201);
    expect(await json(tokens.gm, "POST", `${heroPath}/ownership-transfer`, {
      toUserId: h.users.other.actorId, expectedRevision: revision, idempotencyKey: randomUUID(),
    })).toMatchObject({ characterId: hero.characterId });
    expect((await call(tokens.gm, "GET", heroPath)).statusCode).toBe(404);
    expect((await json(tokens.other, "GET", heroPath)).ownerId).toBe(h.users.other.actorId);

    // Campaign lifecycle, roles and invitation management.
    const campaign = await createCampaign("Sweep");
    const campaignPath = `/campaigns/${campaign.campaignId}`;
    let current = await json<{ revision: number; title: string }>(tokens.gm, "PATCH", campaignPath, {
      title: "Sweep II", description: "Edited", expectedCampaignRevision: campaign.revision, idempotencyKey: randomUUID(),
    });
    expect(current.title).toBe("Sweep II");
    await joinCampaign(campaign.campaignId, tokens.player);
    const promoted = await json<{ role: string }>(tokens.gm, "PATCH", `${campaignPath}/members/${h.users.player.actorId}`, {
      role: "co_gm", expectedCampaignRevision: await revisionOf(campaign.campaignId), idempotencyKey: randomUUID(),
    });
    expect(promoted.role).toBe("co_gm");
    const invite = await json<{ invitationId: string; invitationRevision: number; token: string }>(tokens.gm, "POST",
      `${campaignPath}/invitations`, { intendedRole: "player", expectedCampaignRevision: await revisionOf(campaign.campaignId), idempotencyKey: randomUUID() }, 201);
    const rotated = await json<{ invitationRevision: number; token: string }>(tokens.gm, "POST",
      `${campaignPath}/invitations/${invite.invitationId}/rotate`, {
        expectedInvitationRevision: invite.invitationRevision, expectedCampaignRevision: await revisionOf(campaign.campaignId),
        idempotencyKey: randomUUID(),
      });
    expect(rotated.token).not.toBe(invite.token);
    expect((await call(tokens.other, "POST", "/invitations/review", { token: invite.token })).statusCode).toBe(404);
    const review = await json<{ invitationRevision: number; accessRevision: number }>(tokens.other, "POST", "/invitations/review", { token: rotated.token });
    expect(await json(tokens.other, "POST", "/invitations/decline", {
      campaignId: campaign.campaignId, token: rotated.token, expectedInvitationRevision: review.invitationRevision,
      reviewedAccessRevision: review.accessRevision, idempotencyKey: randomUUID(),
    })).toMatchObject({ status: "declined" });
    const second = await json<{ invitationId: string; invitationRevision: number }>(tokens.gm, "POST", `${campaignPath}/invitations`, {
      intendedRole: "co_gm", expectedCampaignRevision: await revisionOf(campaign.campaignId), idempotencyKey: randomUUID(),
    }, 201);
    expect((await json(tokens.gm, "POST", `${campaignPath}/invitations/${second.invitationId}/revoke`, {
      expectedInvitationRevision: second.invitationRevision, expectedCampaignRevision: await revisionOf(campaign.campaignId),
      idempotencyKey: randomUUID(),
    })).status).toBe("revoked");
    const invitations = await json<{ invitations: Array<{ status: string }> }>(tokens.gm, "GET", `${campaignPath}/invitations`);
    expect(invitations.invitations.map((invitation) => invitation.status).sort()).toEqual(["accepted", "declined", "revoked"]);
    expect(JSON.stringify(invitations)).not.toContain(rotated.token);

    // Content edits, grants and recovery.
    const note = await json<{ contentId: string; revision: number }>(tokens.gm, "POST", `${campaignPath}/content`, {
      title: "Plan", body: "Draft", audience: "gm_only", idempotencyKey: randomUUID(),
    }, 201);
    let content = await json<{ revision: number; audience: string }>(tokens.gm, "PATCH", `/content/${note.contentId}`, {
      body: "Final", audience: "selected_players", expectedContentRevision: note.revision, idempotencyKey: randomUUID(),
    });
    content = await json(tokens.gm, "POST", `/content/${note.contentId}/grants`, {
      grantedUserIds: [h.users.player.actorId], expectedContentRevision: content.revision, idempotencyKey: randomUUID(),
    });
    content = await json(tokens.gm, "DELETE", `/content/${note.contentId}`, { expectedContentRevision: content.revision, idempotencyKey: randomUUID() });
    const deleted = await json<{ content: Array<{ contentId: string }> }>(tokens.gm, "GET", `${campaignPath}/content?status=deleted`);
    expect(deleted.content.map((entry) => entry.contentId)).toContain(note.contentId);
    expect((await json(tokens.gm, "POST", `/content/${note.contentId}/recover`, {
      expectedContentRevision: content.revision, idempotencyKey: randomUUID(),
    })).status).toBe("active");
    const single = await json<{ content: { contentId: string } }>(tokens.gm, "POST", `${campaignPath}/content-preview`, {
      targetUserId: h.users.player.actorId, contentId: note.contentId,
    });
    expect(single.content.contentId).toBe(note.contentId);

    // Templates: bases, edit, sharing, preview, archive and recover.
    await joinCampaign(campaign.campaignId, tokens.other);
    expect((await json<{ templates: unknown[] }>(tokens.gm, "GET", `${campaignPath}/item-templates/bases`)).templates).toEqual(expect.any(Array));
    let template = await json<{ templateId: string; revision: number }>(tokens.gm, "POST", `${campaignPath}/item-templates`, {
      kind: "item", content: { name: "Rope" }, idempotencyKey: randomUUID(),
    }, 201);
    const templatePath = `${campaignPath}/item-templates/${template.templateId}`;
    template = await json(tokens.gm, "PATCH", templatePath, {
      content: { name: "Rope", description: "Fifty feet" }, expectedTemplateRevision: template.revision, idempotencyKey: randomUUID(),
    });
    template = await json(tokens.gm, "POST", `${templatePath}/sharing`, {
      audience: "gm_only", grants: [], expectedTemplateRevision: template.revision, idempotencyKey: randomUUID(),
    });
    const previewed = await json<{ templates: Array<{ templateId: string }> }>(tokens.gm, "POST", `${campaignPath}/item-template-preview`, {
      targetUserId: h.users.other.actorId,
    });
    expect(previewed.templates.map((entry) => entry.templateId)).not.toContain(template.templateId);
    for (const command of ["archive", "recover"] as const) {
      template = await json(tokens.gm, "POST", `${templatePath}/${command}`, { expectedTemplateRevision: template.revision, idempotencyKey: randomUUID() });
    }
    expect(await json(tokens.gm, "GET", templatePath)).toMatchObject({ status: "active", content: { description: "Fifty feet" } });
    expect(await json(tokens.gm, "GET", `${templatePath}/image`)).toEqual({ revision: expect.any(Number), image: null });
    await json(tokens.gm, "PUT", `${templatePath}/image`, {
      description: "Rope", contentType: "image/png", dataBase64: pngBase64, expectedTemplateRevision: template.revision, idempotencyKey: randomUUID(),
    });
    template = await json(tokens.gm, "GET", templatePath);
    expect((await json(tokens.gm, "DELETE", `${templatePath}/image`, {
      expectedTemplateRevision: template.revision, idempotencyKey: randomUUID(),
    })).image).toBeNull();

    // Proposals: art on a pending suggestion, listing and rejection. Co-GMs
    // review, so the third account proposes as a player.
    const proposal = await json<{ proposalId: string; revision: number }>(tokens.other, "POST", `${campaignPath}/item-proposals`, {
      kind: "item", content: { name: "Lantern" }, idempotencyKey: randomUUID(),
    }, 201);
    const proposalPath = `${campaignPath}/item-proposals/${proposal.proposalId}`;
    const proposalArt = await json<{ revision: number; image: { fileId: string }; parentRevision: number }>(tokens.other, "PUT", `${proposalPath}/image`, {
      description: "Lantern", contentType: "image/png", dataBase64: pngBase64,
      expectedProposalRevision: proposal.revision, expectedImageRevision: 0, idempotencyKey: randomUUID(),
    });
    expect((await call(tokens.gm, "GET", `${proposalPath}/image/${proposalArt.image.fileId}`)).statusCode).toBe(200);
    expect((await json(tokens.gm, "GET", `${proposalPath}/image`)).image).toMatchObject({ fileId: proposalArt.image.fileId });
    const listed = await json<{ proposals: Array<{ proposalId: string }> }>(tokens.gm, "GET", `${campaignPath}/item-proposals?status=pending`);
    expect(listed.proposals.map((entry) => entry.proposalId)).toContain(proposal.proposalId);
    const opened = await json<{ revision: number; imageRevision: number }>(tokens.gm, "GET", proposalPath);
    const rejected = await json<{ proposal: { status: string }; template: null }>(tokens.player, "POST", `${proposalPath}/reject`, {
      reason: "Not this season", expectedProposalRevision: opened.revision, expectedImageRevision: opened.imageRevision, idempotencyKey: randomUUID(),
    });
    expect(rejected).toMatchObject({ proposal: { status: "rejected" }, template: null });

    // Media and scene library: thumbnail, background replacement, token removal, deletion.
    const first = await json<{ fileId: string; revision: number }>(tokens.gm, "POST", `${campaignPath}/images`, {
      name: "First", contentType: "image/png", dataBase64: pngBase64, idempotencyKey: randomUUID(),
    }, 201);
    const replacement = await json<{ fileId: string; revision: number }>(tokens.gm, "POST", `${campaignPath}/images`, {
      name: "Second", contentType: "image/png", dataBase64: pngBase64, idempotencyKey: randomUUID(),
    }, 201);
    expect((await call(tokens.gm, "GET", `${campaignPath}/images/${first.fileId}/thumbnail`)).headers["content-type"]).toBe("image/webp");
    let scene = await json<{ sceneId: string; revision: number; tokens: Array<{ tokenId: string }> }>(tokens.gm, "POST", `${campaignPath}/scenes`, {
      backgroundFileId: first.fileId, idempotencyKey: randomUUID(),
    }, 201);
    scene = await json(tokens.gm, "PATCH", `/scenes/${scene.sceneId}`, {
      backgroundFileId: replacement.fileId, expectedSceneRevision: scene.revision, idempotencyKey: randomUUID(),
    });
    scene = await json(tokens.gm, "POST", `/scenes/${scene.sceneId}/tokens`, {
      label: "Crate", x: 0.1, y: 0.1, size: 0.05, visible: true, imageFileId: first.fileId,
      expectedSceneRevision: scene.revision, idempotencyKey: randomUUID(),
    });
    scene = await json(tokens.gm, "DELETE", `/scenes/${scene.sceneId}/tokens/${scene.tokens[0]!.tokenId}`, {
      expectedSceneRevision: scene.revision, idempotencyKey: randomUUID(),
    });
    expect(scene.tokens).toEqual([]);
    expect(await json(tokens.gm, "GET", `/scenes/${scene.sceneId}`)).toMatchObject({ backgroundFileId: replacement.fileId });
    expect((await json<{ scenes: Array<{ sceneId: string }> }>(tokens.gm, "GET", `${campaignPath}/scenes`)).scenes.map((entry) => entry.sceneId))
      .toEqual([scene.sceneId]);
    expect((await call(tokens.other, "GET", `/scenes/${scene.sceneId}`)).statusCode).toBe(404);
    expect(await json(tokens.gm, "DELETE", `${campaignPath}/images/${first.fileId}`, {
      expectedRevision: first.revision, idempotencyKey: randomUUID(),
    })).toMatchObject({ fileId: first.fileId });

    // Archive and recover close the lifecycle.
    for (const command of ["archive", "recover"] as const) {
      current = await json(tokens.gm, "POST", `${campaignPath}/${command}`, {
        expectedCampaignRevision: await revisionOf(campaign.campaignId), idempotencyKey: randomUUID(),
      });
    }
    expect(current).toMatchObject({ status: "active" });
    expect((await call(tokens.gm, "PATCH", `/system-versions/${h.otherVersionId}`, { lifecycle: "deprecated" })).statusCode).toBe(404);
    const clone = await json<{ system: { systemId: string }; draft: { revision: number } }>(tokens.gm, "POST", "/systems", {
      source: { kind: "clone", versionId: h.versionId }, idempotencyKey: randomUUID(),
    }, 201);
    const published = await json<{ versionId: string }>(tokens.gm, "POST", `/systems/${clone.system.systemId}/publish`, {
      expectedRevision: clone.draft.revision, semanticVersion: "1.0.0", idempotencyKey: randomUUID(),
    }, 201);
    expect(await json(tokens.gm, "PATCH", `/system-versions/${published.versionId}`, { lifecycle: "deprecated" }))
      .toMatchObject({ versionId: published.versionId, systemId: clone.system.systemId, lifecycle: "deprecated" });
  });

  it("builds scenes whose API edits reach a paired display stream, and revokes it", async () => {
    const campaign = await createCampaign("Lighthouse");
    await joinCampaign(campaign.campaignId, tokens.player);
    const image = await json<{ fileId: string; mediaType: string }>(tokens.gm, "POST", `/campaigns/${campaign.campaignId}/images`, {
      name: "Map", contentType: "image/png", dataBase64: pngBase64, idempotencyKey: randomUUID(),
    }, 201);
    expect((await call(tokens.player, "GET", `/campaigns/${campaign.campaignId}/images`)).statusCode).toBe(404);
    const original = await call(tokens.gm, "GET", `/campaigns/${campaign.campaignId}/images/${image.fileId}/original`);
    expect(original.statusCode).toBe(200);
    expect(original.rawPayload.equals(Buffer.from(pngBase64, "base64"))).toBe(true);
    expect((await call(tokens.gm, "GET", `/campaigns/${randomUUID()}/images/${image.fileId}/original`)).statusCode).toBe(404);

    type Scene = { sceneId: string; revision: number; tokens: Array<{ tokenId: string; label: string; visible: boolean }> };
    let scene = await json<Scene>(tokens.gm, "POST", `/campaigns/${campaign.campaignId}/scenes`, {
      backgroundFileId: image.fileId, idempotencyKey: randomUUID(),
    }, 201);
    const sceneEdit = async (method: Method, path: string, payload: object) => {
      scene = await json<Scene>(tokens.gm, method, path, { ...payload, expectedSceneRevision: scene.revision, idempotencyKey: randomUUID() });
      return scene;
    };
    await sceneEdit("POST", `/scenes/${scene.sceneId}/fog-edits`, { op: { mode: "reveal", runs: [{ x: 0.5, y: 0.5, r: 0.3 }] } });
    await sceneEdit("POST", `/scenes/${scene.sceneId}/tokens`, { label: "Scout", x: 0.5, y: 0.5, size: 0.1, visible: true, imageFileId: null });
    await sceneEdit("POST", `/scenes/${scene.sceneId}/tokens`, { label: "Ambush", x: 0.4, y: 0.4, size: 0.1, visible: false, imageFileId: null });
    const scout = scene.tokens.find((token) => token.label === "Scout")!;
    expect(scene.tokens.map((token) => token.visible).sort()).toEqual([false, true]);
    const stale = await call(tokens.gm, "POST", `/scenes/${scene.sceneId}/fog-edits`, {
      op: { mode: "conceal", runs: [{ x: 0.5, y: 0.5, r: 0.1 }] }, expectedSceneRevision: 1, idempotencyKey: randomUUID(),
    });
    expect(stale.statusCode).toBe(409);

    const { code } = await json<{ code: string }>(tokens.gm, "POST", `/campaigns/${campaign.campaignId}/display-codes`, undefined, 201);
    const redeemed = await h.app.inject({ method: "POST", url: "/displays/redeem", payload: { code } });
    expect(redeemed.statusCode, redeemed.body).toBe(200);
    const display = redeemed.json<{ display: { displayId: string; secret: string } }>().display;
    const stream = await openStream(`${base}/displays/${display.displayId}/scenes/${scene.sceneId}/events`, display.secret);
    try {
      expect(stream.response.status).toBe(200);
      await waitFor(() => stream.scenes().length === 1);
      const first = stream.scenes()[0]!;
      expect(first.tokens.map((token) => token.label)).toEqual(["Scout"]);
      const rendersBefore = renders.length;

      await sceneEdit("PATCH", `/scenes/${scene.sceneId}/tokens/${scout.tokenId}`, { x: 0.6, y: 0.55 });
      await waitFor(() => stream.scenes().length === 2);
      const moved = stream.scenes()[1]!;
      expect(moved).toMatchObject({ sceneRevision: scene.revision, imageRevision: first.imageRevision });
      expect(moved.tokens).toEqual([expect.objectContaining({ tokenId: scout.tokenId, x: 0.6, y: 0.55 })]);
      expect(renders.length).toBe(rendersBefore);

      const credentials = await json<{ displays: Array<{ displayId: string; revokedAt: string | null }> }>(
        tokens.gm, "GET", `/campaigns/${campaign.campaignId}/display-credentials`);
      expect(credentials.displays).toEqual([expect.objectContaining({ displayId: display.displayId, revokedAt: null })]);
      expect(JSON.stringify(credentials)).not.toContain(display.secret);
      expect((await call(tokens.player, "POST", `/campaigns/${campaign.campaignId}/displays/${display.displayId}/revoke`)).statusCode).toBe(404);
      expect((await json(tokens.gm, "POST", `/campaigns/${campaign.campaignId}/displays/${display.displayId}/revoke`)).displayId)
        .toBe(display.displayId);
      await waitFor(() => stream.events.some((entry) => entry.event === "revoked") && stream.ended());
    } finally {
      stream.close();
    }
    const reconnect = await openStream(`${base}/displays/${display.displayId}/scenes/${scene.sceneId}/events`, display.secret);
    expect(reconnect.response.status).toBe(404);
    reconnect.close();
  });
});
