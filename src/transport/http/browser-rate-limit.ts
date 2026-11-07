import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

import { consumeRequest, type RateBucket } from "./public-api/rate-limit.js";

declare module "fastify" {
  interface FastifyContextConfig {
    browserRateBucket?: RateBucket;
    displayRedeem?: boolean;
  }
}

export function registerBrowserRateLimits(api: FastifyInstance, pool: Pool): void {
  const redeemAttempts = new Map<string, number>();
  let redeemWindow = -1;
  let totalRedeems = 0;

  function consumeRedeem(ip: string): boolean {
    const window = Math.floor(Date.now() / 60_000);
    if (window !== redeemWindow) {
      redeemAttempts.clear();
      redeemWindow = window;
      totalRedeems = 0;
    }
    const attempts = redeemAttempts.get(ip) ?? 0;
    // The process-wide limit also bounds the number of tracked IPs.
    if (attempts >= 10 || totalRedeems >= 120) return false;
    redeemAttempts.set(ip, attempts + 1);
    totalRedeems++;
    return true;
  }

  api.addHook("onRequest", async (request, reply) => {
    const { browserRateBucket, displayRedeem } = request.routeOptions.config;
    let allowed = true;
    if (displayRedeem) {
      allowed = consumeRedeem(request.ip);
    } else if (request.auth?.state === "authenticated") {
      const { actorId } = request.auth;
      const kind = request.method === "GET" || request.method === "HEAD" ? "browser_read" : "ordinary";
      allowed = await consumeRequest(pool, actorId, "general", kind)
        && (browserRateBucket === undefined || await consumeRequest(pool, actorId, browserRateBucket));
    }
    if (!allowed) {
      return reply.code(429).header("retry-after", "60").send({
        error: { code: "rate_limited", message: "The request limit was reached." },
        requestId: request.id,
      });
    }
  });
}
