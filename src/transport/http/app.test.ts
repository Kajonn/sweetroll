import { Pool } from "pg";
import pino from "pino";
import { afterAll, describe, expect, it } from "vitest";

import { buildHttpApp } from "./app.js";

const noopAuthHook = async () => {};

const pool = new Pool({ connectionString: "postgres://invalid:invalid@127.0.0.1:1/invalid" });
const app = buildHttpApp({ logger: pino({ enabled: false }), pool, authHook: noopAuthHook });

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe("HTTP platform endpoints", () => {
  it("reports liveness and emits a server request id", async () => {
    const response = await app.inject({ method: "GET", url: "/health/live" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    expect(response.headers["x-request-id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("does not trust a caller-supplied request id", async () => {
    const response = await app.inject({
      headers: { "x-request-id": "caller-controlled" },
      method: "GET",
      url: "/health/live",
    });

    expect(response.headers["x-request-id"]).not.toBe("caller-controlled");
  });

  it("logs only allow-listed request metadata", async () => {
    const secret = "unique-query-secret-8d3b62";
    const lines: string[] = [];
    const loggingPool = new Pool({
      connectionString: "postgres://invalid:invalid@127.0.0.1:1/invalid",
    });
    const loggingApp = buildHttpApp({
      logger: pino({ base: null, timestamp: false }, { write: (line) => lines.push(line) }),
      pool: loggingPool,
      authHook: noopAuthHook,
    });

    try {
      const response = await loggingApp.inject({
        headers: { authorization: `Bearer ${secret}` },
        method: "GET",
        url: `/health/live?access_token=${secret}`,
      });
      const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
      const requestId = response.headers["x-request-id"];

      expect(lines.join("\n")).not.toContain(secret);
      expect(records).toHaveLength(2);
      expect(records[0]).toMatchObject({
        method: "GET",
        msg: "request started",
        requestId,
        route: "/health/live",
      });
      expect(records[1]).toMatchObject({
        durationSeconds: expect.any(Number),
        method: "GET",
        msg: "request completed",
        requestId,
        route: "/health/live",
        statusCode: 200,
      });
      expect(Object.keys(records[0] ?? {}).sort()).toEqual([
        "level",
        "method",
        "msg",
        "requestId",
        "route",
      ]);
      expect(Object.keys(records[1] ?? {}).sort()).toEqual([
        "durationSeconds",
        "level",
        "method",
        "msg",
        "requestId",
        "route",
        "statusCode",
      ]);
    } finally {
      await loggingApp.close();
      await loggingPool.end();
    }
  });

  it("returns bounded readiness failure details", async () => {
    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: "unavailable" });
  });

  it("exports baseline HTTP metrics", async () => {
    await app.inject({ method: "GET", url: "/health/live" });
    const response = await app.inject({ method: "GET", url: "/metrics" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/plain");
    expect(response.body).toContain("sweetroll_http_requests_total");
    expect(response.body).toContain("sweetroll_http_request_duration_seconds");
  });
});
