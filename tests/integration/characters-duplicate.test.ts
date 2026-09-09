import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  buildI3App,
  createI3Pool,
  createI3Schema,
  dropI3Schema,
  type I3AppHandle,
  type I3Users,
} from "./i3-app.js";
import { d20Document } from "../../src/systems/implementation/package/fixtures/index.js";
import type { SystemDocumentV1 } from "../../src/systems/implementation/package/schema/document.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl === undefined ? describe.skip : describe;

type App = I3AppHandle;

async function makeApp(): Promise<App & { cleanup: () => Promise<void> }> {
  const schema = `char_dup_${randomUUID().replaceAll("-", "")}`;
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

async function publishD20(app: App, user: I3Users["ada"]): Promise<{ versionId: string }> {
  const document = structuredClone(d20Document) as SystemDocumentV1;
  const create = await app.app.inject({
    method: "POST",
    url: "/systems",
    headers: cookieHeader(user),
    payload: { source: { kind: "blank", name: "D20" }, idempotencyKey: `sys-${randomUUID()}` },
  });
  expect(create.statusCode, create.body).toBe(201);
  const systemId = create.json().workspace.system.systemId as string;
  const initialRevision = create.json().workspace.draft?.revision ?? 1;
  const save = await app.app.inject({
    method: "PUT",
    url: `/systems/${systemId}/draft`,
    headers: cookieHeader(user),
    payload: { expectedRevision: initialRevision, document },
  });
  expect(save.statusCode, save.body).toBe(200);
  const publish = await app.app.inject({
    method: "POST",
    url: `/systems/${systemId}/publish`,
    headers: cookieHeader(user),
    payload: {
      expectedRevision: save.json().workspace.draft.revision as number,
      semanticVersion: "1.0.0",
      releaseNotes: "",
      idempotencyKey: `pub-${randomUUID()}`,
      acknowledgeBreaking: true,
    },
  });
  expect(publish.statusCode, publish.body).toBe(200);
  return { versionId: publish.json().version.versionId as string };
}

async function createCharacter(
  app: App,
  user: I3Users[keyof I3Users],
  versionId: string,
  name: string,
) {
  const response = await app.app.inject({
    method: "POST",
    url: "/characters",
    headers: cookieHeader(user),
    payload: {
      systemVersionId: versionId,
      entityDefinitionId: "character",
      name,
      idempotencyKey: randomUUID(),
    },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json().character as { characterId: string; systemVersionId: string; state: unknown };
}

function duplicate(
  app: App,
  user: I3Users[keyof I3Users],
  characterId: string,
  idempotencyKey: string,
) {
  return app.app.inject({
    method: "POST",
    url: `/characters/${characterId}/duplicate`,
    headers: cookieHeader(user),
    payload: { idempotencyKey },
  });
}

describeWithDatabase("Character duplicate (POST /characters/:id/duplicate)", () => {
  it("owner duplicates a character: same version pin, copied state, new id", async () => {
    const app = await makeApp();
    try {
      const { versionId } = await publishD20(app, app.users.ada);
      const source = await createCharacter(app, app.users.ada, versionId, "Aria");

      const response = await duplicate(app, app.users.ada, source.characterId, randomUUID());
      expect(response.statusCode, response.body).toBe(201);
      const copy = response.json().character as {
        characterId: string;
        systemVersionId: string;
        state: unknown;
        revision: number;
      };
      expect(copy.characterId).not.toBe(source.characterId);
      expect(copy.systemVersionId).toBe(source.systemVersionId);
      expect(copy.systemVersionId).toBe(versionId);
      expect(copy.state).toEqual(source.state);
      expect(copy.revision).toBe(1);
      expect(typeof response.json().requestId).toBe("string");
    } finally {
      await app.cleanup();
    }
  });

  it("duplicate rejects archived source and foreign characters", async () => {
    const app = await makeApp();
    try {
      const { versionId } = await publishD20(app, app.users.ada);
      const source = await createCharacter(app, app.users.ada, versionId, "Aria");

      const archived = await app.app.inject({
        method: "PATCH",
        url: `/characters/${source.characterId}`,
        headers: cookieHeader(app.users.ada),
        payload: { command: "archive", expectedRevision: 1, idempotencyKey: randomUUID() },
      });
      expect(archived.statusCode, archived.body).toBe(200);

      const fromArchived = await duplicate(app, app.users.ada, source.characterId, randomUUID());
      expect(fromArchived.statusCode, fromArchived.body).toBe(409);

      // Foreign owner learns nothing about existence: generic 404.
      const foreign = await duplicate(app, app.users.bob, source.characterId, randomUUID());
      expect(foreign.statusCode, foreign.body).toBe(404);
    } finally {
      await app.cleanup();
    }
  });

  it("idempotent retry returns the same duplicate without a second row", async () => {
    const app = await makeApp();
    try {
      const { versionId } = await publishD20(app, app.users.ada);
      const source = await createCharacter(app, app.users.ada, versionId, "Aria");
      const key = randomUUID();

      const first = await duplicate(app, app.users.ada, source.characterId, key);
      expect(first.statusCode, first.body).toBe(201);
      const second = await duplicate(app, app.users.ada, source.characterId, key);
      expect(second.statusCode, second.body).toBe(201);
      expect(second.json().character.characterId).toBe(first.json().character.characterId);

      const count = await app.pool.query("SELECT count(*)::int AS count FROM characters");
      expect(count.rows[0]!.count).toBe(2);
    } finally {
      await app.cleanup();
    }
  });
});
