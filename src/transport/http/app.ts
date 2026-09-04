import { randomUUID } from "node:crypto";

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

export function buildHttpApp(input: { logger: Logger; pool: Pool; authHook: FastifyPluginCallback }): FastifyInstance {
  const logger: FastifyBaseLogger = input.logger;
  const app = Fastify({
    genReqId: () => randomUUID(),
    logController: new LogController({ disableRequestLogging: true }),
    loggerInstance: logger,
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

  app.get("/metrics", async (_request, reply) => {
    reply.type(metrics.registry.contentType);
    return metrics.registry.metrics();
  });

  void app.register(input.authHook);

  return app;
}
