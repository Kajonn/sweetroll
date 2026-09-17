import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("observability bundle", () => {
  it("alert expressions reference only shipped series and SLO buckets", () => {
    const alerts = readFileSync("ops/prometheus/alerts.yml", "utf8");
    expect(alerts).toContain("sweetroll_http_request_duration_seconds_bucket");
    expect(alerts).toContain("sweetroll_http_requests_total");
    expect(alerts).toContain("> 0.3");
    expect(alerts).toContain("> 0.5");
    expect(alerts).toContain("< 0.999");
    expect(alerts).toContain("/characters/:characterId/actions/:actionId");
    const prometheus = readFileSync("ops/prometheus/prometheus.yml", "utf8");
    expect(prometheus).toContain("/metrics");
    expect(prometheus).toContain("/health/ready");
  });
});
