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
import type { ObjectTemplateV1, SystemDocumentV1 } from "../../src/systems/implementation/package/schema/document.js";

// Design 6.7, plan stage 2: standalone character upgrade and revert.

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl === undefined ? describe.skip : describe;

type App = I3AppHandle & { cleanup: () => Promise<void> };
type User = I3Users[keyof I3Users];

const SWORD = "aaaaaaaa-1111-4111-8111-111111111111";
const SHIELD = "bbbbbbbb-2222-4222-8222-222222222222";

async function makeApp(): Promise<App> {
  const schema = `char_ver_${randomUUID().replaceAll("-", "")}`;
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

const headers = (user: User) => ({ cookie: user.cookie });

function longsword(bonusDefault: number, withWeight = true): ObjectTemplateV1 {
  return {
    id: "longsword",
    label: "Longsword",
    kind: "item",
    fields: [
      { kind: "integer", id: "weapon_bonus", label: "Bonus", default: bonusDefault, required: true, min: 0, max: 10, step: 1 },
      ...(withWeight
        ? [{ kind: "integer" as const, id: "weight", label: "Weight", default: 3, required: false, min: 0, max: 20, step: 1 }]
        : []),
    ],
    grantedActions: [],
  };
}

function document(options: { bonusDefault?: number; shield?: boolean; luck?: boolean; weight?: boolean } = {}): SystemDocumentV1 {
  const doc = structuredClone(d20Document) as SystemDocumentV1;
  doc.templates = [longsword(options.bonusDefault ?? 1, options.weight ?? true)];
  if (options.shield) doc.templates.push({ id: "shield", label: "Shield", kind: "item", fields: [], grantedActions: [] });
  doc.slots = [{ id: "inventory", label: "Inventory", accepts: ["item"] }];
  doc.sheets[0]!.sections[0]!.elements.push({ kind: "slot", id: "inventory_element", slotId: "inventory" });
  if (options.luck) {
    doc.entities[0]!.fields.push({ kind: "integer", id: "luck", label: "Luck", default: 5, required: false, min: 0, max: 10, step: 1 });
  }
  return doc;
}

async function createSystem(app: App, user: User): Promise<{ systemId: string; draftRevision: number }> {
  const create = await app.app.inject({
    method: "POST",
    url: "/systems",
    headers: headers(user),
    payload: { source: { kind: "blank", name: `Versioned ${randomUUID().slice(0, 8)}` }, idempotencyKey: randomUUID() },
  });
  expect(create.statusCode, create.body).toBe(201);
  return {
    systemId: create.json().workspace.system.systemId as string,
    draftRevision: (create.json().workspace.draft?.revision ?? 1) as number,
  };
}

async function publish(
  app: App,
  user: User,
  system: { systemId: string; draftRevision: number },
  doc: SystemDocumentV1,
  semanticVersion: string,
): Promise<string> {
  const save = await app.app.inject({
    method: "PUT",
    url: `/systems/${system.systemId}/draft`,
    headers: headers(user),
    payload: { expectedRevision: system.draftRevision, document: doc },
  });
  expect(save.statusCode, save.body).toBe(200);
  system.draftRevision = save.json().workspace.draft.revision as number;
  const published = await app.app.inject({
    method: "POST",
    url: `/systems/${system.systemId}/publish`,
    headers: headers(user),
    payload: {
      expectedRevision: system.draftRevision,
      semanticVersion,
      releaseNotes: `Release ${semanticVersion}`,
      idempotencyKey: randomUUID(),
      acknowledgeBreaking: true,
    },
  });
  expect(published.statusCode, published.body).toBe(200);
  const after = await app.app.inject({ method: "GET", url: `/systems/${system.systemId}`, headers: headers(user) });
  system.draftRevision = (after.json().workspace?.draft?.revision ?? system.draftRevision) as number;
  return published.json().version.versionId as string;
}

async function createCharacter(app: App, user: User, versionId: string) {
  const response = await app.app.inject({
    method: "POST",
    url: "/characters",
    headers: headers(user),
    payload: { systemVersionId: versionId, entityDefinitionId: "character", name: "Hero", idempotencyKey: randomUUID() },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json().character as { characterId: string; revision: number };
}

async function addEntry(app: App, user: User, characterId: string, revision: number, entryId: string, templateId: string) {
  const response = await app.app.inject({
    method: "POST",
    url: `/characters/${characterId}/entries`,
    headers: headers(user),
    payload: {
      entry: { entryId, slotId: "inventory", templateId, source: { kind: "system", templateId }, values: {} },
      expectedRevision: revision,
      idempotencyKey: randomUUID(),
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json().result.character.revision as number;
}

async function removeEntry(app: App, user: User, characterId: string, revision: number, entryId: string) {
  const response = await app.app.inject({
    method: "DELETE",
    url: `/characters/${characterId}/entries/${entryId}`,
    headers: headers(user),
    payload: { expectedRevision: revision, idempotencyKey: randomUUID() },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json().result.character.revision as number;
}

const options = (app: App, user: User, characterId: string) =>
  app.app.inject({ method: "GET", url: `/characters/${characterId}/version-options`, headers: headers(user) });
const check = (app: App, user: User, characterId: string, targetVersionId: string) =>
  app.app.inject({
    method: "GET",
    url: `/characters/${characterId}/version-check?targetVersionId=${targetVersionId}`,
    headers: headers(user),
  });
const change = (app: App, user: User, characterId: string, targetVersionId: string, expectedRevision: number, idempotencyKey = randomUUID()) =>
  app.app.inject({
    method: "POST",
    url: `/characters/${characterId}/version`,
    headers: headers(user),
    payload: { targetVersionId, expectedRevision, idempotencyKey },
  });

describeWithDatabase("character system version upgrade and revert", () => {
  it("upgrades with followed item stats, replays, then reverts after removing a newer item", async () => {
    const app = await makeApp();
    try {
      const { ada } = app.users;
      const system = await createSystem(app, ada);
      const v1 = await publish(app, ada, system, document(), "1.0.0");
      const created = await createCharacter(app, ada, v1);
      let revision = await addEntry(app, ada, created.characterId, created.revision, SWORD, "longsword");
      const v2 = await publish(app, ada, system, document({ bonusDefault: 2, shield: true, luck: true }), "1.1.0");

      const before = await options(app, ada, created.characterId);
      expect(before.statusCode, before.body).toBe(200);
      expect(before.json().options).toMatchObject({
        current: { versionId: v1, semanticVersion: "1.0.0" },
        revertTo: null,
        upgrades: [{ versionId: v2, semanticVersion: "1.1.0", releaseNotes: "Release 1.1.0" }],
      });

      const checked = await check(app, ada, created.characterId, v2);
      expect(checked.statusCode, checked.body).toBe(200);
      expect(checked.json().check).toMatchObject({
        revision,
        direction: "upgrade",
        report: {
          ok: true,
          blockers: [],
          addedFields: ["luck"],
          changedEntries: [{ entryId: SWORD, templateId: "longsword", updatedFields: ["weapon_bonus"], keptFields: [] }],
        },
      });
      expect(checked.json().check.report).not.toHaveProperty("nextState");

      const stale = await change(app, ada, created.characterId, v2, revision - 1);
      expect(stale.statusCode, stale.body).toBe(409);
      expect(stale.json().error.latestRevision).toBe(revision);

      const key = randomUUID();
      const upgraded = await change(app, ada, created.characterId, v2, revision, key);
      expect(upgraded.statusCode, upgraded.body).toBe(200);
      const character = upgraded.json().result.character;
      expect(character.systemVersionId).toBe(v2);
      expect(character.revision).toBe(revision + 1);
      expect(character.state.values.luck).toBe(5);
      expect(character.state.entries[SWORD].values).toEqual({ weapon_bonus: 2, weight: 3 });
      expect(character.reconciliation.cacheDisposition).toBe("replace");

      const replay = await change(app, ada, created.characterId, v2, revision, key);
      expect(replay.statusCode, replay.body).toBe(200);
      expect(replay.json().result.character.revision).toBe(revision + 1);
      expect(replay.json().result.character.reconciliation.replayed).toBe(true);
      revision += 1;

      const activity = await app.app.inject({
        method: "GET",
        url: `/characters/${created.characterId}/activity`,
        headers: headers(ada),
      });
      expect(activity.json().events[0]).toMatchObject({
        kind: "system_version_upgraded",
        payload: { fromVersionId: v1, toVersionId: v2, direction: "upgrade" },
      });

      const after = await options(app, ada, created.characterId);
      expect(after.json().options).toMatchObject({ current: { versionId: v2 }, revertTo: { versionId: v1 }, upgrades: [] });

      revision = await addEntry(app, ada, created.characterId, revision, SHIELD, "shield");
      const blockedCheck = await check(app, ada, created.characterId, v1);
      expect(blockedCheck.json().check).toMatchObject({
        direction: "revert",
        report: { ok: false, blockers: [{ code: "entry_template_missing", entryId: SHIELD }] },
      });
      const blocked = await change(app, ada, created.characterId, v1, revision);
      expect(blocked.statusCode, blocked.body).toBe(409);

      revision = await removeEntry(app, ada, created.characterId, revision, SHIELD);
      const reverted = await change(app, ada, created.characterId, v1, revision);
      expect(reverted.statusCode, reverted.body).toBe(200);
      const back = reverted.json().result.character;
      expect(back.systemVersionId).toBe(v1);
      expect(back.state.values).not.toHaveProperty("luck");
      expect(back.state.entries[SWORD].values).toEqual({ weapon_bonus: 1, weight: 3 });

      const final = await options(app, ada, created.characterId);
      expect(final.json().options).toMatchObject({ current: { versionId: v1 }, revertTo: null, upgrades: [{ versionId: v2 }] });
    } finally {
      await app.cleanup();
    }
  });

  it("blocks a breaking change only for the character it affects", async () => {
    const app = await makeApp();
    try {
      const { ada } = app.users;
      const system = await createSystem(app, ada);
      const v1 = await publish(app, ada, system, document(), "1.0.0");
      const armed = await createCharacter(app, ada, v1);
      const armedRevision = await addEntry(app, ada, armed.characterId, armed.revision, SWORD, "longsword");
      const unarmed = await createCharacter(app, ada, v1);
      const v2 = await publish(app, ada, system, document({ weight: false }), "2.0.0");

      const armedCheck = await check(app, ada, armed.characterId, v2);
      expect(armedCheck.json().check.report).toMatchObject({
        ok: false,
        blockers: [{ code: "breaking_change", definitionId: "/templates/longsword/fields/weight" }],
      });
      expect((await change(app, ada, armed.characterId, v2, armedRevision)).statusCode).toBe(409);

      const unarmedCheck = await check(app, ada, unarmed.characterId, v2);
      expect(unarmedCheck.json().check.report).toMatchObject({
        ok: true,
        packageFindings: [{ code: "template_field_removed", affectsCharacter: false }],
      });
      const moved = await change(app, ada, unarmed.characterId, v2, unarmed.revision);
      expect(moved.statusCode, moved.body).toBe(200);
      expect(moved.json().result.character.systemVersionId).toBe(v2);
    } finally {
      await app.cleanup();
    }
  });

  it("denies other users and rejects targets that are not later versions of the same system", async () => {
    const app = await makeApp();
    try {
      const { ada, bob } = app.users;
      const system = await createSystem(app, ada);
      const v1 = await publish(app, ada, system, document(), "1.0.0");
      const v2 = await publish(app, ada, system, document({ shield: true }), "1.1.0");
      const otherSystem = await createSystem(app, ada);
      const foreign = await publish(app, ada, otherSystem, document({ shield: true }), "9.0.0");
      const created = await createCharacter(app, ada, v2);

      expect((await options(app, bob, created.characterId)).statusCode).toBe(404);
      expect((await check(app, bob, created.characterId, v1)).statusCode).toBe(404);
      expect((await change(app, bob, created.characterId, v1, created.revision)).statusCode).toBe(404);

      // v1 is older and was never this character's previous version.
      expect((await check(app, ada, created.characterId, v1)).statusCode).toBe(404);
      expect((await change(app, ada, created.characterId, v1, created.revision)).statusCode).toBe(409);
      expect((await check(app, ada, created.characterId, foreign)).statusCode).toBe(404);
      expect((await check(app, ada, created.characterId, v2)).statusCode).toBe(422);
    } finally {
      await app.cleanup();
    }
  });
});
