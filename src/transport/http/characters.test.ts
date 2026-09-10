import { randomUUID } from "node:crypto";

import cookiePlugin from "@fastify/cookie";
import Fastify from "fastify";
import pino from "pino";
import { afterAll, describe, expect, it } from "vitest";

import { d20Package } from "../../systems/implementation/package/fixtures/index.js";
import type {
  CharacterCommandResult,
  CharacterError,
  CharacterExportV1,
  CharacterMigrationPreview,
  CharacterView,
  Characters,
} from "../../characters/index.js";
import type { AuthContext, Identity } from "../../identity/index.js";
import type { CharacterProjectionV1 } from "../../systems/runtime.js";
import { buildAuthHook } from "./auth-hook.js";
import { buildCharactersRoutes } from "./characters.js";

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

const cookie = { cookie: "session=t" };

const apps: ReturnType<typeof Fastify>[] = [];

function makeProjection(versionId: string): CharacterProjectionV1 {
  return {
    projectionVersion: "1.0",
    systemId: randomUUID(),
    versionId,
    packageChecksum: d20Package.integrity.checksum,
    entityId: "character",
    entityLabel: "Character",
    sheets: [
      {
        id: "character_sheet",
        label: "Character",
        sections: [
          {
            id: "basics",
            label: "Basics",
            elements: [
              { kind: "heading", id: "basics_heading", text: "Basics", level: 2 },
              {
                kind: "field",
                id: "ancestry_element",
                fieldId: "ancestry",
                label: "Ancestry",
                fieldKind: "singleChoice",
                value: null,
                editable: true,
                constraints: {},
                validations: [],
              },
            ],
          },
        ],
      },
    ],
    derivedValues: {},
    validations: [],
  };
}

function characterView(overrides: Partial<CharacterView> = {}): CharacterView {
  const characterId = randomUUID();
  const systemVersionId = randomUUID();
  return {
    characterId,
    ownerId: actorId,
    campaignId: null,
    controllers: [],
    placementGeneration: 1,
    returnOwnerId: null,
    name: "Aria",
    systemVersionId,
    entityDefinitionId: "character",
    revision: 1,
    lifecycle: "active",
    archivedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    state: { schemaVersion: "1.0", values: { ability: 10 } },
    derivedValues: { defense: 0 },
    validations: [],
    projection: makeProjection(systemVersionId),
    reconciliation: {
      characterId,
      baseRevision: null,
      revision: 1,
      packageChecksum: d20Package.integrity.checksum,
      projectionVersion: "1.0",
      commandExecutionId: randomUUID(),
      replayExpiresAt: "2026-09-06T00:00:00.000Z",
      replayed: false,
      changedDefinitionIds: [],
      activityCursor: null,
      cacheDisposition: "retain",
    },
    ...overrides,
  };
}

function commandResult(roll: CharacterCommandResult["roll"] = null): CharacterCommandResult {
  return { character: characterView(), roll };
}

function characterExport(): CharacterExportV1 {
  return {
    schemaVersion: "1.0",
    mediaType: "application/vnd.sweetroll.character+json;version=1",
    characterId: randomUUID(),
    name: "Aria",
    entityDefinitionId: "character",
    lifecycle: "active",
    createdAt: "1970-01-01T00:00:00.000Z",
    updatedAt: "1970-01-01T00:00:00.000Z",
    systemVersionId: randomUUID(),
    packageChecksum: d20Package.integrity.checksum,
    revision: 1,
    state: { schemaVersion: "1.0", values: { ability: 10 } },
    migrationLineage: [],
  };
}

function migrationPreview(): CharacterMigrationPreview {
  const targetVersionId = randomUUID();
  return {
    previewId: randomUUID(),
    characterId: randomUUID(),
    sourceRevision: 1,
    sourceVersionId: randomUUID(),
    targetVersionId,
    candidateState: { schemaVersion: "1.0", values: {} },
    candidateProjection: makeProjection(targetVersionId),
    warnings: [],
    expiresAt: "2026-09-06T00:00:00.000Z",
  };
}

function makeCharacters(overrides: Partial<Characters> = {}): Characters {
  const base: Characters = {
    create: async () => ({ ok: true, value: characterView() }),
    creationOptions: async () => ({
      ok: true,
      value: {
        versionId: randomUUID(),
        packageChecksum: d20Package.integrity.checksum,
        entities: [{ id: "character", label: "Character" }],
      },
    }),
    listCreationVersions: async () => ({ ok: true, value: { versions: [], nextCursor: null } }),
    list: async () => ({ ok: true, value: { characters: [], nextCursor: null } }),
    open: async () => ({ ok: true, value: characterView() }),
    apply: async () => ({ ok: true, value: commandResult() }),
    manage: async () => ({ ok: true, value: commandResult() }),
    duplicate: async () => ({ ok: true, value: characterView() }),
    listActivity: async () => ({ ok: true, value: { events: [], nextCursor: null } }),
    exportCharacter: async () => ({ ok: true, value: characterExport() }),
    previewMigration: async () => ({ ok: true, value: migrationPreview() }),
    commitMigration: async () => ({ ok: true, value: commandResult() }),
    rollbackMigration: async () => ({ ok: true, value: commandResult() }),
  };
  return { ...base, ...overrides };
}

