import { randomUUID } from "node:crypto";

import Fastify from "fastify";
import pino from "pino";
import { afterAll, describe, expect, it } from "vitest";

import type { AuthContext, Identity } from "../../identity/index.js";
import { buildAuthHook } from "./auth-hook.js";

const fakeIdentity = (resolve: (token: string) => Promise<AuthContext>): Identity =>
  ({
    completeSignIn: async () => {
      throw new Error("not used");
    },
    resolveSession: resolve,
    signOut: async () => ({ ok: true, value: undefined }),
  }) as unknown as Identity;

async function build(identity: Identity) {
  const app = Fastify({ loggerInstance: pino({ enabled: false }) });
  await app.register(buildAuthHook({ identity, cookieName: "session", secure: true, maxAgeSeconds: 3600 }));
  app.get("/auth-test", async (request) => ({ auth: request.auth }));
  await app.ready();
  return app;
}

describe("buildAuthHook", () => {
  const apps: ReturnType<typeof Fastify>[] = [];

  afterAll(async () => {
    for (const app of apps) {
      await app.close();
    }
  });

  it("resolves a valid session cookie to an authenticated context", async () => {
    const identity = fakeIdentity(async () => ({
      state: "authenticated",
      actorId: randomUUID(),
      sessionId: randomUUID(),
    }));
    const app = await build(identity);
    apps.push(app);

    const response = await app.inject({
      headers: { cookie: "session=valid-token" },
      method: "GET",
      url: "/auth-test",
    });
    expect(response.json<{ auth: AuthContext }>().auth.state).toBe("authenticated");
  });

  it("treats a missing cookie as anonymous", async () => {
    const identity = fakeIdentity(async () => ({ state: "anonymous" }));
    const app = await build(identity);
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/auth-test" });
    expect(response.json<{ auth: AuthContext }>().auth).toEqual({ state: "anonymous" });
  });

  it("clears the cookie when the session cannot be resolved", async () => {
    const identity = fakeIdentity(async () => ({ state: "anonymous" }));
    const app = await build(identity);
    apps.push(app);

    const response = await app.inject({
      headers: { cookie: "session=stale-token" },
      method: "GET",
      url: "/auth-test",
    });
    expect(response.cookies.some((cookie) => cookie.name === "session" && cookie.maxAge === 0)).toBe(true);
    expect(response.json<{ auth: AuthContext }>().auth).toEqual({ state: "anonymous" });
  });
});
