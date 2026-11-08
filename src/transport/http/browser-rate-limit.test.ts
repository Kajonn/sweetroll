import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { expect, it, vi } from "vitest";

import { registerApiRoutes } from "./static.js";

it("checks browser account and upload quotas and bounds anonymous redeem attempts by client IP", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
  const app = Fastify({ trustProxy: ["127.0.0.1"] });
  const query = vi.fn().mockResolvedValue({ rowCount: 1 });
  app.addHook("onRequest", async (request) => {
    request.auth = request.headers.cookie
      ? { state: "authenticated", actorId: "account-id", sessionId: "session-id" }
      : { state: "anonymous" };
  });
  const write = vi.fn(async () => ({ ok: true }));
  registerApiRoutes(app, [(api, _opts, done) => {
    api.get("/read", async () => ({ ok: true }));
    api.post("/write", write);
    api.put("/image", { config: { browserRateBucket: "upload" } }, write);
    api.post("/displays/redeem", { config: { displayRedeem: true } }, write);
    done();
  }], true, { pool: { query } as unknown as Pool });
  try {
    const headers = { cookie: "session=valid" };
    expect((await app.inject({ method: "POST", url: "/api/write", headers })).statusCode).toBe(200);
    expect(query.mock.calls[0]?.[1]).toEqual(["account-id", "general", 600, 5]);
    expect((await app.inject({ method: "GET", url: "/api/read", headers })).statusCode).toBe(200);
    expect(query.mock.calls[1]?.[1]).toEqual(["account-id", "general", 600, 1]);
    query.mockResolvedValueOnce({ rowCount: 1 }).mockResolvedValueOnce({ rowCount: 0 });
    const blocked = await app.inject({ method: "PUT", url: "/api/image", headers });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toBe("60");
    expect(query.mock.calls[3]?.[1]).toEqual(["account-id", "upload", 30, 1]);
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
    clock.mockRestore();
    await app.close();
  }
});

it("counts only failed redeems toward the process-wide budget so a valid code still redeems", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
  const app = Fastify({ trustProxy: ["127.0.0.1"] });
  app.addHook("onRequest", async (request) => {
    request.auth = { state: "anonymous" };
  });
  const redeem = vi.fn(async (request: FastifyRequest, reply: FastifyReply) => {
    const { code } = request.body as { code: string };
    if (code === "VALID1") return { display: { displayId: "d", secret: "s" } };
    return reply.code(404).send({ error: { code: "not_found", message: "missing" } });
  });
  registerApiRoutes(app, [(api, _opts, done) => {
    api.post("/displays/redeem", { config: { displayRedeem: true } }, redeem);
    done();
  }], true, { pool: { query: vi.fn() } as unknown as Pool });
  const attempt = (ip: string, code: string) => app.inject({
    method: "POST", url: "/api/displays/redeem", headers: { "x-forwarded-for": ip }, payload: { code },
  });
  try {
    // Successful redeems do not consume the process-wide failure budget.
    for (let index = 0; index < 130; index++) {
      expect((await attempt(`198.51.${Math.floor(index / 10)}.${index % 10}`, "VALID1")).statusCode).toBe(200);
    }
    // 12 IPs x 10 failures exhaust the 120-failure process budget.
    for (let ip = 0; ip < 12; ip++) {
      for (let index = 0; index < 10; index++) {
        expect((await attempt(`192.0.2.${ip}`, "WRONG1")).statusCode).toBe(404);
      }
    }
    const blocked = await attempt("203.0.113.1", "WRONG1");
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toBe("60");
    expect(blocked.json()).toMatchObject({ error: { code: "rate_limited" } });
    // A legitimate display with the right code still pairs.
    expect((await attempt("203.0.113.2", "VALID1")).statusCode).toBe(200);
    // The per-IP limit still covers every attempt, valid or not.
    for (let index = 0; index < 9; index++) {
      expect((await attempt("203.0.113.2", "VALID1")).statusCode).toBe(200);
    }
    expect((await attempt("203.0.113.2", "VALID1")).statusCode).toBe(429);
    expect(redeem).toHaveBeenCalledTimes(130 + 120 + 1 + 10);
    // A fresh window resets both budgets.
    clock.mockReturnValue(1_700_000_060_000);
    expect((await attempt("192.0.2.0", "WRONG1")).statusCode).toBe(404);
  } finally {
    clock.mockRestore();
    await app.close();
  }
});
