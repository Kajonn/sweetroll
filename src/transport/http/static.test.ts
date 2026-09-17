import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerStaticServing } from "./static.js";

describe("static serving", () => {
  it("serves index.html for unknown non-API routes and never for /api", async () => {
    const app = Fastify();
    await app.register(registerStaticServing, { distDir: "web/dist", enabled: true });
    const deep = await app.inject({ method: "GET", url: "/campaigns/abc" });
    expect(deep.statusCode).toBe(200);
    expect(deep.headers["content-type"]).toContain("text/html");
    const api = await app.inject({ method: "GET", url: "/api/unknown-route-xyz" });
    expect(api.statusCode).toBe(404);
    expect(api.headers["content-type"] ?? "").not.toContain("text/html");
  });
});
