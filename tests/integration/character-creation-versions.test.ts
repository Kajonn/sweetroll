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

  /** Inserts an additional published version under an existing system with an
   * explicit created_at so newest-first ordering within the system is deterministic. */
  async function insertExtraVersion(
    app: App,
    systemId: string,
    createdAt: string,
  ): Promise<{ systemId: string; versionId: string }> {
    const versionId = randomUUID();
    const unsigned = structuredClone(d20Package) as unknown as UnsignedSystemPackageV1 & { integrity?: unknown };
    delete unsigned.integrity;
    unsigned.versionId = versionId;
    const packageValue = signSystemPackage(unsigned);
    await app.pool.query(
      "INSERT INTO system_versions (id, system_id, semantic_version, checksum, package_json, lifecycle, created_at) VALUES ($1, $2, '2.0.0', $3, $4::jsonb, 'published', $5)",
      [versionId, systemId, packageValue.integrity.checksum, JSON.stringify(packageValue), createdAt],
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

  it("lists exactly the discoverable published versions ordered by system name without writing rows", async () => {
    const app = await makeApp();
    const ada = app.users.ada;
    const bob = app.users.bob;

    const own = await insertVersion(app, ada.actorId, { name: "Alpha Private", access: "private" });
    const pub = await insertVersion(app, bob.actorId, { name: "Beta Public", access: "public" });
    // OD-01 option A: another owner's link-access system is usable via a known
    // version ID but is NOT enumerated.
    const link = await insertVersion(app, bob.actorId, { name: "Gamma Link", access: "link" });
    await insertVersion(app, bob.actorId, { name: "Delta Private", access: "private" });
    await insertVersion(app, ada.actorId, { name: "Epsilon Deprecated", versionLifecycle: "deprecated" });
    await insertVersion(app, ada.actorId, { name: "Zeta Archived", systemLifecycle: "archived" });
    const pubOlder = await insertExtraVersion(app, pub.systemId, "2024-01-01T00:00:00.000Z");

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
      pubOlder.versionId,
    ]);
    expect(body.data.versions.map((v) => v.systemName)).toEqual([
      "Alpha Private",
      "Beta Public",
      "Beta Public",
    ]);
    expect(body.data.versions.map((v) => v.versionId)).not.toContain(link.versionId);
    const beta = body.data.versions.filter((v) => v.systemName === "Beta Public");
    expect(beta[0]!.versionId).toBe(pub.versionId);
    expect(beta[0]!.createdAt > beta[1]!.createdAt).toBe(true);
    expect(body.data.versions.map((v) => v.semanticVersion)).toEqual([
      "1.0.0",
      "1.0.0",
      "2.0.0",
    ]);
    for (const entry of body.data.versions) {
      expect(entry.systemId).toBeTypeOf("string");
      expect(entry.createdAt).toBeTypeOf("string");
    }
    expect(await rowCounts(app)).toEqual(before);
  });

  it("hides another owner's link-only and private systems from enumeration but keeps known-version use", async () => {
    const app = await makeApp();
    const ada = app.users.ada;
    const bob = app.users.bob;

    // Owned/private/link/public matrix across two accounts.
    const adaPrivate = await insertVersion(app, ada.actorId, { name: "Ada Private", access: "private" });
    const adaLink = await insertVersion(app, ada.actorId, { name: "Ada Link", access: "link" });
    const bobPrivate = await insertVersion(app, bob.actorId, { name: "Bob Private", access: "private" });
    const bobLink = await insertVersion(app, bob.actorId, { name: "Bob Link", access: "link" });
    const sharedPublic = await insertVersion(app, ada.actorId, { name: "Shared Public", access: "public" });

    const listAs = async (user: I3Users[keyof I3Users]) => {
      const response = await app.app.inject({
        method: "GET",
        url: "/characters/creation-versions",
        headers: cookieHeader(user),
      });
      expect(response.statusCode, response.body).toBe(200);
      return (response.json() as { data: { versions: Array<{ versionId: string }> } }).data.versions.map(
        (v) => v.versionId,
      );
    };

    // B's list contains B's owned (private + link) + public systems only.
    const bobList = await listAs(bob);
    expect(bobList).toContain(bobPrivate.versionId);
    expect(bobList).toContain(bobLink.versionId);
    expect(bobList).toContain(sharedPublic.versionId);
    expect(bobList).not.toContain(adaPrivate.versionId);
    expect(bobList).not.toContain(adaLink.versionId);

    // A's list mirrors: A's owned (private + link) + public, not B's.
    const adaList = await listAs(ada);
    expect(adaList).toContain(adaPrivate.versionId);
    expect(adaList).toContain(adaLink.versionId);
    expect(adaList).toContain(sharedPublic.versionId);
    expect(adaList).not.toContain(bobPrivate.versionId);
    expect(adaList).not.toContain(bobLink.versionId);

    // Use-permission intact: B can still resolve metadata and create from A's
    // link-only version via its exact known version ID.
    const metadata = await app.app.inject({
      method: "GET",
      url: `/characters/creation-options?systemVersionId=${adaLink.versionId}`,
      headers: cookieHeader(bob),
    });
    expect(metadata.statusCode, metadata.body).toBe(200);

    const created = await app.app.inject({
      method: "POST",
      url: "/characters",
      headers: cookieHeader(bob),
      payload: {
        systemVersionId: adaLink.versionId,
        entityDefinitionId: "character",
        name: "Bob From Link",
        idempotencyKey: randomUUID(),
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().character.systemVersionId).toBe(adaLink.versionId);

    // A's private system stays closed to B even with a known version ID.
    const privateMetadata = await app.app.inject({
      method: "GET",
      url: `/characters/creation-options?systemVersionId=${adaPrivate.versionId}`,
      headers: cookieHeader(bob),
    });
    expect(privateMetadata.statusCode).toBe(404);
  });

  it("rejects anonymous listing with 401", async () => {
    const app = await makeApp();
    const response = await app.app.inject({ method: "GET", url: "/characters/creation-versions" });
    expect(response.statusCode).toBe(401);
  });

  type VersionsPage = {
    data: {
      versions: Array<{
        versionId: string;
        systemId: string;
        systemName: string;
        semanticVersion: string;
        createdAt: string;
      }>;
      nextCursor: string | null;
    };
    requestId: string;
  };

  async function getVersionsPage(
    app: App,
    user: I3Users[keyof I3Users],
    query: string,
  ): Promise<VersionsPage> {
    const response = await app.app.inject({
      method: "GET",
      url: `/characters/creation-versions${query}`,
      headers: cookieHeader(user),
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as VersionsPage;
    expect(body.requestId).toBeTypeOf("string");
    return body;
  }

  it("creation-versions paginates with stable order across inserts", async () => {
    const app = await makeApp();
    const ada = app.users.ada;

    for (const name of ["Alpha", "Beta", "Delta", "Epsilon", "Gamma"]) {
      await insertVersion(app, ada.actorId, { name, access: "public" });
    }

    const page1 = await getVersionsPage(app, ada, "?limit=2");
    expect(page1.data.versions).toHaveLength(2);
    expect(page1.data.nextCursor).toBeTypeOf("string");

    // A later insert must not duplicate or skip rows when paging on.
    await insertVersion(app, ada.actorId, { name: "Zulu", access: "public" });

    const page2 = await getVersionsPage(
      app,
      ada,
      `?limit=2&cursor=${encodeURIComponent(page1.data.nextCursor!)}`,
    );
    expect(page2.data.versions).toHaveLength(2);
    expect(page2.data.nextCursor).toBeTypeOf("string");

    const full = await getVersionsPage(app, ada, "?limit=100");
    expect(full.data.nextCursor).toBeNull();
    const pagedIds = [...page1.data.versions, ...page2.data.versions].map((v) => v.versionId);
    const fullIds = full.data.versions.map((v) => v.versionId);
    expect(fullIds).toHaveLength(6);
    expect(pagedIds).toEqual(fullIds.slice(0, 4));
    expect(new Set(pagedIds).size).toBe(pagedIds.length);
    expect(full.data.versions.map((v) => v.systemName)).toEqual(
      [...full.data.versions.map((v) => v.systemName)].sort(),
    );
  });

  it("q filters by system name and systemId narrows to one system", async () => {
    const app = await makeApp();
    const ada = app.users.ada;

    const alpha = await insertVersion(app, ada.actorId, { name: "Alpha One", access: "public" });
    await insertExtraVersion(app, alpha.systemId, "2024-06-01T00:00:00.000Z");
    await insertVersion(app, ada.actorId, { name: "Beta One", access: "public" });

    const filtered = await getVersionsPage(app, ada, "?q=alp");
    expect(filtered.data.versions.length).toBeGreaterThan(0);
    expect(filtered.data.versions.map((v) => v.systemName).sort()).toEqual(["Alpha One", "Alpha One"]);

    const upper = await getVersionsPage(app, ada, "?q=ALP");
    expect(upper.data.versions.map((v) => v.versionId).sort()).toEqual(
      filtered.data.versions.map((v) => v.versionId).sort(),
    );

    const narrowed = await getVersionsPage(app, ada, `?systemId=${alpha.systemId}`);
    expect(narrowed.data.versions).toHaveLength(2);
    for (const entry of narrowed.data.versions) {
      expect(entry.systemId).toBe(alpha.systemId);
    }

    const combined = await getVersionsPage(app, ada, `?q=alpha&systemId=${alpha.systemId}`);
    expect(combined.data.versions.map((v) => v.versionId).sort()).toEqual(
      narrowed.data.versions.map((v) => v.versionId).sort(),
    );
  });

  it("pagination preserves OD-01: other-owner link systems never enumerated", async () => {
    const app = await makeApp();
    const ada = app.users.ada;
    const bob = app.users.bob;

    const adaPrivate = await insertVersion(app, ada.actorId, { name: "Ada Private", access: "private" });
    const adaLink = await insertVersion(app, ada.actorId, { name: "Ada Link", access: "link" });
    const bobPrivate = await insertVersion(app, bob.actorId, { name: "Bob Private", access: "private" });
    const bobLink = await insertVersion(app, bob.actorId, { name: "Bob Link", access: "link" });
    const sharedPublic = await insertVersion(app, ada.actorId, { name: "Shared Public", access: "public" });

    async function collectAll(user: I3Users[keyof I3Users]): Promise<string[]> {
      const ids: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 10; page += 1) {
        const query = cursor === null ? "?limit=1" : `?limit=1&cursor=${encodeURIComponent(cursor)}`;
        const body = await getVersionsPage(app, user, query);
        expect(body.data.versions.length).toBeLessThanOrEqual(1);
        ids.push(...body.data.versions.map((v) => v.versionId));
        cursor = body.data.nextCursor;
        if (cursor === null) break;
      }
      expect(cursor).toBeNull();
      return ids;
    }

    const bobList = await collectAll(bob);
    expect(bobList).toContain(bobPrivate.versionId);
    expect(bobList).toContain(bobLink.versionId);
    expect(bobList).toContain(sharedPublic.versionId);
    expect(bobList).not.toContain(adaPrivate.versionId);
    expect(bobList).not.toContain(adaLink.versionId);

    const adaList = await collectAll(ada);
    expect(adaList).toContain(adaPrivate.versionId);
    expect(adaList).toContain(adaLink.versionId);
    expect(adaList).toContain(sharedPublic.versionId);
    expect(adaList).not.toContain(bobPrivate.versionId);
    expect(adaList).not.toContain(bobLink.versionId);
  });
});
