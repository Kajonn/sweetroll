import { randomUUID } from "node:crypto";

import Fastify from "fastify";
import cookie from "@fastify/cookie";
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
  await app.register(cookie);
  await app.register(buildAuthHook({ identity, cookieName: "session", secure: true }));
  app.get("/auth-test", async (request) => ({ auth: request.auth }));
  app.post("/auth-test", async (request) => ({ auth: request.auth }));
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
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  it.each([
    [{}, 403],
    [{ origin: "https://preview.example.com" }, 403],
    [{ origin: "http://app.example.com" }, 403],
    [{ origin: "null", "sec-fetch-site": "same-origin" }, 403],
    [{ origin: "https://app.example.com" }, 200],
    [{ "sec-fetch-site": "same-origin" }, 200],
  ])("requires same-origin evidence on cookie writes (%j)", async (headers, status) => {
    const app = await build(fakeIdentity(async () => ({
      state: "authenticated", actorId: randomUUID(), sessionId: randomUUID(),
    })));
    apps.push(app);
    const response = await app.inject({
      method: "POST", url: "/auth-test", headers: { host: "app.example.com", cookie: "session=token", ...headers },
    });
    expect(response.statusCode).toBe(status);
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

  it("clears the cookie but surfaces an expired session distinctly", async () => {
    const identity = fakeIdentity(async () => ({ state: "session_expired" }));
    const app = await build(identity);
    apps.push(app);

    const response = await app.inject({
      headers: { cookie: "session=expired-token" },
      method: "GET",
      url: "/auth-test",
    });
    expect(response.cookies.some((cookie) => cookie.name === "session" && cookie.maxAge === 0)).toBe(true);
    expect(response.json<{ auth: AuthContext }>().auth).toEqual({ state: "session_expired" });
  });
});
