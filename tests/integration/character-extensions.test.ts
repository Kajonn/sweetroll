import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { derivedTemplateDocument } from "../../src/systems/implementation/package/fixtures/campaign-derived.js";
import type { ExtensionDocumentV1 } from "../../src/systems/implementation/package/schema/index.js";
import { compileDocument } from "../../src/systems/implementation/rules/compile-document.js";
import {
  buildI3App,
  createI3Pool,
  createI3Schema,
  dropI3Schema,
  type I3AppHandle,
} from "./i3-app.js";

// System extensions, stage E3: characters built on a system version plus
// extension versions (design 6.8; plan 2026-11-07-system-extensions).

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl === undefined ? describe.skip : describe;

type User = { actorId: string; cookie: string };

/** Reuses the base template ID "sword" on purpose (decision X5). */
function frostPack(bonus = 5): ExtensionDocumentV1 {
  return {
    schemaVersion: "2.0",
    metadata: { name: "Frost pack", description: "", language: "en" },
    expressions: [
      { id: "sword_hit_expr", context: "roll", resultType: "number", source: `d20 + fields.modifier + fields.edge + ${bonus}`, fallback: 0 },
      { id: "frost_pool_expr", context: "roll", resultType: "number", source: 'countSuccesses(group("attribute", "Attribute", dice(fields.ability, 6)), 6)', fallback: 0 },
    ],
    templates: [{
      id: "sword",
      kind: "item",
      label: "Frost sword",
      fields: [{ id: "edge", kind: "integer", label: "Edge", default: 3, required: true, min: 0, max: 10, step: 1 }],
      grantedActions: [
        { id: "sword_hit", kind: "roll", label: "Frost hit", expressionId: "sword_hit_expr", inputs: [], outputTemplate: "Frost {total}" },
        {
          id: "frost_pool", kind: "roll", label: "Pool", expressionId: "frost_pool_expr", inputs: [], outputTemplate: "Pool {total}",
          pushPolicy: { version: "1.0", maxAttempts: 2, successThreshold: 99, allowOnSuccess: true, groups: [{ groupId: "attribute", lockedFaces: [], reportedFaces: [1] }] },
        },
      ],
    }],
  };
}

