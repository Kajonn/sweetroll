import { randomUUID } from "node:crypto";

import { afterEach } from "vitest";
import { describe, expect, it } from "vitest";

import {
  buildD20V2Document,
  buildI3App,
  createI3Pool,
  createI3Schema,
  dropI3Schema,
  type I3AppHandle,
  type I3Users,
} from "./i3-app.js";
import {
  d20Document,
  d6SuccessPoolDocument,
  pbta2d6Document,
} from "../../src/systems/implementation/package/fixtures/index.js";
import type { SystemDocumentV1 } from "../../src/systems/implementation/package/schema/document.js";
import type { SystemRuntime } from "../../src/systems/runtime.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl === undefined ? describe.skip : describe;

type App = I3AppHandle;

async function makeApp(): Promise<App & { cleanup: () => Promise<void> }> {
  const schema = `i3_http_${randomUUID().replaceAll("-", "")}`;
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

const cookieHeader = (user: I3Users[keyof I3Users]) => ({ cookie: user.cookie });

async function publishVersion(
  app: App,
  user: I3Users["ada"],
  document: SystemDocumentV1,
  opts: { name: string; semanticVersion: string },
): Promise<{ systemId: string; versionId: string }> {
  const create = await app.app.inject({
    method: "POST",
    url: "/systems",
    headers: cookieHeader(user),
    payload: { source: { kind: "blank", name: opts.name }, idempotencyKey: `sys-${randomUUID()}` },
  });
  expect(create.statusCode, create.body).toBe(201);
  const workspace = create.json().workspace;
  const systemId = workspace.system.systemId as string;
  const initialRevision = workspace.draft?.revision ?? 1;

  const save = await app.app.inject({
    method: "PUT",
    url: `/systems/${systemId}/draft`,
    headers: cookieHeader(user),
    payload: { expectedRevision: initialRevision, document },
  });
  expect(save.statusCode, save.body).toBe(200);
  const draftRevision = save.json().workspace.draft.revision as number;

  const publish = await app.app.inject({
    method: "POST",
    url: `/systems/${systemId}/publish`,
    headers: cookieHeader(user),
    payload: {
      expectedRevision: draftRevision,
      semanticVersion: opts.semanticVersion,
      releaseNotes: "",
      idempotencyKey: `pub-${randomUUID()}`,
      acknowledgeBreaking: true,
    },
  });
  expect(publish.statusCode, publish.body).toBe(200);
  return { systemId, versionId: publish.json().version.versionId as string };
}

async function createCharacter(
  app: App,
  user: I3Users["ada"],
  input: { systemVersionId: string; name: string; initialValues?: Record<string, unknown>; idempotencyKey: string },
) {
  return app.app.inject({
    method: "POST",
    url: "/characters",
    headers: cookieHeader(user),
    payload: {
      systemVersionId: input.systemVersionId,
      entityDefinitionId: "character",
      name: input.name,
      ...(input.initialValues === undefined ? {} : { initialValues: input.initialValues }),
      idempotencyKey: input.idempotencyKey,
    },
  });
}

async function getCharacter(app: App, user: I3Users["ada"], characterId: string) {
  return app.app.inject({ method: "GET", url: `/characters/${characterId}`, headers: cookieHeader(user) });
}

async function setField(
  app: App,
  user: I3Users["ada"],
  characterId: string,
  fieldId: string,
  value: unknown,
  expectedRevision: number,
  idempotencyKey: string,
) {
  return app.app.inject({
    method: "POST",
    url: `/characters/${characterId}/fields/${fieldId}/set`,
    headers: cookieHeader(user),
    payload: { value, expectedRevision, idempotencyKey },
  });
}

async function bumpResource(
  app: App,
  user: I3Users["ada"],
  characterId: string,
  resourceId: string,
  direction: "up" | "down",
  expectedRevision: number,
  idempotencyKey: string,
) {
  return app.app.inject({
    method: "POST",
    url: `/characters/${characterId}/resources/${resourceId}/bump`,
    headers: cookieHeader(user),
    payload: { direction, expectedRevision, idempotencyKey },
  });
}

async function executeAction(
  app: App,
  user: I3Users["ada"],
  characterId: string,
  actionId: string,
  inputs: Record<string, unknown>,
  expectedRevision: number,
  idempotencyKey: string,
) {
  return app.app.inject({
    method: "POST",
    url: `/characters/${characterId}/actions/${actionId}`,
    headers: cookieHeader(user),
    payload: { inputs, expectedRevision, idempotencyKey },
  });
}

// Replay proof compares full result objects; the `replayed` flag legitimately
// flips to true on the second instance, so it is excluded from deep equality.
function stripReplayFlag(value: unknown): unknown {
  const clone = structuredClone(value) as Record<string, unknown>;
  walk(clone);
  return clone;
  function walk(node: unknown): void {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const record = node as Record<string, unknown>;
    const reconciliation = record.reconciliation as { replayed?: boolean } | undefined;
    if (reconciliation) delete reconciliation.replayed;
    for (const key of Object.keys(record)) walk(record[key]);
  }
}

async function manageCharacter(
  app: App,
  user: I3Users["ada"],
  characterId: string,
  command: { command: "rename" | "archive" | "recover"; name?: string },
  expectedRevision: number,
  idempotencyKey: string,
) {
  return app.app.inject({
    method: "PATCH",
    url: `/characters/${characterId}`,
    headers: cookieHeader(user),
    payload: { ...command, expectedRevision, idempotencyKey },
  });
}

async function transferOwnership(
  app: App,
  user: I3Users["ada"],
  characterId: string,
  toUserId: string,
  expectedRevision: number,
  idempotencyKey: string,
) {
  return app.app.inject({
    method: "POST",
    url: `/characters/${characterId}/ownership-transfer`,
    headers: cookieHeader(user),
    payload: { toUserId, expectedRevision, idempotencyKey },
  });
}

async function listActivity(
  app: App,
  user: I3Users["ada"],
  characterId: string,
  limit?: number,
  cursor?: string,
) {
  const search = new URLSearchParams();
  if (limit !== undefined) search.set("limit", String(limit));
  if (cursor !== undefined) search.set("cursor", cursor);
  const qs = search.toString();
  return app.app.inject({
    method: "GET",
    url: `/characters/${characterId}/activity${qs === "" ? "" : `?${qs}`}`,
    headers: cookieHeader(user),
  });
}

async function exportCharacter(app: App, user: I3Users["ada"], characterId: string) {
  return app.app.inject({ method: "POST", url: `/characters/${characterId}/exports`, headers: cookieHeader(user) });
}

describeWithDatabase("characters HTTP acceptance", () => {
  const apps: Array<{ cleanup: () => Promise<void> }> = [];
  afterEach(async () => {
    for (const app of apps.splice(0)) await app.cleanup();
  });

  it("full d20 flow over HTTP: create → set → bump → roll → replay → race → archive/recover → activity → export → breaking publish → preview/commit/rollback", async () => {
    const app = await makeApp();
    apps.push(app);
    const ada = app.users.ada;

    const { systemId, versionId: v1Id } = await publishVersion(app, ada, d20Document, {
      name: "D20 Acceptance",
      semanticVersion: "1.0.0",
    });

    const created = await createCharacter(app, ada, {
      systemVersionId: v1Id,
      name: "Aria",
      idempotencyKey: "c1",
    });
    expect(created.statusCode, created.body).toBe(201);
    const c1 = created.json();
    const characterId = c1.character.characterId as string;
    expect(c1.requestId).toBeTruthy();
    const createView = c1.character;
    expect(createView.revision).toBe(1);
    expect(createView.state).toMatchObject({ schemaVersion: "1.0", values: { ability: 10 } });
    expect(createView.state.values.health).toEqual({ current: 10, max: 10 });
    expect(createView.derivedValues.defense).toBe(10);
    expect(createView.projection.entityLabel).toBe("Character");
    expect(createView.reconciliation).toMatchObject({
      baseRevision: null,
      revision: 1,
      projectionVersion: "1.0",
      replayed: false,
      cacheDisposition: "retain",
      activityCursor: null,
    });

    const opened = await getCharacter(app, ada, characterId);
    expect(opened.statusCode, opened.body).toBe(200);
    expect(opened.headers["cache-control"]).toBe("private");
    expect(opened.headers["x-resource-revision"]).toBe("1");
    expect(opened.headers["etag"]).toMatch(/^"1-.+-1\.0"$/);
    expect(opened.json().character.reconciliation).toMatchObject({
      revision: 1,
      baseRevision: 1,
      activityCursor: null,
      cacheDisposition: "retain",
    });

    const set = await setField(app, ada, characterId, "ability", 15, 1, "s1");
    expect(set.statusCode, set.body).toBe(200);
    const s1 = set.json().result;
    expect(s1.character.revision).toBe(2);
    expect(s1.character.state.values.ability).toBe(15);
    expect(s1.character.reconciliation).toMatchObject({ baseRevision: 1, replayed: false });

    const bump = await bumpResource(app, ada, characterId, "health", "down", 2, "b1");
    expect(bump.statusCode, bump.body).toBe(200);
    expect(bump.json().result.character.state.values.health.current).toBe(9);
    expect(bump.json().result.character.revision).toBe(3);

    const rollReq = {
      actionId: "check",
      inputs: { bonus: 2 },
      expectedRevision: 3,
      idempotencyKey: "a1",
    };
    const roll = await executeAction(app, ada, characterId, rollReq.actionId, rollReq.inputs, 3, rollReq.idempotencyKey);
    expect(roll.statusCode, roll.body).toBe(200);
    const r1 = roll.json().result;
    expect(r1.character.revision).toBe(3);
    expect(r1.roll).toEqual({
      actionId: "check",
      expression: "d20 + fields.modifier + inputs.bonus",
      dice: [expect.objectContaining({ sides: 20, kept: true })],
      bindings: expect.arrayContaining([
        { scope: "fields", definitionId: "modifier", value: 0 },
        { scope: "inputs", definitionId: "bonus", value: 2 },
      ]),
      total: expect.any(Number),
      output: `Result: ${r1.roll.total}`,
      audience: "owner_only",
    });
    expect(r1.character.reconciliation.replayed).toBe(false);

    const replay = await executeAction(app, ada, characterId, "check", { bonus: 2 }, 3, "a1");
    expect(replay.statusCode, replay.body).toBe(200);
    const r2 = replay.json().result;
    expect(r2.character.reconciliation.replayed).toBe(true);
    expect(r2.character.reconciliation.commandExecutionId).toBe(r1.character.reconciliation.commandExecutionId);
    expect(r2.character.reconciliation.replayExpiresAt).toBe(r1.character.reconciliation.replayExpiresAt);
    expect(r2.roll).toEqual(r1.roll);
    const rollRows = await app.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM character_rolls WHERE character_id = $1",
      [characterId],
    );
    expect(rollRows.rows[0]!.n).toBe(1);

    const [raceA, raceB] = await Promise.all([
      bumpResource(app, ada, characterId, "health", "down", 3, "race-a"),
      bumpResource(app, ada, characterId, "health", "down", 3, "race-b"),
    ]);
    const winners = [raceA, raceB].filter((r) => r.statusCode === 200);
    const losers = [raceA, raceB].filter((r) => r.statusCode === 409);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(winners[0]!.json().result.character.revision).toBe(4);
    const loser = losers[0]!.json().error;
    expect(loser).toMatchObject({
      code: "conflict",
      latestRevision: 4,
      cacheDisposition: "replace",
    });
    expect(Array.isArray(loser.changedDefinitionIds)).toBe(true);
    expect(loser.activityCursor).toBeTruthy();

    const archived = await manageCharacter(app, ada, characterId, { command: "archive" }, 4, "m1");
    expect(archived.statusCode, archived.body).toBe(200);
    expect(archived.json().result.character).toMatchObject({ revision: 5, lifecycle: "archived" });
    expect(archived.json().result.character.archivedAt).toBeTruthy();

    const playWhileArchived = await setField(app, ada, characterId, "ability", 11, 5, "s2");
    expect(playWhileArchived.statusCode, playWhileArchived.body).toBe(409);
    expect(playWhileArchived.json().error.code).toBe("conflict");
    expect(playWhileArchived.json().error.message).toMatch(/archived/i);

    const recovered = await manageCharacter(app, ada, characterId, { command: "recover" }, 5, "m2");
    expect(recovered.statusCode, recovered.body).toBe(200);
    expect(recovered.json().result.character).toMatchObject({ revision: 6, lifecycle: "active" });

    const all = await listActivity(app, ada, characterId, 100);
    expect(all.statusCode, all.body).toBe(200);
    const events = all.json();
    expect(events.nextCursor).toBeNull();
    const kinds = (events.events as Array<{ kind: string }>).map((e) => e.kind);
    expect(kinds).toEqual([
      "character_recovered",
      "character_archived",
      "character_resource_bumped",
      "character_action_executed",
      "character_resource_bumped",
      "character_field_set",
      "character_created",
    ]);
    expect(kinds.filter((k) => k === "character_action_executed")).toHaveLength(1);

    const p1 = await listActivity(app, ada, characterId, 2);
    const p1Events = p1.json();
    expect(p1Events.events).toHaveLength(2);
    expect(p1Events.nextCursor).toBeTruthy();
    const p2 = await listActivity(app, ada, characterId, 100, p1Events.nextCursor);
    const p2Events = p2.json();
    expect(p2Events.events).toHaveLength(5);
    expect(p2Events.nextCursor).toBeNull();
    const allIds = [...p1Events.events, ...p2Events.events].map((e: { id: string }) => e.id);
    expect(new Set(allIds).size).toBe(allIds.length);

    const exported1 = await exportCharacter(app, ada, characterId);
    expect(exported1.statusCode, exported1.body).toBe(200);
    expect(exported1.headers["content-type"]).toContain("application/vnd.sweetroll.character+json;version=1");
    const doc1 = exported1.json();
    expect(doc1).toMatchObject({
      schemaVersion: "1.0",
      mediaType: "application/vnd.sweetroll.character+json;version=1",
      name: "Aria",
      revision: 6,
      migrationLineage: [],
    });

    const v2 = buildD20V2Document();
    await app.app.inject({
      method: "PUT",
      url: `/systems/${systemId}/draft`,
      headers: cookieHeader(ada),
      payload: { expectedRevision: 2, document: v2 },
    });
    const blocked = await app.app.inject({
      method: "POST",
      url: `/systems/${systemId}/publish`,
      headers: cookieHeader(ada),
      payload: {
        expectedRevision: 3,
        semanticVersion: "2.0.0",
        releaseNotes: "Breaking: rename ability",
        idempotencyKey: `pub-v2-noack-${randomUUID()}`,
        acknowledgeBreaking: false,
      },
    });
    expect(blocked.statusCode, blocked.body).toBe(422);
    expect(blocked.json().error.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "breaking_removed_definition" })]),
    );
    const publishedV2 = await app.app.inject({
      method: "POST",
      url: `/systems/${systemId}/publish`,
      headers: cookieHeader(ada),
      payload: {
        expectedRevision: 3,
        semanticVersion: "2.0.0",
        releaseNotes: "Breaking: rename ability",
        idempotencyKey: `pub-v2-${randomUUID()}`,
        acknowledgeBreaking: true,
      },
    });
    expect(publishedV2.statusCode, publishedV2.body).toBe(200);
    const v2Id = publishedV2.json().version.versionId as string;
    expect(v2Id).not.toBe(v1Id);

    const pinned = await getCharacter(app, ada, characterId);
    expect(pinned.statusCode, pinned.body).toBe(200);
    expect(pinned.json().character).toMatchObject({
      revision: 6,
      state: { schemaVersion: "1.0", values: { ability: 15, proficient: false } },
    });
    expect(pinned.json().character.systemVersionId).toBe(v1Id);

    const preview = await app.app.inject({
      method: "POST",
      url: `/characters/${characterId}/migration-previews`,
      headers: cookieHeader(ada),
      payload: { targetVersionId: v2Id, mappings: { ability: "ability_score" } },
    });
    expect(preview.statusCode, preview.body).toBe(201);
    const previewBody = preview.json().preview;
    expect(previewBody).toMatchObject({
      characterId,
      sourceRevision: 6,
      sourceVersionId: v1Id,
      targetVersionId: v2Id,
    });
    expect(previewBody.candidateState.values).toEqual({
      ability_score: 15,
      modifier: 0,
      ancestry: null,
      health: { current: 8, max: 10 },
      level: 1,
    });
    expect(previewBody.candidateProjection.entityLabel).toBe("Character");
    expect(previewBody.warnings).toHaveLength(2);
    expect(previewBody.warnings[0]).toContain(`"proficient"`);
    expect(previewBody.warnings[1]).toContain(`"level"`);

    const commit = await app.app.inject({
      method: "POST",
      url: `/characters/${characterId}/migrations/${previewBody.previewId}/commit`,
      headers: cookieHeader(ada),
      payload: { expectedRevision: 6, idempotencyKey: `cm-${randomUUID()}` },
    });
    expect(commit.statusCode, commit.body).toBe(200);
    expect(commit.json().result.character).toMatchObject({ revision: 7 });
    expect(commit.json().result.character.state.values.ability_score).toBe(15);
    expect(commit.json().result.character.systemVersionId).toBe(v2Id);

    const committed = await app.pool.query<{ id: string }>(
      "SELECT id FROM character_migrations WHERE character_id = $1",
      [characterId],
    );
    expect(committed.rows).toHaveLength(1);
    const migrationId = committed.rows[0]!.id;

    const rollback = await app.app.inject({
      method: "POST",
      url: `/characters/${characterId}/migrations/${migrationId}/rollback`,
      headers: cookieHeader(ada),
      payload: { idempotencyKey: `rb-${randomUUID()}` },
    });
    expect(rollback.statusCode, rollback.body).toBe(200);
    expect(rollback.json().result.character).toMatchObject({ revision: 8, systemVersionId: v1Id });
