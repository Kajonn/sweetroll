import { Counter, Histogram, Registry } from "prom-client";

export type HttpMetrics = ReturnType<typeof createHttpMetrics>;

export function createHttpMetrics() {
  const registry = new Registry();
  const requests = new Counter({
    help: "Completed HTTP requests",
    labelNames: ["method", "route", "status_code"] as const,
    name: "sweetroll_http_requests_total",
    registers: [registry],
  });
  const duration = new Histogram({
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.3, 0.5, 1, 2.5, 5, 10],
    help: "HTTP response duration in seconds",
    labelNames: ["method", "route", "status_code"] as const,
    name: "sweetroll_http_request_duration_seconds",
    registers: [registry],
  });

  return { duration, registry, requests };
}