async function build(characters: Characters, anonymous = false): Promise<ReturnType<typeof Fastify>> {
  const app = Fastify({ genReqId: () => randomUUID(), loggerInstance: pino({ enabled: false }) });
  await app.register(cookiePlugin);
  await app.register(
    buildAuthHook({
      identity: anonymous
        ? ({ ...fakeIdentity, resolveSession: async () => ({ state: "anonymous" }) } as unknown as Identity)
        : fakeIdentity,
      cookieName: "session",
      secure: true,
      maxAgeSeconds: 3600,
    }),
  );
  await app.register(buildCharactersRoutes({ characters }));
  await app.ready();
  apps.push(app);
  return app;
}

const eTag = `"1-${d20Package.integrity.checksum}-1.0"`;

describe("character HTTP routes", () => {
  afterAll(async () => {
    for (const app of apps) await app.close();
  });

  it("rejects unauthenticated requests with 401 on every route", async () => {
    const app = await build(makeCharacters(), true);
    const routes: Array<{ method: "get" | "post" | "patch"; url: string; payload?: unknown }> = [
      { method: "post", url: "/characters", payload: { systemVersionId: randomUUID(), entityDefinitionId: "character", name: "Aria", idempotencyKey: "key-1" } },
      { method: "get", url: "/characters" },
      { method: "get", url: `/characters/${randomUUID()}` },
      { method: "post", url: `/characters/${randomUUID()}/fields/ability/set`, payload: { value: 12, expectedRevision: 1, idempotencyKey: "key-1" } },
      { method: "post", url: `/characters/${randomUUID()}/resources/health/bump`, payload: { direction: "up", expectedRevision: 1, idempotencyKey: "key-1" } },
      { method: "post", url: `/characters/${randomUUID()}/actions/check`, payload: { inputs: {}, expectedRevision: 1, idempotencyKey: "key-1" } },
      { method: "patch", url: `/characters/${randomUUID()}`, payload: { command: "archive", expectedRevision: 1, idempotencyKey: "key-1" } },
      { method: "post", url: `/characters/${randomUUID()}/ownership-transfer`, payload: { toUserId: randomUUID(), expectedRevision: 1, idempotencyKey: "key-1" } },
      { method: "post", url: `/characters/${randomUUID()}/duplicate`, payload: { idempotencyKey: "key-1" } },
      { method: "get", url: `/characters/${randomUUID()}/activity` },
      { method: "post", url: `/characters/${randomUUID()}/exports` },
      { method: "post", url: `/characters/${randomUUID()}/migration-previews`, payload: { targetVersionId: randomUUID() } },
      { method: "post", url: `/characters/${randomUUID()}/migrations/${randomUUID()}/commit`, payload: { expectedRevision: 1, idempotencyKey: "key-1" } },
      { method: "post", url: `/characters/${randomUUID()}/migrations/${randomUUID()}/rollback`, payload: { idempotencyKey: "key-1" } },
    ];

    for (const route of routes) {
      const response = await app.inject({
        method: route.method,
        url: route.url,
        headers: cookie,
        ...(route.payload === undefined ? {} : { payload: route.payload }),
      });
      expect(response.statusCode, `${route.method} ${route.url}`).toBe(401);
      expect((response.json() as { error: { code: string } }).error.code).toBe("unauthorized");
      expect(response.headers["x-request-id"]).toBeDefined();
    }
  });

  it.each([undefined, [], [{
    kind: "field" as const, id: "unlisted-name", fieldId: "unlisted-name", label: "Unlisted name",
    fieldKind: "text" as const, value: "", editable: true,
    constraints: { required: true, minLength: 1, maxLength: 120 }, validations: [],
  }]])("preserves optional completion metadata across create, command and GET responses: %j", async (completionFields) => {
    const view = characterView();
    if (completionFields !== undefined) Object.assign(view.projection, { completionFields });
    view.reconciliation.replayed = completionFields === undefined;
    const app = await build(makeCharacters({
      create: async () => ({ ok: true, value: view }),
      apply: async () => ({ ok: true, value: { character: view, roll: null } }),
      open: async () => ({ ok: true, value: view }),
    }));
    const responses = [
      await app.inject({ method: "POST", url: "/characters", headers: cookie, payload: {
        systemVersionId: view.systemVersionId, entityDefinitionId: "character", name: "Aria", idempotencyKey: "old-create",
      } }),
      await app.inject({ method: "POST", url: `/characters/${view.characterId}/fields/ability/set`, headers: cookie,
        payload: { value: 12, expectedRevision: 1, idempotencyKey: "old-command" } }),
      await app.inject({ method: "GET", url: `/characters/${view.characterId}`, headers: cookie }),
    ];
    expect(responses.map(response => response.statusCode)).toEqual([201, 200, 200]);
    for (const response of responses) {
      const body = response.json();
      const projection = (body.character ?? body.result.character).projection;
      expect(projection.projectionVersion).toBe("1.0");
      if (completionFields === undefined) expect(projection).not.toHaveProperty("completionFields");
      else expect(projection.completionFields).toEqual(completionFields);
    }
    expect(responses[2]!.headers.etag).toBe(eTag);
  });

  it("maps POST /characters to create and requires an idempotencyKey in the body", async () => {
    let received: unknown;
    const app = await build(
      makeCharacters({
        create: async (_ctx, input) => {
          received = input;
          return { ok: true, value: characterView() };
        },
      }),
    );
    const systemVersionId = randomUUID();
    const response = await app.inject({
      method: "POST",
      url: "/characters",
      headers: cookie,
      payload: {
        systemVersionId,
        entityDefinitionId: "character",
        name: "Aria",
        initialValues: { ability: 12 },
        idempotencyKey: "key-1",
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ character: expect.any(Object), requestId: expect.any(String) });
    expect(response.json().character.reconciliation).toMatchObject({
      revision: 1,
      projectionVersion: "1.0",
      replayed: false,
      cacheDisposition: "retain",
    });
    expect(received).toEqual({
      systemVersionId,
      entityDefinitionId: "character",
      name: "Aria",
      initialValues: { ability: 12 },
      idempotencyKey: "key-1",
    });

    const missing = await app.inject({
      method: "POST",
      url: "/characters",
      headers: cookie,
      payload: { systemVersionId, entityDefinitionId: "character", name: "Aria" },
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.code).toBe("bad_request");

    const differentKey = await app.inject({
      method: "POST",
      url: "/characters",
      headers: cookie,
      payload: {
        systemVersionId,
        entityDefinitionId: "character",
        name: "Aria",
        idempotencyKey: "key-2",
      },
    });
    expect(differentKey.statusCode).toBe(201);
    expect(received).toMatchObject({ idempotencyKey: "key-2" });
  });

  it("maps GET /characters to list and validates limit", async () => {
    let received: unknown;
    const app = await build(
      makeCharacters({
        list: async (_ctx, input) => {
          received = input;
          return { ok: true, value: { characters: [], nextCursor: null } };
        },
      }),
    );
    const ok = await app.inject({ method: "GET", url: "/characters?limit=5&cursor=abc", headers: cookie });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["cache-control"]).toBe("private");
    expect(ok.json()).toEqual({ characters: [], nextCursor: null, requestId: expect.any(String) });
    expect(received).toEqual({ limit: 5, cursor: "abc" });

    const bad = await app.inject({ method: "GET", url: "/characters?limit=999", headers: cookie });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("bad_request");
  });

  it("maps GET /characters/creation-options to creationOptions and forwards its data", async () => {
    let received: unknown;
    const versionId = randomUUID();
    const app = await build(
      makeCharacters({
        creationOptions: async (_ctx, input) => {
          received = input;
          return {
            ok: true,
            value: {
              versionId,
              packageChecksum: d20Package.integrity.checksum,
              entities: [{ id: "character", label: "Character" }],
            },
          };
        },
      }),
    );
    const response = await app.inject({
      method: "GET",
      url: `/characters/creation-options?systemVersionId=${versionId}`,
      headers: cookie,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: {
        versionId,
        packageChecksum: d20Package.integrity.checksum,
        entities: [{ id: "character", label: "Character" }],
      },
      requestId: expect.any(String),
    });
    expect(received).toEqual({ systemVersionId: versionId });
  });

  it("maps GET /characters/creation-versions to listCreationVersions and forwards its data", async () => {
    const versions = [
      {
        versionId: randomUUID(),
        systemId: randomUUID(),
        systemName: "D20",
        semanticVersion: "1.0.0",
        createdAt: "2026-09-06T00:00:00.000Z",
      },
    ];
    const app = await build(
      makeCharacters({
        listCreationVersions: async () => ({ ok: true, value: { versions, nextCursor: null } }),
      }),
    );
    const response = await app.inject({
      method: "GET",
      url: "/characters/creation-versions",
      headers: cookie,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: { versions, nextCursor: null }, requestId: expect.any(String) });
  });

  it("maps internal creation-versions failures to 500", async () => {
    const internal: Characters["listCreationVersions"] = async () => ({
      ok: false,
      error: { code: "internal", message: "An internal error occurred." },
    });
    const app = await build(makeCharacters({ listCreationVersions: internal }));
    const response = await app.inject({
      method: "GET",
      url: "/characters/creation-versions",
      headers: cookie,
    });
    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe("internal");
  });

  it("requires the systemVersionId query parameter for creation options", async () => {
    const app = await build(makeCharacters({}));
    const missing = await app.inject({ method: "GET", url: "/characters/creation-options", headers: cookie });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.code).toBe("bad_request");

    const malformed = await app.inject({
      method: "GET",
      url: "/characters/creation-options?systemVersionId=not-a-uuid",
      headers: cookie,
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().error.code).toBe("bad_request");
  });

  it("maps unauthorized and inaccessible creation-option lookups to 404", async () => {
    const notFound: Characters["creationOptions"] = async () => ({
      ok: false,
      error: { code: "not_found", message: "The requested resource does not exist." },
    });
    const app = await build(makeCharacters({ creationOptions: notFound }));
    const response = await app.inject({
      method: "GET",
      url: `/characters/creation-options?systemVersionId=${randomUUID()}`,
      headers: cookie,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.cacheDisposition).toBe("purge");
  });

  it("maps corrupt-package creation-option lookups to 422", async () => {
    const invalidValue: Characters["creationOptions"] = async () => ({
      ok: false,
      error: { code: "invalid_value", message: "Published package is corrupt." },
    });
    const app = await build(makeCharacters({ creationOptions: invalidValue }));
    const response = await app.inject({
      method: "GET",
      url: `/characters/creation-options?systemVersionId=${randomUUID()}`,
      headers: cookie,
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("invalid_value");
  });

  it("maps GET /characters/:characterId to open and emits private cache headers", async () => {
    let received: string | undefined;
    const app = await build(
      makeCharacters({
        open: async (_ctx, characterId) => {
          received = characterId;
          return { ok: true, value: characterView() };
        },
      }),
    );
    const id = randomUUID();
    const response = await app.inject({ method: "GET", url: `/characters/${id}`, headers: cookie });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private");
    expect(response.headers["etag"]).toBe(eTag);
    expect(response.headers["x-resource-revision"]).toBe("1");
    expect(response.json().character.reconciliation).toMatchObject({
      revision: 1,
      projectionVersion: "1.0",
      activityCursor: null,
      cacheDisposition: "retain",
    });
    expect(response.json().requestId).toBeTypeOf("string");
    expect(received).toBe(id);
  });

  it("maps field set to apply with direct setField input", async () => {
    let received: unknown;
    const app = await build(
      makeCharacters({
        apply: async (_ctx, input) => {
          received = input;
          return { ok: true, value: commandResult() };
        },
      }),
    );
    const id = randomUUID();
    const response = await app.inject({
      method: "POST",
      url: `/characters/${id}/fields/ability/set`,
      headers: cookie,
      payload: { value: 14, expectedRevision: 2, idempotencyKey: "key-1" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ result: { character: expect.any(Object), roll: null }, requestId: expect.any(String) });
    expect(received).toEqual({
      kind: "setField",
      characterId: id,
      fieldId: "ability",
      value: 14,
      expectedRevision: 2,
      idempotencyKey: "key-1",
    });
  });

  it("maps resource bump to apply with direct bumpResource input", async () => {
    let received: unknown;
    const app = await build(
      makeCharacters({
        apply: async (_ctx, input) => {
          received = input;
          return { ok: true, value: commandResult() };
        },
      }),
    );
    const id = randomUUID();
    const response = await app.inject({
      method: "POST",
      url: `/characters/${id}/resources/health/bump`,
      headers: cookie,
      payload: { direction: "down", expectedRevision: 3, idempotencyKey: "key-1" },
    });
    expect(response.statusCode).toBe(200);
    expect(received).toEqual({
      kind: "bumpResource",
      characterId: id,
      resourceId: "health",
      direction: "down",
      expectedRevision: 3,
      idempotencyKey: "key-1",
    });
  });

  it("maps action execution to apply and defaults inputs", async () => {
    let received: unknown;
    const app = await build(
      makeCharacters({
        apply: async (_ctx, input) => {
          received = input;
          return { ok: true, value: commandResult({
            actionId: "check", expression: "d20", dice: [], bindings: [], total: 12, output: "12", audience: "owner_only",
          } as CharacterCommandResult["roll"]) };
        },
      }),
    );
    const id = randomUUID();
    const response = await app.inject({
      method: "POST",
      url: `/characters/${id}/actions/check`,
      headers: cookie,
      payload: { expectedRevision: 1, idempotencyKey: "key-1" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().result.roll).toMatchObject({ audience: "owner_only" });
    expect(received).toEqual({
      kind: "executeAction",
      characterId: id,
      actionId: "check",
      inputs: {},
      expectedRevision: 1,
      idempotencyKey: "key-1",
    });
  });

  it("forwards the requested roll audience and serves campaign audiences", async () => {
    let received: unknown;
    const app = await build(
      makeCharacters({
        apply: async (_ctx, input) => {
          received = input;
          return { ok: true, value: commandResult({
            actionId: "check", expression: "d20", dice: [], bindings: [], total: 12, output: "12", audience: "campaign",
          } as CharacterCommandResult["roll"]) };
        },
      }),
    );
    const id = randomUUID();
    const response = await app.inject({
      method: "POST",
      url: `/characters/${id}/actions/check`,
      headers: cookie,
      payload: { inputs: {}, audience: "campaign", expectedRevision: 1, idempotencyKey: "key-2" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().result.roll).toMatchObject({ audience: "campaign" });
    expect(received).toEqual({
      kind: "executeAction",
      characterId: id,
      actionId: "check",
      inputs: {},
      audience: "campaign",
      expectedRevision: 1,
      idempotencyKey: "key-2",
    });
  });

  it("rejects unknown roll audiences at the wire boundary", async () => {
    const app = await build(makeCharacters({}));
    const response = await app.inject({
      method: "POST",
      url: `/characters/${randomUUID()}/actions/check`,
      headers: cookie,
      payload: { inputs: {}, audience: "everyone", expectedRevision: 1, idempotencyKey: "key-3" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("bad_request");
  });

  it("maps PATCH /characters/:characterId to manage for rename/archive/recover", async () => {
    const seen: unknown[] = [];
    const app = await build(
      makeCharacters({
        manage: async (_ctx, input) => {
          seen.push(input);
          return { ok: true, value: commandResult() };
        },
      }),
    );
    const id = randomUUID();
    const rename = await app.inject({
      method: "PATCH",
      url: `/characters/${id}`,
      headers: cookie,
      payload: { command: "rename", name: "Renamed", expectedRevision: 1, idempotencyKey: "key-1" },
    });
    expect(rename.statusCode).toBe(200);
    expect(rename.json()).toEqual({ result: { character: expect.any(Object), roll: null }, requestId: expect.any(String) });

    const archive = await app.inject({
      method: "PATCH",
      url: `/characters/${id}`,
      headers: cookie,
      payload: { command: "archive", expectedRevision: 1, idempotencyKey: "key-1" },
    });
    expect(archive.statusCode).toBe(200);

    const recover = await app.inject({
      method: "PATCH",
      url: `/characters/${id}`,
      headers: cookie,
      payload: { command: "recover", expectedRevision: 1, idempotencyKey: "key-1" },
    });
    expect(recover.statusCode).toBe(200);

    expect(seen).toEqual([
      { kind: "rename", characterId: id, name: "Renamed", expectedRevision: 1, idempotencyKey: "key-1" },
      { kind: "archive", characterId: id, expectedRevision: 1, idempotencyKey: "key-1" },
      { kind: "recover", characterId: id, expectedRevision: 1, idempotencyKey: "key-1" },
    ]);

    const bad = await app.inject({
      method: "PATCH",
      url: `/characters/${id}`,
      headers: cookie,
      payload: { command: "wat", expectedRevision: 1, idempotencyKey: "key-1" },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("bad_request");
  });

  it("maps ownership transfer to manage with direct transferOwnership input", async () => {
    let received: unknown;
    const app = await build(
      makeCharacters({
        manage: async (_ctx, input) => {
          received = input;
          return { ok: true, value: commandResult() };
        },
      }),
    );
    const id = randomUUID();
    const toUserId = randomUUID();
    const response = await app.inject({
      method: "POST",
      url: `/characters/${id}/ownership-transfer`,
      headers: cookie,
      payload: { toUserId, expectedRevision: 1, idempotencyKey: "key-1" },
    });
    expect(response.statusCode).toBe(200);
    expect(received).toEqual({
      kind: "transferOwnership",
      characterId: id,
      toUserId,
      expectedRevision: 1,
      idempotencyKey: "key-1",
    });
  });

  it("maps activity listing with limit/cursor and emits private cache", async () => {
    let received: unknown;
    const app = await build(
      makeCharacters({
        listActivity: async (_ctx, input) => {
          received = input;
          return {
            ok: true,
            value: {
              events: [
                {
                  id: randomUUID(),
                  characterRevision: 1,
                  kind: "character_field_set",
                  payload: { fieldId: "ability", changedDefinitionIds: ["ability"] },
                  rollId: null,
                  requestId: randomUUID(),
                  occurredAt: new Date(0),
                },
              ],
              nextCursor: null,
            },
          };
        },
      }),
    );
    const id = randomUUID();
    const response = await app.inject({ method: "GET", url: `/characters/${id}/activity?limit=3`, headers: cookie });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private");
    expect(response.json().events).toHaveLength(1);
    expect(response.json().events[0]).toMatchObject({
      kind: "character_field_set",
      payload: { fieldId: "ability" },
      occurredAt: "1970-01-01T00:00:00.000Z",
    });
    expect(received).toEqual({ characterId: id, limit: 3, cursor: null });
  });

  it("maps exports to exportCharacter with vendor media type and cache headers", async () => {
    let received: unknown;
    const app = await build(
      makeCharacters({
        exportCharacter: async (_ctx, input) => {
          received = input;
          return { ok: true, value: characterExport() };
        },
      }),
    );
    const id = randomUUID();
    const response = await app.inject({ method: "POST", url: `/characters/${id}/exports`, headers: cookie });
    expect(response.statusCode).toBe(200);
    expect(received).toEqual({ characterId: id });
    expect(response.headers["content-type"]).toContain("application/vnd.sweetroll.character+json;version=1");
    expect(response.headers["cache-control"]).toBe("private");
    expect(response.headers["etag"]).toBe(eTag);
    expect(response.headers["x-resource-revision"]).toBe("1");
    const body = response.json() as CharacterExportV1;
    expect(body.mediaType).toBe("application/vnd.sweetroll.character+json;version=1");
    expect(body.characterId).toBeTypeOf("string");
    expect(body.migrationLineage).toEqual([]);
  });

  it("maps migration preview to previewMigration returning 201", async () => {
    let received: unknown;
    const app = await build(
      makeCharacters({
        previewMigration: async (_ctx, input) => {
          received = input;
          return { ok: true, value: migrationPreview() };
        },
      }),
    );
    const id = randomUUID();
    const targetVersionId = randomUUID();
    const response = await app.inject({
      method: "POST",
      url: `/characters/${id}/migration-previews`,
      headers: cookie,
      payload: { targetVersionId, mappings: { ability: "strength" }, defaults: { ancestry: "human" } },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().preview).toMatchObject({ sourceRevision: 1, warnings: [] });
    expect(response.json().preview.candidateProjection).toMatchObject({ entityLabel: "Character" });
    expect(response.json().requestId).toBeTypeOf("string");
    expect(received).toEqual({
      characterId: id,
      targetVersionId,
      mappings: { ability: "strength" },
      defaults: { ancestry: "human" },
    });
  });

  it("maps migration commit to commitMigration", async () => {
    let received: unknown;
    const app = await build(
      makeCharacters({
        commitMigration: async (_ctx, input) => {
          received = input;
          return { ok: true, value: commandResult() };
        },
      }),
    );
    const id = randomUUID();
    const previewId = randomUUID();
    const response = await app.inject({
      method: "POST",
      url: `/characters/${id}/migrations/${previewId}/commit`,
      headers: cookie,
      payload: { expectedRevision: 4, idempotencyKey: "key-1" },
    });
    expect(response.statusCode).toBe(200);
    expect(received).toEqual({
      characterId: id,
      previewId,
      expectedRevision: 4,
      idempotencyKey: "key-1",
    });
  });

  it("maps migration rollback to rollbackMigration", async () => {
    let received: unknown;
    const app = await build(
      makeCharacters({
        rollbackMigration: async (_ctx, input) => {
          received = input;
          return { ok: true, value: commandResult() };
        },
      }),
    );
    const id = randomUUID();
    const migrationId = randomUUID();
    const response = await app.inject({
      method: "POST",
      url: `/characters/${id}/migrations/${migrationId}/rollback`,
      headers: cookie,
      payload: { idempotencyKey: "key-1" },
    });
    expect(response.statusCode).toBe(200);
    expect(received).toEqual({ characterId: id, migrationId, idempotencyKey: "key-1" });
  });

  it("rejects malformed payloads with 400", async () => {
    const app = await build(makeCharacters());
    const noName = await app.inject({
      method: "POST",
      url: "/characters",
      headers: cookie,
      payload: { systemVersionId: randomUUID(), entityDefinitionId: "character", idempotencyKey: "key-1" },
    });
    expect(noName.statusCode).toBe(400);
    expect(noName.json().error.code).toBe("bad_request");

    const badDirection = await app.inject({
      method: "POST",
      url: `/characters/${randomUUID()}/resources/health/bump`,
      headers: cookie,
      payload: { direction: "sideways", expectedRevision: 1, idempotencyKey: "key-1" },
    });
    expect(badDirection.statusCode).toBe(400);

    const badRevision = await app.inject({
      method: "POST",
      url: `/characters/${randomUUID()}/migrations/${randomUUID()}/commit`,
      headers: cookie,
      payload: { expectedRevision: "abc", idempotencyKey: "key-1" },
    });
    expect(badRevision.statusCode).toBe(400);

    const noKey = await app.inject({
      method: "POST",
      url: `/characters/${randomUUID()}/fields/ability/set`,
      headers: cookie,
      payload: { value: 12, expectedRevision: 1 },
    });
    expect(noKey.statusCode).toBe(400);
    expect(noKey.json().error.code).toBe("bad_request");
  });

  it("maps inaccessible characters to 404 with purge reconciliation on every route", async () => {
    const notFound = async (): Promise<{ ok: false; error: CharacterError }> => ({
      ok: false,
      error: { code: "not_found", message: "The requested character does not exist." },
    });
    const app = await build(
      makeCharacters({
        create: notFound,
        list: notFound,
        open: notFound,
        apply: notFound,
        manage: notFound,
        duplicate: notFound,
        listActivity: notFound,
        exportCharacter: notFound,
        previewMigration: notFound,
        commitMigration: notFound,
        rollbackMigration: notFound,
      }),
    );
    const routes: Array<{ method: "get" | "post" | "patch"; url: string; payload?: unknown }> = [
      { method: "post", url: "/characters", payload: { systemVersionId: randomUUID(), entityDefinitionId: "character", name: "Aria", idempotencyKey: "key-1" } },
      { method: "get", url: "/characters" },
      { method: "get", url: `/characters/${randomUUID()}` },
      { method: "post", url: `/characters/${randomUUID()}/fields/ability/set`, payload: { value: 12, expectedRevision: 1, idempotencyKey: "key-1" } },
      { method: "post", url: `/characters/${randomUUID()}/resources/health/bump`, payload: { direction: "up", expectedRevision: 1, idempotencyKey: "key-1" } },
      { method: "post", url: `/characters/${randomUUID()}/actions/check`, payload: { inputs: {}, expectedRevision: 1, idempotencyKey: "key-1" } },
      { method: "patch", url: `/characters/${randomUUID()}`, payload: { command: "archive", expectedRevision: 1, idempotencyKey: "key-1" } },
      { method: "post", url: `/characters/${randomUUID()}/ownership-transfer`, payload: { toUserId: randomUUID(), expectedRevision: 1, idempotencyKey: "key-1" } },
      { method: "post", url: `/characters/${randomUUID()}/duplicate`, payload: { idempotencyKey: "key-1" } },
      { method: "get", url: `/characters/${randomUUID()}/activity` },
      { method: "post", url: `/characters/${randomUUID()}/exports` },
      { method: "post", url: `/characters/${randomUUID()}/migration-previews`, payload: { targetVersionId: randomUUID() } },
      { method: "post", url: `/characters/${randomUUID()}/migrations/${randomUUID()}/commit`, payload: { expectedRevision: 1, idempotencyKey: "key-1" } },
      { method: "post", url: `/characters/${randomUUID()}/migrations/${randomUUID()}/rollback`, payload: { idempotencyKey: "key-1" } },
    ];

    for (const route of routes) {
      const response = await app.inject({
        method: route.method,
        url: route.url,
        headers: cookie,
        ...(route.payload === undefined ? {} : { payload: route.payload }),
      });
      expect(response.statusCode, `${route.method} ${route.url}`).toBe(404);
      const body = response.json() as { error: CharacterError; requestId: string };
      expect(body.error.code).toBe("not_found");
      expect(body.error.cacheDisposition).toBe("purge");
      expect(body.error).not.toHaveProperty("characterId");
      expect(body.requestId).toBeTypeOf("string");
    }
  });

  it("serves attached campaign views through the ownership-union DTO", async () => {
    const campaignId = randomUUID();
    const controllerId = randomUUID();
    const attached = characterView({
      ownerId: null,
      campaignId,
      controllers: [controllerId],
      placementGeneration: 2,
      returnOwnerId: controllerId,
    });
    const app = await build(makeCharacters({ open: async () => ({ ok: true, value: attached }) }));
    const response = await app.inject({
      method: "get",
      url: `/characters/${attached.characterId}`,
      headers: cookie,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { character: Record<string, unknown>; requestId: string };
    expect(body.character).toMatchObject({
      characterId: attached.characterId,
      ownerId: null,
      campaignId,
      controllers: [controllerId],
      placementGeneration: 2,
      returnOwnerId: controllerId,
    });
  });

  it("maps result_unavailable to 409 without a payload", async () => {
    const app = await build(
      makeCharacters({
        apply: async () => ({
          ok: false,
          error: {
            code: "result_unavailable",
            message: "The saved result is no longer available under the current policy. Retry with a new idempotency key.",
          },
        }),
      }),
    );
    const response = await app.inject({
      method: "post",
      url: `/characters/${randomUUID()}/fields/ability/set`,
      headers: cookie,
      payload: { value: 12, expectedRevision: 1, idempotencyKey: "key-1" },
    });
    expect(response.statusCode).toBe(409);
    const body = response.json() as { error: CharacterError; requestId: string };
    expect(body.error.code).toBe("result_unavailable");
    expect(body).not.toHaveProperty("value");
    expect(body.requestId).toBeTypeOf("string");
  });

  it("returns 409 with the reconciliation payload for conflicts", async () => {
    const conflict: CharacterError = {
      code: "conflict",
      message: "The character has a newer revision.",
      latestRevision: 7,
      changedDefinitionIds: ["ability"],
      activityCursor: "dG9rZW4",
      cacheDisposition: "replace",
    };
    const app = await build(
      makeCharacters({
        create: async () => ({ ok: false, error: { code: "idempotency_mismatch", message: "This idempotency key was already used with different input." } }),
        apply: async () => ({ ok: false, error: conflict }),
        manage: async () => ({ ok: false, error: conflict }),
        commitMigration: async () => ({ ok: false, error: conflict }),
        rollbackMigration: async () => ({ ok: false, error: conflict }),
      }),
    );
    const headers = cookie;
    const conflictUrl = `/characters/${randomUUID()}/fields/ability/set`;

    const set = await app.inject({ method: "POST", url: conflictUrl, headers, payload: { value: 1, expectedRevision: 1, idempotencyKey: "key-1" } });
    expect(set.statusCode).toBe(409);
    expect(set.json().error).toMatchObject({
      code: "conflict",
      latestRevision: 7,
      changedDefinitionIds: ["ability"],
      activityCursor: "dG9rZW4",
      cacheDisposition: "replace",
    });

    const mismatch = await app.inject({
      method: "POST",
      url: "/characters",
      headers,
      payload: { systemVersionId: randomUUID(), entityDefinitionId: "character", name: "Aria", idempotencyKey: "key-1" },
    });
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json().error.code).toBe("idempotency_mismatch");

    const transfer = await app.inject({
      method: "POST",
      url: `/characters/${randomUUID()}/ownership-transfer`,
      headers,
      payload: { toUserId: randomUUID(), expectedRevision: 1, idempotencyKey: "key-1" },
    });
    expect(transfer.statusCode).toBe(409);

    const commit = await app.inject({
      method: "POST",
      url: `/characters/${randomUUID()}/migrations/${randomUUID()}/commit`,
      headers,
      payload: { expectedRevision: 1, idempotencyKey: "key-1" },
    });
    expect(commit.statusCode).toBe(409);
    expect(commit.json().error.cacheDisposition).toBe("replace");

    const rollback = await app.inject({
      method: "POST",
      url: `/characters/${randomUUID()}/migrations/${randomUUID()}/rollback`,
      headers,
      payload: { idempotencyKey: "key-1" },
    });
    expect(rollback.statusCode).toBe(409);
  });

  it("maps command_in_progress to 409", async () => {
    const app = await build(
      makeCharacters({
        apply: async () => ({
          ok: false,
          error: { code: "command_in_progress", message: "Another request is already processing this idempotency key." },
        }),
      }),
    );
    const response = await app.inject({
      method: "POST",
      url: `/characters/${randomUUID()}/resources/health/bump`,
      headers: cookie,
      payload: { direction: "up", expectedRevision: 1, idempotencyKey: "key-1" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("command_in_progress");
  });

  it("maps runtime-invalid module errors to 422 with diagnostics", async () => {
    const app = await build(
      makeCharacters({
        apply: async () => ({
          ok: false,
          error: {
            code: "invalid_value",
            message: "Field value is invalid.",
            diagnostics: [
              {
                validationId: "ability_valid_expr",
                severity: "error",
                message: "Ability score must be between 3 and 18",
                targetDefinitionId: "ability",
              },
            ],
          },
        }),
        previewMigration: async () => ({ ok: false, error: { code: "invalid_value", message: "Mappings conflict." } }),
      }),
    );
    const id = randomUUID();
    const set = await app.inject({
      method: "POST",
      url: `/characters/${id}/fields/ability/set`,
      headers: cookie,
      payload: { value: 99, expectedRevision: 1, idempotencyKey: "key-1" },
    });
    expect(set.statusCode).toBe(422);
    expect(set.json().error.code).toBe("invalid_value");
    expect(set.json().error.diagnostics).toHaveLength(1);

    const preview = await app.inject({
      method: "POST",
      url: `/characters/${id}/migration-previews`,
      headers: cookie,
      payload: { targetVersionId: randomUUID() },
    });
    expect(preview.statusCode).toBe(422);
    expect(preview.json().error.code).toBe("invalid_value");
    expect(preview.json().error).not.toHaveProperty("diagnostics");
  });

  it("maps genuine catch-block internal module errors to 500", async () => {
    const app = await build(
      makeCharacters({
        open: async () => ({ ok: false, error: { code: "internal", message: "An internal error occurred." } }),
      }),
    );
    const response = await app.inject({ method: "GET", url: `/characters/${randomUUID()}`, headers: cookie });
    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe("internal");
    expect(response.json().requestId).toBeTypeOf("string");
  });

  it("maps temporary infrastructure failures to 503", async () => {
    const app = await build(
      makeCharacters({
        open: async () => ({
          ok: false,
          error: { code: "temporarily_unavailable", message: "A temporary infrastructure failure occurred." },
        }),
      }),
    );
    const response = await app.inject({ method: "GET", url: `/characters/${randomUUID()}`, headers: cookie });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("temporarily_unavailable");
    expect(response.json().requestId).toBeTypeOf("string");
  });

  it("feeds conflict activityCursor back into listActivity cursor", async () => {
    const cursor = "eyJjIjo0Mn0";
    let captured: string | null | undefined;
    const id = randomUUID();
    const app = await build(
      makeCharacters({
        apply: async () => ({
          ok: false,
          error: {
            code: "conflict",
            message: "stale",
            latestRevision: 3,
            changedDefinitionIds: ["ability"],
            activityCursor: cursor,
            cacheDisposition: "replace",
          },
        }),
        listActivity: async (_ctx, input) => {
          captured = input.cursor;
          return { ok: true, value: { events: [], nextCursor: null } };
        },
      }),
    );
    const conflict = await app.inject({
      method: "POST",
      url: `/characters/${id}/fields/ability/set`,
      headers: cookie,
      payload: { value: 1, expectedRevision: 1, idempotencyKey: "key-1" },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.activityCursor).toBe(cursor);

    await app.inject({
      method: "GET",
      url: `/characters/${id}/activity?cursor=${encodeURIComponent(cursor)}`,
      headers: cookie,
    });
    expect(captured).toBe(cursor);
  });

  it("uses the server-generated request id for the context and ignores client request-id headers", async () => {
    const clientRequestId = "client-supplied-request-id";
    let receivedCtx: { actorId: string; requestId: string } | undefined;
    const app = await build(
      makeCharacters({
        open: async (ctx) => {
          receivedCtx = ctx;
          return { ok: true, value: characterView() };
        },
      }),
    );
    const response = await app.inject({
      method: "GET",
      url: `/characters/${randomUUID()}`,
      headers: { ...cookie, ...{ "request-id": clientRequestId, "x-request-id": clientRequestId } },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().requestId).toBeTypeOf("string");
    expect(response.json().requestId).not.toBe(clientRequestId);
    expect(receivedCtx?.requestId).toBe(response.json().requestId);
    expect(receivedCtx?.actorId).toBe(actorId);
  });
});
