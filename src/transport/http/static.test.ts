import Fastify from "fastify";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Identity } from "../../identity/index.js";
import { buildIdentityRoutes } from "./identity.js";
import { registerApiRoutes, registerStaticServing } from "./static.js";

describe("static serving", () => {
  it("serves index.html for unknown non-API routes and never for /api", async () => {
    const distDir = await mkdtemp(join(tmpdir(), "sweetroll-static-test-"));
    const app = Fastify();
    const html = "<!doctype html><html><body>Sweetroll test shell</body></html>";
    try {
      await writeFile(join(distDir, "index.html"), html);
      await app.register(registerStaticServing, { distDir, enabled: true });
      const deep = await app.inject({ method: "GET", url: "/campaigns/abc" });
      expect(deep.statusCode).toBe(200);
      expect(deep.headers["content-type"]).toContain("text/html");
      expect(deep.body).toBe(html);
      const api = await app.inject({ method: "GET", url: "/api/unknown-route-xyz" });
      expect(api.statusCode).toBe(404);
      expect(api.headers["content-type"] ?? "").not.toContain("text/html");
    } finally {
      try {
        await app.close();
      } finally {
        await rm(distDir, { recursive: true, force: true });
      }
    }
  });
});


describe("combined frontend/API deployment", () => {
  it.each([true, false])("routes correctly with static serving %s", async (serveStatic) => {
    const distDir = await mkdtemp(join(tmpdir(), "sweetroll-combined-test-"));
    const app = Fastify();
    const html = "<!doctype html><html><body>Sweetroll shell</body></html>";
    app.addHook("onRequest", async (request) => {
      request.auth = { state: "anonymous" };
    });
    registerApiRoutes(app, [
      buildIdentityRoutes({ identity: {} as Identity, cookieName: "session", secure: true }),
      async (api) => {
        api.get("/characters", async () => ({ characters: [] }));
      },
    ], serveStatic);
    try {
      await writeFile(join(distDir, "index.html"), html);
      await app.register(registerStaticServing, { distDir, enabled: serveStatic });
      const prefix = serveStatic ? "/api" : "";
      const me = await app.inject(`${prefix}/me`);
      expect(me.statusCode).toBe(200);
      expect(me.json()).toEqual({ state: "anonymous" });
      const list = await app.inject(`${prefix}/characters`);
      expect(list.statusCode).toBe(200);
      expect(list.json()).toEqual({ characters: [] });
      if (serveStatic) {
        const deep = await app.inject("/characters");
        expect(deep.statusCode).toBe(200);
        expect(deep.body).toBe(html);
        const missing = await app.inject("/api/does-not-exist");
        expect(missing.statusCode).toBe(404);
        expect(missing.headers["content-type"]).toContain("application/json");
      } else {
        expect((await app.inject("/api/me")).statusCode).toBe(404);
      }
    } finally {
      await app.close();
      await rm(distDir, { recursive: true, force: true });
    }
  });
});
