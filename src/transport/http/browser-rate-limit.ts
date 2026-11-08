import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";

import { consumeRequest, type RateBucket } from "./public-api/rate-limit.js";

declare module "fastify" {
  interface FastifyContextConfig {
    browserRateBucket?: RateBucket;
    displayRedeem?: boolean;
  }
}

const REDEEM_ATTEMPTS_PER_IP = 10;
const REDEEM_FAILURES_PER_PROCESS = 120;
/** Bounds memory under an address-spraying flood; the oldest entry is evicted. */
const MAX_TRACKED_REDEEM_IPS = 10_000;

function rateLimitedBody(request: FastifyRequest) {
  return { error: { code: "rate_limited", message: "The request limit was reached." }, requestId: request.id };
}

export function registerBrowserRateLimits(api: FastifyInstance, pool: Pool): void {
  const redeemAttempts = new Map<string, number>();
  let redeemWindow = -1;
  let redeemFailures = 0;

  function rollRedeemWindow(): void {
    const window = Math.floor(Date.now() / 60_000);
    if (window !== redeemWindow) {
      redeemAttempts.clear();
      redeemWindow = window;
      redeemFailures = 0;
    }
  }

  /** Per-IP limit: every redeem attempt counts, valid or not. */
  function consumeRedeemAttempt(ip: string): boolean {
    rollRedeemWindow();
    const attempts = redeemAttempts.get(ip) ?? 0;
    if (attempts >= REDEEM_ATTEMPTS_PER_IP) return false;
    if (attempts === 0 && redeemAttempts.size >= MAX_TRACKED_REDEEM_IPS) {
      const oldest = redeemAttempts.keys().next().value;
      if (oldest !== undefined) redeemAttempts.delete(oldest);
    }
    redeemAttempts.set(ip, attempts + 1);
    return true;
  }

  /** Process-wide limit: only failed redeems count (issue #61). */
  function recordRedeemFailure(): boolean {
    rollRedeemWindow();
    if (redeemFailures >= REDEEM_FAILURES_PER_PROCESS) return false;
    redeemFailures++;
    return true;
  }

  api.addHook("onRequest", async (request, reply) => {
    const { browserRateBucket, displayRedeem } = request.routeOptions.config;
    let allowed = true;
    if (displayRedeem) {
      allowed = consumeRedeemAttempt(request.ip);
    } else if (request.auth?.state === "authenticated") {
      const { actorId } = request.auth;
      const kind = request.method === "GET" || request.method === "HEAD" ? "browser_read" : "ordinary";
      allowed = await consumeRequest(pool, actorId, "general", kind)
        && (browserRateBucket === undefined || await consumeRequest(pool, actorId, browserRateBucket));
    }
    if (!allowed) return reply.code(429).header("retry-after", "60").send(rateLimitedBody(request));
  });

  // The process-wide redeem budget is judged after the code lookup, so a
  // correct code always pairs and failures from many IPs cannot block
  // legitimate displays. Once the failure budget is spent, a wrong, expired
  // or unknown code answers 429 instead of 404. Both mean "not redeemed" and
  // both paths do the same single hash lookup, so exhaustion tells a caller
  // nothing a 404 would not; guessing stays bounded by the per-IP limit and
  // the 36^6 code space against short-lived, single-use codes.
  api.addHook("onSend", async (request, reply, payload) => {
    if (!request.routeOptions.config.displayRedeem || reply.statusCode !== 404) return payload;
    if (recordRedeemFailure()) return payload;
    reply.code(429).header("retry-after", "60").type("application/json; charset=utf-8");
    return JSON.stringify(rateLimitedBody(request));
  });
}
