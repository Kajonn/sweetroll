import Fastify from "fastify";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import pino from "pino";
import { describe, expect, it } from "vitest";
import type { Identity } from "../../identity/index.js";
import { buildHttpApp } from "./app.js";
import { buildIdentityRoutes } from "./identity.js";
import { registerApiRoutes, registerStaticServing } from "./static.js";

describe("static serving", () => {
  it.each([false, true])("gates the dice assets when physicalDiceEnabled is %s", async physicalDiceEnabled => {
    const distDir = await mkdtemp(join(tmpdir(), "sweetroll-dice-assets-"));
    const pool = new Pool();
    const app = buildHttpApp({ logger: pino({ enabled: false }), pool, authHook: async () => {} });
    try {
      await mkdir(join(distDir, "dice", "v1"), { recursive: true });
      await writeFile(join(distDir, "index.html"), "<html>app</html>");
      await writeFile(join(distDir, "dice", "v1", "6Dice.obj"), "o d6");
      await writeFile(join(distDir, "dice", "v1", "worker.js"), "self.onmessage = () => {};");
      await app.register(registerStaticServing, { distDir, enabled: true, physicalDiceEnabled });
      const response = await app.inject("/dice/v1/6Dice.obj");
      expect(response.statusCode).toBe(physicalDiceEnabled ? 200 : 404);
      if (physicalDiceEnabled) expect(response.body).toBe("o d6");
      const worker = await app.inject("/dice/v1/worker.js?version=1");
      expect(worker.statusCode).toBe(physicalDiceEnabled ? 200 : 404);
      const policy = worker.headers["content-security-policy"];
      if (physicalDiceEnabled) {
        expect(policy).toContain("script-src 'self' 'wasm-unsafe-eval'");
      } else {
        expect(policy).not.toContain("'wasm-unsafe-eval'");
      }
      expect(response.headers["content-security-policy"]).not.toContain("'wasm-unsafe-eval'");
      expect((await app.inject("/")).headers["content-security-policy"]).not.toContain("'wasm-unsafe-eval'");
      expect((await app.inject("/health/live")).headers["content-security-policy"]).not.toContain("'wasm-unsafe-eval'");
    } finally {
      await app.close();
      await pool.end();
      await rm(distDir, { recursive: true, force: true });
    }
  });

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
