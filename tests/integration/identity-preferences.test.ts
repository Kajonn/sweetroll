import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildI3App,
  createI3Pool,
  createI3Schema,
  dropI3Schema,
  type I3AppHandle,
  type I3Users,
} from "./i3-app.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl === undefined ? describe.skip : describe;

type App = I3AppHandle & { cleanup: () => Promise<void> };

async function makeApp(): Promise<App> {
  const schema = `i3_prefs_${randomUUID().replaceAll("-", "")}`;
  await createI3Schema(databaseUrl!, schema);
  const pool = createI3Pool(databaseUrl!, schema);
  const handle = await buildI3App({ pool });
  return {
    ...handle,
    cleanup: async () => {
      await handle.app.close();
      await pool.end();
      await dropI3Schema(databaseUrl!, schema);
    },
  };
}

let app: App | null = null;

afterEach(async () => {
  if (app !== null) {
    await app.cleanup();
    app = null;
  }
});

const cookieHeader = (user: I3Users[keyof I3Users]) => ({ cookie: user.cookie });

describeWithDatabase("account theme default (GET/PATCH /me/preferences)", () => {
  it("account theme default is actor-isolated", async () => {
    app = await makeApp();

    const patch = await app.app.inject({
      method: "PATCH",
      url: "/me/preferences",
      headers: cookieHeader(app.users.ada),
      payload: { theme_default: "dark" },
    });
    expect(patch.statusCode, patch.body).toBe(200);
    expect(patch.json()).toEqual({ theme_default: "dark" });

    const bobGet = await app.app.inject({
      method: "GET",
      url: "/me/preferences",
      headers: cookieHeader(app.users.bob),
    });
    expect(bobGet.statusCode, bobGet.body).toBe(200);
    expect(bobGet.json()).toEqual({ theme_default: null });

    const adaGet = await app.app.inject({
      method: "GET",
      url: "/me/preferences",
      headers: cookieHeader(app.users.ada),
    });
    expect(adaGet.statusCode, adaGet.body).toBe(200);
    expect(adaGet.json()).toEqual({ theme_default: "dark" });

    // PATCH is partial: an omitted theme_default leaves the stored default.
    const noop = await app.app.inject({
      method: "PATCH",
      url: "/me/preferences",
      headers: cookieHeader(app.users.ada),
      payload: {},
    });
    expect(noop.statusCode, noop.body).toBe(200);
    expect(noop.json()).toEqual({ theme_default: "dark" });
  });

  it("invalid value rejected, anonymous rejected", async () => {
    app = await makeApp();

    const invalid = await app.app.inject({
      method: "PATCH",
      url: "/me/preferences",
      headers: cookieHeader(app.users.ada),
      payload: { theme_default: "neon" },
    });
    expect(invalid.statusCode, invalid.body).toBe(400);
    expect((invalid.json() as { error: { code: string } }).error.code).toBeTypeOf("string");

    const anonymousGet = await app.app.inject({ method: "GET", url: "/me/preferences" });
    expect(anonymousGet.statusCode, anonymousGet.body).toBe(401);

    const anonymousPatch = await app.app.inject({
      method: "PATCH",
      url: "/me/preferences",
      payload: { theme_default: "dark" },
    });
    expect(anonymousPatch.statusCode, anonymousPatch.body).toBe(401);
  });
});

describeWithDatabase("browser sessions", () => {
  it("sets the session cookie expiry once and revokes the prior cookie on sign-in", async () => {
    app = await makeApp();
    const { app: http, users } = app;
    const signIn = await http.inject({
      method: "POST", url: "/dev/signin",
      headers: { cookie: users.bob.cookie, "sec-fetch-site": "same-origin" },
      payload: { code: "code-bob", redirectUri: "http://localhost/cb" },
    });
    expect(signIn.statusCode).toBe(200);
    const sessionCookie = signIn.cookies.find((cookie) => cookie.name === "session");
    const { expiresAt } = signIn.json<{ expiresAt: string }>();
    expect(sessionCookie?.expires?.getTime()).toBe(Math.floor(Date.parse(expiresAt) / 1000) * 1000);
    expect(sessionCookie?.maxAge).toBeUndefined();
    const old = await http.inject({ url: "/me", headers: { cookie: users.bob.cookie } });
    expect(old.json()).toEqual({ state: "anonymous" });
    const current = await http.inject({ url: "/me", headers: { cookie: `session=${sessionCookie?.value}` } });
    expect(current.json().state).toBe("authenticated");
    expect(current.headers["set-cookie"]).toBeUndefined();
  });
});