describeWithDatabase("Characters built with extensions (E3)", () => {
  const schema = `character_extensions_${randomUUID().replaceAll("-", "")}`;
  let handle: I3AppHandle;
  let ada: User;
  let bob: User;
  let base: { systemId: string; versionId: string };

  beforeAll(async () => {
    await createI3Schema(databaseUrl!, schema);
    handle = await buildI3App({ pool: createI3Pool(databaseUrl!, schema) });
    ada = handle.users.ada;
    bob = handle.users.bob;
    base = await baseSystem();
  });

  afterAll(async () => {
    await handle?.app.close();
    await handle?.pool.end();
    await dropI3Schema(databaseUrl!, schema);
  });

  async function call(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, user: User = ada, payload?: object) {
    return handle.app.inject({ method, url, headers: { cookie: user.cookie }, ...(payload === undefined ? {} : { payload }) });
  }

  async function baseSystem() {
    const systemId = (await handle.pool.query<{ id: string }>(
      "INSERT INTO systems (owner_id, name, access) VALUES ($1, 'Base', 'public') RETURNING id",
      [handle.users.ada.actorId],
    )).rows[0]!.id;
    const compiled = compileDocument(derivedTemplateDocument(), { systemId, versionId: randomUUID(), semanticVersion: "1.0.0" });
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
    await handle.pool.query(
      "INSERT INTO system_versions (id, system_id, semantic_version, checksum, package_json) VALUES ($1, $2, '1.0.0', $3, $4::jsonb)",
      [compiled.value.versionId, systemId, compiled.value.integrity.checksum, JSON.stringify(compiled.value)],
    );
    return { systemId, versionId: compiled.value.versionId };
  }

  /** Ada publishes an extension of the base system and shares it as `access`. */
  async function publishedExtension(access: "private" | "link" | "public" = "link", systemId = base.systemId, versionId = base.versionId) {
    const created = await call("POST", `/systems/${systemId}/extensions`, ada, { baseVersionId: versionId, name: "Frost pack", idempotencyKey: randomUUID() });
    expect(created.statusCode, created.body).toBe(201);
    const extensionId = created.json().workspace.extension.extensionId as string;
    expect((await call("PUT", `/extensions/${extensionId}/draft`, ada, { expectedRevision: 1, document: frostPack() })).statusCode).toBe(200);
    const published = await call("POST", `/extensions/${extensionId}/publish`, ada, {
      expectedRevision: 2, semanticVersion: "1.0.0", releaseNotes: "", acknowledgeBreaking: false, idempotencyKey: randomUUID(),
    });
    expect(published.statusCode, published.body).toBe(200);
    if (access !== "private") expect((await call("PATCH", `/systems/${extensionId}`, ada, { access })).statusCode).toBe(200);
    return { extensionId, versionId: published.json().version.versionId as string };
  }

  async function createCharacter(user: User, extensions: Array<{ extensionId: string; versionId: string }>, key = randomUUID()) {
    return call("POST", "/characters", user, {
      systemVersionId: base.versionId, entityDefinitionId: "character", name: "Frost hero", extensions, idempotencyKey: key,
    });
  }

  async function addEntry(user: User, characterId: string, revision: number, entry: object) {
    return call("POST", `/characters/${characterId}/entries`, user, { entry, expectedRevision: revision, idempotencyKey: randomUUID() });
  }

  it("creates, places, rolls, pushes, replays, exports and duplicates with an extension", async () => {
    const extension = await publishedExtension();
    const refs = [{ extensionId: extension.extensionId, versionId: extension.versionId }];
    const key = randomUUID();
    const created = await createCharacter(bob, refs, key);
    expect(created.statusCode, created.body).toBe(201);
    const character = created.json().character;
    expect(character.extensions).toEqual(refs);
    expect((await createCharacter(bob, refs, key)).json().character.characterId).toBe(character.characterId);
    expect((await createCharacter(bob, [], key)).statusCode).toBe(409);

    // The item picker lists the base and extension "sword" separately.
    const templates = (await call("GET", `/characters/${character.characterId}/templates`, bob)).json().templates;
    expect(templates.filter((template: { id: string }) => template.id === "sword")
      .map((template: { label: string; extensionId?: string; source?: unknown }) => [template.label, template.extensionId ?? null, template.source ?? null]))
      .toEqual([
        ["Longsword", null, null],
        ["Frost sword", extension.extensionId, { kind: "system", templateId: "sword", extensionId: extension.extensionId }],
      ]);

    const baseEntry = randomUUID();
    const frostEntry = randomUUID();
    const placedBase = await addEntry(bob, character.characterId, 1, { entryId: baseEntry, slotId: "inventory", templateId: "sword", values: {} });
    expect(placedBase.statusCode, placedBase.body).toBe(200);
    const placed = await addEntry(bob, character.characterId, 2, {
      entryId: frostEntry, slotId: "inventory", templateId: "sword", extensionId: extension.extensionId,
      source: { kind: "system", templateId: "sword", extensionId: extension.extensionId }, values: {},
    });
    expect(placed.statusCode, placed.body).toBe(200);
    const sheet = placed.json().result.character;
    expect(sheet.state.entries[frostEntry]).toMatchObject({ templateId: "sword", extensionId: extension.extensionId, values: { edge: 3 } });
    const slot = sheet.projection.sheets.flatMap((s: { sections: Array<{ elements: unknown[] }> }) => s.sections.flatMap((section) => section.elements))
      .find((element: { kind: string }) => element.kind === "slot");
    expect(slot.entries.map((entry: { label: string; extensionId?: string }) => [entry.label, entry.extensionId ?? null]).sort())
      .toEqual([["Frost sword", extension.extensionId], ["Longsword", null]]);

    // Extension templates need an extension that is part of the character.
    const foreign = await addEntry(bob, character.characterId, 3, { entryId: randomUUID(), slotId: "inventory", templateId: "sword", extensionId: randomUUID(), values: {} });
    expect(foreign.statusCode).toBe(422);

    const rollKey = randomUUID();
    const hit = await call("POST", `/characters/${character.characterId}/actions/sword_hit`, bob, { entryId: frostEntry, expectedRevision: 3, idempotencyKey: rollKey });
    expect(hit.statusCode, hit.body).toBe(200);
    const roll = hit.json().result.roll;
    expect(roll.output).toMatch(/^Frost \d+$/);
    const replayed = await call("POST", `/characters/${character.characterId}/actions/sword_hit`, bob, { entryId: frostEntry, expectedRevision: 3, idempotencyKey: rollKey });
    expect(replayed.json().result.roll).toEqual(roll);
    const old = await call("POST", `/characters/${character.characterId}/actions/sword_hit`, bob, { entryId: baseEntry, expectedRevision: 3, idempotencyKey: randomUUID() });
    expect(old.json().result.roll.output).toMatch(/^Hit \d+$/);

    const pool = await call("POST", `/characters/${character.characterId}/actions/frost_pool`, bob, { entryId: frostEntry, expectedRevision: 3, idempotencyKey: randomUUID() });
    expect(pool.statusCode, pool.body).toBe(200);
    const rootRoll = pool.json().result.roll;
    const pushed = await call("POST", `/characters/${character.characterId}/rolls/${rootRoll.push.rollId}/push`, bob, { expectedRevision: 3, idempotencyKey: randomUUID() });
    expect(pushed.statusCode, pushed.body).toBe(200);
    expect(pushed.json().result.roll.push.parentRollId).toBe(rootRoll.push.rollId);

    const exported = await call("POST", `/characters/${character.characterId}/exports`, bob, {});
    expect(exported.statusCode, exported.body).toBe(200);
    expect(exported.json()).toMatchObject({ extensions: refs, systemVersionId: base.versionId });
    expect(JSON.stringify(exported.json())).not.toContain("frost_pool_expr");

    const copy = await call("POST", `/characters/${character.characterId}/duplicate`, bob, { expectedRevision: 3, name: "Twin", idempotencyKey: randomUUID() });
    expect(copy.statusCode, copy.body).toBe(201);
    expect(copy.json().character).toMatchObject({ extensions: refs });

    // Rules version changes and campaign adoption wait for E5/E4.
    expect((await call("GET", `/characters/${character.characterId}/version-check?targetVersionId=${base.versionId}`, bob)).statusCode).toBe(409);
  });

  it("authorizes each extension and keeps existing characters working after sharing is revoked", async () => {
    const privateExtension = await publishedExtension("private");
    expect((await createCharacter(bob, [privateExtension])).statusCode).toBe(404);
    expect((await createCharacter(ada, [privateExtension])).statusCode).toBe(201);

    const shared = await publishedExtension("link");
    const created = await createCharacter(bob, [shared]);
    expect(created.statusCode).toBe(201);
    const characterId = created.json().character.characterId as string;
    const entryId = randomUUID();
    expect((await addEntry(bob, characterId, 1, { entryId, slotId: "inventory", templateId: "sword", extensionId: shared.extensionId, values: {} })).statusCode).toBe(200);

    expect((await call("PATCH", `/systems/${shared.extensionId}`, ada, { access: "private" })).statusCode).toBe(200);
    expect((await createCharacter(bob, [shared])).statusCode).toBe(404);
    const opened = await call("GET", `/characters/${characterId}`, bob);
    expect(opened.statusCode).toBe(200);
    const rolled = await call("POST", `/characters/${characterId}/actions/sword_hit`, bob, { entryId, expectedRevision: 2, idempotencyKey: randomUUID() });
    expect(rolled.statusCode, rolled.body).toBe(200);
  });

  it("rejects duplicate, foreign, unknown and mismatched extension references", async () => {
    const first = await publishedExtension("link");
    const later = await call("PUT", `/extensions/${first.extensionId}/draft`, ada, { expectedRevision: 2, document: frostPack(6) });
    expect(later.statusCode, later.body).toBe(200);
    const second = await call("POST", `/extensions/${first.extensionId}/publish`, ada, {
      expectedRevision: 3, semanticVersion: "1.1.0", releaseNotes: "", acknowledgeBreaking: false, idempotencyKey: randomUUID(),
    });
    expect(second.statusCode, second.body).toBe(200);
    const twice = await createCharacter(bob, [first, { extensionId: first.extensionId, versionId: second.json().version.versionId }]);
    expect(twice.statusCode).toBe(400);

    const otherBase = await baseSystem();
    const foreign = await publishedExtension("link", otherBase.systemId, otherBase.versionId);
    expect((await createCharacter(bob, [foreign])).statusCode).toBe(404);
    expect((await createCharacter(bob, [{ extensionId: first.extensionId, versionId: randomUUID() }])).statusCode).toBe(404);
    expect((await createCharacter(bob, [{ extensionId: foreign.extensionId, versionId: first.versionId }])).statusCode).toBe(404);
    // A system version is not an extension version.
    expect((await createCharacter(bob, [{ extensionId: first.extensionId, versionId: base.versionId }])).statusCode).toBe(404);

    const used = await createCharacter(bob, [first]);
    expect(used.statusCode).toBe(201);
    expect((await call("DELETE", `/systems/${first.extensionId}`)).statusCode).toBe(409);
  });
});
