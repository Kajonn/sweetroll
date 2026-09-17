import { randomUUID } from "node:crypto";

import cookiePlugin from "@fastify/cookie";
import Fastify from "fastify";
import pino from "pino";
import { afterAll, describe, expect, it } from "vitest";

import type {
  CampaignCharacterSummary,
  CampaignError,
  Campaigns,
  CampaignView,
  ContentView,
  DisplayProjection,
  InvitationAcceptSuccess,
  InvitationIssueReplay,
  InvitationIssueSuccess,
  InvitationReview,
  MediaFileView,
  MemberView,
  SceneView,
} from "../../campaigns/index.js";
import type { Characters } from "../../characters/index.js";
import type { CharacterView } from "../../characters/index.js";
import type { PlacedCharacterView } from "../../characters/campaignPlacement.js";
import type { SystemRuntime } from "../../systems/runtime.js";
import type { AuthContext, Identity } from "../../identity/index.js";
import { buildAuthHook } from "./auth-hook.js";
import { buildCampaignsRoutes } from "./campaigns.js";

const actorId = randomUUID();

const fakeIdentity: Identity = {
  completeSignIn: async () => {
    throw new Error("not used");
  },
  resolveSession: async (): Promise<AuthContext> => ({
    state: "authenticated",
    actorId,
    sessionId: randomUUID(),
  }),
  signOut: async () => ({ ok: true, value: undefined }),
} as unknown as Identity;

const cookie = { cookie: "session=t" };
const apps: ReturnType<typeof Fastify>[] = [];

