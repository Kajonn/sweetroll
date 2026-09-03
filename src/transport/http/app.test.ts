import { Pool } from "pg";
import pino from "pino";
import { afterAll, describe, expect, it } from "vitest";

import { buildHttpApp } from "./app.js";

const pool = new Pool({ connectionString: "postgres://invalid:invalid@127.0.0.1:1/invalid" });
const app = buildHttpApp({ logger: pino({ enabled: false }), pool });

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