expect(rollback.json().result.character.state.values).toEqual({
      ability: 15,
      modifier: 0,
      proficient: false,
      ancestry: null,
      health: { current: 8, max: 10 },
    });

    const exported2 = await exportCharacter(app, ada, characterId);
    const doc2 = exported2.json();
    expect(doc2.migrationLineage).toEqual([]);
    expect(doc2.revision).toBe(8);
    expect(doc2.systemVersionId).toBe(v1Id);
  });

  it("replays an offline sequence identically on a second instance without re-hashing or re-running the runtime", async () => {
    const app1 = await makeApp();
    apps.push(app1);
    const ada = app1.users.ada;

    const { versionId: v1Id } = await publishVersion(app1, ada, d20Document, {
      name: "D20 Offline",
      semanticVersion: "1.0.0",
    });

    const created = await createCharacter(app1, ada, {
      systemVersionId: v1Id,
      name: "Mara",
      initialValues: { ability: 13 },
      idempotencyKey: "o-c1",
    });
    expect(created.statusCode, created.body).toBe(201);
    const characterId = created.json().character.characterId as string;
    const first = created.json().character;

    const rSet = await setField(app1, ada, characterId, "modifier", 2, 1, "o-s1");
    expect(rSet.statusCode, rSet.body).toBe(200);
    const second = rSet.json().result.character;
    const rBump = await bumpResource(app1, ada, characterId, "health", "down", 2, "o-b1");
    expect(rBump.statusCode, rBump.body).toBe(200);
    const third = rBump.json().result.character;
    const rRoll = await executeAction(app1, ada, characterId, "check", { bonus: 3 }, 3, "o-a1");
    expect(rRoll.statusCode, rRoll.body).toBe(200);
    const fourthResult = rRoll.json().result;

    let resolveCalls = 0;
    // A second Characters+runtime instance over the same database. If replays
    // re-invoked the runtime this spy would count calls.
    const app2 = await buildI3App({
      pool: app1.pool,
      wrapRuntime: (runtime) =>
        ({
          ...runtime,
          resolve: (input: Parameters<SystemRuntime["resolve"]>[0]) => {
            resolveCalls += 1;
            return runtime.resolve(input);
          },
        }) as SystemRuntime,
    });

    const users2 = app2.users;

    const reCreate = await createCharacter(app2, users2.ada, {
      systemVersionId: v1Id,
      name: "Mara",
      initialValues: { ability: 13 },
      idempotencyKey: "o-c1",
    });
    expect(reCreate.statusCode, reCreate.body).toBe(201);
    expect(stripReplayFlag(reCreate.json().character)).toEqual(stripReplayFlag(first));
    expect(reCreate.json().character.reconciliation.replayed).toBe(true);

    const reSet = await setField(app2, users2.ada, characterId, "modifier", 2, 1, "o-s1");
    expect(reSet.statusCode, reSet.body).toBe(200);
    expect(stripReplayFlag(reSet.json().result.character)).toEqual(stripReplayFlag(second));
    expect(reSet.json().result.character.reconciliation.replayed).toBe(true);

    const reBump = await bumpResource(app2, users2.ada, characterId, "health", "down", 2, "o-b1");
    expect(reBump.statusCode, reBump.body).toBe(200);
    expect(stripReplayFlag(reBump.json().result.character)).toEqual(stripReplayFlag(third));
    expect(reBump.json().result.character.reconciliation.replayed).toBe(true);

    const reRoll = await executeAction(app2, users2.ada, characterId, "check", { bonus: 3 }, 3, "o-a1");
    expect(reRoll.statusCode, reRoll.body).toBe(200);
    expect(stripReplayFlag(reRoll.json().result)).toEqual(stripReplayFlag(fourthResult));
    expect(reRoll.json().result.character.reconciliation.replayed).toBe(true);

    expect(resolveCalls).toBe(0);
    await app2.app.close();

    const execCount = await app1.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM character_command_executions WHERE actor_id = $1",
      [ada.actorId],
    );
    expect(execCount.rows[0]!.n).toBe(4);
    const rollCount = await app1.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM character_rolls WHERE character_id = $1",
      [characterId],
    );
    expect(rollCount.rows[0]!.n).toBe(1);
  });

  it("rejects replay with a stale expectedRevision with replacement metadata, and the conflict is terminal", async () => {
    const app = await makeApp();
    apps.push(app);
    const ada = app.users.ada;
    const { versionId: v1Id } = await publishVersion(app, ada, d20Document, {
      name: "D20 Stale",
      semanticVersion: "1.0.0",
    });
    const created = await createCharacter(app, ada, {
      systemVersionId: v1Id,
      name: "Stale",
      idempotencyKey: "st-c1",
    });
    const characterId = created.json().character.characterId as string;
    const set = await setField(app, ada, characterId, "ability", 12, 1, "st-s1");
    expect(set.statusCode, set.body).toBe(200);
    expect(set.json().result.character.revision).toBe(2);

    const staleBody = { value: 14, expectedRevision: 1, idempotencyKey: "st-stale" };
    const stale1 = await app.app.inject({
      method: "POST",
      url: `/characters/${characterId}/fields/ability/set`,
      headers: cookieHeader(ada),
      payload: staleBody,
    });
    expect(stale1.statusCode, stale1.body).toBe(409);
    const err1 = stale1.json().error;
    expect(err1).toMatchObject({
      code: "conflict",
      latestRevision: 2,
      cacheDisposition: "replace",
    });
    expect(err1.changedDefinitionIds).toEqual(["ability"]);
    expect(err1.activityCursor).toBeTruthy();

    const stale2 = await app.app.inject({
      method: "POST",
      url: `/characters/${characterId}/fields/ability/set`,
      headers: cookieHeader(ada),
      payload: staleBody,
    });
    expect(stale2.statusCode, stale2.body).toBe(409);
    expect(stale2.json().error).toEqual(err1);
    const execCount = await app.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM character_command_executions WHERE actor_id = $1 AND idempotency_key = 'st-stale'",
      [ada.actorId],
    );
    expect(execCount.rows[0]!.n).toBe(1);
  });

  it("rejects unauthenticated requests with 401 across every route family", async () => {
    const app = await makeApp();
    apps.push(app);
    const ada = app.users.ada;
    const { versionId: v1Id } = await publishVersion(app, ada, d20Document, {
      name: "D20 Auth",
      semanticVersion: "1.0.0",
    });
    const created = await createCharacter(app, ada, {
      systemVersionId: v1Id,
      name: "Auth",
      idempotencyKey: "au-c1",
    });
    const characterId = created.json().character.characterId as string;

    const routes = [
      { method: "GET" as const, url: "/characters" },
      { method: "GET" as const, url: `/characters/${characterId}` },
      { method: "POST" as const, url: "/characters", payload: { systemVersionId: v1Id, entityDefinitionId: "character", name: "X", idempotencyKey: "k" } },
      { method: "POST" as const, url: `/characters/${characterId}/fields/ability/set`, payload: { value: 1, expectedRevision: 1, idempotencyKey: "k" } },
      { method: "POST" as const, url: `/characters/${characterId}/resources/health/bump`, payload: { direction: "down", expectedRevision: 1, idempotencyKey: "k" } },
      { method: "POST" as const, url: `/characters/${characterId}/actions/check`, payload: { inputs: {}, expectedRevision: 1, idempotencyKey: "k" } },
      { method: "PATCH" as const, url: `/characters/${characterId}`, payload: { command: "archive", expectedRevision: 1, idempotencyKey: "k" } },
      { method: "POST" as const, url: `/characters/${characterId}/ownership-transfer`, payload: { toUserId: randomUUID(), expectedRevision: 1, idempotencyKey: "k" } },
      { method: "GET" as const, url: `/characters/${characterId}/activity` },
      { method: "POST" as const, url: `/characters/${characterId}/exports` },
      { method: "POST" as const, url: `/characters/${characterId}/migration-previews`, payload: { targetVersionId: randomUUID() } },
      { method: "POST" as const, url: `/characters/${characterId}/migrations/${randomUUID()}/commit`, payload: { expectedRevision: 1, idempotencyKey: "k" } },
      { method: "POST" as const, url: `/characters/${characterId}/migrations/${randomUUID()}/rollback`, payload: { idempotencyKey: "k" } },
    ];

    for (const route of routes) {
      const noCookie = await app.app.inject({
        method: route.method,
        url: route.url,
        ...(route.payload === undefined ? {} : { payload: route.payload }),
      });
      expect(noCookie.statusCode, `${route.method} ${route.url} (no cookie)`).toBe(401);
      expect(noCookie.json().error.code).toBe("unauthorized");

      const badCookie = await app.app.inject({
        method: route.method,
        url: route.url,
        headers: { cookie: "session=totally-bogus-token" },
        ...(route.payload === undefined ? {} : { payload: route.payload }),
      });
      expect(badCookie.statusCode, `${route.method} ${route.url} (bad cookie)`).toBe(401);
    }
  });

  it("keeps a transfered character reachable by the new owner and generic-404s (purge) the previous owner, while the transfer stays replayable", async () => {
    const app = await makeApp();
    apps.push(app);
    const ada = app.users.ada;
    const bob = app.users.bob;
    const { versionId: v1Id } = await publishVersion(app, ada, d20Document, {
      name: "D20 Transfer",
      semanticVersion: "1.0.0",
    });
    const created = await createCharacter(app, ada, {
      systemVersionId: v1Id,
      name: "Swap",
      idempotencyKey: "tr-c1",
    });
    const characterId = created.json().character.characterId as string;

    const transferred = await transferOwnership(app, ada, characterId, bob.actorId, 1, "tr-x1");
    expect(transferred.statusCode, transferred.body).toBe(200);
    expect(transferred.json().result.character).toMatchObject({ revision: 2, ownerId: bob.actorId });

    const asBob = await getCharacter(app, bob, characterId);
    expect(asBob.statusCode, asBob.body).toBe(200);
    expect(asBob.json().character.ownerId).toBe(bob.actorId);

    const asAda = await getCharacter(app, ada, characterId);
    expect(asAda.statusCode, asAda.body).toBe(404);
    expect(asAda.json().error).toMatchObject({ code: "not_found", cacheDisposition: "purge" });

    const asAdaCommand = await setField(app, ada, characterId, "ability", 17, 1, "tr-x2");
    expect(asAdaCommand.statusCode, asAdaCommand.body).toBe(404);
    expect(asAdaCommand.json().error).toMatchObject({ code: "not_found", cacheDisposition: "purge" });

    const replayTransfer = await transferOwnership(app, ada, characterId, bob.actorId, 1, "tr-x1");
    expect(replayTransfer.statusCode, replayTransfer.body).toBe(200);
    expect(replayTransfer.json().result.character.reconciliation.replayed).toBe(true);
    expect(replayTransfer.json().result.character.ownerId).toBe(bob.actorId);
  });

  it("rejects replay of a key whose 30-day replay window has expired instead of re-executing", async () => {
    const app = await makeApp();
    apps.push(app);
    const ada = app.users.ada;
    const { versionId: v1Id } = await publishVersion(app, ada, d20Document, {
      name: "D20 Expiry",
      semanticVersion: "1.0.0",
    });
    const created = await createCharacter(app, ada, {
      systemVersionId: v1Id,
      name: "Expiry",
      idempotencyKey: "ex-c1",
    });
    expect(created.statusCode, created.body).toBe(201);
    const characterId = created.json().character.characterId as string;

    const setUp = await setField(app, ada, characterId, "ability", 16, 1, "ex-s1");
    expect(setUp.statusCode, setUp.body).toBe(200);

    await app.pool.query(
      "UPDATE character_command_executions SET expires_at = now() - interval '1 second' WHERE actor_id = $1",
      [ada.actorId],
    );

    const expiredCreate = await createCharacter(app, ada, {
      systemVersionId: v1Id,
      name: "Expiry",
      idempotencyKey: "ex-c1",
    });
    expect(expiredCreate.statusCode, expiredCreate.body).toBe(409);
    expect(expiredCreate.json().error.code).toBe("conflict");
    expect(expiredCreate.json().error.message).toMatch(/replay/i);

    const expiredSet = await setField(app, ada, characterId, "ability", 16, 1, "ex-s1");
    expect(expiredSet.statusCode, expiredSet.body).toBe(409);
    expect(expiredSet.json().error.code).toBe("conflict");
    expect(expiredSet.json().error.message).toMatch(/replay/i);

    const charCount = await app.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM characters WHERE id = $1",
      [characterId],
    );
    expect(charCount.rows[0]!.n).toBe(1);
    const execCount = await app.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM character_command_executions WHERE actor_id = $1",
      [ada.actorId],
    );
    expect(execCount.rows[0]!.n).toBe(2);
  });

  it("serves all three reference systems through the same HTTP surface", async () => {
    const systems: Array<{
      name: string;
      document: SystemDocumentV1;
      fieldId: string;
      validValue: unknown;
      invalidValue: unknown;
      defaultValues: Record<string, unknown>;
      actionId: string;
      actionInputs: Record<string, unknown>;
      diceCount: number;
      resourceId: string;
    }> = [
      {
        name: "D20 All",
        document: d20Document,
        fieldId: "ability",
        validValue: 14,
        invalidValue: 25,
        defaultValues: { ability: 10, modifier: 0, proficient: false },
        actionId: "check",
        actionInputs: { bonus: 1 },
        diceCount: 1,
        dieSides: 20,
        resourceId: "health",
        bumpDirection: "down" as const,
      },
      {
        name: "PbtA All",
        document: pbta2d6Document,
        fieldId: "move_stat",
        validValue: 2,
        invalidValue: 5,
        defaultValues: { move_stat: 0, condition: false },
        actionId: "make_move",
        actionInputs: { forward: 1 },
        diceCount: 2,
        dieSides: 6,
        resourceId: "harm",
        bumpDirection: "up" as const,
      },
      {
        name: "D6 All",
        document: d6SuccessPoolDocument,
        fieldId: "attribute",
        validValue: 3,
        invalidValue: 9,
        defaultValues: { attribute: 1, skill: 1 },
        actionId: "test_pool",
        actionInputs: {},
        diceCount: 4,
        dieSides: 6,
        resourceId: "stress",
        bumpDirection: "up" as const,
      },
    ];

    for (const s of systems) {
      const app = await makeApp();
      apps.push(app);
      const ada = app.users.ada;
      const { versionId } = await publishVersion(app, ada, s.document, {
        name: s.name,
        semanticVersion: "1.0.0",
      });

      const created = await createCharacter(app, ada, {
        systemVersionId: versionId,
        name: `${s.name} C`,
        idempotencyKey: `al-${s.name}-c`,
      });
      expect(created.statusCode, created.body).toBe(201);
      const characterId = created.json().character.characterId as string;
      const defaults = created.json().character.state.values;
      for (const [key, value] of Object.entries(s.defaultValues)) {
        expect(defaults[key]).toEqual(value);
      }

      const valid = await setField(app, ada, characterId, s.fieldId, s.validValue, 1, `al-${s.name}-s`);
      expect(valid.statusCode, valid.body).toBe(200);
      expect(valid.json().result.character.state.values[s.fieldId]).toBe(s.validValue);
      expect(valid.json().result.character.revision).toBe(2);

      const invalid = await setField(app, ada, characterId, s.fieldId, s.invalidValue, 2, `al-${s.name}-bad`);
      expect(invalid.statusCode, invalid.body).toBe(422);
      expect(invalid.json().error.code).toBe("invalid_value");
      expect(valid.json().result.character.state.values[s.fieldId]).toBe(s.validValue);

      const b = await bumpResource(app, ada, characterId, s.resourceId, s.bumpDirection, 2, `al-${s.name}-b`);
      expect(b.statusCode, b.body).toBe(200);
      expect(b.json().result.character.revision).toBe(3);

      const roll = await executeAction(app, ada, characterId, s.actionId, s.actionInputs, 3, `al-${s.name}-a`);
      expect(roll.statusCode, roll.body).toBe(200);
      const dice = roll.json().result.roll.dice;
      expect(dice).toHaveLength(s.diceCount);
      for (const d of dice) expect(d.sides).toBe(s.dieSides);
    }
  });
});