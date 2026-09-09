import cookie from "@fastify/cookie";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import type { Identity } from "../../identity/index.js";
import { buildDevSignInRoutes } from "./dev-signin.js";

const buildIdentity = (): Identity => ({
  completeSignIn: async () => ({
    ok: true,
    value: { token: "tok", userId: "u", sessionId: "s", expiresAt: new Date(0) },
  }),
  resolveSession: async () => ({ state: "anonymous" }),
  signOut: async () => ({ ok: true, value: undefined }),
  getThemeDefault: async () => ({ ok: true, value: null }),
  setThemeDefault: async (_actorId, value) => ({ ok: true, value }),
});

async function buildApp(nodeEnv: "development" | "production" | "test") {
  const app = Fastify();
  await app.register(cookie);
  void app.register(buildDevSignInRoutes({ identity: buildIdentity(), nodeEnv }));
  await app.ready();
  return app;
}

describe("buildDevSignInRoutes", () => {
  it("returns 404 in production", async () => {
    const app = await buildApp("production");
    try {
      const res = await app.inject({ method: "POST", url: "/dev/signin", payload: { code: "x", redirectUri: "y" } });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("returns 200 in development", async () => {
    const app = await buildApp("development");
    try {
      const res = await app.inject({ method: "POST", url: "/dev/signin", payload: { code: "x", redirectUri: "y" } });
      expect(res.statusCode).toBe(200);
      expect(String(res.headers["set-cookie"])).toContain("session=tok");
    } finally {
      await app.close();
    }
  });
});