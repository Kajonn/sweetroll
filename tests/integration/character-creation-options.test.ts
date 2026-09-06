import { randomUUID } from "node:crypto";

import { afterEach } from "vitest";
import { describe, expect, it, vi } from "vitest";

import type { SystemRuntime } from "../../src/systems/runtime.js";
import {
  d20Document,
  d20Package,
  d6SuccessPoolDocument,
  pbta2d6Document,
} from "../../src/systems/implementation/package/fixtures/index.js";
import { signSystemPackage } from "../../src/systems/implementation/package/canonical.js";
import type { UnsignedSystemPackageV1 } from "../../src/systems/implementation/package/schema/index.js";
import type { SystemDocumentV1 } from "../../src/systems/implementation/package/schema/document.js";
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

type App = I3AppHandle;

describeWithDatabase("Character creation options", () => {
  const apps: Array<{ cleanup: () => Promise<void> }> = [];
  afterEach(async () => {
    for (const app of apps.splice(0)) await app.cleanup();
  });

  async function makeApp(
    wrapRuntime?: (runtime: SystemRuntime) => SystemRuntime,
  ): Promise<App & { cleanup: () => Promise<void> }> {
    const schema = `characters_options_${randomUUID().replaceAll("-", "")}`;
    await createI3Schema(databaseUrl!, schema);
    const pool = createI3Pool(databaseUrl!, schema);
    const handle = await buildI3App(wrapRuntime === undefined ? { pool } : { pool, wrapRuntime });
    const app = { ...handle, cleanup: async () => {
      await handle.app.close();
      await pool.end();
      await dropI3Schema(databaseUrl!, schema);
    } };
    apps.push(app);
    return app;
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

  /** Directly inserts a published d20 version row whose authorization policy can be
   * varied by access/lifecycle and whose package storage can be corrupted on purpose. */
  async function insertVersion(
    app: App,
    ownerId: string,
    options: { access?: string; versionLifecycle?: string; corrupt?: boolean } = {},
  ): Promise<{ systemId: string; versionId: string }> {
    const systemResult = await app.pool.query<{ id: string }>(
      "INSERT INTO systems (owner_id, name, access, lifecycle) VALUES ($1, $2, $3, 'active') RETURNING id",
      [ownerId, "D20", options.access ?? "public"],
    );
    const systemId = systemResult.rows[0]!.id;
    const versionId = randomUUID();
    const unsigned = structuredClone(d20Package) as unknown as UnsignedSystemPackageV1 & { integrity?: unknown };
    delete unsigned.integrity;
    unsigned.versionId = versionId;
    const packageValue = signSystemPackage(unsigned);
    await app.pool.query(
      "INSERT INTO system_versions (id, system_id, semantic_version, checksum, package_json, lifecycle) VALUES ($1, $2, '1.0.0', $3, $4::jsonb, $5)",
      [
        versionId,
        systemId,
        options.corrupt === true ? `sha256:${"0".repeat(64)}` : packageValue.integrity.checksum,
        JSON.stringify(packageValue),
        options.versionLifecycle ?? "published",
      ],
    );
    return { systemId, versionId };
  }

  async function creationOptions(app: App, user: I3Users["ada"], systemVersionId: string) {
    return app.app.inject({
      method: "GET",
      url: `/characters/creation-options?systemVersionId=${systemVersionId}`,
      headers: cookieHeader(user),
    });
  }

  async function rowCounts(app: App): Promise<{ characters: number; executions: number; rolls: number }> {
    const characters = await app.pool.query<{ count: number }>("SELECT count(*)::int AS count FROM characters");
    const executions = await app.pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM character_command_executions",
    );
    const rolls = await app.pool.query<{ count: number }>("SELECT count(*)::int AS count FROM character_rolls");
    return {
      characters: characters.rows[0]!.count,
      executions: executions.rows[0]!.count,
      rolls: rolls.rows[0]!.count,
    };
  }

  it("returns creation metadata for an authorized published version without writing rows", async () => {
    const app = await makeApp();
    const ada = app.users.ada;
    const before = await rowCounts(app);

    const { versionId } = await publishVersion(app, ada, d20Document, {
      name: "D20 Options",
      semanticVersion: "1.0.0",
    });
    const response = await creationOptions(app, ada, versionId);

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().requestId).toBeTypeOf("string");
    expect(response.json().data.versionId).toBe(versionId);
    expect(response.json().data.packageChecksum).toBeTypeOf("string");
    expect(response.json().data.packageChecksum.length).toBeGreaterThan(0);
    expect(response.json().data.entities).toEqual([{ id: "character", label: "Character" }]);
    expect(await rowCounts(app)).toEqual(before);
  });

  it("exposes the reference entity for every reference system", async () => {
    const app = await makeApp();
    const ada = app.users.ada;

    for (const [name, document] of [
      ["D20", d20Document],
      ["PbtA 2d6", pbta2d6Document],
      ["D6 pool", d6SuccessPoolDocument],
    ] as const) {
      const { versionId } = await publishVersion(app, ada, document, {
        name,
        semanticVersion: "1.0.0",
      });
      const response = await creationOptions(app, ada, versionId);
      expect(response.statusCode, `${name}: ${response.body}`).toBe(200);
      expect(response.json().data.entities, name).toEqual([{ id: "character", label: "Character" }]);
    }

    const counts = await rowCounts(app);
    expect(counts.characters).toBe(0);
    expect(counts.executions).toBe(0);
    expect(counts.rolls).toBe(0);
  });

  it("rejects a missing version with 404 without describing", async () => {
    const app = await makeApp();
    const ada = app.users.ada;
    const describeSpy = vi.spyOn(app.runtime, "describeVersion");
    try {
      const response = await creationOptions(app, ada, randomUUID());
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe("not_found");
      expect(describeSpy).not.toHaveBeenCalled();
    } finally {
      describeSpy.mockRestore();
    }
  });

  it("rejects an unpublished version with 404 without describing", async () => {
    const app = await makeApp();
    const ada = app.users.ada;
    const { versionId } = await insertVersion(app, ada.actorId, { versionLifecycle: "draft" });
    const describeSpy = vi.spyOn(app.runtime, "describeVersion");
    try {
      const response = await creationOptions(app, ada, versionId);
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe("not_found");
      expect(describeSpy).not.toHaveBeenCalled();
    } finally {
      describeSpy.mockRestore();
    }
  });

  it("rejects an inaccessible private version owned by another user without describing", async () => {
    const app = await makeApp();
    const ada = app.users.ada;
    const bob = app.users.bob;
    const { versionId } = await insertVersion(app, ada.actorId, { access: "private" });
    const describeSpy = vi.spyOn(app.runtime, "describeVersion");
    try {
      const response = await creationOptions(app, bob, versionId);
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe("not_found");
      expect(describeSpy).not.toHaveBeenCalled();
    } finally {
      describeSpy.mockRestore();
    }
  });

  it("rejects a deprecated version with 404 without describing", async () => {
    const app = await makeApp();
    const ada = app.users.ada;
    const { versionId } = await insertVersion(app, ada.actorId, { versionLifecycle: "deprecated" });
    const describeSpy = vi.spyOn(app.runtime, "describeVersion");
    try {
      const response = await creationOptions(app, ada, versionId);
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe("not_found");
      expect(describeSpy).not.toHaveBeenCalled();
    } finally {
      describeSpy.mockRestore();
    }
  });

  it("rejects a corrupt published package with the create policy's invalid_package response", async () => {
    const app = await makeApp();
    const ada = app.users.ada;
    const before = await rowCounts(app);
    const { versionId } = await insertVersion(app, ada.actorId, { corrupt: true });
    const describeSpy = vi.spyOn(app.runtime, "describeVersion");
    try {
      const response = await creationOptions(app, ada, versionId);
      expect(response.statusCode).toBe(422);
      expect(response.json().error.code).toBe("invalid_value");
      expect(describeSpy).toHaveBeenCalledTimes(1);
    } finally {
      describeSpy.mockRestore();
    }
    expect(await rowCounts(app)).toEqual(before);
  });
});