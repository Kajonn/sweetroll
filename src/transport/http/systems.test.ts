import { randomUUID } from "node:crypto";

import cookie from "@fastify/cookie";
import Fastify from "fastify";
import pino from "pino";
import { afterAll, describe, expect, it } from "vitest";

import { d20Export, d20Package } from "../../systems/implementation/package/fixtures/index.js";
import type {
  AuthoringWorkspace,
  PreviewSnapshot,
  PublishedVersion,
  SystemAuthoring,
} from "../../systems/authoring.js";
import type { AuthContext, Identity } from "../../identity/index.js";
import { buildAuthHook } from "./auth-hook.js";
import { buildSystemsRoutes } from "./systems.js";

const actorId = randomUUID();

const fakeIdentity: Identity = {
  completeSignIn: async () => {
    throw new Error("not used");
  },
  resolveSession: async (): Promise<AuthContext> => ({
    state: "authenticated",
    actorId,
    sessionId: randomUUID(),
  }),
  signOut: async () => ({ ok: true, value: undefined }),
} as unknown as Identity;

const workspace = (): AuthoringWorkspace => ({
  system: {
    systemId: randomUUID(),
    name: "Test",
    access: "private",
    lifecycle: "active",
    createdAt: new Date(0),
    updatedAt: new Date(0),
  },
  draft: null,
  versions: [],
  assessment: { ok: true, diagnostics: [] },
});

function makeAuthoring(overrides: Partial<SystemAuthoring> = {}): SystemAuthoring {
  const base: SystemAuthoring = {
    createDraft: async () => ({ ok: true, value: workspace() }),
    open: async () => ({ ok: true, value: workspace() }),
    list: async () => ({ ok: true, value: { systems: [], nextCursor: null } }),
    saveDraft: async () => ({ ok: true, value: workspace() }),
    previewDraft: async () => ({
      ok: true,
      value: {
        snapshotId: randomUUID(),
        systemId: randomUUID(),
        sourceRevision: 1,
        package: d20Package,
        expiresAt: new Date(Date.now() + 60_000),
      } satisfies PreviewSnapshot,
    }),
    authorizeVersionUse: async (_ctx, versionId) => ({
      ok: true,
      value: { systemId: randomUUID(), versionId, checksum: d20Package.integrity.checksum },
    }),
    listAuthorizedVersions: async () => ({ ok: true, value: { versions: [], nextCursor: null } }),
    publish: async () => ({
      ok: true,
      value: {
        versionId: randomUUID(),
        systemId: randomUUID(),
        semanticVersion: "1.0.0",
        checksum: d20Package.integrity.checksum,
        package: d20Package,
        releaseNotes: "",
        lifecycle: "published",
        createdAt: new Date(0),
      } satisfies PublishedVersion,
    }),
    exportVersion: async () => ({ ok: true, value: d20Export }),
    listVersions: async () => ({ ok: true, value: { versions: [] } }),
    changeLifecycle: async () => ({
      ok: true,
      value: { kind: "system", systemId: randomUUID(), lifecycle: "archived" },
    }),
    deleteSystem: async () => ({ ok: true, value: { systemId: randomUUID() } }),
  };
  return { ...base, ...overrides };
}

async function build(authoring: SystemAuthoring): Promise<ReturnType<typeof Fastify>> {
  const app = Fastify({ genReqId: () => randomUUID(), loggerInstance: pino({ enabled: false }) });
  await app.register(cookie);
  await app.register(
    buildAuthHook({ identity: fakeIdentity, cookieName: "session", secure: true, maxAgeSeconds: 3600 }),
  );
  await app.register(buildSystemsRoutes({ authoring }));
  await app.ready();
  return app;
}

