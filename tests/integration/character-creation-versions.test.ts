import { randomUUID } from "node:crypto";

import { afterEach } from "vitest";
import { describe, expect, it } from "vitest";

import { signSystemPackage } from "../../src/systems/implementation/package/canonical.js";
import { d20Package } from "../../src/systems/implementation/package/fixtures/index.js";
import type { UnsignedSystemPackageV1 } from "../../src/systems/implementation/package/schema/index.js";
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

describeWithDatabase("Character creation versions", () => {
  const apps: Array<{ cleanup: () => Promise<void> }> = [];
  afterEach(async () => {
    for (const app of apps.splice(0)) await app.cleanup();
  });

  async function makeApp(): Promise<App & { cleanup: () => Promise<void> }> {
    const schema = `characters_versions_${randomUUID().replaceAll("-", "")}`;
    await createI3Schema(databaseUrl!, schema);
    const pool = createI3Pool(databaseUrl!, schema);
    const handle = await buildI3App({ pool });
    const app = { ...handle, cleanup: async () => {
      await handle.app.close();
      await pool.end();
      await dropI3Schema(databaseUrl!, schema);
    } };
    apps.push(app);
    return app;
  }

  const cookieHeader = (user: I3Users[keyof I3Users]) => ({ cookie: user.cookie });

  /** Directly inserts a published d20 version row whose authorization policy can be
   * varied by access/lifecycle. */
  async function insertVersion(
    app: App,
    ownerId: string,
    options: { name: string; access?: string; versionLifecycle?: string; systemLifecycle?: string },
  ): Promise<{ systemId: string; versionId: string }> {
    const systemResult = await app.pool.query<{ id: string }>(
      "INSERT INTO systems (owner_id, name, access, lifecycle) VALUES ($1, $2, $3, $4) RETURNING id",
      [ownerId, options.name, options.access ?? "public", options.systemLifecycle ?? "active"],
    );
    const systemId = systemResult.rows[0]!.id;
    const versionId = randomUUID();
    const unsigned = structuredClone(d20Package) as unknown as UnsignedSystemPackageV1 & { integrity?: unknown };
    delete unsigned.integrity;
    unsigned.versionId = versionId;
    const packageValue = signSystemPackage(unsigned);
    await app.pool.query(
      "INSERT INTO system_versions (id, system_id, semantic_version, checksum, package_json, lifecycle) VALUES ($1, $2, '1.0.0', $3, $4::jsonb, $5)",
      [versionId, systemId, packageValue.integrity.checksum, JSON.stringify(packageValue), options.versionLifecycle ?? "published"],
    );
    return { systemId, versionId };
  }

  async function rowCounts(app: App): Promise<{ systems: number; versions: number }> {
    const systems = await app.pool.query<{ count: number }>("SELECT count(*)::int AS count FROM systems");
    const versions = await app.pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM system_versions",
    );
    return { systems: systems.rows[0]!.count, versions: versions.rows[0]!.count };
  }

  it("lists exactly the authorized published versions ordered by system name without writing rows", async () => {
    const app = await makeApp();
    const ada = app.users.ada;
    const bob = app.users.bob;

    const own = await insertVersion(app, ada.actorId, { name: "Alpha Private", access: "private" });
    const pub = await insertVersion(app, bob.actorId, { name: "Beta Public", access: "public" });
    const link = await insertVersion(app, bob.actorId, { name: "Gamma Link", access: "link" });
    await insertVersion(app, bob.actorId, { name: "Delta Private", access: "private" });
    await insertVersion(app, ada.actorId, { name: "Epsilon Deprecated", versionLifecycle: "deprecated" });
    await insertVersion(app, ada.actorId, { name: "Zeta Archived", systemLifecycle: "archived" });

    const before = await rowCounts(app);
    const response = await app.app.inject({
      method: "GET",
      url: "/characters/creation-versions",
      headers: cookieHeader(ada),
    });

    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as {
      data: {
        versions: Array<{
          versionId: string;
          systemId: string;
          systemName: string;
          semanticVersion: string;
          createdAt: string;
        }>;
      };
      requestId: string;
    };
    expect(body.requestId).toBeTypeOf("string");
    expect(body.data.versions.map((v) => v.versionId)).toEqual([
      own.versionId,
      pub.versionId,
      link.versionId,
    ]);
    expect(body.data.versions.map((v) => v.systemName)).toEqual([
      "Alpha Private",
      "Beta Public",
      "Gamma Link",
    ]);
    for (const entry of body.data.versions) {
      expect(entry.semanticVersion).toBe("1.0.0");
      expect(entry.systemId).toBeTypeOf("string");
      expect(entry.createdAt).toBeTypeOf("string");
    }
    expect(await rowCounts(app)).toEqual(before);
  });

  it("rejects anonymous listing with 401", async () => {
    const app = await makeApp();
    const response = await app.app.inject({ method: "GET", url: "/characters/creation-versions" });
    expect(response.statusCode).toBe(401);
  });
});
