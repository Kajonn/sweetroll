import { randomUUID } from "node:crypto";

import cookiePlugin from "@fastify/cookie";
import Fastify from "fastify";
import pino from "pino";
import { afterAll, describe, expect, it } from "vitest";

import type { AuthContext, Identity } from "../../identity/index.js";
import { buildAuthHook } from "./auth-hook.js";
import { buildIdentityRoutes } from "./identity.js";

const COOKIE_NAME = "session";

function makeStatefulIdentity() {
  const revoked = new Set<string>();
  const validToken = randomUUID();
  let themeDefault: "light" | "dark" | "system" | null = null;
  const identity: Identity = {
    completeSignIn: async () => {
      throw new Error("not used");
    },
    resolveSession: async (token): Promise<AuthContext> => {
      if (revoked.has(token)) return { state: "anonymous" };
      if (token !== validToken) return { state: "anonymous" };
      return { state: "authenticated", actorId: randomUUID(), sessionId: randomUUID() };
    },
    signOut: async (token) => {
      revoked.add(token);
      return { ok: true, value: undefined };
    },
    getThemeDefault: async () => ({ ok: true, value: themeDefault }),
    setThemeDefault: async (_actorId, value) => {
      themeDefault = value;
      return { ok: true, value: themeDefault };
    },
  };
  return { identity, validToken, revoked, getRevoked: () => revoked };
}

function makeAnonymousIdentity() {
  const identity: Identity = {
    completeSignIn: async () => {
      throw new Error("not used");
    },
    resolveSession: async () => ({ state: "anonymous" }),
    signOut: async () => ({ ok: true, value: undefined }),
    getThemeDefault: async () => ({ ok: true, value: null }),
    setThemeDefault: async (_actorId, value) => ({ ok: true, value }),
  };
  return { identity };
}

const apps: ReturnType<typeof Fastify>[] = [];

async function build(identity: Identity, allowedOrigins: string[] = []): Promise<ReturnType<typeof Fastify>> {
  const app = Fastify({ genReqId: () => randomUUID(), loggerInstance: pino({ enabled: false }) });
  await app.register(cookiePlugin);
  await app.register(
    buildAuthHook({
      identity,
      cookieName: COOKIE_NAME,
      secure: true,
      maxAgeSeconds: 3600,
    }),
  );
  await app.register(buildIdentityRoutes({ identity, cookieName: COOKIE_NAME, secure: true, allowedOrigins }));
  await app.ready();
  apps.push(app);
  return app;
}

const cookie = (token: string) => ({ cookie: `${COOKIE_NAME}=${token}` });
const sameOriginHeaders = (token: string) => ({
  ...cookie(token),
  host: "app.example.com",
  origin: "https://app.example.com",
});

describe("identity HTTP routes", () => {
  afterAll(async () => {
    for (const app of apps) await app.close();
  });

  it("GET /me still returns the authenticated state", async () => {
    const { identity, validToken } = makeStatefulIdentity();
    const app = await build(identity);
    const response = await app.inject({ method: "GET", url: "/me", headers: cookie(validToken) });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ state: "authenticated" });
    expect(response.json().userId).toBeTypeOf("string");
  });

  it("POST /signout revokes the token and clears the cookie with the configured flags", async () => {
    const { identity, validToken } = makeStatefulIdentity();
    const app = await build(identity);
    const response = await app.inject({
      method: "POST",
      url: "/signout",
      headers: sameOriginHeaders(validToken),
    });
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe("");
    expect(await identity.resolveSession(validToken)).toMatchObject({ state: "anonymous" });

    const setCookie = response.headers["set-cookie"] as string | undefined;
    expect(setCookie).toBeDefined();
    const header = setCookie!;
    expect(header).toContain("session=;");
    expect(header.toLowerCase()).toContain("max-age=0");
    expect(header.toLowerCase()).toContain("httponly");
    expect(header.toLowerCase()).toContain("samesite=lax");
    expect(header.toLowerCase()).toContain("path=/");
    expect(header.toLowerCase()).toContain("secure");
  });

  it("repeated anonymous sign-out is safe and still returns 204", async () => {
    const { identity } = makeAnonymousIdentity();
    const app = await build(identity);
    for (let i = 0; i < 2; i++) {
      const response = await app.inject({ method: "POST", url: "/signout", headers: sameOriginHeaders("missing-token") });
      expect(response.statusCode).toBe(204);
    }
  });

  it("rejects a cross-origin sign-out request", async () => {
    const { identity, validToken } = makeStatefulIdentity();
    const app = await build(identity);
    const response = await app.inject({
      method: "POST",
      url: "/signout",
      headers: {
        ...cookie(validToken),
        host: "app.example.com",
        origin: "https://evil.example.net",
      },
    });
    expect(response.statusCode).toBe(403);
    expect((response.json() as { error: { code: string } }).error.code).toBe("forbidden");
    expect(await identity.resolveSession(validToken)).toMatchObject({ state: "authenticated" });
  });

  it("allows an origin that is explicitly allowed by the configuration", async () => {
    const { identity, validToken } = makeStatefulIdentity();
    const app = await build(identity, ["https://trusted.example.net"]);
    const response = await app.inject({
      method: "POST",
      url: "/signout",
      headers: {
        ...cookie(validToken),
        host: "app.example.com",
        origin: "https://trusted.example.net",
      },
    });
    expect(response.statusCode).toBe(204);
    expect(await identity.resolveSession(validToken)).toMatchObject({ state: "anonymous" });
  });

  it("treats a browser-origin request through a same-host proxy as same-origin", async () => {
    const { identity, validToken } = makeStatefulIdentity();
    const app = await build(identity);
    const response = await app.inject({
      method: "POST",
      url: "/signout",
      headers: {
        ...cookie(validToken),
        host: "localhost:4173",
        origin: "http://localhost:4173",
      },
    });
    expect(response.statusCode).toBe(204);
    expect(await identity.resolveSession(validToken)).toMatchObject({ state: "anonymous" });
  });
});
