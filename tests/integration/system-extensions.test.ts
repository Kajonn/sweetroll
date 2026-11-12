import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { decodeExtensionPackage } from "../../src/systems/implementation/package/extension.js";
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

// System extensions, stage E2 (design 6.8; plan 2026-11-07-system-extensions).

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl === undefined ? describe.skip : describe;

function frostPack(): ExtensionDocumentV1 {
  return {
    schemaVersion: "2.0",
    metadata: { name: "Frost pack", description: "Cold weapons", language: "en" },
    expressions: [
      { id: "axe_hit_expr", context: "roll", resultType: "number", source: "d20 + fields.modifier + item.edge", fallback: 0 },
    ],
    templates: [{
      id: "frost_axe",
      kind: "item",
      label: "Frost axe",
      fields: [{ id: "edge", kind: "integer", label: "Edge", default: 2, required: true, min: 0, max: 10, step: 1 }],
      grantedActions: [{ id: "axe_hit", kind: "roll", label: "Hit", expressionId: "axe_hit_expr", inputs: [], outputTemplate: "Hit {total}" }],
    }],
  };
}

describeWithDatabase("System extensions authoring (E2)", () => {
  const schema = `system_extensions_${randomUUID().replaceAll("-", "")}`;
  let handle: I3AppHandle;
  let mediaRoot: string;
  let ada: { actorId: string; cookie: string };
  let bob: { actorId: string; cookie: string };

  beforeAll(async () => {
    mediaRoot = await mkdtemp(join(tmpdir(), "sweetroll-extension-art-"));
    process.env.SWEETROLL_MEDIA_DIR = mediaRoot;
    await createI3Schema(databaseUrl!, schema);
    handle = await buildI3App({ pool: createI3Pool(databaseUrl!, schema) });
    ada = handle.users.ada;
    bob = handle.users.bob;
  });

  afterAll(async () => {
    await handle?.app.close();
    await handle?.pool.end();
    await dropI3Schema(databaseUrl!, schema);
    delete process.env.SWEETROLL_MEDIA_DIR;
    await rm(mediaRoot, { recursive: true, force: true });
  });

  async function call(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, user = ada, payload?: object) {
    return handle.app.inject({ method, url, headers: { cookie: user.cookie }, ...(payload === undefined ? {} : { payload }) });
  }

  /** A published base system with an item slot, owned by `owner`. */
  async function baseSystem(owner = ada, access = "private", mutate?: (document: ReturnType<typeof derivedTemplateDocument>) => void) {
    const systemId = (await handle.pool.query<{ id: string }>(
      "INSERT INTO systems (owner_id, name, access) VALUES ($1, 'Base', $2) RETURNING id",
      [owner.actorId, access],
    )).rows[0]!.id;
    const addVersion = async (semanticVersion: string, change?: typeof mutate) => {
      const document = derivedTemplateDocument();
      change?.(document);
      const compiled = compileDocument(document, { systemId, versionId: randomUUID(), semanticVersion });
      if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
      await handle.pool.query(
        "INSERT INTO system_versions (id, system_id, semantic_version, checksum, package_json) VALUES ($1, $2, $3, $4, $5::jsonb)",
        [compiled.value.versionId, systemId, semanticVersion, compiled.value.integrity.checksum, JSON.stringify(compiled.value)],
      );
      return compiled.value.versionId;
    };
    const versionId = await addVersion("1.0.0", mutate);
    return { systemId, versionId, addVersion };
  }

  async function createExtension(systemId: string, baseVersionId: string, user = ada, name = "Frost pack") {
    const response = await call("POST", `/systems/${systemId}/extensions`, user, { baseVersionId, name, idempotencyKey: randomUUID() });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().workspace;
  }

  async function saveDraft(extensionId: string, revision: number, document: unknown, baseVersionId?: string) {
    return call("PUT", `/extensions/${extensionId}/draft`, ada, {
      expectedRevision: revision,
      document,
      ...(baseVersionId === undefined ? {} : { baseVersionId }),
    });
  }

  async function publish(extensionId: string, revision: number, semanticVersion: string, extra: object = {}) {
    return call("POST", `/extensions/${extensionId}/publish`, ada, {
      expectedRevision: revision,
      semanticVersion,
      releaseNotes: "",
      acknowledgeBreaking: false,
      idempotencyKey: randomUUID(),
      ...extra,
    });
  }

  it("creates, drafts, previews and publishes an immutable extension version", async () => {
    const base = await baseSystem();
    const workspace = await createExtension(base.systemId, base.versionId);
    expect(workspace).toMatchObject({
      extension: { baseSystemId: base.systemId, name: "Frost pack", access: "private", lifecycle: "active", owned: true },
      draft: { revision: 1, baseVersionId: base.versionId, document: { templates: [] } },
      versions: [],
    });
    const extensionId = workspace.extension.extensionId as string;

    // Extensions are not systems: the system library and system routes ignore them.
    const library = await call("GET", "/systems");
    expect(library.json().systems.map((system: { systemId: string }) => system.systemId)).not.toContain(extensionId);
    expect((await call("GET", `/systems/${extensionId}`)).statusCode).toBe(404);
    expect((await call("POST", `/systems/${extensionId}/publish`, ada, { expectedRevision: 1, semanticVersion: "1.0.0", releaseNotes: "", acknowledgeBreaking: false, idempotencyKey: randomUUID() })).statusCode).toBe(404);

    // Saving keeps drafts with rule errors but reports them; schema errors are rejected.
    const broken = frostPack();
    broken.expressions[0]!.source = "d20 + fields.luck";
    const brokenSave = await saveDraft(extensionId, 1, broken);
    expect(brokenSave.statusCode, brokenSave.body).toBe(200);
    expect(brokenSave.json().workspace.assessment).toMatchObject({ ok: false, diagnostics: [{ code: "missing_reference" }] });
    expect((await saveDraft(extensionId, 2, { schemaVersion: "1.0" })).statusCode).toBe(422);

    const saved = await saveDraft(extensionId, 2, frostPack());
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().workspace.assessment).toEqual({ ok: true, diagnostics: [], warnings: [] });
    expect((await saveDraft(extensionId, 2, frostPack())).statusCode).toBe(409);

    const preview = await call("POST", `/extensions/${extensionId}/preview`);
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json().preview).toMatchObject({ baseVersionId: base.versionId, package: { baseSystemId: base.systemId, templates: [{ id: "frost_axe" }] } });

    const key = randomUUID();
    const first = await publish(extensionId, 3, "1.0.0", { idempotencyKey: key });
    expect(first.statusCode, first.body).toBe(200);
    const version = first.json().version;
    expect(version).toMatchObject({ extensionId, semanticVersion: "1.0.0", builtAgainstVersionId: base.versionId });
    expect(decodeExtensionPackage(version.package)).toMatchObject({ ok: true });
    expect((await publish(extensionId, 3, "1.0.0", { idempotencyKey: key })).json().version.versionId).toBe(version.versionId);
    expect((await publish(extensionId, 3, "1.0.1", { idempotencyKey: key })).statusCode).toBe(409);

    // Removing a template is breaking: it needs acknowledgement and a major bump.
    const removed = frostPack();
    removed.templates = [];
    removed.expressions = [];
    expect((await saveDraft(extensionId, 3, removed)).statusCode).toBe(200);
    const refused = await publish(extensionId, 4, "1.1.0", { acknowledgeBreaking: true });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error.diagnostics).toEqual([expect.objectContaining({ code: "template_removed" })]);
    const major = await publish(extensionId, 4, "2.0.0", { acknowledgeBreaking: true });
    expect(major.statusCode, major.body).toBe(200);

    const stored = await handle.pool.query<{ package_json: unknown; built_against_version_id: string }>(
      "SELECT package_json, built_against_version_id FROM system_versions WHERE id = $1",
      [version.versionId],
    );
    expect(stored.rows[0]).toEqual({ package_json: version.package, built_against_version_id: base.versionId });

    // Extension versions are never usable as a character's base system.
    const asBase = await handle.authoring.authorizeVersionUse({ actorId: ada.actorId, requestId: "r" }, version.versionId);
    expect(asBase.ok).toBe(false);
    const creation = await handle.authoring.listAuthorizedVersions({ actorId: ada.actorId, requestId: "r" }, { limit: 100 });
    expect(creation.ok && creation.value.versions.map((entry) => entry.versionId)).not.toContain(version.versionId);
    expect((await call("GET", `/system-versions/${version.versionId}/export`)).statusCode).toBe(404);
  });

  it("validates against a chosen base version and follows base availability", async () => {
    const base = await baseSystem();
    const workspace = await createExtension(base.systemId, base.versionId);
    const extensionId = workspace.extension.extensionId as string;
    // Version 2 moves the item slot to the NPC sheet, whose entity lacks `modifier`.
    const narrowed = await base.addVersion("2.0.0", (document) => {
      const section = document.sheets[0]!.sections[0]!;
      const slot = section.elements.find((element) => element.kind === "slot")!;
      section.elements = section.elements.filter((element) => element !== slot);
      document.sheets[1]!.sections[0]!.elements.push(slot);
      document.templates = [];
      document.expressions = document.expressions.filter((expression) => !expression.id.startsWith("sword_"));
    });
    const moved = await saveDraft(extensionId, 1, frostPack(), narrowed);
    expect(moved.statusCode, moved.body).toBe(200);
    expect(moved.json().workspace).toMatchObject({ draft: { baseVersionId: narrowed }, assessment: { ok: false } });
    expect((await publish(extensionId, 2, "1.0.0")).statusCode).toBe(422);
    expect((await saveDraft(extensionId, 2, frostPack(), base.versionId)).json().workspace.assessment.ok).toBe(true);

    const other = await baseSystem();
    expect((await saveDraft(extensionId, 3, frostPack(), other.versionId)).statusCode).toBe(400);

    // An archived base system can no longer be built against.
    expect((await call("PATCH", `/systems/${base.systemId}`, ada, { lifecycle: "archived" })).statusCode).toBe(200);
    const archived = await publish(extensionId, 3, "1.0.0");
    expect(archived.statusCode).toBe(409);
    expect((await call("POST", `/systems/${base.systemId}/extensions`, ada, { baseVersionId: base.versionId, name: "Late", idempotencyKey: randomUUID() })).statusCode).toBe(404);
  });

  it("applies the owner/public/link/private matrix to authoring, listing and use", async () => {
    const privateBase = await baseSystem(ada, "private");
    expect((await call("POST", `/systems/${privateBase.systemId}/extensions`, bob, { baseVersionId: privateBase.versionId, name: "Nope", idempotencyKey: randomUUID() })).statusCode).toBe(404);
    expect((await call("GET", `/systems/${privateBase.systemId}/extensions`, bob)).statusCode).toBe(404);

    const base = await baseSystem(ada, "public");
    const bobs = await createExtension(base.systemId, base.versionId, bob, "Bob's pack");
    const bobsId = bobs.extension.extensionId as string;
    const adas = await createExtension(base.systemId, base.versionId, ada, "Ada's pack");
    const adasId = adas.extension.extensionId as string;
    expect((await saveDraft(adasId, 1, frostPack())).statusCode).toBe(200);
    const published = await publish(adasId, 2, "1.0.0");
    const versionId = published.json().version.versionId as string;

    // Bob can neither open nor change Ada's extension.
    expect((await call("GET", `/extensions/${adasId}`, bob)).statusCode).toBe(404);
    expect((await call("PUT", `/extensions/${adasId}/draft`, bob, { expectedRevision: 2, document: frostPack() })).statusCode).toBe(404);
    expect((await call("PATCH", `/systems/${adasId}`, bob, { access: "public" })).statusCode).toBe(404);

    const listed = async (user: typeof ada) => (await call("GET", `/systems/${base.systemId}/extensions`, user)).json()
      .extensions.map((extension: { extensionId: string }) => extension.extensionId);
    const use = (user: typeof ada) => handle.extensions.authorizeExtensionUse({ actorId: user.actorId, requestId: "r" }, versionId);

    expect(await listed(ada)).toEqual([adasId]);
    expect(await listed(bob)).toEqual([bobsId]);
    expect((await use(ada)).ok).toBe(true);
    expect((await use(bob)).ok).toBe(false);

    expect((await call("PATCH", `/systems/${adasId}`, ada, { access: "link" })).statusCode).toBe(200);
    expect(await listed(bob)).toEqual([bobsId]);
    expect(await use(bob)).toEqual({ ok: true, value: { extensionId: adasId, versionId, baseSystemId: base.systemId, checksum: published.json().version.checksum } });

    expect((await call("PATCH", `/systems/${adasId}`, ada, { access: "public" })).statusCode).toBe(200);
    const bobView = (await call("GET", `/systems/${base.systemId}/extensions`, bob)).json().extensions;
    expect(bobView.map((extension: { extensionId: string }) => extension.extensionId).sort()).toEqual([adasId, bobsId].sort());
    expect(bobView.find((extension: { extensionId: string }) => extension.extensionId === adasId))
      .toMatchObject({ owned: false, latestVersion: { versionId, semanticVersion: "1.0.0" } });

    expect((await call("PATCH", `/systems/${adasId}`, ada, { lifecycle: "archived" })).statusCode).toBe(200);
    expect((await use(bob)).ok).toBe(false);
    expect(await listed(bob)).toEqual([bobsId]);
    expect((await publish(adasId, 2, "1.0.1")).statusCode).toBe(409);
    expect((await call("PATCH", `/systems/${adasId}`, ada, { lifecycle: "active" })).statusCode).toBe(200);

    expect((await call("PATCH", `/system-versions/${versionId}`, ada, { lifecycle: "deprecated" })).statusCode).toBe(200);
    expect((await use(ada)).ok).toBe(false);

    // Extensions cannot extend extensions, and a referenced base cannot be deleted.
    expect((await call("POST", `/systems/${adasId}/extensions`, ada, { baseVersionId: versionId, name: "Meta", idempotencyKey: randomUUID() })).statusCode).toBe(404);
    expect((await call("DELETE", `/systems/${base.systemId}`)).statusCode).toBe(409);
    expect((await call("DELETE", `/systems/${bobsId}`, bob)).statusCode).toBe(200);
  });

  it("attaches template art to extension drafts and freezes it in published versions", async () => {
    const base = await baseSystem();
    const workspace = await createExtension(base.systemId, base.versionId);
    const extensionId = workspace.extension.extensionId as string;
    expect((await saveDraft(extensionId, 1, frostPack())).statusCode).toBe(200);
    const png = (await sharp({ create: { width: 30, height: 20, channels: 3, background: "#5588aa" } }).png().toBuffer()).toString("base64");
    const url = `/systems/${extensionId}/templates/frost_axe/image`;
    const uploaded = await call("PUT", url, ada, { expectedRevision: 2, description: "A frosted axe", contentType: "image/png", dataBase64: png, idempotencyKey: randomUUID() });
    expect(uploaded.statusCode, uploaded.body).toBe(200);
    const image = uploaded.json().image;
    expect((await call("PUT", url, bob, { expectedRevision: 3, description: "x", contentType: "image/png", dataBase64: png, idempotencyKey: randomUUID() })).statusCode).toBe(404);

    const published = await publish(extensionId, 3, "1.0.0");
    expect(published.statusCode, published.body).toBe(200);
    const version = published.json().version;
    expect(version.package.templates[0].image).toEqual(image);
    const bytes = await call("GET", `/system-versions/${version.versionId}/templates/frost_axe/image/${image.fileId}`);
    expect(bytes.statusCode).toBe(200);
    expect(createHash("sha256").update(bytes.rawPayload).digest("hex")).toBe(image.checksum);
  });
});
