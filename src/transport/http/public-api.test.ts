import type { Pool } from "pg";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import type { Identity } from "../../identity/index.js";
import type { Characters } from "../../characters/index.js";
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
      pool: {} as Pool,
    }), { prefix: publicApiPrefix });
    try {
      const contract = await app.inject("/api/v1/openapi.json");
      expect(contract.statusCode).toBe(200);
      expect(contract.json().servers).toEqual([{ url: "/api/v1" }]);
      expect(Object.keys(contract.json().paths).sort()).toEqual([
        "/characters", "/characters/creation-options", "/characters/creation-versions",
        "/characters/{characterId}", "/characters/{characterId}/fields/{fieldId}/set",
        "/openapi.json", "/systems", "/systems/validate", "/systems/{systemId}",
        "/systems/{systemId}/draft", "/systems/{systemId}/publish",
      ]);
      const denied = await app.inject({ url: "/api/v1/systems", headers: { cookie: "session=existing" } });
      expect(denied.statusCode).toBe(401);
      expect(denied.headers["www-authenticate"]).toBe("Bearer");
      expect(denied.json()).toMatchObject({ error: { code: "unauthorized" }, requestId: expect.any(String) });
      expect((await app.inject("/api/v1/campaigns")).json()).toMatchObject({ error: { code: "not_found" } });
      expect((await app.inject("/api/v1/me")).statusCode).toBe(404);
      expect((await app.inject(combined ? "/api/me" : "/me")).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
