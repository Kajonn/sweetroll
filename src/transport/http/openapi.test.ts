import { describe, expect, it } from "vitest";
import Fastify from "fastify";

import type { Characters } from "../../characters/index.js";
import type { Campaigns } from "../../campaigns/index.js";
import type { SystemRuntime } from "../../systems/runtime.js";
import type { Identity } from "../../identity/index.js";
import { buildCampaignsRoutes } from "./campaigns.js";
import { buildCharactersRoutes } from "./characters.js";
import { buildIdentityRoutes } from "./identity.js";
import { buildOpenApiDocument } from "./openapi.js";
import { buildSystemsRoutes } from "./systems.js";
import type { SystemAuthoring } from "../../systems/authoring.js";

const testIdentity: Identity = {
  completeSignIn: async () => {
    throw new Error("not used");
  },
  resolveSession: async () => ({ state: "anonymous" }),
  signOut: async () => ({ ok: true, value: undefined }),
  getThemeDefault: async () => ({ ok: true, value: null }),
  setThemeDefault: async (_actorId, value) => ({ ok: true, value }),
};

describe("buildOpenApiDocument", () => {
  it("emits an OpenAPI 3.1 document with every systems, character and campaign route", async () => {
    const app = Fastify();
    void app.register(buildIdentityRoutes({ identity: testIdentity, cookieName: "session", secure: true }));
    void app.register(buildSystemsRoutes({ authoring: {} as SystemAuthoring }));
    void app.register(buildCharactersRoutes({ characters: {} as Characters }));
    void app.register(
      buildCampaignsRoutes({
        campaigns: {} as Campaigns,
        characters: {} as Characters,
        runtime: {} as SystemRuntime,
      }),
    );
    await app.ready();
    const doc = buildOpenApiDocument(app);
    expect(doc.openapi).toBe("3.1.0");
    expect(Object.keys(doc.paths ?? {}).sort()).toEqual([
      "/campaigns",
      "/campaigns/{id}",
      "/campaigns/{id}/activity",
      "/campaigns/{id}/archive",
      "/campaigns/{id}/characters",
      "/campaigns/{id}/characters/{characterId}/adopt",
      "/campaigns/{id}/characters/{characterId}/assign",
      "/campaigns/{id}/characters/{characterId}/claim",
      "/campaigns/{id}/claimable-characters",
      "/campaigns/{id}/content",
      "/campaigns/{id}/display-codes",
      "/campaigns/{id}/display-credentials",
      "/campaigns/{id}/displays/{displayId}/revoke",
      "/campaigns/{id}/exports",
      "/campaigns/{id}/images",
      "/campaigns/{id}/images/{fileId}",
      "/campaigns/{id}/images/{fileId}/original",
      "/campaigns/{id}/invitations",
      "/campaigns/{id}/invitations/{inviteId}/revoke",
      "/campaigns/{id}/invitations/{inviteId}/rotate",
      "/campaigns/{id}/members",
      "/campaigns/{id}/members/{userId}",
      "/campaigns/{id}/recover",
      "/campaigns/{id}/scenes",
      "/campaigns/{id}/upgrade-commits",
      "/campaigns/{id}/upgrade-previews",
      "/characters",
      "/characters/creation-options",
      "/characters/creation-versions",
      "/characters/{characterId}",
      "/characters/{characterId}/actions/{actionId}",
      "/characters/{characterId}/activity",
      "/characters/{characterId}/duplicate",
      "/characters/{characterId}/exports",
      "/characters/{characterId}/fields/{fieldId}/set",
      "/characters/{characterId}/migration-previews",
      "/characters/{characterId}/migrations/{migrationId}/rollback",
      "/characters/{characterId}/migrations/{previewId}/commit",
      "/characters/{characterId}/ownership-transfer",
      "/characters/{characterId}/resources/{resourceId}/bump",
      "/content/{id}",
      "/content/{id}/grants",
      "/content/{id}/recover",
      "/displays/redeem",
      "/displays/{id}/scenes/{sceneId}/image",
      "/displays/{id}/scenes/{sceneId}/projection",
      "/displays/{id}/scenes/{sceneId}/tokens/{tokenId}/image",
      "/invitations/accept",
      "/invitations/decline",
      "/invitations/review",
      "/me",
      "/me/preferences",
      "/scenes/{id}",
      "/scenes/{id}/fog-edits",
      "/scenes/{id}/tokens",
      "/scenes/{id}/tokens/{tokenId}",
      "/signout",
      "/system-versions/{versionId}",
      "/system-versions/{versionId}/export",
      "/systems",
      "/systems/{systemId}",
      "/systems/{systemId}/draft",
      "/systems/{systemId}/preview",
      "/systems/{systemId}/publish",
      "/systems/{systemId}/versions",
      "/templates",
    ]);
    const paths = doc.paths ?? {};
    for (const path of Object.keys(paths)) {
      for (const method of Object.keys(paths[path] ?? {})) {
        const op = paths[path]?.[method];
        expect(op?.operationId, `${method} ${path}`).toBeTypeOf("string");
      }
    }
    await app.close();
  });

  it("represents character and system export operations with their vendor media types", async () => {
    const doc = buildOpenApiDocument(Fastify());
    const paths = doc.paths ?? {};

    const characterExport = paths["/characters/{characterId}/exports"]?.post;
    expect(characterExport?.responses?.["200"]?.content?.["application/vnd.sweetroll.character+json;version=1"]).toBeDefined();
    expect(characterExport?.responses?.["200"]?.content?.["application/json"]).toBeUndefined();

    const systemExport = paths["/system-versions/{versionId}/export"]?.get;
    expect(systemExport?.responses?.["200"]?.content?.["application/vnd.sweetroll.system+json;version=1"]).toBeDefined();
    expect(systemExport?.responses?.["200"]?.content?.["application/json"]).toBeUndefined();
  });

  it("declares idempotencyKey in character mutation request bodies", async () => {
    const doc = buildOpenApiDocument(Fastify());
    const paths = doc.paths ?? {};

    const create = paths["/characters"]?.post;
    const createSchema = create?.requestBody?.content?.["application/json"]?.schema as
      | { required?: string[]; properties?: Record<string, unknown> }
      | undefined;
    expect(createSchema?.required).toContain("idempotencyKey");
    expect((createSchema?.properties ?? {})["idempotencyKey"]).toMatchObject({ type: "string" });

    const setField = paths["/characters/{characterId}/fields/{fieldId}/set"]?.post;
    const setFieldSchema = setField?.requestBody?.content?.["application/json"]?.schema as
      | { required?: string[]; properties?: Record<string, unknown> }
      | undefined;
    expect(setFieldSchema?.required).toContain("idempotencyKey");

    const duplicate = paths["/characters/{characterId}/duplicate"]?.post;
    const duplicateSchema = duplicate?.requestBody?.content?.["application/json"]?.schema as
      | { required?: string[]; properties?: Record<string, unknown> }
      | undefined;
    expect(duplicateSchema?.required).toContain("idempotencyKey");
  });

  it("declares idempotencyKey and revision preconditions in campaign mutation bodies", async () => {
    const doc = buildOpenApiDocument(Fastify());
    const paths = doc.paths ?? {};

    const withBody = (operation: { requestBody?: { content: { "application/json": { schema: unknown } } } } | undefined) =>
      operation?.requestBody?.content?.["application/json"]?.schema as
        | { required?: string[]; properties?: Record<string, unknown> }
        | undefined;

    // Campaign mutations require an idempotency key; resource mutations
    // additionally require their expected revision (campaign or content).
    expect(withBody(paths["/campaigns"]?.post)?.required).toContain("idempotencyKey");
    expect(withBody(paths["/campaigns/{id}"]?.patch)?.required).toEqual(
      expect.arrayContaining(["expectedCampaignRevision", "idempotencyKey"]),
    );
    expect(withBody(paths["/campaigns/{id}/archive"]?.post)?.required).toEqual(
      expect.arrayContaining(["expectedCampaignRevision", "idempotencyKey"]),
    );
    expect(withBody(paths["/campaigns/{id}/members/{userId}"]?.patch)?.required).toEqual(
      expect.arrayContaining(["expectedCampaignRevision", "idempotencyKey"]),
    );
    // DELETE mutations carry explicit revision/key input in the JSON body.
    expect(withBody(paths["/campaigns/{id}/members/{userId}"]?.delete)?.required).toEqual(
      expect.arrayContaining(["expectedCampaignRevision", "idempotencyKey"]),
    );
    expect(withBody(paths["/content/{id}"]?.delete)?.required).toEqual(
      expect.arrayContaining(["expectedContentRevision", "idempotencyKey"]),
    );
    expect(withBody(paths["/content/{id}/grants"]?.post)?.required).toEqual(
      expect.arrayContaining(["grantedUserIds", "expectedContentRevision", "idempotencyKey"]),
    );
    // Accept/decline are built from review revisions; no campaign revision.
    expect(withBody(paths["/invitations/accept"]?.post)?.required).toEqual(
      expect.arrayContaining([
        "campaignId",
        "token",
        "expectedInvitationRevision",
        "reviewedAccessRevision",
        "idempotencyKey",
      ]),
    );
  });

  it("documents the one-time invitation token exception and keeps tokens out of URLs", async () => {
    const doc = buildOpenApiDocument(Fastify());
    const paths = doc.paths ?? {};

    // Tokens travel in POST bodies only: no token query parameter exists on
    // any campaign operation.
    for (const [path, methods] of Object.entries(paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        for (const parameter of operation.parameters ?? []) {
          expect(parameter.name, `${method} ${path}`).not.toBe("token");
        }
      }
    }

    const issue = paths["/campaigns/{id}/invitations"]?.post;
    const issueSchema = issue?.responses?.["201"]?.content?.["application/json"]?.schema as
      | { properties?: { invitation?: unknown } }
      | undefined;
    const issueText = JSON.stringify(issueSchema);
    expect(issueText).toContain("tokenUnavailable");
    expect(issueText).toContain("One-time");

    const rotate = paths["/campaigns/{id}/invitations/{inviteId}/rotate"]?.post;
    const rotateText = JSON.stringify(rotate?.responses?.["200"]?.content?.["application/json"]?.schema);
    expect(rotateText).toContain("tokenUnavailable");
  });

  it("exposes the scene/display operations with credentials outside URLs", async () => {
    const doc = buildOpenApiDocument(Fastify());
    const paths = doc.paths ?? {};

    // Task 5/7 seam operations pin these IDs and paths.
    expect(paths["/campaigns/{id}/images"]?.post?.operationId).toBe("post_campaigns_id_images");
    expect(paths["/campaigns/{id}/images/{fileId}"]?.delete?.operationId).toBe(
      "delete_campaigns_id_images_fileId",
    );
    expect(paths["/campaigns/{id}/images/{fileId}/original"]?.get?.operationId).toBe(
      "get_campaigns_id_images_fileId_original",
    );
    expect(paths["/campaigns/{id}/scenes"]?.post?.operationId).toBe("post_campaigns_id_scenes");
    expect(paths["/scenes/{id}"]?.get?.operationId).toBe("get_scenes_id");
    expect(paths["/scenes/{id}/fog-edits"]?.post?.operationId).toBe("post_scenes_id_fog_edits");
    expect(paths["/scenes/{id}/tokens"]?.post?.operationId).toBe("post_scenes_id_tokens");
    expect(paths["/campaigns/{id}/display-codes"]?.post?.operationId).toBe(
      "post_campaigns_id_display_codes",
    );
    expect(paths["/campaigns/{id}/display-credentials"]?.get?.operationId).toBe(
      "get_campaigns_id_display_credentials",
    );
    expect(paths["/displays/redeem"]?.post?.operationId).toBe("post_displays_redeem");
    expect(paths["/displays/{id}/scenes/{sceneId}/projection"]?.get?.operationId).toBe(
      "get_displays_id_scenes_sceneId_projection",
    );
    expect(paths["/displays/{id}/scenes/{sceneId}/image"]?.get?.operationId).toBe(
      "get_displays_id_scenes_sceneId_image",
    );

    // Display credentials travel in the redeem body / a header — never in
    // the URL query (the rev cache key is the only display query parameter).
    for (const [path, methods] of Object.entries(paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        for (const parameter of operation.parameters ?? []) {
          expect(parameter.name, `${method} ${path}`).not.toBe("secret");
          expect(parameter.name, `${method} ${path}`).not.toBe("code");
        }
      }
    }
    const imageParamNames = (
      paths["/displays/{id}/scenes/{sceneId}/image"]?.get?.parameters ?? []
    ).map((parameter) => parameter.name);
    expect(imageParamNames).toContain("rev");
    expect(imageParamNames).not.toContain("secret");
    const redeemSchema = paths["/displays/redeem"]?.post?.requestBody?.content?.["application/json"]
      ?.schema as { required?: string[] } | undefined;
    expect(redeemSchema?.required).toContain("code");
  });
});