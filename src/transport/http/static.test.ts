import Fastify from "fastify";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { registerStaticServing } from "./static.js";

describe("static serving", () => {
  it("serves index.html for unknown non-API routes and never for /api", async () => {
    const distDir = await mkdtemp(join(tmpdir(), "sweetroll-static-test-"));
    const app = Fastify();
    const html = "<!doctype html><html><body>Sweetroll test shell</body></html>";
    try {
      await writeFile(join(distDir, "index.html"), html);
      await app.register(registerStaticServing, { distDir, enabled: true });
      const deep = await app.inject({ method: "GET", url: "/campaigns/abc" });
      expect(deep.statusCode).toBe(200);
      expect(deep.headers["content-type"]).toContain("text/html");
      expect(deep.body).toBe(html);
      const api = await app.inject({ method: "GET", url: "/api/unknown-route-xyz" });
      expect(api.statusCode).toBe(404);
      expect(api.headers["content-type"] ?? "").not.toContain("text/html");
    } finally {
      try {
        await app.close();
      } finally {
        await rm(distDir, { recursive: true, force: true });
      }
    }
  });
});