function campaignView(overrides: Partial<CampaignView> = {}): CampaignView {
  return {
    campaignId: randomUUID(),
    ownerId: actorId,
    systemVersionId: randomUUID(),
    title: "Table Campaign",
    description: "",
    status: "active",
    revision: 1,
    accessRevision: 1,
    archivedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

function memberView(overrides: Partial<MemberView> = {}): MemberView {
  return {
    campaignId: randomUUID(),
    userId: actorId,
    role: "player",
    status: "active",
    generation: 1,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

function issueSuccess(overrides: Partial<InvitationIssueSuccess> = {}): InvitationIssueSuccess {
  return {
    invitationId: randomUUID(),
    campaignId: randomUUID(),
    intendedRole: "player",
    status: "pending",
    expiresAt: new Date("2026-10-01T00:00:00.000Z"),
    invitationRevision: 1,
    issuedBy: actorId,
    token: "one-time-token",
    ...overrides,
  };
}

function issueReplay(overrides: Partial<InvitationIssueReplay> = {}): InvitationIssueReplay {
  const { token: _dropped, ...rest } = issueSuccess();
  return { ...rest, tokenUnavailable: true as const, ...overrides };
}

function reviewValue(overrides: Partial<InvitationReview> = {}): InvitationReview {
  return {
    invitationId: randomUUID(),
    campaignId: randomUUID(),
    campaignTitle: "Table Campaign",
    systemVersionId: randomUUID(),
    inviterDisplayName: "GM",
    intendedRole: "player",
    expiresAt: new Date("2026-10-01T00:00:00.000Z"),
    invitationRevision: 3,
    accessRevision: 7,
    ...overrides,
  };
}

function acceptValue(overrides: Partial<InvitationAcceptSuccess> = {}): InvitationAcceptSuccess {
  return {
    invitationId: randomUUID(),
    campaignId: randomUUID(),
    membership: memberView(),
    membershipGeneration: 1,
    ...overrides,
  };
}

function contentView(overrides: Partial<ContentView> = {}): ContentView {
  return {
    contentId: randomUUID(),
    campaignId: randomUUID(),
    creatorId: actorId,
    audience: "gm_only",
    title: "Opening",
    tags: [],
    revision: 1,
    accessRevision: 1,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    body: "You meet at the table.",
    status: "active",
    deletedAt: null,
    ...overrides,
  };
}

function placedView(overrides: Partial<PlacedCharacterView> = {}): PlacedCharacterView {
  const characterId = randomUUID();
  return {
    characterId,
    ownerId: null,
    campaignId: randomUUID(),
    controllers: [actorId],
    placementGeneration: 1,
    returnOwnerId: null,
    name: "Placed Hero",
    systemVersionId: randomUUID(),
    entityDefinitionId: "character",
    revision: 2,
    lifecycle: "active",
    archivedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    state: { schemaVersion: "1.0", values: {} },
    replayed: false,
    ...overrides,
  };
}

function characterSummary(): CampaignCharacterSummary {
  return {
    characterId: randomUUID(),
    campaignId: randomUUID(),
    name: "Listed Hero",
    entityDefinitionId: "character",
    systemVersionId: randomUUID(),
    revision: 1,
    lifecycle: "active",
    placementGeneration: 1,
    controllers: [actorId],
    updatedAt: new Date(0),
  };
}

function mediaFileView(overrides: Partial<MediaFileView> = {}): MediaFileView {
  return {
    fileId: randomUUID(),
    campaignId: randomUUID(),
    name: "cave",
    mediaType: "image/png",
    sizeBytes: 70,
    width: 1,
    height: 1,
    checksum: "deadbeef",
    revision: 1,
    ...overrides,
  };
}

function sceneView(overrides: Partial<SceneView> = {}): SceneView {
  return {
    sceneId: randomUUID(),
    campaignId: randomUUID(),
    revision: 1,
    backgroundFileId: randomUUID(),
    fog: [],
    tokens: [],
    ...overrides,
  };
}

function displayProjection(overrides: Partial<DisplayProjection> = {}): DisplayProjection {
  const sceneId = randomUUID();
  const displayId = randomUUID();
  return {
    sceneId,
    sceneRevision: 1,
    imageUrl: `/displays/${displayId}/scenes/${sceneId}/image?rev=1`,
    tokens: [],
    ...overrides,
  };
}

function makeCampaigns(overrides: Partial<Campaigns> = {}): Campaigns {
  const base: Campaigns = {
    create: async () => ({ ok: true, value: campaignView() }),
    open: async () => ({ ok: true, value: campaignView() }),
    list: async () => ({ ok: true, value: { campaigns: [], nextCursor: null } }),
    update: async () => ({ ok: true, value: campaignView() }),
    archive: async () => ({ ok: true, value: campaignView() }),
    recover: async () => ({ ok: true, value: campaignView() }),
    listMembers: async () => ({ ok: true, value: { members: [], nextCursor: null } }),
    changeRole: async () => ({ ok: true, value: memberView() }),
    removeMember: async () => ({ ok: true, value: memberView() }),
    issueInvitation: async () => ({ ok: true, value: issueSuccess() }),
    listInvitations: async () => ({ ok: true, value: { invitations: [], nextCursor: null } }),
    reviewInvitation: async () => ({ ok: true, value: reviewValue() }),
    acceptInvitation: async () => ({ ok: true, value: acceptValue() }),
    declineInvitation: async () => ({ ok: true, value: { invitationId: randomUUID(), campaignId: randomUUID(), status: "declined" as const } }),
    rotateInvitation: async () => ({ ok: true, value: issueSuccess() }),
    revokeInvitation: async () => ({
      ok: true as const,
      value: {
        invitationId: randomUUID(),
        campaignId: randomUUID(),
        intendedRole: "player" as const,
        status: "revoked" as const,
        expiresAt: new Date("2026-10-01T00:00:00.000Z"),
        invitationRevision: 2,
        issuedBy: actorId,
      },
    }),
    createContent: async () => ({ ok: true, value: contentView() }),
    openContent: async () => ({ ok: true, value: contentView() }),
    listContent: async () => ({ ok: true, value: { content: [], nextCursor: null } }),
    // Preview-as-player: content preview projection lands in Task 1; the
    // stub keeps the seam total while no route calls it yet.
    previewContent: async () => ({ ok: true as const, value: { kind: "list" as const, content: [] } }),
    updateContent: async () => ({ ok: true, value: contentView() }),
    deleteContent: async () => ({ ok: true, value: contentView() }),
    recoverContent: async () => ({ ok: true, value: contentView() }),
    replaceGrants: async () => ({ ok: true, value: contentView() }),
    listActivity: async () => ({ ok: true, value: { events: [], nextCursor: null } }),
    exportCampaign: async () => ({
      ok: true,
      value: {
        exportVersion: 1 as const,
        campaign: {
          campaignId: randomUUID(),
          ownerId: actorId,
          systemVersionId: randomUUID(),
          title: "Table Campaign",
          description: "",
          status: "active" as const,
          revision: 1,
          accessRevision: 1,
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        },
        members: [],
        content: [],
        activity: [],
        rolls: [],
      },
    }),
    listCharacters: async () => ({ ok: true, value: { characters: [], nextCursor: null } }),
    listClaimableCharacters: async () => ({ ok: true, value: { characters: [], nextCursor: null } }),
    createCampaignCharacter: async () => ({ ok: true, value: placedView() }),
    assignCampaignControllers: async () => ({ ok: true, value: placedView() }),
    claimCampaignCharacter: async () => ({ ok: true, value: placedView() }),
    adoptCampaignCharacter: async () => ({ ok: true, value: placedView() }),
    // I7 Phase 3: preview route lands in Task 3; the stub keeps the
    // seam total while no route calls it yet.
    previewUpgrade: async () => ({
      ok: true as const,
      value: {
        campaignId: randomUUID(),
        campaignRevision: 1,
        sourceVersionId: randomUUID(),
        targetVersionId: randomUUID(),
        targetSemanticVersion: "2.0.0",
        characters: [],
      },
    }),
    // I7 Phase 3 Task 2: commit route lands in Task 3; the stub keeps the
    // seam total while no route calls it yet.
    commitUpgrade: async () => ({
      ok: true as const,
      value: {
        campaignId: randomUUID(),
        campaignRevision: 2,
        sourceVersionId: randomUUID(),
        targetVersionId: randomUUID(),
        migratedCharacterIds: [],
      },
    }),
    // I7b Task 1: image routes land in a later task; the stub keeps the
    // seam total while no route calls them yet.
    uploadImage: async () => ({ ok: true as const, value: mediaFileView() }),
    deleteImage: async () => ({ ok: true as const, value: mediaFileView() }),
    // I7b Task 4: GM original read; the stub keeps the seam total while no
    // route calls it yet.
    openImage: async () => ({
      ok: true as const,
      value: { file: mediaFileView(), contentType: "image/png" as const, bytes: Buffer.from([1, 2, 3]) },
    }),
    // I7b Task 2: scene routes land in a later task; the stub keeps the
    // seam total while no route calls them yet.
    createScene: async () => ({ ok: true as const, value: sceneView() }),
    openScene: async () => ({ ok: true as const, value: sceneView() }),
    updateScene: async () => ({ ok: true as const, value: sceneView() }),
    applyFogEdit: async () => ({ ok: true as const, value: sceneView() }),
    placeToken: async () => ({ ok: true as const, value: sceneView() }),
    moveToken: async () => ({ ok: true as const, value: sceneView() }),
    removeToken: async () => ({ ok: true as const, value: sceneView() }),
    // I7b Task 3: display routes land in a later task; the stub keeps the
    // seam total while no route calls them yet.
    pairDisplay: async () => ({ ok: true as const, value: { code: "ABC123" } }),
    redeemDisplayCode: async () => ({
      ok: true as const,
      value: { displayId: randomUUID(), secret: "secret" },
    }),
    getDisplayProjection: async () => ({ ok: true as const, value: displayProjection() }),
    revokeDisplay: async () => ({ ok: true as const, value: { displayId: randomUUID() } }),
    // I7b Task 4: credential list + binary image reads; the stub keeps the
    // seam total while no route calls them yet.
    listDisplayCredentials: async () => ({ ok: true as const, value: [] }),
    getDisplaySceneImage: async () => ({
      ok: true as const,
      value: { contentType: "image/png", bytes: Buffer.from([4, 5, 6]), revision: 1 },
    }),
    getDisplayTokenImage: async () => ({
      ok: true as const,
      value: { contentType: "image/png", bytes: Buffer.from([7, 8, 9]), revision: 1 },
    }),
  };
  return { ...base, ...overrides };
}

function fakeCharacterView(): CharacterView {
  const characterId = randomUUID();
  const systemVersionId = randomUUID();
  return {
    characterId,
    ownerId: null,
    campaignId: randomUUID(),
    controllers: [actorId],
    placementGeneration: 1,
    returnOwnerId: null,
    name: "Placed Hero",
    systemVersionId,
    entityDefinitionId: "character",
    revision: 2,
    lifecycle: "active",
    archivedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    state: { schemaVersion: "1.0", values: {} },
    derivedValues: {},
    validations: [],
    projection: {
      projectionVersion: "1.0",
      systemId: randomUUID(),
      versionId: systemVersionId,
      packageChecksum: "checksum",
      entityId: "character",
      entityLabel: "Character",
      sheets: [],
      derivedValues: {},
      validations: [],
    },
    reconciliation: {
      characterId,
      baseRevision: null,
      revision: 2,
      packageChecksum: "checksum",
      projectionVersion: "1.0",
      commandExecutionId: randomUUID(),
      replayExpiresAt: new Date("2026-09-06T00:00:00.000Z").toISOString(),
      replayed: false,
      changedDefinitionIds: [],
      activityCursor: null,
      cacheDisposition: "retain",
    },
  } as unknown as CharacterView;
}

function makeRuntime(): SystemRuntime {
  return {
    resolve: async () => ({
      ok: true,
      value: {
        versionId: randomUUID(),
        state: { schemaVersion: "1.0", values: {} },
        packageChecksum: "checksum",
      },
    }),
  } as unknown as SystemRuntime;
}

async function build(input?: {
  campaigns?: Campaigns;
  characters?: Characters;
  runtime?: SystemRuntime;
  anonymous?: boolean;
}): Promise<ReturnType<typeof Fastify>> {
  const app = Fastify({ genReqId: () => randomUUID(), loggerInstance: pino({ enabled: false }) });
  await app.register(cookiePlugin);
  await app.register(
    buildAuthHook({
      identity: input?.anonymous
        ? ({ ...fakeIdentity, resolveSession: async () => ({ state: "anonymous" }) } as unknown as Identity)
        : fakeIdentity,
      cookieName: "session",
      secure: true,
      maxAgeSeconds: 3600,
    }),
  );
  await app.register(
    buildCampaignsRoutes({
      campaigns: input?.campaigns ?? makeCampaigns(),
      characters: input?.characters ?? ({ open: async () => ({ ok: true, value: fakeCharacterView() }) } as unknown as Characters),
      runtime: input?.runtime ?? makeRuntime(),
    }),
  );
  await app.ready();
  apps.push(app);
  return app;
}

describe("campaign HTTP routes", () => {
  afterAll(async () => {
    for (const app of apps) await app.close();
  });

  it("rejects unauthenticated requests with 401 on every route", async () => {
    const app = await build({ anonymous: true });
    const id = randomUUID();
    const characterId = randomUUID();
    const contentId = randomUUID();
    const inviteId = randomUUID();
    const userId = randomUUID();
    const revisionBody = { expectedCampaignRevision: 1, idempotencyKey: "key-1" };
    const contentBody = { expectedContentRevision: 1, idempotencyKey: "key-1" };
    const routes: Array<{ method: "get" | "post" | "patch" | "delete"; url: string; payload?: unknown }> = [
      { method: "post", url: "/campaigns", payload: { systemVersionId: randomUUID(), title: "T", idempotencyKey: "k" } },
      { method: "get", url: "/campaigns" },
      { method: "get", url: `/campaigns/${id}` },
      { method: "patch", url: `/campaigns/${id}`, payload: { title: "T", ...revisionBody } },
      { method: "post", url: `/campaigns/${id}/archive`, payload: revisionBody },
      { method: "post", url: `/campaigns/${id}/recover`, payload: revisionBody },
      { method: "get", url: `/campaigns/${id}/members` },
      { method: "patch", url: `/campaigns/${id}/members/${userId}`, payload: { role: "player", ...revisionBody } },
      { method: "delete", url: `/campaigns/${id}/members/${userId}`, payload: revisionBody },
      { method: "post", url: `/campaigns/${id}/invitations`, payload: { intendedRole: "player", ...revisionBody } },
      { method: "get", url: `/campaigns/${id}/invitations` },
      { method: "post", url: `/campaigns/${id}/invitations/${inviteId}/rotate`, payload: { expectedInvitationRevision: 1, ...revisionBody } },
      { method: "post", url: `/campaigns/${id}/invitations/${inviteId}/revoke`, payload: { expectedInvitationRevision: 1, ...revisionBody } },
      { method: "post", url: "/invitations/review", payload: { token: "t" } },
      { method: "post", url: "/invitations/accept", payload: { campaignId: id, token: "t", expectedInvitationRevision: 1, reviewedAccessRevision: 1, idempotencyKey: "k" } },
      { method: "post", url: "/invitations/decline", payload: { campaignId: id, token: "t", expectedInvitationRevision: 1, reviewedAccessRevision: 1, idempotencyKey: "k" } },
      { method: "get", url: `/campaigns/${id}/characters` },
      { method: "post", url: `/campaigns/${id}/characters`, payload: { name: "H", entityDefinitionId: "character", ...revisionBody } },
      { method: "post", url: `/campaigns/${id}/characters/${characterId}/assign`, payload: { controllerUserIds: [userId], expectedCampaignRevision: 1, expectedCharacterRevision: 1, idempotencyKey: "k" } },
      { method: "post", url: `/campaigns/${id}/characters/${characterId}/claim`, payload: { expectedCampaignRevision: 1, expectedCharacterRevision: 1, idempotencyKey: "k" } },
      { method: "post", url: `/campaigns/${id}/characters/${characterId}/adopt`, payload: { expectedCampaignRevision: 1, expectedCharacterRevision: 1, acknowledgedDisclosure: true, idempotencyKey: "k" } },
      { method: "get", url: `/campaigns/${id}/content` },
      { method: "post", url: `/campaigns/${id}/content`, payload: { title: "N", idempotencyKey: "k" } },
      { method: "post", url: `/campaigns/${id}/content-preview`, payload: { targetUserId: userId } },
      { method: "get", url: `/content/${contentId}` },
      { method: "patch", url: `/content/${contentId}`, payload: { title: "N", ...contentBody } },
      { method: "delete", url: `/content/${contentId}`, payload: contentBody },
      { method: "post", url: `/content/${contentId}/grants`, payload: { grantedUserIds: [], ...contentBody } },
      { method: "post", url: `/content/${contentId}/recover`, payload: contentBody },
      { method: "get", url: `/campaigns/${id}/activity` },
      { method: "post", url: `/campaigns/${id}/exports`, payload: { idempotencyKey: "k" } },
      { method: "post", url: `/campaigns/${id}/upgrade-previews`, payload: { targetVersionId: id } },
      { method: "post", url: `/campaigns/${id}/upgrade-commits`, payload: { targetVersionId: id, expectedCampaignRevision: 1, idempotencyKey: id } },
      { method: "post", url: `/campaigns/${id}/images`, payload: { name: "cave", contentType: "image/png", dataBase64: "iVBORw0KGgo=", idempotencyKey: id } },
      { method: "delete", url: `/campaigns/${id}/images/${id}`, payload: { expectedRevision: 1, idempotencyKey: id } },
      { method: "get", url: `/campaigns/${id}/images/${id}/original` },
      { method: "post", url: `/campaigns/${id}/scenes`, payload: { backgroundFileId: id, idempotencyKey: id } },
      { method: "get", url: `/scenes/${id}` },
      { method: "patch", url: `/scenes/${id}`, payload: { backgroundFileId: id, expectedSceneRevision: 1, idempotencyKey: id } },
      { method: "post", url: `/scenes/${id}/fog-edits`, payload: { expectedSceneRevision: 1, op: { mode: "reveal", runs: [{ x: 0.5, y: 0.5, r: 0.1 }] }, idempotencyKey: id } },
      { method: "post", url: `/scenes/${id}/tokens`, payload: { expectedSceneRevision: 1, label: "H", x: 0.5, y: 0.5, size: 0.1, visible: true, imageFileId: null, idempotencyKey: id } },
      { method: "patch", url: `/scenes/${id}/tokens/${id}`, payload: { expectedSceneRevision: 1, x: 0.5, y: 0.5, idempotencyKey: id } },
      { method: "delete", url: `/scenes/${id}/tokens/${id}`, payload: { expectedSceneRevision: 1, idempotencyKey: id } },
      { method: "post", url: `/campaigns/${id}/display-codes`, payload: {} },
      { method: "get", url: `/campaigns/${id}/display-credentials` },
      { method: "post", url: `/campaigns/${id}/displays/${id}/revoke`, payload: {} },
    ];
    expect(routes).toHaveLength(46);

    for (const route of routes) {
      const response = await app.inject({
        method: route.method,
        url: route.url,
        headers: cookie,
        ...(route.payload === undefined ? {} : { payload: route.payload }),
      });
      expect(response.statusCode, `${route.method} ${route.url}`).toBe(401);
      expect((response.json() as { error: { code: string } }).error.code).toBe("unauthorized");
      expect(response.headers["x-request-id"]).toBeDefined();
    }
  });

  it("exposes no session-board endpoint and no token URL parameters", async () => {
    const app = await build({});
    const id = randomUUID();
    for (const url of [`/campaigns/${id}/board`, `/campaigns/${id}/session-board`, "/invitations/review?token=abc", `/invitations/accept?token=abc`]) {
      const response = await app.inject({ method: "GET", url, headers: cookie });
      expect(response.statusCode, url).toBe(404);
    }
    expect((await app.inject({ method: "GET", url: "/invitations/review", headers: cookie })).statusCode).toBe(404);
  });

  it("maps campaign create/list/read/update/archive/recover with preconditions", async () => {
    let received: unknown;
    const view = campaignView();
    const app = await build({
      campaigns: makeCampaigns({
        create: async (_ctx, input) => {
          received = input;
          return { ok: true, value: view };
        },
      }),
    });
    const systemVersionId = randomUUID();
    const created = await app.inject({
      method: "POST", url: "/campaigns", headers: cookie,
      payload: { systemVersionId, title: "T", description: "D", idempotencyKey: "key-1" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual({ campaign: expect.any(Object), requestId: expect.any(String) });
    expect(received).toEqual({ systemVersionId, title: "T", description: "D", idempotencyKey: "key-1" });

    const missingKey = await app.inject({
      method: "POST", url: "/campaigns", headers: cookie,
      payload: { systemVersionId, title: "T" },
    });
    expect(missingKey.statusCode).toBe(400);
    expect(missingKey.json().error.code).toBe("bad_request");

    const read = await app.inject({ method: "GET", url: `/campaigns/${view.campaignId}`, headers: cookie });
    expect(read.statusCode).toBe(200);
    expect(read.headers.etag).toBe(`"campaign-${view.revision}-${view.accessRevision}"`);
    // Authorize before conditional: no 304 path exists; a validator re-read
    // still authorizes and returns the current representation.
    const conditional = await app.inject({
      method: "GET", url: `/campaigns/${view.campaignId}`, headers: { ...cookie, "if-none-match": `"campaign-1-1"` },
    });
    expect(conditional.statusCode).toBe(200);
  });

  it("maps error codes to HTTP status (404 collapse, 409 incl. result_unavailable, 413, 429)", async () => {
    const cases: Array<{ error: CampaignError; status: number }> = [
      { error: { code: "not_found", message: "nope" }, status: 404 },
      { error: { code: "conflict", message: "stale", latestRevision: 4 }, status: 409 },
      { error: { code: "idempotency_mismatch", message: "mismatch" }, status: 409 },
      { error: { code: "result_unavailable", message: "gone" }, status: 409 },
      { error: { code: "export_too_large", message: "too big" }, status: 413 },
      { error: { code: "rate_limited", message: "slow down" }, status: 429 },
      { error: { code: "bad_request", message: "bad" }, status: 400 },
    ];
    for (const { error, status } of cases) {
      const app = await build({
        campaigns: makeCampaigns({ open: async () => ({ ok: false, error }) }),
      });
      const response = await app.inject({ method: "GET", url: `/campaigns/${randomUUID()}`, headers: cookie });
      expect(response.statusCode, error.code).toBe(status);
      expect(response.json().error.code).toBe(error.code);
      if (error.code === "conflict") expect(response.json().error.latestRevision).toBe(4);
    }
  });

  it("rejects unknown enums, bad limits and cross-scope cursors as 400", async () => {
    const app = await build({});
    const id = randomUUID();
    const badRole = await app.inject({
      method: "PATCH", url: `/campaigns/${id}/members/${randomUUID()}`, headers: cookie,
      payload: { role: "owner", expectedCampaignRevision: 1, idempotencyKey: "k" },
    });
    expect(badRole.statusCode).toBe(400);

    const badAudience = await app.inject({
      method: "POST", url: `/campaigns/${id}/content`, headers: cookie,
      payload: { audience: "everyone", idempotencyKey: "k" },
    });
    expect(badAudience.statusCode).toBe(400);

    for (const limit of ["0", "101", "nope"]) {
      const response = await app.inject({ method: "GET", url: `/campaigns?limit=${limit}`, headers: cookie });
      expect(response.statusCode, `limit=${limit}`).toBe(400);
      expect(response.json().error.code).toBe("bad_request");
    }

    const cursorApp = await build({
      campaigns: makeCampaigns({
        list: async () => ({ ok: false, error: { code: "bad_request", message: "cursor is not valid for this query." } }),
      }),
    });
    const cursor = await cursorApp.inject({ method: "GET", url: "/campaigns?cursor=bogus", headers: cookie });
    expect(cursor.statusCode).toBe(400);
  });

  it("sends Cache-Control: no-store on campaign, attached and history responses", async () => {
    const app = await build({});
    const id = randomUUID();
    const responses = [
      await app.inject({ method: "GET", url: "/campaigns", headers: cookie }),
      await app.inject({ method: "GET", url: `/campaigns/${id}`, headers: cookie }),
      await app.inject({ method: "POST", url: "/campaigns", headers: cookie, payload: { systemVersionId: randomUUID(), title: "T", idempotencyKey: "k" } }),
      await app.inject({ method: "GET", url: `/campaigns/${id}/members`, headers: cookie }),
      await app.inject({ method: "GET", url: `/campaigns/${id}/content`, headers: cookie }),
      await app.inject({ method: "GET", url: `/campaigns/${id}/activity`, headers: cookie }),
      await app.inject({ method: "POST", url: `/campaigns/${id}/exports`, headers: cookie, payload: { idempotencyKey: "k" } }),
      await app.inject({ method: "GET", url: `/campaigns/${id}/characters`, headers: cookie }),
    ];
    for (const response of responses) {
      expect(response.headers["cache-control"]).toBe("no-store");
    }
  });

  it("issues invitations with a one-time token and replays metadata with tokenUnavailable", async () => {
    let received: unknown;
    const issued = issueSuccess();
    const app = await build({
      campaigns: makeCampaigns({
        issueInvitation: async (_ctx, input) => {
          received = input;
          return { ok: true, value: issued };
        },
      }),
    });
    const campaignId = randomUUID();
    const response = await app.inject({
      method: "POST", url: `/campaigns/${campaignId}/invitations`, headers: cookie,
      payload: { intendedRole: "co_gm", expectedCampaignRevision: 2, idempotencyKey: "key-1" },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().invitation).toMatchObject({ token: "one-time-token" });
    expect(received).toEqual({ campaignId, intendedRole: "co_gm", expectedCampaignRevision: 2, idempotencyKey: "key-1" });

    const replayApp = await build({
      campaigns: makeCampaigns({
        issueInvitation: async () => ({ ok: true, value: issueReplay() }),
      }),
    });
    const replayed = await replayApp.inject({
      method: "POST", url: `/campaigns/${campaignId}/invitations`, headers: cookie,
      payload: { intendedRole: "player", expectedCampaignRevision: 2, idempotencyKey: "key-1" },
    });
    expect(replayed.statusCode).toBe(201);
    const body = replayed.json().invitation as Record<string, unknown>;
    expect(body.tokenUnavailable).toBe(true);
    expect(body).not.toHaveProperty("token");
  });

  it("constructs accept/decline from review revisions without a campaign revision", async () => {
    const review = reviewValue();
    let acceptInput: unknown;
    let declineInput: unknown;
    const app = await build({
      campaigns: makeCampaigns({
        reviewInvitation: async (_ctx, input) => {
          expect(input).toEqual({ token: "bearer-token" });
          return { ok: true, value: review };
        },
        acceptInvitation: async (_ctx, input) => {
          acceptInput = input;
          return { ok: true, value: acceptValue() };
        },
        declineInvitation: async (_ctx, input) => {
          declineInput = input;
          return { ok: true, value: { invitationId: review.invitationId, campaignId: review.campaignId, status: "declined" as const } };
        },
      }),
    });
    const reviewed = await app.inject({
      method: "POST", url: "/invitations/review", headers: cookie, payload: { token: "bearer-token" },
    });
    expect(reviewed.statusCode).toBe(200);
    expect(reviewed.json().review).toMatchObject({
      invitationRevision: review.invitationRevision,
      accessRevision: review.accessRevision,
    });

    const accepted = await app.inject({
      method: "POST", url: "/invitations/accept", headers: cookie,
      payload: {
        campaignId: review.campaignId,
        token: "bearer-token",
        expectedInvitationRevision: review.invitationRevision,
        reviewedAccessRevision: review.accessRevision,
        idempotencyKey: "accept-1",
      },
    });
    expect(accepted.statusCode).toBe(200);
    expect(acceptInput).toEqual({
      campaignId: review.campaignId,
      token: "bearer-token",
      expectedInvitationRevision: review.invitationRevision,
      reviewedAccessRevision: review.accessRevision,
      idempotencyKey: "accept-1",
    });

    const declined = await app.inject({
      method: "POST", url: "/invitations/decline", headers: cookie,
      payload: {
        campaignId: review.campaignId,
        token: "bearer-token",
        expectedInvitationRevision: review.invitationRevision,
        reviewedAccessRevision: review.accessRevision,
        idempotencyKey: "decline-1",
      },
    });
    expect(declined.statusCode).toBe(200);
    expect(declineInput).toEqual({
      campaignId: review.campaignId,
      token: "bearer-token",
      expectedInvitationRevision: review.invitationRevision,
      reviewedAccessRevision: review.accessRevision,
      idempotencyKey: "decline-1",
    });

    // Unknown/revoked/expired tokens collapse without distinction.
    const unknownApp = await build({
      campaigns: makeCampaigns({
        reviewInvitation: async () => ({ ok: false, error: { code: "not_found", message: "unavailable" } }),
      }),
    });
    const unknown = await unknownApp.inject({
      method: "POST", url: "/invitations/review", headers: cookie, payload: { token: "stale" },
    });
    expect(unknown.statusCode).toBe(404);
  });

  it("requires explicit revision/key bodies on DELETE mutations", async () => {
    const app = await build({});
    const memberUrl = `/campaigns/${randomUUID()}/members/${randomUUID()}`;
    const noBody = await app.inject({ method: "DELETE", url: memberUrl, headers: cookie, payload: {} });
    expect(noBody.statusCode).toBe(400);
    const okMember = await app.inject({
      method: "DELETE", url: memberUrl, headers: cookie,
      payload: { expectedCampaignRevision: 1, idempotencyKey: "leave-1" },
    });
    expect(okMember.statusCode).toBe(200);
    expect(okMember.json()).toEqual({ member: expect.any(Object), requestId: expect.any(String) });

    const contentUrl = `/content/${randomUUID()}`;
    const noContentBody = await app.inject({ method: "DELETE", url: contentUrl, headers: cookie, payload: {} });
    expect(noContentBody.statusCode).toBe(400);
    const okContent = await app.inject({
      method: "DELETE", url: contentUrl, headers: cookie,
      payload: { expectedContentRevision: 2, idempotencyKey: "del-1" },
    });
    expect(okContent.statusCode).toBe(200);
  });

  it("creates campaign characters Runtime-prepared on the pinned version via one owning-module call", async () => {
    const campaignId = randomUUID();
    const pinnedVersionId = randomUUID();
    let resolveInput: unknown;
    let createInput: unknown;
    const fullView = fakeCharacterView();
    const placed = placedView({ campaignId, characterId: fullView.characterId });
    const runtime: SystemRuntime = {
      resolve: async (input: unknown) => {
        resolveInput = input;
        return {
          ok: true,
          value: { versionId: pinnedVersionId, state: { schemaVersion: "1.0", values: {} }, packageChecksum: "chk" },
        };
      },
    } as unknown as SystemRuntime;
    const app = await build({
      campaigns: makeCampaigns({
        open: async () => ({ ok: true, value: campaignView({ campaignId, systemVersionId: pinnedVersionId }) }),
        createCampaignCharacter: async (_ctx, input) => {
          createInput = input;
          return { ok: true, value: placed };
        },
      }),
      characters: { open: async () => ({ ok: true, value: fullView }) } as unknown as Characters,
      runtime,
    });
    const response = await app.inject({
      method: "POST", url: `/campaigns/${campaignId}/characters`, headers: cookie,
      payload: {
        name: "New Hero", entityDefinitionId: "character",
        initialValues: { ability: 12 },
        expectedCampaignRevision: 3, idempotencyKey: "create-1",
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().character).toMatchObject({ characterId: fullView.characterId });
    expect(resolveInput).toMatchObject({ versionId: pinnedVersionId, entityId: "character" });
    // The adapter decodes the wire and passes Runtime prep through; the
    // membership generation stays server-side (resolved in-transaction by
    // the owning module, never a wire field).
    expect(createInput).toMatchObject({
      campaignId, expectedCampaignRevision: 3, idempotencyKey: "create-1", name: "New Hero",
    });
    expect(createInput).not.toHaveProperty("membershipGeneration");
    expect(createInput).toMatchObject({ prepared: { versionId: pinnedVersionId } });
  });

  it("maps placement failures without a post-commit read (no post-commit read on denial)", async () => {
    const campaignId = randomUUID();
    const characterId = randomUUID();
    let postCommitReads = 0;
    const characters = {
      open: async () => {
        postCommitReads += 1;
        return { ok: true, value: fakeCharacterView() };
      },
    } as unknown as Characters;
    const failing = await build({
      campaigns: makeCampaigns({
        claimCampaignCharacter: async () => ({ ok: false, error: { code: "conflict", message: "designation missing" } }),
      }),
      characters,
    });
    const failed = await failing.inject({
      method: "POST", url: `/campaigns/${campaignId}/characters/${characterId}/claim`, headers: cookie,
      payload: { expectedCampaignRevision: 1, expectedCharacterRevision: 1, idempotencyKey: "claim-1" },
    });
    expect(failed.statusCode).toBe(409);
    expect(failed.json().error.code).toBe("conflict");
    expect(postCommitReads).toBe(0);

    const outsider = await build({
      campaigns: makeCampaigns({
        adoptCampaignCharacter: async () => ({ ok: false, error: { code: "not_found", message: "nope" } }),
      }),
      characters,
    });
    const denied = await outsider.inject({
      method: "POST", url: `/campaigns/${campaignId}/characters/${characterId}/adopt`, headers: cookie,
      payload: { expectedCampaignRevision: 1, expectedCharacterRevision: 1, acknowledgedDisclosure: true, idempotencyKey: "adopt-1" },
    });
    expect(denied.statusCode).toBe(404);
    expect(postCommitReads).toBe(0);
  });

  it("maps post-commit read failures to result_unavailable without leaking (commit-then-revoke race)", async () => {
    const campaignId = randomUUID();
    const characterId = randomUUID();
    // The placement already committed; the follow-up Characters read fails
    // because the sheet was revoked or became undisclosable in between.
    // Fault injection stands in for the race: the committed outcome stays
    // committed and the wire carries a non-sensitive result_unavailable.
    for (const openError of [
      { code: "not_found", message: "The requested character does not exist." },
      { code: "internal", message: "database exploded: TOP SECRET" },
    ]) {
      const app = await build({
        campaigns: makeCampaigns({
          assignCampaignControllers: async () => ({ ok: true, value: placedView({ characterId, campaignId }) }),
        }),
        characters: { open: async () => ({ ok: false, error: openError }) } as unknown as Characters,
      });
      const response = await app.inject({
        method: "POST", url: `/campaigns/${campaignId}/characters/${characterId}/assign`, headers: cookie,
        payload: {
          controllerUserIds: [actorId],
          expectedCampaignRevision: 2, expectedCharacterRevision: 5, idempotencyKey: "assign-race-1",
        },
      });
      expect(response.statusCode, openError.code).toBe(409);
      expect(response.statusCode, openError.code).not.toBe(500);
      const body = response.json() as { error: { code: string; message: string } };
      expect(body.error.code).toBe("result_unavailable");
      expect(JSON.stringify(body)).not.toContain("TOP SECRET");
      expect(body).not.toHaveProperty("character");
    }
  });

  it("maps assign/claim/adopt to one owning-module call each with explicit revisions and full views", async () => {
    const campaignId = randomUUID();
    const characterId = randomUUID();
    const seen: Record<string, unknown> = {};
    const fullView = fakeCharacterView();
    const app = await build({
      characters: { open: async () => ({ ok: true, value: fullView }) } as unknown as Characters,
      campaigns: makeCampaigns({
        assignCampaignControllers: async (_ctx, input) => {
          seen.assign = input;
          return { ok: true, value: placedView({ characterId, campaignId }) };
        },
        claimCampaignCharacter: async (_ctx, input) => {
          seen.claim = input;
          return { ok: true, value: placedView({ characterId, campaignId }) };
        },
        adoptCampaignCharacter: async (_ctx, input) => {
          seen.adopt = input;
          return { ok: true, value: placedView({ characterId, campaignId }) };
        },
      }),
    });
    const assign = await app.inject({
      method: "POST", url: `/campaigns/${campaignId}/characters/${characterId}/assign`, headers: cookie,
      payload: {
        controllerUserIds: [actorId], designateClaimants: [actorId],
        expectedCampaignRevision: 2, expectedCharacterRevision: 5, idempotencyKey: "assign-1",
      },
    });
    expect(assign.statusCode).toBe(200);
    expect(seen.assign).toMatchObject({ campaignId, characterId, expectedCampaignRevision: 2, expectedCharacterRevision: 5 });

    const claim = await app.inject({
      method: "POST", url: `/campaigns/${campaignId}/characters/${characterId}/claim`, headers: cookie,
      payload: { expectedCampaignRevision: 2, expectedCharacterRevision: 5, idempotencyKey: "claim-1" },
    });
    expect(claim.statusCode).toBe(200);
    expect(seen.claim).toMatchObject({ campaignId, characterId });

    const adopt = await app.inject({
      method: "POST", url: `/campaigns/${campaignId}/characters/${characterId}/adopt`, headers: cookie,
      payload: { expectedCampaignRevision: 2, expectedCharacterRevision: 5, acknowledgedDisclosure: true, idempotencyKey: "adopt-1" },
    });
    expect(adopt.statusCode).toBe(200);
    expect(seen.adopt).toMatchObject({ acknowledgedDisclosure: true });
    expect(adopt.json().character).toMatchObject({ characterId: fullView.characterId });
  });

  it("maps content, activity and export operations with wire decoding", async () => {
    const view = contentView();
    const summary = {
      contentId: view.contentId,
      campaignId: view.campaignId,
      creatorId: view.creatorId,
      audience: view.audience,
      title: view.title,
      tags: view.tags,
      revision: view.revision,
      accessRevision: view.accessRevision,
      status: view.status,
      createdAt: view.createdAt,
      updatedAt: view.updatedAt,
    };
    const app = await build({
      campaigns: makeCampaigns({
        openContent: async () => ({ ok: true, value: view }),
        listContent: async () => ({ ok: true, value: { content: [summary], nextCursor: "cursor-1" } }),
      }),
    });
    const read = await app.inject({ method: "GET", url: `/content/${view.contentId}`, headers: cookie });
    expect(read.statusCode).toBe(200);
    expect(read.headers.etag).toBe(`"content-${view.revision}-${view.accessRevision}"`);
    expect(read.json().content).toMatchObject({ contentId: view.contentId, body: view.body });

    const listed = await app.inject({ method: "GET", url: `/campaigns/${view.campaignId}/content?limit=10`, headers: cookie });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().nextCursor).toBe("cursor-1");
    expect(listed.json().content[0].status).toBe("active");

    let statusInput: unknown;
    const statusApp = await build({
      campaigns: makeCampaigns({
        openContent: async () => ({ ok: true, value: view }),
        listContent: async (_ctx, input) => {
          statusInput = input;
          return { ok: true, value: { content: [], nextCursor: null } };
        },
      }),
    });
    const deleted = await statusApp.inject({
      method: "GET",
      url: `/campaigns/${view.campaignId}/content?status=deleted`,
      headers: cookie,
    });
    expect(deleted.statusCode).toBe(200);
    expect(statusInput).toMatchObject({ status: "deleted" });
    const invalid = await statusApp.inject({
      method: "GET",
      url: `/campaigns/${view.campaignId}/content?status=archived`,
      headers: cookie,
    });
    expect(invalid.statusCode).toBe(400);

    const oversize = await build({
      campaigns: makeCampaigns({
        createContent: async () => ({ ok: false, error: { code: "bad_request", message: "body must be at most 100000 characters." } }),
      }),
    });
    const tooBig = await oversize.inject({
      method: "POST", url: `/campaigns/${view.campaignId}/content`, headers: cookie,
      payload: { body: "x".repeat(100001), idempotencyKey: "k" },
    });
    expect(tooBig.statusCode).toBe(400);

    const exported = await app.inject({
      method: "POST", url: `/campaigns/${view.campaignId}/exports`, headers: cookie, payload: { idempotencyKey: "exp-1" },
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.json().export).toMatchObject({ exportVersion: 1 });
  });

  it("lists campaign characters and members with cursor pagination", async () => {
    let charactersInput: unknown;
    const app = await build({
      campaigns: makeCampaigns({
        listCharacters: async (_ctx, input) => {
          charactersInput = input;
          return { ok: true, value: { characters: [characterSummary()], nextCursor: "char-cursor" } };
        },
        listMembers: async () => ({ ok: true, value: { members: [memberView()], nextCursor: null } }),
      }),
    });
    const id = randomUUID();
    const characters = await app.inject({ method: "GET", url: `/campaigns/${id}/characters?limit=25`, headers: cookie });
    expect(characters.statusCode).toBe(200);
    expect(characters.json().characters).toHaveLength(1);
    expect(characters.json().nextCursor).toBe("char-cursor");
    expect(charactersInput).toEqual({ campaignId: id, limit: 25, cursor: null });

    const members = await app.inject({ method: "GET", url: `/campaigns/${id}/members`, headers: cookie });
    expect(members.statusCode).toBe(200);
    expect(members.json().members).toHaveLength(1);
  });

  it("lists claimable characters with exact four-field rows and maps auth/page errors", async () => {
    let claimInput: unknown;
    const claimRow = {
      characterId: randomUUID(),
      name: "Bram",
      revision: 3,
      lifecycle: "active" as const,
    };
    const app = await build({
      campaigns: makeCampaigns({
        listClaimableCharacters: async (_ctx, input) => {
          claimInput = input;
          return { ok: true, value: { characters: [claimRow], nextCursor: "claim-cursor" } };
        },
      }),
    });
    const id = randomUUID();
    const listed = await app.inject({
      method: "GET",
      url: `/campaigns/${id}/claimable-characters?limit=1`,
      headers: cookie,
    });
    expect(listed.statusCode).toBe(200);
    expect(Object.keys(listed.json().characters[0]).sort()).toEqual([
      "characterId",
      "lifecycle",
      "name",
      "revision",
    ]);
    expect(listed.json().nextCursor).toBe("claim-cursor");
    expect(claimInput).toEqual({ campaignId: id, limit: 1, cursor: null });

    const unauthenticated = await app.inject({ method: "GET", url: `/campaigns/${id}/claimable-characters` });
    expect(unauthenticated.statusCode).toBe(401);

    const denied = await build({
      campaigns: makeCampaigns({
        listClaimableCharacters: async () => ({ ok: false, error: { code: "not_found", message: "nope" } }),
      }),
    });
    const missing = await denied.inject({
      method: "GET",
      url: `/campaigns/${id}/claimable-characters`,
      headers: cookie,
    });
    expect(missing.statusCode).toBe(404);

    const badLimit = await app.inject({
      method: "GET",
      url: `/campaigns/${id}/claimable-characters?limit=0`,
      headers: cookie,
    });
    expect(badLimit.statusCode).toBe(400);
  });

  it("previews campaign upgrades with exact field mapping and no projection keys", async () => {
    const campaignId = randomUUID();
    const sourceVersionId = randomUUID();
    const targetVersionId = randomUUID();
    const characterId = randomUUID();
    let received: unknown;
    const app = await build({
      campaigns: makeCampaigns({
        previewUpgrade: async (_ctx, input) => {
          received = input;
          return {
            ok: true,
            value: {
              campaignId,
              campaignRevision: 3,
              sourceVersionId,
              targetVersionId,
              targetSemanticVersion: "2.0.0",
              characters: [
                {
                  characterId,
                  name: "Mira",
                  sourceVersionId,
                  warnings: ["definition dropped: old-field"],
                  requiresMapping: true,
                },
              ],
            },
          };
        },
      }),
    });
    const preview = await app.inject({
      method: "POST",
      url: `/campaigns/${campaignId}/upgrade-previews`,
      headers: cookie,
      payload: { targetVersionId, mappings: { "old-field": "new-field" }, defaults: { level: 1 } },
    });
    expect(preview.statusCode).toBe(200);
    expect(received).toEqual({
      campaignId,
      targetVersionId,
      mappings: { "old-field": "new-field" },
      defaults: { level: 1 },
    });
    const body = preview.json();
    expect(Object.keys(body)).toContain("characters");
    expect(body).toMatchObject({
      campaignId,
      campaignRevision: 3,
      sourceVersionId,
      targetVersionId,
      targetSemanticVersion: "2.0.0",
    });
    expect(body.characters).toHaveLength(1);
    expect(body.characters[0]).toMatchObject({ characterId, name: "Mira", requiresMapping: true });
    expect(JSON.stringify(body)).not.toContain("candidateState");
    expect(JSON.stringify(body)).not.toContain("projection");
    expect(body.requestId).toBeTypeOf("string");

    const unauthenticated = await app.inject({
      method: "POST",
      url: `/campaigns/${campaignId}/upgrade-previews`,
      payload: { targetVersionId },
    });
    expect(unauthenticated.statusCode).toBe(401);

    const denied = await build({
      campaigns: makeCampaigns({
        previewUpgrade: async () => ({ ok: false, error: { code: "not_found", message: "nope" } }),
      }),
    });
    const missing = await denied.inject({
      method: "POST",
      url: `/campaigns/${campaignId}/upgrade-previews`,
      headers: cookie,
      payload: { targetVersionId },
    });
    expect(missing.statusCode).toBe(404);

    const empty = await app.inject({
      method: "POST",
      url: `/campaigns/${campaignId}/upgrade-previews`,
      headers: cookie,
      payload: {},
    });
    expect(empty.statusCode).toBe(400);
    expect(empty.json().error.code).toBe("bad_request");

    const malformed = await app.inject({
      method: "POST",
      url: `/campaigns/${campaignId}/upgrade-previews`,
      headers: cookie,
      payload: { targetVersionId: "not-a-uuid" },
    });
    expect(malformed.statusCode).toBe(400);
  });

  it("commits campaign upgrades with revision/key guards and 422 mapping errors", async () => {
    const campaignId = randomUUID();
    const sourceVersionId = randomUUID();
    const targetVersionId = randomUUID();
    const migratedId = randomUUID();
    const idempotencyKey = randomUUID();
    let received: unknown;
    const app = await build({
      campaigns: makeCampaigns({
        commitUpgrade: async (_ctx, input) => {
          received = input;
          return {
            ok: true,
            value: {
              campaignId,
              campaignRevision: 4,
              sourceVersionId,
              targetVersionId,
              migratedCharacterIds: [migratedId],
            },
          };
        },
      }),
    });
    const commit = await app.inject({
      method: "POST",
      url: `/campaigns/${campaignId}/upgrade-commits`,
      headers: cookie,
      payload: { targetVersionId, expectedCampaignRevision: 3, idempotencyKey },
    });
    expect(commit.statusCode).toBe(200);
    expect(received).toEqual({ campaignId, targetVersionId, expectedCampaignRevision: 3, idempotencyKey });
    expect(commit.json()).toMatchObject({
      campaignId,
      campaignRevision: 4,
      sourceVersionId,
      targetVersionId,
      migratedCharacterIds: [migratedId],
    });
    expect(commit.json().requestId).toBeTypeOf("string");

    const unauthenticated = await app.inject({
      method: "POST",
      url: `/campaigns/${campaignId}/upgrade-commits`,
      payload: { targetVersionId, expectedCampaignRevision: 3, idempotencyKey },
    });
    expect(unauthenticated.statusCode).toBe(401);

    const denied = await build({
      campaigns: makeCampaigns({
        commitUpgrade: async () => ({ ok: false, error: { code: "not_found", message: "nope" } }),
      }),
    });
    const missing = await denied.inject({
      method: "POST",
      url: `/campaigns/${campaignId}/upgrade-commits`,
      headers: cookie,
      payload: { targetVersionId, expectedCampaignRevision: 3, idempotencyKey },
    });
    expect(missing.statusCode).toBe(404);

    for (const payload of [
      {},
      { expectedCampaignRevision: 3, idempotencyKey },
      { targetVersionId, expectedCampaignRevision: 3 },
      { targetVersionId, expectedCampaignRevision: 3, idempotencyKey: "not-a-uuid" },
      { targetVersionId, expectedCampaignRevision: 1.5, idempotencyKey },
      { targetVersionId: "not-a-uuid", expectedCampaignRevision: 3, idempotencyKey },
    ]) {
      const invalid = await app.inject({
        method: "POST",
        url: `/campaigns/${campaignId}/upgrade-commits`,
        headers: cookie,
        payload,
      });
      expect(invalid.statusCode, JSON.stringify(payload)).toBe(400);
      expect(invalid.json().error.code).toBe("bad_request");
    }

    const conflicted = await build({
      campaigns: makeCampaigns({
        commitUpgrade: async () => ({
          ok: false,
          error: { code: "conflict", message: "stale", latestRevision: 9 },
        }),
      }),
    });
    const conflict = await conflicted.inject({
      method: "POST",
      url: `/campaigns/${campaignId}/upgrade-commits`,
      headers: cookie,
      payload: { targetVersionId, expectedCampaignRevision: 3, idempotencyKey },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error).toMatchObject({ code: "conflict", latestRevision: 9 });

    const characterId = randomUUID();
    const unmapped = await build({
      campaigns: makeCampaigns({
        commitUpgrade: async () => ({
          ok: false,
          error: {
            code: "invalid_value",
            message: `Character ${characterId}: missing required mapping for definition "old-field"`,
          },
        }),
      }),
    });
    const rejected = await unmapped.inject({
      method: "POST",
      url: `/campaigns/${campaignId}/upgrade-commits`,
      headers: cookie,
      payload: { targetVersionId, expectedCampaignRevision: 3, idempotencyKey },
    });
    expect(rejected.statusCode).toBe(422);
    expect(rejected.json().error.code).toBe("invalid_value");
    expect(rejected.json().error.message).toContain(characterId);
    expect(rejected.json().error.message).toContain("old-field");
  });

  it("previews content as a member with the GM gate matrix", async () => {
    const campaignId = randomUUID();
    const targetUserId = randomUUID();
    const view = contentView({ campaignId });
    const summary = {
      contentId: view.contentId,
      campaignId: view.campaignId,
      creatorId: view.creatorId,
      audience: view.audience,
      title: view.title,
      tags: view.tags,
      revision: view.revision,
      accessRevision: view.accessRevision,
      status: view.status,
      createdAt: view.createdAt,
      updatedAt: view.updatedAt,
    };
    let received: unknown;
    const app = await build({
      campaigns: makeCampaigns({
        previewContent: async (_ctx, input) => {
          received = input;
          if (input.contentId !== undefined) {
            return { ok: true as const, value: { kind: "item" as const, content: view } };
          }
          return { ok: true as const, value: { kind: "list" as const, content: [summary] } };
        },
      }),
    });

    // GM caller + active-member target: 200 with list rows in the member
    // list shape (same fields the member's real list returns).
    const listed = await app.inject({
      method: "POST",
      url: `/campaigns/${campaignId}/content-preview`,
      headers: cookie,
      payload: { targetUserId },
    });
    expect(listed.statusCode).toBe(200);
    expect(received).toEqual({ campaignId, targetUserId });
    expect(listed.json().content).toHaveLength(1);
    expect(listed.json().content[0]).toMatchObject({
      contentId: summary.contentId,
      title: summary.title,
      status: "active",
    });
    expect(listed.json().nextCursor).toBeNull();
    expect(listed.json().requestId).toBeTypeOf("string");
    expect(listed.headers["cache-control"]).toBe("no-store");

    // Single item: the projected reader view with its body.
    const itemId = randomUUID();
    const single = await app.inject({
      method: "POST",
      url: `/campaigns/${campaignId}/content-preview`,
      headers: cookie,
      payload: { targetUserId, contentId: itemId },
    });
    expect(single.statusCode).toBe(200);
    expect(received).toEqual({ campaignId, targetUserId, contentId: itemId });
    expect(single.json().content).toMatchObject({ contentId: view.contentId, body: view.body });
    expect(single.json().requestId).toBeTypeOf("string");

    // Signed-out: 401 via the existing auth hook.
    const unauthenticated = await app.inject({
      method: "POST",
      url: `/campaigns/${campaignId}/content-preview`,
      payload: { targetUserId },
    });
    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.json().error.code).toBe("unauthorized");

    // Member caller (caller is not a GM): 403.
    const denied = await build({
      campaigns: makeCampaigns({
        previewContent: async () => ({
          ok: false as const,
          error: {
            code: "forbidden" as const,
            message: "Only game masters may preview content as another member.",
          },
        }),
      }),
    });
    const forbiddenResponse = await denied.inject({
      method: "POST",
      url: `/campaigns/${campaignId}/content-preview`,
      headers: cookie,
      payload: { targetUserId },
    });
    expect(forbiddenResponse.statusCode).toBe(403);
    expect(forbiddenResponse.json().error.code).toBe("forbidden");
    expect(forbiddenResponse.json().requestId).toBeTypeOf("string");

    // Non-member target, removed-member target and unknown campaign: 404.
    const missing = await build({
      campaigns: makeCampaigns({
        previewContent: async () => ({
          ok: false as const,
          error: {
            code: "not_found" as const,
            message: "The preview target is not an active member of this campaign.",
          },
        }),
      }),
    });
    for (const payload of [{ targetUserId }, { targetUserId, contentId: itemId }]) {
      const notFound = await missing.inject({
        method: "POST",
        url: `/campaigns/${campaignId}/content-preview`,
        headers: cookie,
        payload,
      });
      expect(notFound.statusCode, JSON.stringify(payload)).toBe(404);
      expect(notFound.json().error.code).toBe("not_found");
    }

    const unknown = await build({
      campaigns: makeCampaigns({
        previewContent: async () => ({
          ok: false as const,
          error: { code: "not_found" as const, message: "The requested campaign does not exist." },
        }),
      }),
    });
    const unknownCampaign = await unknown.inject({
      method: "POST",
      url: `/campaigns/${randomUUID()}/content-preview`,
      headers: cookie,
      payload: { targetUserId },
    });
    expect(unknownCampaign.statusCode).toBe(404);

    // Outsider and removed-member callers collapse to the same not_found
    // (the module returns campaign_not_found for both; proven in the parity
    // test) — no existence oracle, while active members keep the 403 above.
    for (const payload of [{ targetUserId }, { targetUserId, contentId: itemId }]) {
      const collapsed = await unknown.inject({
        method: "POST",
        url: `/campaigns/${campaignId}/content-preview`,
        headers: cookie,
        payload,
      });
      expect(collapsed.statusCode, JSON.stringify(payload)).toBe(404);
      expect(collapsed.json().error).toMatchObject({
        code: "not_found",
        message: "The requested campaign does not exist.",
      });
    }

    // Malformed bodies: 400.
    for (const payload of [{}, { targetUserId: "not-a-uuid" }, { targetUserId, contentId: "nope" }]) {
      const invalid = await app.inject({
        method: "POST",
        url: `/campaigns/${campaignId}/content-preview`,
        headers: cookie,
        payload,
      });
      expect(invalid.statusCode, JSON.stringify(payload)).toBe(400);
      expect(invalid.json().error.code).toBe("bad_request");
    }
  });
});

// 1x1 transparent PNG fixture (inline base64, mirrors the module suite).
const ONE_BY_ONE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const displayHeaders = (secret: string) => ({ ...cookie, "x-display-secret": secret });

describe("campaign media/scene/display HTTP routes (I7b Task 4)", () => {
  afterAll(async () => {
    for (const app of apps) await app.close();
  });

  it("uploads images with exact field mapping and leak-free responses", async () => {
    const campaignId = randomUUID();
    const fileId = randomUUID();
    const idempotencyKey = randomUUID();
    let received: unknown;
    const app = await build({
      campaigns: makeCampaigns({
        uploadImage: async (_ctx, input) => {
          received = input;
          return { ok: true, value: mediaFileView({ fileId, campaignId }) };
        },
      }),
    });
    const res = await app.inject({
      method: "POST",
      url: `/campaigns/${campaignId}/images`,
      headers: cookie,
      payload: { name: "cave", contentType: "image/png", dataBase64: ONE_BY_ONE_PNG_BASE64, idempotencyKey },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ image: expect.any(Object), requestId: expect.any(String) });
    expect(res.json().image).toMatchObject({ fileId, campaignId, mediaType: "image/png" });
    expect(received).toEqual({ campaignId, name: "cave", contentType: "image/png", dataBase64: ONE_BY_ONE_PNG_BASE64, idempotencyKey });
    expect(JSON.stringify(res.json())).not.toContain("storage_key");

    const unauthenticated = await app.inject({
      method: "POST",
      url: `/campaigns/${campaignId}/images`,
      payload: { name: "cave", contentType: "image/png", dataBase64: ONE_BY_ONE_PNG_BASE64, idempotencyKey },
    });
    expect(unauthenticated.statusCode).toBe(401);

    const denied = await build({
      campaigns: makeCampaigns({
        uploadImage: async () => ({ ok: false, error: { code: "not_found", message: "nope" } }),
      }),
    });
    const missing = await denied.inject({
      method: "POST",
      url: `/campaigns/${campaignId}/images`,
      headers: cookie,
      payload: { name: "cave", contentType: "image/png", dataBase64: ONE_BY_ONE_PNG_BASE64, idempotencyKey },
    });
    expect(missing.statusCode).toBe(404);

    for (const payload of [
      { name: "cave", contentType: "image/gif", dataBase64: ONE_BY_ONE_PNG_BASE64, idempotencyKey },
      { name: "cave", contentType: "image/png", dataBase64: ONE_BY_ONE_PNG_BASE64, idempotencyKey: "not-a-uuid" },
      { name: "", contentType: "image/png", dataBase64: ONE_BY_ONE_PNG_BASE64, idempotencyKey },
      { name: "cave", contentType: "image/png", dataBase64: "", idempotencyKey },
      { name: "cave", contentType: "image/png", idempotencyKey },
    ]) {
      const invalid = await app.inject({
        method: "POST",
        url: `/campaigns/${campaignId}/images`,
        headers: cookie,
        payload,
      });
      expect(invalid.statusCode, JSON.stringify(payload)).toBe(400);
      expect(invalid.json().error.code).toBe("bad_request");
    }

    const tooLarge = await build({
      campaigns: makeCampaigns({
        uploadImage: async () => ({ ok: false, error: { code: "too_large", message: "Image bytes exceed the cap." } }),
      }),
    });
    const capped = await tooLarge.inject({
      method: "POST",
      url: `/campaigns/${campaignId}/images`,
      headers: cookie,
      payload: { name: "cave", contentType: "image/png", dataBase64: ONE_BY_ONE_PNG_BASE64, idempotencyKey },
    });
    expect(capped.statusCode).toBe(413);
    expect(capped.json().error.code).toBe("too_large");

    // Payloads past Fastify's JSON body limit surface as 413 too_large, not 500.
    const oversized = await app.inject({
      method: "POST",
      url: `/campaigns/${campaignId}/images`,
      headers: cookie,
      payload: { name: "cave", contentType: "image/png", dataBase64: "A".repeat(2 * 1024 * 1024), idempotencyKey },
    });
    expect(oversized.statusCode).toBe(413);
    expect(oversized.json().error.code).toBe("too_large");

    const undecodable = await build({
      campaigns: makeCampaigns({
        uploadImage: async () => ({ ok: false, error: { code: "unprocessable", message: "bad magic" } }),
      }),
    });
    const rejected422 = await undecodable.inject({
      method: "POST",
      url: `/campaigns/${campaignId}/images`,
      headers: cookie,
      payload: { name: "cave", contentType: "image/png", dataBase64: ONE_BY_ONE_PNG_BASE64, idempotencyKey },
    });
    expect(rejected422.statusCode).toBe(422);
    expect(rejected422.json().error.code).toBe("unprocessable");
  });

  it("deletes images and serves GM originals as no-store bytes", async () => {
    const campaignId = randomUUID();
    const fileId = randomUUID();
    const idempotencyKey = randomUUID();
    let received: unknown;
    const app = await build({
      campaigns: makeCampaigns({
        deleteImage: async (_ctx, input) => {
          received = input;
          return { ok: true, value: mediaFileView({ fileId, campaignId }) };
        },
        openImage: async () => ({
          ok: true as const,
          value: { file: mediaFileView({ fileId, campaignId }), contentType: "image/png" as const, bytes: Buffer.from(ONE_BY_ONE_PNG_BASE64, "base64") },
        }),
      }),
    });
    const deleted = await app.inject({
      method: "DELETE",
      url: `/campaigns/${campaignId}/images/${fileId}`,
      headers: cookie,
      payload: { expectedRevision: 2, idempotencyKey },
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().image).toMatchObject({ fileId, campaignId });
    expect(received).toEqual({ fileId, expectedRevision: 2, idempotencyKey });

    const noBody = await app.inject({
      method: "DELETE",
      url: `/campaigns/${campaignId}/images/${fileId}`,
      headers: cookie,
      payload: {},
    });
    expect(noBody.statusCode).toBe(400);

    const original = await app.inject({
      method: "GET",
      url: `/campaigns/${campaignId}/images/${fileId}/original`,
      headers: cookie,
    });
    expect(original.statusCode).toBe(200);
    expect(original.headers["content-type"]).toBe("image/png");
    expect(original.headers["cache-control"]).toBe("no-store");
    expect(original.rawPayload.equals(Buffer.from(ONE_BY_ONE_PNG_BASE64, "base64"))).toBe(true);

    const unauthenticated = await app.inject({ method: "GET", url: `/campaigns/${campaignId}/images/${fileId}/original` });
    expect(unauthenticated.statusCode).toBe(401);

    // A file from another campaign reads as 404 through this campaign's URL.
    const crossed = await build({
      campaigns: makeCampaigns({
        openImage: async () => ({
          ok: true as const,
          value: { file: mediaFileView({ fileId, campaignId: randomUUID() }), contentType: "image/png" as const, bytes: Buffer.from([9]) },
        }),
      }),
    });
    const mismatch = await crossed.inject({
      method: "GET",
      url: `/campaigns/${campaignId}/images/${fileId}/original`,
      headers: cookie,
    });
    expect(mismatch.statusCode).toBe(404);
  });

  it("refuses cross-campaign image deletes before any mutation", async () => {
    const campaignId = randomUUID();
    const fileId = randomUUID();
    const idempotencyKey = randomUUID();
    // A file owned elsewhere reads as 404 through this campaign's URL
    // WITHOUT deleting: the openImage pre-check runs before any mutation.
    let deleteCalls = 0;
    const scoped = await build({
      campaigns: makeCampaigns({
        openImage: async () => ({
          ok: true as const,
          value: { file: mediaFileView({ fileId, campaignId: randomUUID() }), contentType: "image/png" as const, bytes: Buffer.from([9]) },
        }),
        deleteImage: async () => {
          deleteCalls += 1;
          return { ok: true as const, value: mediaFileView({ fileId, campaignId }) };
        },
      }),
    });
    const wrongCampaign = await scoped.inject({
      method: "DELETE",
      url: `/campaigns/${campaignId}/images/${fileId}`,
      headers: cookie,
      payload: { expectedRevision: 1, idempotencyKey },
    });
    expect(wrongCampaign.statusCode).toBe(404);
    expect(wrongCampaign.json().error.code).toBe("not_found");
    expect(wrongCampaign.json()).not.toHaveProperty("image");
    expect(deleteCalls).toBe(0);

    // The pre-check failure propagates the same way: an outsider of the
    // owning campaign cannot reach the delete call either.
    let outsiderDeleteCalls = 0;
    const unscoped = await build({
      campaigns: makeCampaigns({
        openImage: async () => ({ ok: false, error: { code: "not_found", message: "nope" } }),
        deleteImage: async () => {
          outsiderDeleteCalls += 1;
          return { ok: true as const, value: mediaFileView({ fileId, campaignId }) };
        },
      }),
    });
    const outsider = await unscoped.inject({
      method: "DELETE",
      url: `/campaigns/${campaignId}/images/${fileId}`,
      headers: cookie,
      payload: { expectedRevision: 1, idempotencyKey },
    });
    expect(outsider.statusCode).toBe(404);
    expect(outsiderDeleteCalls).toBe(0);
  });

  it("creates, reads and updates scenes under GM auth", async () => {
    const campaignId = randomUUID();
    const sceneId = randomUUID();
    const backgroundFileId = randomUUID();
    const idempotencyKey = randomUUID();
    const seen: Record<string, unknown> = {};
    const app = await build({
      campaigns: makeCampaigns({
        createScene: async (_ctx, input) => {
          seen.create = input;
          return { ok: true, value: sceneView({ sceneId, campaignId, backgroundFileId }) };
        },
        openScene: async (_ctx, input) => {
          seen.open = input;
          return { ok: true, value: sceneView({ sceneId, campaignId, backgroundFileId }) };
        },
        updateScene: async (_ctx, input) => {
          seen.update = input;
          return { ok: true, value: sceneView({ sceneId, campaignId, backgroundFileId, revision: 2 }) };
        },
      }),
    });
    const created = await app.inject({
      method: "POST",
      url: `/campaigns/${campaignId}/scenes`,
      headers: cookie,
      payload: { backgroundFileId, idempotencyKey },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().scene).toMatchObject({ sceneId, campaignId, backgroundFileId });
    expect(seen.create).toEqual({ campaignId, backgroundFileId, idempotencyKey });

    const read = await app.inject({ method: "GET", url: `/scenes/${sceneId}`, headers: cookie });
    expect(read.statusCode).toBe(200);
    expect(read.json().scene).toMatchObject({ sceneId, revision: 1 });
    expect(seen.open).toEqual({ sceneId });

    const updated = await app.inject({
      method: "PATCH",
      url: `/scenes/${sceneId}`,
      headers: cookie,
      payload: { backgroundFileId, expectedSceneRevision: 1, idempotencyKey },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().scene).toMatchObject({ revision: 2 });
    expect(seen.update).toEqual({ sceneId, backgroundFileId, expectedSceneRevision: 1, idempotencyKey });

    const unauthenticated = await app.inject({ method: "GET", url: `/scenes/${sceneId}` });
    expect(unauthenticated.statusCode).toBe(401);

    const denied = await build({
      campaigns: makeCampaigns({
        openScene: async () => ({ ok: false, error: { code: "not_found", message: "nope" } }),
      }),
    });
    expect((await denied.inject({ method: "GET", url: `/scenes/${sceneId}`, headers: cookie })).statusCode).toBe(404);

    const conflicted = await build({
      campaigns: makeCampaigns({
        updateScene: async () => ({ ok: false, error: { code: "conflict", message: "stale", latestRevision: 7 } }),
      }),
    });
    const conflict = await conflicted.inject({
      method: "PATCH",
      url: `/scenes/${sceneId}`,
      headers: cookie,
      payload: { backgroundFileId, expectedSceneRevision: 1, idempotencyKey },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error).toMatchObject({ code: "conflict", latestRevision: 7 });

    const empty = await app.inject({
      method: "POST",
      url: `/campaigns/${campaignId}/scenes`,
      headers: cookie,
      payload: { idempotencyKey },
    });
    expect(empty.statusCode).toBe(400);
  });

  it("applies fog edits and token mutations with revision guards", async () => {
    const sceneId = randomUUID();
    const tokenId = randomUUID();
    const idempotencyKey = randomUUID();
    const seen: Record<string, unknown> = {};
    const view = sceneView({ sceneId, revision: 3 });
    const app = await build({
      campaigns: makeCampaigns({
        applyFogEdit: async (_ctx, input) => {
          seen.fog = input;
          return { ok: true as const, value: view };
        },
        placeToken: async (_ctx, input) => {
          seen.place = input;
          return { ok: true as const, value: view };
        },
        moveToken: async (_ctx, input) => {
          seen.move = input;
          return { ok: true as const, value: view };
        },
        removeToken: async (_ctx, input) => {
          seen.remove = input;
          return { ok: true as const, value: view };
        },
      }),
    });
    const op = { mode: "reveal", runs: [{ x: 0.5, y: 0.5, r: 0.1 }] };
    const fogged = await app.inject({
      method: "POST",
      url: `/scenes/${sceneId}/fog-edits`,
      headers: cookie,
      payload: { expectedSceneRevision: 2, op, idempotencyKey },
    });
    expect(fogged.statusCode).toBe(200);
    expect(fogged.json().scene).toMatchObject({ sceneId, revision: 3 });
    expect(seen.fog).toEqual({ sceneId, expectedSceneRevision: 2, op, idempotencyKey });

    const placed = await app.inject({
      method: "POST",
      url: `/scenes/${sceneId}/tokens`,
      headers: cookie,
      payload: { expectedSceneRevision: 3, label: "Hero", x: 0.5, y: 0.5, size: 0.1, visible: true, imageFileId: null, idempotencyKey },
    });
    expect(placed.statusCode).toBe(200);
    expect(seen.place).toEqual({
      sceneId, expectedSceneRevision: 3, label: "Hero", x: 0.5, y: 0.5, size: 0.1, visible: true, imageFileId: null, idempotencyKey,
    });

    const moved = await app.inject({
      method: "PATCH",
      url: `/scenes/${sceneId}/tokens/${tokenId}`,
      headers: cookie,
      payload: { expectedSceneRevision: 3, x: 0.2, y: 0.8, idempotencyKey },
    });
    expect(moved.statusCode).toBe(200);
    expect(seen.move).toEqual({ sceneId, tokenId, expectedSceneRevision: 3, x: 0.2, y: 0.8, idempotencyKey });

    const removed = await app.inject({
      method: "DELETE",
      url: `/scenes/${sceneId}/tokens/${tokenId}`,
      headers: cookie,
      payload: { expectedSceneRevision: 3, idempotencyKey },
    });
    expect(removed.statusCode).toBe(200);
    expect(seen.remove).toEqual({ sceneId, tokenId, expectedSceneRevision: 3, idempotencyKey });

    // Out-of-range coordinates, bad modes and non-UUID keys are 400s.
    for (const { method, url, payload } of [
      { method: "POST", url: `/scenes/${sceneId}/tokens`, payload: { expectedSceneRevision: 3, label: "H", x: 2, y: 0.5, size: 0.1, visible: true, imageFileId: null, idempotencyKey } },
      { method: "POST", url: `/scenes/${sceneId}/tokens`, payload: { expectedSceneRevision: 3, label: "H", x: 0.5, y: 0.5, size: 0, visible: true, imageFileId: null, idempotencyKey } },
      { method: "POST", url: `/scenes/${sceneId}/fog-edits`, payload: { expectedSceneRevision: 3, op: { mode: "reveal", runs: [{ x: -1, y: 0.5, r: 0.1 }] }, idempotencyKey } },
      { method: "POST", url: `/scenes/${sceneId}/fog-edits`, payload: { expectedSceneRevision: 3, op: { mode: "smudge", runs: [{ x: 0.5, y: 0.5, r: 0.1 }] }, idempotencyKey } },
      { method: "POST", url: `/scenes/${sceneId}/fog-edits`, payload: { expectedSceneRevision: 3, op, idempotencyKey: "not-a-uuid" } },
    ] as Array<{ method: "POST" | "PATCH" | "DELETE"; url: string; payload: unknown }>) {
      const invalid = await app.inject({ method, url, headers: cookie, payload });
      expect(invalid.statusCode, JSON.stringify(payload)).toBe(400);
      expect(invalid.json().error.code).toBe("bad_request");
    }

    const noBody = await app.inject({
      method: "DELETE",
      url: `/scenes/${sceneId}/tokens/${tokenId}`,
      headers: cookie,
      payload: {},
    });
    expect(noBody.statusCode).toBe(400);
  });

  it("pairs, redeems and projects displays without a GM session", async () => {
    const campaignId = randomUUID();
    const sceneId = randomUUID();
    const displayId = randomUUID();
    const secret = "display-secret";
    const seen: Record<string, unknown> = {};
    const projection = displayProjection({
      sceneId,
      sceneRevision: 4,
      imageUrl: `/displays/${displayId}/scenes/${sceneId}/image?rev=4`,
      tokens: [{ tokenId: randomUUID(), label: "Hero", x: 0.5, y: 0.5, size: 0.1, imageUrl: `/displays/${displayId}/scenes/${sceneId}/tokens/tok/image?rev=4` }],
    });
    const app = await build({
      campaigns: makeCampaigns({
        pairDisplay: async (_ctx, input) => {
          seen.pair = input;
          return { ok: true as const, value: { code: "ABC123" } };
        },
        redeemDisplayCode: async (input) => {
          seen.redeem = input;
          return { ok: true as const, value: { displayId, secret } };
        },
        getDisplayProjection: async (input) => {
          seen.projection = input;
          if (input.secret.length === 0) return { ok: false, error: { code: "not_found", message: "nope" } };
          return { ok: true as const, value: projection };
        },
      }),
    });
    const paired = await app.inject({ method: "POST", url: `/campaigns/${campaignId}/display-codes`, headers: cookie, payload: {} });
    expect(paired.statusCode).toBe(200);
    expect(paired.json()).toEqual({ code: "ABC123", requestId: expect.any(String) });
    expect(seen.pair).toEqual({ campaignId });

    // The display redeems with no GM session: credential auth, never 401.
    // The anonymous app shares the same stubs so the credential is stable.
    const anonymous = await build({
      campaigns: makeCampaigns({
        redeemDisplayCode: async (input) => {
          seen.redeem = input;
          return { ok: true as const, value: { displayId, secret } };
        },
        getDisplayProjection: async (input) => {
          seen.projection = input;
          if (input.secret.length === 0) return { ok: false, error: { code: "not_found", message: "nope" } };
          return { ok: true as const, value: projection };
        },
      }),
      anonymous: true,
    });
    const redeemed = await anonymous.inject({ method: "POST", url: "/displays/redeem", payload: { code: "ABC123" } });
    expect(redeemed.statusCode).toBe(200);
    expect(redeemed.json()).toEqual({ display: { displayId, secret }, requestId: expect.any(String) });
    expect(seen.redeem).toEqual({ code: "ABC123" });

    const emptyCode = await anonymous.inject({ method: "POST", url: "/displays/redeem", payload: {} });
    expect(emptyCode.statusCode).toBe(400);

    // A code in the URL query is ignored: the credential travels in the body.
    const queried = await anonymous.inject({ method: "POST", url: "/displays/redeem?code=ABC123", payload: {} });
    expect(queried.statusCode).toBe(400);

    const projected = await anonymous.inject({
      method: "GET",
      url: `/displays/${displayId}/scenes/${sceneId}/projection`,
      headers: displayHeaders(secret),
    });
    expect(projected.statusCode).toBe(200);
    expect(projected.json()).toEqual({ projection: expect.any(Object), requestId: expect.any(String) });
    expect(seen.projection).toEqual({ displayId, secret, sceneId });
    const text = JSON.stringify(projected.json());
    expect(text).not.toContain("storage_key");
    expect(text).not.toContain("secret");
    expect(text).toContain("image?rev=4");

    // A secret in the URL query is ignored: the header carries the credential.
    const leaked = await anonymous.inject({
      method: "GET",
      url: `/displays/${displayId}/scenes/${sceneId}/projection?secret=${secret}`,
    });
    expect(leaked.statusCode).toBe(404);
    expect(seen.projection).toMatchObject({ secret: "" });

    const unknown = await build({
      campaigns: makeCampaigns({
        getDisplayProjection: async () => ({ ok: false, error: { code: "not_found", message: "nope" } }),
      }),
    });
    const missing = await unknown.inject({
      method: "GET",
      url: `/displays/${displayId}/scenes/${sceneId}/projection`,
      headers: displayHeaders(secret),
    });
    expect(missing.statusCode).toBe(404);
  });

  it("serves revision-keyed display image bytes with private caching", async () => {
    const sceneId = randomUUID();
    const displayId = randomUUID();
    const tokenId = randomUUID();
    const secret = "display-secret";
    const sceneBytes = Buffer.from([10, 20, 30]);
    const tokenBytes = Buffer.from([40, 50, 60]);
    const seen: Record<string, unknown> = {};
    const stubs = {
      getDisplaySceneImage: async (input: { displayId: string; secret: string; sceneId: string; rev: number }) => {
        seen.sceneImage = input;
        if (input.rev !== 4) return { ok: false as const, error: { code: "not_found" as const, message: "nope" } };
        return { ok: true as const, value: { contentType: "image/png", bytes: sceneBytes, revision: 4 } };
      },
      getDisplayTokenImage: async (input: { displayId: string; secret: string; sceneId: string; tokenId: string }) => {
        seen.tokenImage = input;
        return { ok: true as const, value: { contentType: "image/png", bytes: tokenBytes, revision: 4 } };
      },
    };
    const app = await build({ campaigns: makeCampaigns(stubs) });
    // Credential auth only: no GM session required, never 401.
    const unauthenticated = await build({ campaigns: makeCampaigns(stubs), anonymous: true });

    const image = await app.inject({
      method: "GET",
      url: `/displays/${displayId}/scenes/${sceneId}/image?rev=4`,
      headers: displayHeaders(secret),
    });
    expect(image.statusCode).toBe(200);
    expect(image.headers["content-type"]).toBe("image/png");
    expect(image.headers["cache-control"]).toBe("private, max-age=3600");
    expect(image.rawPayload.equals(sceneBytes)).toBe(true);
    expect(seen.sceneImage).toEqual({ displayId, secret, sceneId, rev: 4 });

    // No GM session: the display credential alone authorizes the bytes.
    const sessionless = await unauthenticated.inject({
      method: "GET",
      url: `/displays/${displayId}/scenes/${sceneId}/image?rev=4`,
      headers: displayHeaders(secret),
    });
    expect(sessionless.statusCode).toBe(200);
    expect(sessionless.rawPayload.equals(sceneBytes)).toBe(true);

    const stale = await app.inject({
      method: "GET",
      url: `/displays/${displayId}/scenes/${sceneId}/image?rev=3`,
      headers: displayHeaders(secret),
    });
    expect(stale.statusCode).toBe(404);

    const noRev = await app.inject({
      method: "GET",
      url: `/displays/${displayId}/scenes/${sceneId}/image`,
      headers: displayHeaders(secret),
    });
    expect(noRev.statusCode).toBe(400);

    const tokenImage = await app.inject({
      method: "GET",
      url: `/displays/${displayId}/scenes/${sceneId}/tokens/${tokenId}/image?rev=4`,
      headers: displayHeaders(secret),
    });
    expect(tokenImage.statusCode).toBe(200);
    expect(tokenImage.headers["content-type"]).toBe("image/png");
    expect(tokenImage.headers["cache-control"]).toBe("private, max-age=3600");
    expect(tokenImage.rawPayload.equals(tokenBytes)).toBe(true);
    expect(seen.tokenImage).toEqual({ displayId, secret, sceneId, tokenId });
  });

  it("lists display credentials as secret-free metadata and revokes them", async () => {
    const campaignId = randomUUID();
    const firstId = randomUUID();
    const secondId = randomUUID();
    let received: unknown;
    const app = await build({
      campaigns: makeCampaigns({
        listDisplayCredentials: async (_ctx, input) => {
          received = input;
          return {
            ok: true as const,
            value: [
              { displayId: firstId, campaignId, revokedAt: null, createdAt: new Date(0) },
              { displayId: secondId, campaignId, revokedAt: new Date(1), createdAt: new Date(0) },
            ],
          };
        },
        revokeDisplay: async (_ctx, input) => {
          received = input;
          return { ok: true as const, value: { displayId: firstId } };
        },
      }),
    });
    const listed = await app.inject({ method: "GET", url: `/campaigns/${campaignId}/display-credentials`, headers: cookie });
    expect(listed.statusCode).toBe(200);
    expect(received).toEqual({ campaignId });
    expect(listed.json()).toEqual({
      displays: [
        { displayId: firstId, campaignId, revokedAt: null, createdAt: new Date(0).toISOString() },
        { displayId: secondId, campaignId, revokedAt: new Date(1).toISOString(), createdAt: new Date(0).toISOString() },
      ],
      requestId: expect.any(String),
    });
    expect(JSON.stringify(listed.json())).not.toMatch(/secret/i);

    const unauthenticated = await app.inject({ method: "GET", url: `/campaigns/${campaignId}/display-credentials` });
    expect(unauthenticated.statusCode).toBe(401);

    const anonymousRevoke = await build({ anonymous: true });
    const revokedWithoutSession = await anonymousRevoke.inject({
      method: "POST",
      url: `/campaigns/${campaignId}/displays/${firstId}/revoke`,
      payload: {},
    });
    expect(revokedWithoutSession.statusCode).toBe(401);

    const revoked = await app.inject({
      method: "POST",
      url: `/campaigns/${campaignId}/displays/${firstId}/revoke`,
      headers: cookie,
      payload: {},
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toEqual({ display: { displayId: firstId }, requestId: expect.any(String) });
    expect(received).toEqual({ displayId: firstId });

    // A credential owned elsewhere reads as 404 through this campaign's URL
    // WITHOUT revoking: the namespace pre-check runs before any mutation.
    let revokeCalls = 0;
    const scoped = await build({
      campaigns: makeCampaigns({
        listDisplayCredentials: async (_ctx, input) => {
          expect(input).toEqual({ campaignId });
          return { ok: true as const, value: [] };
        },
        revokeDisplay: async () => {
          revokeCalls += 1;
          return { ok: true as const, value: { displayId: firstId } };
        },
      }),
    });
    const wrongCampaign = await scoped.inject({
      method: "POST",
      url: `/campaigns/${campaignId}/displays/${firstId}/revoke`,
      headers: cookie,
      payload: {},
    });
    expect(wrongCampaign.statusCode).toBe(404);
    expect(wrongCampaign.json().error.code).toBe("not_found");
    expect(wrongCampaign.json()).not.toHaveProperty("display");
    expect(revokeCalls).toBe(0);

    // The pre-check failure propagates the same way: an outsider of :id
    // cannot reach the revoke call either.
    let outsiderRevokeCalls = 0;
    const unscoped = await build({
      campaigns: makeCampaigns({
        listDisplayCredentials: async () => ({ ok: false, error: { code: "not_found", message: "nope" } }),
        revokeDisplay: async () => {
          outsiderRevokeCalls += 1;
          return { ok: true as const, value: { displayId: firstId } };
        },
      }),
    });
    const outsider = await unscoped.inject({
      method: "POST",
      url: `/campaigns/${campaignId}/displays/${firstId}/revoke`,
      headers: cookie,
      payload: {},
    });
    expect(outsider.statusCode).toBe(404);
    expect(outsiderRevokeCalls).toBe(0);

    const denied = await build({
      campaigns: makeCampaigns({
        listDisplayCredentials: async () => ({
          ok: true as const,
          value: [{ displayId: firstId, campaignId, revokedAt: null, createdAt: new Date(0) }],
        }),
        revokeDisplay: async () => ({ ok: false, error: { code: "not_found", message: "nope" } }),
      }),
    });
    const missing = await denied.inject({
      method: "POST",
      url: `/campaigns/${campaignId}/displays/${firstId}/revoke`,
      headers: cookie,
      payload: {},
    });
    expect(missing.statusCode).toBe(404);
  });

});