describe("systems HTTP routes", () => {
  const apps: ReturnType<typeof Fastify>[] = [];

  afterAll(async () => {
    for (const app of apps) await app.close();
  });

  it("rejects unauthenticated requests with 401", async () => {
    const app = Fastify({ loggerInstance: pino({ enabled: false }) });
    apps.push(app);
    await app.register(cookie);
    await app.register(
      buildAuthHook({
        identity: {
          ...fakeIdentity,
          resolveSession: async () => ({ state: "anonymous" }),
        } as unknown as Identity,
        cookieName: "session",
        secure: true,
        maxAgeSeconds: 3600,
      }),
    );
    await app.register(buildSystemsRoutes({ authoring: makeAuthoring() }));
    await app.ready();

    const response = await app.inject({ method: "GET", url: "/systems" });
    expect(response.statusCode).toBe(401);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("unauthorized");
    expect(response.headers["x-request-id"]).toBeDefined();
  });

  it("maps POST /systems to createDraft and returns 201", async () => {
    let received: unknown;
    const app = await build(
      makeAuthoring({
        createDraft: async (_ctx, input) => {
          received = input;
          return { ok: true, value: workspace() };
        },
      }),
    );
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/systems",
      headers: { cookie: "session=t" },
      payload: { source: { kind: "blank", name: "New" }, idempotencyKey: "key-1" },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().requestId).toBeDefined();
    expect(received).toEqual({ source: { kind: "blank", name: "New" }, idempotencyKey: "key-1" });
  });

  it("rejects an invalid create body with 400", async () => {
    const app = await build(makeAuthoring());
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/systems",
      headers: { cookie: "session=t" },
      payload: { source: { kind: "wat" }, idempotencyKey: "key-1" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("bad_request");
  });

  it("maps GET /systems to list and validates limit", async () => {
    let received: unknown;
    const app = await build(
      makeAuthoring({
        list: async (_ctx, input) => {
          received = input;
          return { ok: true, value: { systems: [], nextCursor: null } };
        },
      }),
    );
    apps.push(app);

    const ok = await app.inject({
      method: "GET",
      url: "/systems?limit=5&cursor=abc",
      headers: { cookie: "session=t" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ systems: [], nextCursor: null, requestId: expect.any(String) });
    expect(received).toEqual({ limit: 5, cursor: "abc" });

    const bad = await app.inject({
      method: "GET",
      url: "/systems?limit=999",
      headers: { cookie: "session=t" },
    });
    expect(bad.statusCode).toBe(400);
  });

  it("maps module errors to stable HTTP statuses", async () => {
    const app = await build(
      makeAuthoring({
        open: async () => ({ ok: false, error: { code: "not_found", message: "The requested resource does not exist." } }),
        saveDraft: async () => ({
          ok: false,
          error: { code: "conflict", message: "The draft was modified by another request.", latestRevision: 7 },
        }),
        publish: async () => ({
          ok: false,
          error: {
            code: "invalid_package",
            message: "The system package is invalid.",
            diagnostics: [{ code: "invalid_schema", path: "/metadata", message: "bad" }],
          },
        }),
      }),
    );
    apps.push(app);
    const headers = { cookie: "session=t" };

    const missing = await app.inject({ method: "GET", url: `/systems/${randomUUID()}`, headers });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("not_found");

    const conflict = await app.inject({
      method: "PUT",
      url: `/systems/${randomUUID()}/draft`,
      headers,
      payload: { expectedRevision: 1, document: {} },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.latestRevision).toBe(7);

    const invalid = await app.inject({
      method: "POST",
      url: `/systems/${randomUUID()}/publish`,
      headers,
      payload: {
        expectedRevision: 1,
        semanticVersion: "1.0.0",
        releaseNotes: "",
        idempotencyKey: "k",
        acknowledgeBreaking: false,
      },
    });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json().error.diagnostics).toHaveLength(1);
  });

  it("maps preview, lifecycle, and export routes", async () => {
    const app = await build(makeAuthoring());
    apps.push(app);
    const headers = { cookie: "session=t" };

    const preview = await app.inject({ method: "POST", url: `/systems/${randomUUID()}/preview`, headers, payload: {} });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().snapshot.package.integrity.checksum).toBe(d20Package.integrity.checksum);

    const archive = await app.inject({
      method: "PATCH",
      url: `/systems/${randomUUID()}`,
      headers,
      payload: { lifecycle: "archived" },
    });
    expect(archive.statusCode).toBe(200);
    expect(archive.json().lifecycle.lifecycle).toBe("archived");

    const badLifecycle = await app.inject({
      method: "PATCH",
      url: `/systems/${randomUUID()}`,
      headers,
      payload: { lifecycle: "deleted" },
    });
    expect(badLifecycle.statusCode).toBe(400);

    const deprecate = await app.inject({
      method: "PATCH",
      url: `/system-versions/${randomUUID()}`,
      headers,
      payload: { lifecycle: "deprecated" },
    });
    expect(deprecate.statusCode).toBe(200);

    const badDeprecate = await app.inject({
      method: "PATCH",
      url: `/system-versions/${randomUUID()}`,
      headers,
      payload: { lifecycle: "published" },
    });
    expect(badDeprecate.statusCode).toBe(400);

    const exported = await app.inject({
      method: "GET",
      url: `/system-versions/${randomUUID()}/export`,
      headers,
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.headers["content-type"]).toContain("application/vnd.sweetroll.system+json");
    expect(exported.json().package.integrity.checksum).toBe(d20Package.integrity.checksum);
  });

  it("requires and forwards breaking-change acknowledgement when publishing", async () => {
    let received: unknown;
    const app = await build(
      makeAuthoring({
        publish: async (_ctx, input) => {
          received = input;
          return makeAuthoring().publish(_ctx, input);
        },
      }),
    );
    apps.push(app);
    const url = `/systems/${randomUUID()}/publish`;
    const headers = { cookie: "session=t" };
    const payload = {
      expectedRevision: 2,
      semanticVersion: "2.0.0",
      releaseNotes: "Breaking",
      idempotencyKey: "publish-key",
      acknowledgeBreaking: true,
    };

    const response = await app.inject({ method: "POST", url, headers, payload });
    expect(response.statusCode).toBe(200);
    expect(received).toEqual({ systemId: expect.any(String), ...payload });

    const missing = await app.inject({
      method: "POST",
      url,
      headers,
      payload: {
        expectedRevision: payload.expectedRevision,
        semanticVersion: payload.semanticVersion,
        releaseNotes: payload.releaseNotes,
        idempotencyKey: payload.idempotencyKey,
      },
    });
    expect(missing.statusCode).toBe(400);
  });

  it("maps DELETE /systems/:systemId to deleteSystem and returns 404 when missing", async () => {
    let received: string | undefined;
    const app = await build(
      makeAuthoring({
        deleteSystem: async (_ctx, systemId) => {
          received = systemId;
          return { ok: true, value: { systemId } };
        },
      }),
    );
    apps.push(app);
    const headers = { cookie: "session=t" };
    const systemId = randomUUID();

    const ok = await app.inject({ method: "DELETE", url: `/systems/${systemId}`, headers });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ systemId, requestId: expect.any(String) });
    expect(received).toBe(systemId);

    const missingApp = await build(
      makeAuthoring({
        deleteSystem: async () => ({
          ok: false,
          error: { code: "not_found", message: "The requested resource does not exist." },
        }),
      }),
    );
    apps.push(missingApp);
    const missing = await missingApp.inject({
      method: "DELETE",
      url: `/systems/${randomUUID()}`,
      headers,
    });
    expect(missing.statusCode).toBe(404);

    const referencedApp = await build(
      makeAuthoring({
        deleteSystem: async () => ({
          ok: false,
          error: { code: "conflict", message: "The system is referenced and cannot be deleted." },
        }),
      }),
    );
    apps.push(referencedApp);
    const referenced = await referencedApp.inject({
      method: "DELETE",
      url: `/systems/${randomUUID()}`,
      headers,
    });
    expect(referenced.statusCode).toBe(409);
  });

  it("maps GET /systems/:systemId/versions to listVersions and returns 404 when missing", async () => {
    let received: unknown;
    const app = await build(
      makeAuthoring({
        listVersions: async (_ctx, input) => {
          received = input;
          return { ok: true, value: { versions: [] } };
        },
      }),
    );
    apps.push(app);
    const headers = { cookie: "session=t" };
    const systemId = randomUUID();

    const ok = await app.inject({ method: "GET", url: `/systems/${systemId}/versions`, headers });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ versions: [], requestId: expect.any(String) });
    expect(received).toEqual({ systemId });

    const missingApp = await build(
      makeAuthoring({
        listVersions: async () => ({
          ok: false,
          error: { code: "not_found", message: "The requested resource does not exist." },
        }),
      }),
    );
    apps.push(missingApp);
    const missing = await missingApp.inject({
      method: "GET",
      url: `/systems/${randomUUID()}/versions`,
      headers,
    });
    expect(missing.statusCode).toBe(404);
  });
});
