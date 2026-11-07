import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildPublicApi, publicApiPrefix } from "../../src/transport/http/public-api/index.js";
import { buildPersonalTokenRoutes } from "../../src/transport/http/personal-tokens.js";
import { DEFAULT_CAMPAIGN_LIMITS } from "../../src/platform/config.js";
import { createCampaignsModule } from "../../src/campaigns/index.js";
import { createCampaignPlacement } from "../../src/characters/campaignPlacement.js";
import { knaveDocument, knaveCharacter } from "./fixtures/knave.js";
import { d20Document } from "../../src/systems/implementation/package/fixtures/index.js";
import { buildI3App, createI3Pool, createI3Schema, dropI3Schema, type I3AppHandle } from "./i3-app.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("public API v1 with PostgreSQL", () => {
  const schema = `public_api_${randomUUID().replaceAll("-", "")}`;
  let handle: I3AppHandle;
  let pauseFieldEdit: (() => Promise<void>) | undefined;
  const scopes = ["systems:read", "systems:write", "characters:read", "characters:write"];

  beforeAll(async () => {
    await createI3Schema(databaseUrl!, schema);
    const pool = createI3Pool(databaseUrl!, schema);
    handle = await buildI3App({
      pool,
      allowPersonalTokens: true,
      wrapRuntime: (runtime) => ({
        ...runtime,
        async resolve(request) {
          if (request.intent.kind === "set") await pauseFieldEdit?.();
          return runtime.resolve(request);
        },
      }),
      extraRoutes: (modules) => [
        (app, _opts, done) => {
          void app.register(buildPublicApi({ ...modules, pool }), { prefix: publicApiPrefix });
          done();
        },
        buildPersonalTokenRoutes({ identity: modules.identity }),
      ],
    });
  });
  afterAll(async () => {
    await handle?.app.close();
    await handle?.pool.end();
    await dropI3Schema(databaseUrl!, schema);
  });

  async function issue(cookie: string, requested = scopes) {
    const response = await handle.app.inject({
      method: "POST", url: "/me/personal-tokens",
      headers: { cookie, origin: "http://localhost", host: "localhost" },
      payload: { label: "Script", scopes: requested, expiresInDays: 7 },
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json<{ token: string; id: string }>();
  }

  function call(token: string, method: "GET" | "POST" | "PUT", path: string, payload?: object) {
    return handle.app.inject({
      method, url: `/api/v1${path}`, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}),
    });
  }

  it("issues cookie-only tokens with origin checks and enforces scopes, expiry and revocation", async () => {
    const { app, pool, users: { ada, bob } } = handle;
    const rejected = await app.inject({
      method: "POST", url: "/me/personal-tokens",
      headers: { cookie: ada.cookie, origin: "https://other.example" },
      payload: { label: "Script", scopes, expiresInDays: 7 },
    });
    expect(rejected.statusCode).toBe(403);
    const { token, id } = await issue(ada.cookie, ["systems:read"]);
    const list = await app.inject({ url: "/me/personal-tokens", headers: { cookie: ada.cookie } });
    expect(list.json()).toMatchObject({ enabled: true, tokens: [{ id, label: "Script" }] });
    expect(list.body).not.toContain(token);
    expect((await app.inject({ url: "/me/personal-tokens", headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(401);
    expect((await call(token, "GET", "/systems")).statusCode).toBe(200);
    expect((await call(token, "POST", "/systems", { name: "Denied", idempotencyKey: "x" })).statusCode).toBe(403);
    expect((await call(token + "x", "GET", "/systems")).statusCode).toBe(401);
    expect((await app.inject({
      method: "DELETE", url: `/me/personal-tokens/${id}`, headers: { cookie: bob.cookie, origin: "http://localhost", host: "localhost" },
    })).statusCode).toBe(404);
    expect((await app.inject({
      method: "DELETE", url: `/me/personal-tokens/${id}`, headers: { cookie: ada.cookie, origin: "http://localhost", host: "localhost" },
    })).statusCode).toBe(204);
    expect((await call(token, "GET", "/systems")).statusCode).toBe(401);
    const expired = await issue(ada.cookie);
    await pool.query("UPDATE personal_access_tokens SET expires_at = now() WHERE id = $1", [expired.id]);
    expect((await call(expired.token, "GET", "/systems")).statusCode).toBe(401);
  });

  it("shares validation quotas across tokens owned by the same account", async () => {
    const { users: { ada, bob }, pool } = handle;
    const first = (await issue(ada.cookie)).token;
    const second = (await issue(ada.cookie)).token;
    const other = (await issue(bob.cookie)).token;
    const { rows: [{ window_at }] } = await pool.query("SELECT date_trunc('minute', now()) AS window_at");
    await pool.query("INSERT INTO public_api_rate_limits VALUES ($1, 'validate', $2, 11)", [ada.actorId, window_at]);
    try {
      expect((await call(first, "POST", "/systems/validate", { document: {} })).statusCode).toBe(200);
      const limited = await call(second, "POST", "/systems/validate", { document: {} });
      expect(limited.statusCode).toBe(429);
      expect(limited.headers["retry-after"]).toBe("60");
      expect((await call(second, "GET", "/systems")).statusCode).toBe(200);
      expect((await call(other, "POST", "/systems/validate", { document: {} })).statusCode).toBe(200);
    } finally {
      await pool.query("DELETE FROM public_api_rate_limits");
    }
  });

  it("validates without writes, publishes exact revisions and creates and edits pinned standalone sheets", async () => {
    const { users: { ada, bob }, pool, authoring } = handle;
    const { token } = await issue(ada.cookie);
    const other = (await issue(bob.cookie)).token;
    const document = structuredClone(d20Document);
    const invalid = { ...document, entities: [{ ...document.entities[0], id: "INVALID" }] };
    const assessed = await call(token, "POST", "/systems/validate", { document: invalid });
    expect(assessed.statusCode, assessed.body).toBe(200);
    expect(assessed.json()).toMatchObject({ valid: false, diagnostics: expect.arrayContaining([
      expect.objectContaining({ code: "invalid_definition_id", severity: "error", path: "/entities/0/id" }),
    ]) });
    expect((await pool.query("SELECT id FROM systems WHERE owner_id = $1", [ada.actorId])).rowCount).toBe(0);
    expect((await pool.query("SELECT id FROM preview_snapshots")).rowCount).toBe(0);
    expect((await call(token, "POST", "/systems/validate", { document })).json()).toMatchObject({ valid: true });

    const badExpression = structuredClone(document);
    badExpression.expressions[0]!.source = "fields.undefined_field";
    expect((await call(token, "POST", "/systems/validate", { document: badExpression })).json()).toMatchObject({
      valid: false,
      diagnostics: expect.arrayContaining([expect.objectContaining({ path: "/expressions/0/source" })]),
    });

    const creation = { name: "Scripted system", idempotencyKey: "create-system" };
    const [first, replay] = await Promise.all([
      call(token, "POST", "/systems", creation), call(token, "POST", "/systems", creation),
    ]);
    expect(first.statusCode, first.body).toBe(201);
    expect(replay.json()).toEqual(first.json());
    const { system: { systemId }, draft } = first.json();
    expect((await call(token, "POST", "/systems", { ...creation, name: "Different" })).json().error.code).toBe("idempotency_mismatch");
    expect((await call(other, "GET", `/systems/${systemId}`)).statusCode).toBe(404);
    const saved = await call(token, "PUT", `/systems/${systemId}/draft`, { expectedRevision: draft.revision, document });
    expect(saved.statusCode, saved.body).toBe(200);
    expect((await call(token, "PUT", `/systems/${systemId}/draft`, { expectedRevision: draft.revision, document })).json())
      .toMatchObject({ error: { code: "stale_revision", latestRevision: saved.json().draft.revision } });

    const publish = { expectedRevision: saved.json().draft.revision, idempotencyKey: "publish-1", semanticVersion: "1.0.0" };
    expect((await call(token, "POST", `/systems/${systemId}/publish`, { ...publish, expectedRevision: draft.revision })).json().error.code).toBe("stale_revision");
    const versions = await Promise.all([
      call(token, "POST", `/systems/${systemId}/publish`, publish),
      call(token, "POST", `/systems/${systemId}/publish`, publish),
    ]);
    expect(versions[0].statusCode, versions[0].body).toBe(201);
    expect(versions[1].json()).toEqual(versions[0].json());
    const { versionId } = versions[0].json();
    const optionPath = `/characters/creation-options?systemVersionId=${versionId}`;
    expect((await call(other, "GET", optionPath)).statusCode).toBe(404);
    const options = await call(token, "GET", optionPath);
    expect(options.statusCode, options.body).toBe(200);
    const entity = options.json().entities[0];
    const field = entity.fields.find((candidate: { kind: string }) => candidate.kind === "integer");
    expect(field).toMatchObject({ id: expect.any(String), default: expect.any(Number), min: expect.any(Number) });
    const create = { name: "Scripted hero", systemVersionId: versionId, entityDefinitionId: entity.id, idempotencyKey: "create-character" };
    const invalidValues = await call(token, "POST", "/characters", { ...create, initialValues: { [field.id]: "12" } });
    expect(invalidValues.statusCode).toBe(422);
    expect(invalidValues.json().error.diagnostics).toEqual([
      expect.objectContaining({ path: `/initialValues/${field.id}`, code: "invalid_value" }),
    ]);
    const responses = await Promise.all(Array.from({ length: 2 }, () =>
      call(token, "POST", "/characters", { ...create, initialValues: { [field.id]: 12 } })));
    const [created, retried] = responses;
    expect(created!.statusCode, created!.body).toBe(201);
    expect(retried!.json()).toEqual(created!.json());
    const { characterId, revision } = created!.json();
    const path = `/characters/${characterId}`;
    const sheet = await call(token, "GET", path);
    expect(sheet.json()).toMatchObject({ characterId, systemVersionId: versionId, revision, values: { [field.id]: 12 } });
    expect(sheet.json()).not.toHaveProperty("reconciliation");
    expect(sheet.json()).not.toHaveProperty("campaignId");
    expect((await call(other, "GET", path)).statusCode).toBe(404);

    const fieldPath = `${path}/fields/${field.id}/set`;
    const edit = { value: 14, expectedRevision: revision, idempotencyKey: "edit" };
    const edited = await call(token, "POST", fieldPath, edit);
    expect(edited.statusCode, edited.body).toBe(200);
    expect((await call(token, "POST", fieldPath, edit)).json()).toEqual(edited.json());
    expect((await call(token, "POST", fieldPath, { ...edit, value: 15 })).json().error.code).toBe("idempotency_mismatch");
    expect((await call(token, "POST", fieldPath, { ...edit, idempotencyKey: "stale" })).json()).toMatchObject({
      error: { code: "stale_revision", latestRevision: edited.json().revision },
    });

    const context = { actorId: ada.actorId, requestId: randomUUID() };
    await authoring.changeSharing(context, { systemId, access: "link" });
    expect((await call(other, "GET", optionPath)).statusCode).toBe(200);
    expect((await call(other, "GET", "/characters/creation-versions")).json().versions).toEqual([]);
    await authoring.changeSharing(context, { systemId, access: "public" });
    expect((await call(other, "GET", "/characters/creation-versions")).json().versions).toEqual([
      expect.objectContaining({ versionId }),
    ]);

    document.metadata.description = "Updated system";
    const next = await call(token, "PUT", `/systems/${systemId}/draft`, { expectedRevision: publish.expectedRevision, document });
    const published = await call(token, "POST", `/systems/${systemId}/publish`, {
      expectedRevision: next.json().draft.revision, semanticVersion: "1.0.1", idempotencyKey: "publish-2",
    });
    expect(published.statusCode, published.body).toBe(201);
    expect(published.json().versionId).not.toBe(versionId);
    expect((await call(token, "GET", path)).json().systemVersionId).toBe(versionId);

    const second = await call(token, "POST", "/characters", { ...create, idempotencyKey: "page-second" });
    expect(second.statusCode, second.body).toBe(201);
    const secondId = second.json().characterId;
    await pool.query("UPDATE characters SET updated_at = '2026-11-07T08:00:00.123999Z' WHERE id = $1", [secondId]);
    await pool.query("UPDATE characters SET updated_at = '2026-11-07T08:00:00.123001Z' WHERE id = $1", [characterId]);
    const firstPage = (await call(token, "GET", "/characters?limit=1")).json();
    expect(firstPage.characters.map((character: { characterId: string }) => character.characterId)).toEqual([secondId]);
    const nextPage = await call(token, "GET", `/characters?limit=1&cursor=${firstPage.nextCursor}`);
    expect(nextPage.json().characters.map((character: { characterId: string }) => character.characterId)).toEqual([characterId]);
    const malformed = Buffer.from(JSON.stringify({ updatedAt: "2026-11-07", characterId: "invalid" })).toString("base64url");
    expect((await call(token, "GET", `/characters?cursor=${malformed}`)).statusCode).toBe(400);

    const campaigns = createCampaignsModule({
      pool,
      limits: DEFAULT_CAMPAIGN_LIMITS,
      charactersPlacement: createCampaignPlacement({ pool, runtime: handle.runtime }),
    });
    const campaign = await campaigns.create(context, {
      systemVersionId: versionId, title: "Adoption race", description: "", idempotencyKey: "campaign",
    });
    expect(campaign.ok).toBe(true);
    if (!campaign.ok) throw new Error("Campaign fixture failed.");
    let resume!: () => void;
    let started!: () => void;
    const blocked = new Promise<void>((resolve) => { resume = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    pauseFieldEdit = async () => { started(); await blocked; };
    const racing = call(token, "POST", fieldPath, {
      ...edit, expectedRevision: edited.json().revision, value: 16, idempotencyKey: "placement-race",
    });
    try {
      await Promise.race([entered, racing.then((response) => {
        throw new Error(`The edit returned before the placement barrier: ${response.statusCode}`);
      })]);
      const adopted = await campaigns.adoptCampaignCharacter(context, {
        campaignId: campaign.value.campaignId,
        expectedCampaignRevision: campaign.value.revision,
        characterId,
        expectedCharacterRevision: edited.json().revision,
        acknowledgedDisclosure: true,
        idempotencyKey: "adopt",
      });
      expect(adopted.ok).toBe(true);
    } finally {
      pauseFieldEdit = undefined;
      resume();
    }
    expect((await racing).statusCode).toBe(404);
    expect((await call(token, "GET", path)).statusCode).toBe(404);
    expect((await call(token, "POST", fieldPath, edit)).statusCode).toBe(404);
    expect((await call(token, "POST", "/characters", { ...create, initialValues: { [field.id]: 12 } })).statusCode).toBe(404);
    expect((await call(token, "GET", "/characters")).json().characters.map(
      (character: { characterId: string }) => character.characterId,
    )).toEqual([secondId]);
    const browserSheet = await handle.app.inject({ url: path, headers: { cookie: ada.cookie } });
    expect(browserSheet.statusCode).toBe(200);
    expect(browserSheet.json().character.state.values[field.id]).toBe(14);

  });

  it("authors Knave 1e and creates a playable character through API v1", async () => {
    const { token } = await issue(handle.users.bob.cookie);
    const assessment = await call(token, "POST", "/systems/validate", { document: knaveDocument });
    expect(assessment.statusCode, assessment.body).toBe(200);
    expect(assessment.json()).toEqual({ valid: true, diagnostics: [] });

    const created = await call(token, "POST", "/systems", {
      name: knaveDocument.metadata.name,
      idempotencyKey: "knave-create-system",
    });
    expect(created.statusCode, created.body).toBe(201);
    const { system: { systemId }, draft: blank } = created.json();

    const saved = await call(token, "PUT", `/systems/${systemId}/draft`, {
      expectedRevision: blank.revision,
      document: knaveDocument,
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const { draft } = saved.json();
    expect(draft.document).toEqual(knaveDocument);

    const published = await call(token, "POST", `/systems/${systemId}/publish`, {
      expectedRevision: draft.revision,
      semanticVersion: "1.0.0",
      idempotencyKey: "knave-publish",
    });
    expect(published.statusCode, published.body).toBe(201);
    const { versionId } = published.json();

    const versions = await call(token, "GET", `/characters/creation-versions?systemId=${systemId}`);
    expect(versions.statusCode, versions.body).toBe(200);
    expect(versions.json().versions).toEqual([expect.objectContaining({ versionId, systemId })]);
    const options = await call(token, "GET", `/characters/creation-options?systemVersionId=${versionId}`);
    expect(options.statusCode, options.body).toBe(200);
    const [entity] = options.json().entities;
    expect(entity).toMatchObject({ id: "knave", kind: "playable" });
    expect(entity.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "constitution", kind: "integer", min: 1, max: 10 }),
      expect.objectContaining({ id: "hp", kind: "resource" }),
    ]));
    expect(entity.fields.map((field: { id: string }) => field.id)).not.toContain("item_capacity");

    const character = await call(token, "POST", "/characters", {
      ...knaveCharacter,
      systemVersionId: versionId,
      entityDefinitionId: entity.id,
      idempotencyKey: "knave-create-character",
    });
    expect(character.statusCode, character.body).toBe(201);
    const { characterId, revision } = character.json();

    const sheet = await call(token, "GET", `/characters/${characterId}`);
    expect(sheet.statusCode, sheet.body).toBe(200);
    expect(sheet.json()).toMatchObject({
      characterId,
      systemVersionId: versionId,
      entityDefinitionId: "knave",
      name: "Mara Flint",
      revision,
      values: knaveCharacter.initialValues,
      derivedValues: {
        strength_defense: 12, dexterity_defense: 11, constitution_defense: 13,
        intelligence_defense: 11, wisdom_defense: 12, charisma_defense: 11,
        armor_defense: 13, item_capacity: 13,
      },
      validations: [],
    });
  });

});
