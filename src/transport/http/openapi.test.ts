import { describe, expect, it } from "vitest";
import Fastify from "fastify";

import type { Characters } from "../../characters/index.js";
import type { Identity } from "../../identity/index.js";
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
};

describe("buildOpenApiDocument", () => {
  it("emits an OpenAPI 3.1 document with every systems and character route", async () => {
    const app = Fastify();
    void app.register(buildIdentityRoutes({ identity: testIdentity, cookieName: "session", secure: true }));
    void app.register(buildSystemsRoutes({ authoring: {} as SystemAuthoring }));
    void app.register(buildCharactersRoutes({ characters: {} as Characters }));
    await app.ready();
    const doc = buildOpenApiDocument(app);
    expect(doc.openapi).toBe("3.1.0");
    expect(Object.keys(doc.paths ?? {}).sort()).toEqual([
      "/characters",
      "/characters/creation-options",
      "/characters/{characterId}",
      "/characters/{characterId}/actions/{actionId}",
      "/characters/{characterId}/activity",
      "/characters/{characterId}/exports",
      "/characters/{characterId}/fields/{fieldId}/set",
      "/characters/{characterId}/migration-previews",
      "/characters/{characterId}/migrations/{migrationId}/rollback",
      "/characters/{characterId}/migrations/{previewId}/commit",
      "/characters/{characterId}/ownership-transfer",
      "/characters/{characterId}/resources/{resourceId}/bump",
      "/me",
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
  });
});