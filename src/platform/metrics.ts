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
    help: "HTTP response duration in seconds",
    labelNames: ["method", "route", "status_code"] as const,
    name: "sweetroll_http_request_duration_seconds",
    registers: [registry],
  });

  return { duration, registry, requests };
}
