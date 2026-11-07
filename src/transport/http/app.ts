import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import cookie from "@fastify/cookie";
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyPluginCallback,
  LogController,
} from "fastify";
import type { Pool } from "pg";
import type { Logger } from "pino";

import { createHttpMetrics } from "../../platform/metrics.js";

const contentSecurityPolicy = [
  "default-src 'self'",
  // The pre-paint theme initializer in web/index.html.
  "script-src 'self' 'sha256-OWklNvkjFbeof/NxSsTtco9Ub/P8Sf5i97VsA3sTRCE='",
  "img-src 'self' blob: data:",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

export function buildHttpApp(input: {
  logger: Logger;
  pool: Pool;
  authHook: FastifyPluginCallback;
  metricsToken?: string | undefined;
  hsts?: boolean;
  trustedProxyCidrs?: string[];
}): FastifyInstance {
  const logger: FastifyBaseLogger = input.logger;
  const app = Fastify({
    genReqId: () => randomUUID(),
    logController: new LogController({ disableRequestLogging: true }),
    loggerInstance: logger,
    trustProxy: input.trustedProxyCidrs?.length ? input.trustedProxyCidrs : false,
  });
  const metrics = createHttpMetrics();
  const startedAt = new WeakMap<object, bigint>();

  void app.register(cookie);

  app.addHook("onRequest", async (request) => {
    startedAt.set(request, process.hrtime.bigint());
    input.logger.info(
      {
        method: request.method,
        requestId: request.id,
        route: request.routeOptions.url ?? "unknown",
      },
      "request started",
    );
  });

  app.addHook("onSend", async (request, reply) => {
    reply.header("x-request-id", request.id);
    reply.header("content-security-policy", contentSecurityPolicy);
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "no-referrer");
    reply.header("x-content-type-options", "nosniff");
    if (input.hsts) reply.header("strict-transport-security", "max-age=31536000");
  });

  app.addHook("onResponse", async (request, reply) => {
    const start = startedAt.get(request);
    if (start === undefined) return;
    const labels = {
      method: request.method,
      route: request.routeOptions.url ?? "unknown",
      status_code: String(reply.statusCode),
    };
    const durationSeconds = Number(process.hrtime.bigint() - start) / 1_000_000_000;
    metrics.requests.inc(labels);
    metrics.duration.observe(labels, durationSeconds);
    input.logger.info(
      {
        durationSeconds,
        method: request.method,
        requestId: request.id,
        route: labels.route,
        statusCode: reply.statusCode,
      },
      "request completed",
    );
  });

  app.get("/health/live", async () => ({ status: "ok" }));

  app.get("/health/ready", async (_request, reply) => {
    try {
      const query = { text: "SELECT 1", query_timeout: 250 };
      await input.pool.query(query);
      return { status: "ok" };
    } catch {
      return reply.code(503).send({ status: "unavailable" });
    }
  });

  if (input.metricsToken) {
    const expected = createHash("sha256").update(input.metricsToken).digest();
    app.get("/metrics", { config: { bearerOnly: true } }, async (request, reply) => {
      reply.header("cache-control", "no-store");
      const token = /^Bearer ([^\s,]+)$/i.exec(request.headers.authorization ?? "")?.[1];
      if (!token || !timingSafeEqual(createHash("sha256").update(token).digest(), expected)) {
        return reply.code(401).header("www-authenticate", "Bearer").send({ status: "unauthorized" });
      }
      reply.type(metrics.registry.contentType);
      return metrics.registry.metrics();
    });
  }

  void app.register(input.authHook);

  return app;
}
