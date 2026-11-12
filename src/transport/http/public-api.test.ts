import type { Pool } from "pg";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import type { Identity } from "../../identity/index.js";
import type { Campaigns } from "../../campaigns/index.js";
import type { Characters } from "../../characters/index.js";
import type { SystemRuntime } from "../../systems/runtime.js";
import type { SystemAuthoring } from "../../systems/authoring.js";
import { buildPublicApi, publicApiPrefix } from "./public-api/index.js";
import { registerApiRoutes } from "./static.js";

describe.each([false, true])("public API with combined deployment = %s", (combined) => {
  it("publishes only v1 operations at a fixed prefix and requires Bearer credentials", async () => {
    const app = Fastify();
    registerApiRoutes(app, [(browser, _opts, done) => {
      browser.get("/me", async () => ({ state: "anonymous" }));
      done();
    }], combined);
    await app.register(buildPublicApi({
      identity: {} as Identity,
      authoring: {} as SystemAuthoring,
      characters: {} as Characters,
      campaigns: {} as Campaigns,
      runtime: {} as SystemRuntime,
      pool: {} as Pool,
    }), { prefix: publicApiPrefix });
    try {
      const contract = await app.inject("/api/v1/openapi.json");
      expect(contract.statusCode).toBe(200);
      expect(contract.json().servers).toEqual([{ url: "/api/v1" }]);
      const paths = contract.json().paths as Record<string, Record<string, { "x-required-scopes"?: string[] }>>;
      expect(Object.keys(paths)).toEqual(expect.arrayContaining([
        "/characters", "/characters/creation-options", "/characters/creation-versions",
        "/characters/{characterId}", "/characters/{characterId}/duplicate", "/characters/{characterId}/actions/{actionId}",
        "/characters/{characterId}/rolls/{rollId}/push", "/characters/{characterId}/activity",
        "/characters/{characterId}/entries", "/characters/{characterId}/entries/{entryId}",
        "/characters/{characterId}/entries/{entryId}/image", "/characters/{characterId}/fields/{fieldId}/set",
        "/characters/{characterId}/portrait", "/characters/{characterId}/resources/{resourceId}/bump",
        "/characters/{characterId}/resources/{resourceId}/adjust", "/characters/{characterId}/resources/{resourceId}",
        "/openapi.json", "/system-versions/{versionId}/export", "/systems", "/systems/validate", "/systems/{systemId}",
        "/systems/{systemId}/draft", "/systems/{systemId}/preview", "/systems/{systemId}/publish", "/systems/{systemId}/sharing",
        "/systems/{systemId}/templates/{templateId}/image", "/systems/{systemId}/versions", "/templates",
        "/campaigns", "/campaigns/{campaignId}/members/{userId}", "/invitations/accept",
        "/campaigns/{campaignId}/characters/{characterId}/adopt", "/content/{contentId}",
        "/campaigns/{campaignId}/item-proposals/{proposalId}/approve", "/scenes/{sceneId}/fog-edits",
        "/campaigns/{campaignId}/display-codes", "/campaigns/{campaignId}/displays/{displayId}/revoke",
      ]));
      // Browser sessions, token management and display credentials stay outside v1.
      expect(Object.keys(paths).filter((path) => /^\/(me|signout|dev|displays)\b|personal-tokens/.test(path))).toEqual([]);
      for (const [path, operations] of Object.entries(paths)) {
        for (const operation of Object.values(operations)) {
          if (path !== "/openapi.json") expect(operation["x-required-scopes"]?.length).toBeGreaterThan(0);
        }
      }
      expect(paths["/campaigns/{campaignId}/characters/{characterId}/claim"]?.post?.["x-required-scopes"])
        .toEqual(["campaigns:write", "characters:write"]);

      const denied = await app.inject({ url: "/api/v1/systems", headers: { cookie: "session=existing" } });
      expect(denied.statusCode).toBe(401);
      expect(denied.headers["www-authenticate"]).toBe("Bearer");
      expect(denied.json()).toMatchObject({ error: { code: "unauthorized" }, requestId: expect.any(String) });
      expect((await app.inject("/api/v1/campaigns")).statusCode).toBe(401);
      expect((await app.inject("/api/v1/displays/redeem")).json()).toMatchObject({ error: { code: "not_found" } });
      expect((await app.inject("/api/v1/me")).statusCode).toBe(404);
      expect((await app.inject(combined ? "/api/me" : "/me")).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
