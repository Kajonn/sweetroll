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
  InvitationAcceptSuccess,
  InvitationIssueReplay,
  InvitationIssueSuccess,
  InvitationReview,
  MemberView,
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
    createCampaignCharacter: async () => ({ ok: true, value: placedView() }),
    assignCampaignControllers: async () => ({ ok: true, value: placedView() }),
    claimCampaignCharacter: async () => ({ ok: true, value: placedView() }),
    adoptCampaignCharacter: async () => ({ ok: true, value: placedView() }),
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
      { method: "get", url: `/content/${contentId}` },
      { method: "patch", url: `/content/${contentId}`, payload: { title: "N", ...contentBody } },
      { method: "delete", url: `/content/${contentId}`, payload: contentBody },
      { method: "post", url: `/content/${contentId}/grants`, payload: { grantedUserIds: [], ...contentBody } },
      { method: "post", url: `/content/${contentId}/recover`, payload: contentBody },
      { method: "get", url: `/campaigns/${id}/activity` },
      { method: "post", url: `/campaigns/${id}/exports`, payload: { idempotencyKey: "k" } },
    ];
    expect(routes).toHaveLength(30);

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
});
