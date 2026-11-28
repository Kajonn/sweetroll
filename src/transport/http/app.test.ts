import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

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

  it("disables metrics when no token is configured", async () => {
    expect((await app.inject({ url: "/metrics" })).statusCode).toBe(404);
  });

  it("protects metrics and adds security headers to API and HTML responses", async () => {
    const secured = buildHttpApp({
      logger: pino({ enabled: false }), pool, authHook: noopAuthHook, metricsToken: "scrape-secret", hsts: true,
    });
    secured.get("/app", async (_request, reply) => reply.type("text/html").send("<html></html>"));
    try {
      const index = readFileSync(new URL("../../../web/index.html", import.meta.url), "utf8");
      const inlineScript = /<script>([\s\S]*?)<\/script>/.exec(index)?.[1];
      const themeHash = createHash("sha256").update(inlineScript!).digest("base64");
      for (const url of ["/health/live", "/app", "/missing"]) {
        const { headers } = await secured.inject({ url });
        expect(headers["content-security-policy"]).toContain(`script-src 'self' 'sha256-${themeHash}'`);
        expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
        expect(headers["content-security-policy"]).toContain("img-src 'self' blob: data:");
        expect(headers["x-frame-options"]).toBe("DENY");
        expect(headers["referrer-policy"]).toBe("no-referrer");
        expect(headers["strict-transport-security"]).toBe("max-age=31536000");
      }
      expect((await secured.inject({ url: "/metrics" })).statusCode).toBe(401);
      expect((await secured.inject({ url: "/metrics", headers: { authorization: "Bearer wrong" } })).statusCode).toBe(401);
      const response = await secured.inject({ url: "/metrics", headers: { authorization: "Bearer scrape-secret" } });

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/plain");
      expect(response.body).toContain("sweetroll_http_requests_total");
      expect(response.body).toContain("sweetroll_http_request_duration_seconds");
      expect(response.body).toContain('sweetroll_http_request_duration_seconds_bucket{');
      expect(response.body).toMatch(/le="0\.3"/);
      expect(response.body).toMatch(/le="0\.5"/);
    } finally {
      await secured.close();
    }
  });

  it("warns once when X-Forwarded-For arrives while no proxy is trusted", async () => {
    const build = (trustedProxyCidrs?: string[]) => {
      const lines: string[] = [];
      const built = buildHttpApp({
        logger: pino({ base: null, timestamp: false }, { write: (line) => lines.push(line) }),
        pool,
        authHook: noopAuthHook,
        ...(trustedProxyCidrs ? { trustedProxyCidrs } : {}),
      });
      const warnings = () => lines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((record) => record.level === 40);
      return { built, warnings };
    };
    const untrusted = build();
    const trusted = build(["127.0.0.1"]);
    try {
      await untrusted.built.inject({ method: "GET", url: "/health/live" });
      expect(untrusted.warnings()).toHaveLength(0);
      for (let index = 0; index < 3; index++) {
        await untrusted.built.inject({
          method: "GET", url: "/health/live", headers: { "x-forwarded-for": `203.0.113.${index}` },
        });
      }
      expect(untrusted.warnings()).toHaveLength(1);
      expect(untrusted.warnings()[0]?.msg).toContain("TRUSTED_PROXY_CIDRS");
      expect(JSON.stringify(untrusted.warnings())).not.toContain("203.0.113");

      await trusted.built.inject({
        method: "GET", url: "/health/live", headers: { "x-forwarded-for": "203.0.113.9" },
      });
      expect(trusted.warnings()).toHaveLength(0);
    } finally {
      await untrusted.built.close();
      await trusted.built.close();
    }
  });
});
