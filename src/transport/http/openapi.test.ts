import { describe, expect, it } from "vitest";
import Fastify from "fastify";

import { buildIdentityRoutes } from "./identity.js";
import { buildOpenApiDocument } from "./openapi.js";
import { buildSystemsRoutes } from "./systems.js";
import type { SystemAuthoring } from "../../systems/authoring.js";

describe("buildOpenApiDocument", () => {
  it("emits an OpenAPI 3.1 document with every systems route", async () => {
    const app = Fastify();
    void app.register(buildIdentityRoutes());
    void app.register(buildSystemsRoutes({ authoring: {} as SystemAuthoring }));
    await app.ready();
    const doc = buildOpenApiDocument(app);
    expect(doc.openapi).toBe("3.1.0");
    expect(Object.keys(doc.paths ?? {}).sort()).toEqual([
      "/me",
      "/system-versions/{versionId}",
      "/system-versions/{versionId}/export",
      "/systems",
      "/systems/{systemId}",
      "/systems/{systemId}/draft",
      "/systems/{systemId}/preview",
      "/systems/{systemId}/publish",
      "/systems/{systemId}/versions",
    ]);
    const paths = doc.paths ?? {};
    for (const path of Object.keys(paths)) {
      for (const method of Object.keys(paths[path] ?? {})) {
        const op = paths[path]?.[method];
        expect(op?.operationId, `${method} ${path}`).toBeTypeOf("string");
      }
    }
    await app.close();
  });
});
