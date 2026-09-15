# Sweetroll SLOs (I7 hardening)

Source budgets: `design_v2.md` §§11.4 (p95 < 300 ms ordinary operations,
< 500 ms bounded rule actions) and 15 (99.9% availability, RPO ≤ 15 min,
RTO ≤ 4 h).

> **Deployment status: `not-deployed`.** There is no production
> Prometheus/alertmanager. The PromQL expressions and alert rules below are
> example-only: validated for syntax only, not evaluated against production
> traffic. HTTP buckets (`0.3`, `0.5`) resolve the 300/500 ms SLO queries.

| SLO | Measuring series / endpoint | Example PromQL |
| --- | --- | --- |
| Availability 99.9% | `GET /health/ready` (availability probing); `sweetroll_http_requests_total` (`/metrics`) | `sum(rate(sweetroll_http_requests_total{status_code!~"5.."}[5m])) / sum(rate(sweetroll_http_requests_total[5m]))` |
| Ordinary operations p95 < 300 ms | `sweetroll_http_request_duration_seconds` (`/metrics`), `le="0.3"` bucket | `histogram_quantile(0.95, sum(rate(sweetroll_http_request_duration_seconds_bucket[5m])) by (le)) < 0.3` |
| Bounded rule-action p95 < 500 ms | `sweetroll_http_request_duration_seconds` (`/metrics`), `le="0.5"` bucket | `histogram_quantile(0.95, sum(rate(sweetroll_http_request_duration_seconds_bucket{route="/characters/:characterId/actions/:actionId"}[5m])) by (le)) < 0.5` |
| RPO ≤ 15 min | Backup/export pipeline (no dedicated series yet) | n/a — verified by restore drill, not PromQL |
| RTO ≤ 4 h | `GET /health/ready` recovery probing (no dedicated series yet) | n/a — verified by recovery drill, not PromQL |

## Alert-rule sketch (example-only, not deployed)

```yaml
# Example-only: not deployed (no production Prometheus/alertmanager).
groups:
  - name: sweetroll-slo
    rules:
      - alert: SweetrollLatencySLOBreach
        expr: histogram_quantile(0.95, sum(rate(sweetroll_http_request_duration_seconds_bucket[5m])) by (le)) > 0.3
        for: 10m
        labels:
          severity: page
        annotations:
          summary: "Ordinary p95 latency above 300 ms SLO"
      - alert: SweetrollAvailabilitySLOBreach
        expr: sum(rate(sweetroll_http_requests_total{status_code!~"5.."}[5m])) / sum(rate(sweetroll_http_requests_total[5m])) < 0.999
        for: 10m
        labels:
          severity: page
        annotations:
          summary: "Availability below 99.9% SLO"
```
