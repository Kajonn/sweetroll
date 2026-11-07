import Fastify from "fastify";
import type { Pool } from "pg";
import { expect, it, vi } from "vitest";

import { registerApiRoutes } from "./static.js";

it("checks browser account and upload quotas and bounds anonymous redeem attempts by client IP", async () => {
  const app = Fastify({ trustProxy: ["127.0.0.1"] });
  const query = vi.fn().mockResolvedValue({ rowCount: 1 });
  app.addHook("onRequest", async (request) => {
    request.auth = request.headers.cookie
      ? { state: "authenticated", actorId: "account-id", sessionId: "session-id" }
      : { state: "anonymous" };
  });
  const write = vi.fn(async () => ({ ok: true }));
  registerApiRoutes(app, [(api, _opts, done) => {
    api.post("/write", write);
    api.put("/image", { config: { browserRateBucket: "upload" } }, write);
    api.post("/displays/redeem", { config: { displayRedeem: true } }, write);
    done();
  }], true, { pool: { query } as unknown as Pool });
  try {
    const headers = { cookie: "session=valid" };
    expect((await app.inject({ method: "POST", url: "/api/write", headers })).statusCode).toBe(200);
    expect(query.mock.calls[0]?.[1]).toEqual(["account-id", "general", 120]);
    query.mockResolvedValueOnce({ rowCount: 1 }).mockResolvedValueOnce({ rowCount: 0 });
    const blocked = await app.inject({ method: "PUT", url: "/api/image", headers });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toBe("60");
    expect(query.mock.calls[2]?.[1]).toEqual(["account-id", "upload", 30]);
    expect(write).toHaveBeenCalledTimes(1);

    for (let attempt = 1; attempt <= 11; attempt++) {
      const redeem = await app.inject({
        method: "POST", url: "/api/displays/redeem",
        headers: { "x-forwarded-for": `192.0.2.${attempt}, 198.51.100.1` },
      });
      expect(redeem.statusCode).toBe(attempt <= 10 ? 200 : 429);
    }
    expect((await app.inject({
      method: "POST", url: "/api/displays/redeem", headers: { "x-forwarded-for": "198.51.100.2" },
    })).statusCode).toBe(200);
  } finally {
    await app.close();
  }
});
