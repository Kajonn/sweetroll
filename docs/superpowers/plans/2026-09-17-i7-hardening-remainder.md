# I7 Hardening Remainder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the repo-scoped remainder of I7 hardening so design §17.10 ("backup restoration, monitoring, alerting, load testing, incident runbook exercised before public beta") is evidenced, leaving only explicit owner-gated items blocked.

**Architecture:** Build on the landed hardening evidence (axe spec, co-GM proof, SLO buckets, `scripts/backup.sh`, runbook) without inventing production infrastructure: a checked-in schedule example plus a retention script for RPO, a compose WAL-override for opt-in PITR, a file-based Prometheus/alerts bundle validated by unit tests, and minimal static serving of the built web client from the existing Fastify app with SPA fallback.

**Tech Stack:** TypeScript/Fastify on Node.js 24, PostgreSQL 17 via `docker compose exec`, bash (`set -euo pipefail`), `@fastify/static`, `prom-client`, Vitest, Playwright Chromium (existing patterns only).

**Spec:** `design_v2.md` §§11.4, 12.3, 15, 17.9 (task 10), 17.9a, 17.10, 18.1 (OD-05, OD-08); GUI plan G9 (`docs/superpowers/plans/2026-09-08-gui-integration.md`); prior hardening plan (`docs/superpowers/plans/2026-09-15-i7-hardening.md`) and its acceptance record (`docs/acceptance/i7-2026-09-15-hardening.md`) with the open-gaps list.

## Global Constraints

- One deployable artifact; no package-format change; no new production service, cloud resource, or OIDC provider (production auth stays owner-deferred per OD-05).
- All browser specs run with caller-managed resources: fresh scratch DB in this repo's compose postgres, `AUTHORITATIVE_ROLL_SECRET=development-only-roll-secret-32-bytes`, dedicated `BACKEND_PORT`/`WEB_PORT`, `CI=1`, `SWEETROLL_BACKEND_TARGET=http://localhost:<backend>`; `workers: 1`, `retries: 0` preserved.
- Destructive drill commands (CREATE/DROP DATABASE, pg_restore, `docker pause`) run ONLY inside this repo's compose postgres (`docker compose exec postgres ...`) against `sweetroll_drill*` / `sweetroll_hard_*` scratch databases. Never target `localhost:5432` from host tooling if that port belongs to another project (check `docker compose ps` first) and never touch the `sweetroll` dev database except as the backup source.
- New authorization/cache failures found during this work block acceptance and receive their own regression-first repair; never weaken a test to fit current behavior.
- Record tested commit, exact commands, actual result, and limitations in `docs/acceptance/i7-2026-09-17-hardening-remainder.md`. Do not claim production, physical-device, or deployment acceptance from local Chromium results.
- Preview-as-player (closed 2026-09-17), NPC list, §4 nav, co-GM proof, axe spec, and historical I1–I4 records are done — do not restart them.

---

## File map

| File | Responsibility |
| --- | --- |
| `scripts/backup-prune.sh` (create) | Retention enforcement for timestamped backup dirs (keep N daily, keep all manifests); refuses `data/` and non-backup dirs |
| `ops/backups/backup.cron.example` (create) | Cron schedule example achieving RPO ≤ 15 min (every 10 min) + manifest check |
| `docs/operations/backup-restore.md` (modify) | Append schedule + retention + production-volume re-drill evidence |
| `scripts/seed-volume-fixture.ts` (create) | Seeded volume fixture (N campaigns/characters/notes) for production-scale drill timing only |
| `compose.pitr.yaml` (create) | Compose override enabling WAL archiving (`archive_mode=on`, `archive_command` to a volume) for opt-in PITR |
| `docs/operations/pitr.md` (create) | PITR procedure (base backup + WAL replay drill on scratch), honest gap statement if not exercised at scale |
| `ops/prometheus/prometheus.yml` (create) | Scrape config for `/metrics` + `/health/ready` probing (file only, not deployed) |
| `ops/prometheus/alerts.yml` (create) | Alert rules for availability + 300/500 ms p95 (file only, not deployed) |
| `src/platform/alerts.test.ts` (create) | Unit test locking alert expressions to existing series names and bucket boundaries |
| `docs/operations/slo.md` (modify) | Point SLO table at the new bundle files; keep `not-deployed` honesty until a real host exists |
| `src/transport/http/static.ts` (create) | Fastify plugin serving `web/dist` with SPA fallback excluding `/api`, `/metrics`, `/health/*` |
| `src/transport/http/static.test.ts` (create) | Route-level tests for static serving, fallback, MIME, and API exclusion |
| `src/bootstrap/http.ts` (modify) | Register the static plugin when `SWEETROLL_SERVE_STATIC=1` (default off in dev) |
| `Dockerfile` (modify) | Copy built `web/dist` into the runtime image so the single artifact serves UI + API |
| `docs/acceptance/g9-2026-09-17-device-playtest.md` (create) | G9 protocol + owner-gated re-verification (mockup 401, OD-08, production auth, devices, playtests) |
| `docs/acceptance/i7-2026-09-17-hardening-remainder.md` (create) | Acceptance record for Tasks 1–5 + full verification matrix |

---

### Task 1: Backup schedule, retention, and production-volume re-drill

**Files:**
- Create: `scripts/backup-prune.sh`
- Create: `ops/backups/backup.cron.example`
- Create: `scripts/seed-volume-fixture.ts`
- Modify: `docs/operations/backup-restore.md`
- Test: manual drill commands recorded in the acceptance record (no new unit suite; the prune script has a `--dry-run` self-check)

**Interfaces:**
- Consumes: `scripts/backup.sh <output-dir>` (usage `scripts/backup.sh <output-dir>`, refuses non-empty/`data/`/`sweetroll` targets, writes `sweetroll.dump` + `media.tar.gz` + `manifest.txt` with `migrations_max` from `schema_migrations(max(filename))`); compose service `postgres` (`compose.yaml:2-16`).
- Produces (used by Task 6): scheduled-backup procedure achieving RPO ≤ 15 min, retention rule, and large-volume restore timing for the acceptance record.

- [ ] **Step 1: Write `scripts/backup-prune.sh`**

Create `scripts/backup-prune.sh` with exactly this content (executable, `set -euo pipefail`, dry-run first):

```bash
#!/usr/bin/env bash
# Retain timestamped backup dirs: keep newest $KEEP (default 144 = 24h at 10-min cadence).
# Usage: scripts/backup-prune.sh <backup-root> [KEEP] [--dry-run]
# Safety: refuses roots inside <repo>/data; only deletes dirs matching backup-*[0-9].
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
root="${1:?usage: scripts/backup-prune.sh <backup-root> [KEEP] [--dry-run]}"
keep="${2:-144}"
dry_run="0"
if [[ "${keep}" == "--dry-run" ]]; then dry_run="1"; keep="144"; fi
if [[ "${3:-}" == "--dry-run" ]]; then dry_run="1"; fi
resolved="$(realpath "$root")"
if [[ "$resolved" == "$repo_root/data" || "$resolved" == "$repo_root/data"/* ]]; then
  echo "error: backup root must not be inside $repo_root/data" >&2; exit 1
fi
mapfile -t dirs < <(ls -1d "$resolved"/backup-*[0-9] 2>/dev/null | sort)
total="${#dirs[@]}"
remove=$((total - keep))
if [[ "$remove" -le 0 ]]; then echo "prune: $total dirs, keep $keep, nothing to remove"; exit 0; fi
for ((i = 0; i < remove; i++)); do
  if [[ "$dry_run" == "1" ]]; then echo "would remove ${dirs[$i]}";
  else echo "removing ${dirs[$i]}"; rm -rf "${dirs[$i]}"; fi
done
```

Run: `chmod +x scripts/backup-prune.sh && mkdir -p /tmp/opencode/prune-selfcheck && mkdir -p /tmp/opencode/prune-selfcheck/backup-0001 /tmp/opencode/prune-selfcheck/backup-0002 /tmp/opencode/prune-selfcheck/backup-0003 && scripts/backup-prune.sh /tmp/opencode/prune-selfcheck 2 --dry-run`
Expected: prints `would remove .../backup-0001` and exits 0, deleting nothing (`ls /tmp/opencode/prune-selfcheck` still shows 3 dirs). Clean up: `rm -rf /tmp/opencode/prune-selfcheck`.

- [ ] **Step 2: Write the cron example**

Create `ops/backups/backup.cron.example` with exactly this content:

```cron
# Sweetroll scheduled backups — RPO <= 15 min requires <= 10 min cadence.
# Install with `crontab -e` on the backup host (NOT in CI). Example-only until
# a production host exists; the hardening drill used manual runs.
# Every 10 minutes: timestamped backup + retention (keep newest 144 = 24h).
SHELL=/bin/bash
*/10 * * * * cd /opt/sweetroll && ./scripts/backup.sh "/var/backups/sweetroll/backup-$(date -u +\%Y\%m\%dT\%H\%M\%SZ)" >>/var/log/sweetroll-backup.log 2>&1 && ./scripts/backup-prune.sh /var/backups/sweetroll 144 >>/var/log/sweetroll-backup.log 2>&1
```

Run: `crontab -l 2>/dev/null | head -5; echo "---"; cat ops/backups/backup.cron.example`
Expected: file prints as above; no crontab is modified (this step only records the example).

- [ ] **Step 3: Write the volume fixture seeder**

Create `scripts/seed-volume-fixture.ts` with exactly this content (test-data only, deterministic prefix `vol-drill-`):

```ts
// Seeds a production-like volume into a SCRATCH database only.
// Usage: TEST_DATABASE_URL=... npx tsx scripts/seed-volume-fixture.ts [campaigns=20 charactersPerCampaign=50]
// Never point at the dev `sweetroll` database; the drill doc requires sweetroll_drill_* targets.
import { Pool } from "pg";

const url = process.env.TEST_DATABASE_URL ?? "";
if (!url || /\/sweetroll(\?|$)/.test(url)) {
  console.error("refusing: TEST_DATABASE_URL must be a sweetroll_drill_* scratch database");
  process.exit(1);
}
const campaigns = Number(process.argv[2] ?? 20);
const perCampaign = Number(process.argv[3] ?? 50);
const pool = new Pool({ connectionString: url });
const owner = "00000000-0000-0000-0000-000000000001";
await pool.query(`INSERT INTO users (id, display_name) VALUES ($1, 'vol-drill') ON CONFLICT (id) DO NOTHING`, [owner]);
for (let c = 0; c < campaigns; c++) {
  const camp = await pool.query(
    `INSERT INTO campaigns (owner_id, system_version_id, settings_json, status) VALUES ($1, (SELECT version_id FROM system_versions LIMIT 1), '{}', 'active') RETURNING id`,
    [owner],
  );
  const campId: string = camp.rows[0].id;
  for (let i = 0; i < perCampaign; i++) {
    await pool.query(
      `INSERT INTO characters (owner_id, campaign_id, revision, state_json) VALUES ($1, $2, 1, $3)`,
      [owner, campId, JSON.stringify({ name: `vol-drill-${c}-${i}` })],
    );
  }
}
await pool.end();
console.log(`seeded campaigns=${campaigns} perCampaign=${perCampaign}`);
```

Run: `npm run typecheck` from root.
Expected: clean (the script compiles; it is not executed against dev data in this step).

- [ ] **Step 4: Execute the production-volume re-drill on scratch targets**

Run (all through compose postgres, scratch names only):

```bash
docker compose exec -T postgres psql -U sweetroll -d postgres -c "CREATE DATABASE sweetroll_drill_volume;"
TEST_DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll_drill_volume npx tsx scripts/seed-volume-fixture.ts 20 50
time scripts/backup.sh /tmp/opencode/drill-volume
docker compose cp /tmp/opencode/drill-volume/sweetroll.dump postgres:/tmp/drill-volume.dump
docker compose exec -T postgres psql -U sweetroll -d postgres -c "CREATE DATABASE sweetroll_drill_volume_restore;"
time docker compose exec -T postgres pg_restore -U sweetroll -d sweetroll_drill_volume_restore --clean --if-exists /tmp/drill-volume.dump
docker compose exec -T postgres psql -U sweetroll -d sweetroll_drill_volume -tAc "SELECT count(*) FROM characters"
docker compose exec -T postgres psql -U sweetroll -d sweetroll_drill_volume_restore -tAc "SELECT count(*) FROM characters"
docker compose exec -T postgres psql -U sweetroll -d postgres -c "DROP DATABASE sweetroll_drill_volume_restore;"
docker compose exec -T postgres psql -U sweetroll -d postgres -c "DROP DATABASE sweetroll_drill_volume;"
docker compose exec -T postgres rm /tmp/drill-volume.dump
```

Expected: both character counts print `1000`/`1000` (20×50), backup+restore wall-clock timings recorded for Task 6 (they replace the 101 KB small-volume caveat). If host port 5432 belongs to another project, create the scratch DBs via that reachable container exactly as the 2026-09-15 drill did, but still run ALL destructive steps only against `sweetroll_drill_*`.

- [ ] **Step 5: Append schedule + retention + volume evidence to `docs/operations/backup-restore.md`**

Append a section `## Scheduled backups and retention (2026-09-17)` documenting: the cron file path and 10-minute cadence with the RPO math (backup every 10 min ⇒ RPO ≤ 10 min < 15 min target), the prune command with KEEP=144, and the Step 4 volume timings plus before/after character counts. Keep the existing small-volume caveat and add one line stating it is superseded by the volume drill numbers.

Run: `git diff --check`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add scripts/backup-prune.sh ops/backups/backup.cron.example scripts/seed-volume-fixture.ts docs/operations/backup-restore.md
git commit -m "feat(i7): add backup schedule, retention, and volume re-drill"
```

---

### Task 2: Opt-in PITR (WAL archiving compose override + procedure)

**Files:**
- Create: `compose.pitr.yaml`
- Create: `docs/operations/pitr.md`

**Interfaces:**
- Consumes: base `compose.yaml` service `postgres` (image `postgres:17-alpine`, volume `sweetroll-postgres`); migrations high-water mark query on `schema_migrations(max(filename))` from `docs/operations/backup-restore.md:60-62`.
- Produces (used by Task 6): an opt-in PITR path with a scratch-only drill, or an honest `not-exercised` gap statement.

- [ ] **Step 1: Write `compose.pitr.yaml`**

Create `compose.pitr.yaml` with exactly this content (override only, base file untouched):

```yaml
# Opt-in WAL archiving for point-in-time recovery drills.
# Usage: docker compose -f compose.yaml -f compose.pitr.yaml up -d
# Never applied to the dev database without owner approval; drills use scratch DBs.
services:
  postgres:
    command: ["postgres", "-c", "archive_mode=on", "-c", "archive_command='test ! -f /var/lib/postgresql/wal_archive/%f && cp %p /var/lib/postgresql/wal_archive/%f'", "-c", "max_wal_senders=2", "-c", "wal_level=replica"]
    volumes:
      - sweetroll-postgres:/var/lib/postgresql/data
      - sweetroll-wal:/var/lib/postgresql/wal_archive

volumes:
  sweetroll-wal:
```

Run: `docker compose -f compose.yaml -f compose.pitr.yaml config | grep -A3 "archive_mode\|wal_archive"`
Expected: prints the `archive_mode=on` command line and the `sweetroll-wal` volume (config validates; no containers started in this step).

- [ ] **Step 2: Write `docs/operations/pitr.md`**

Create `docs/operations/pitr.md` with these sections and no invented timings: `Base backup` (exact `pg_basebackup` via compose exec into a scratch dir), `WAL replay drill` (create scratch DB, write a marker row with timestamp, base-backup, write a second marker row, kill scratch DB, replay to a recovery target with `recovery_target_time` set between the two markers, assert only the first marker is present), `Verification queries` (the two `SELECT` statements), and `Status` (either measured drill output or the literal line `PITR drill: NOT-EXERCISED — WAL override validated by config only` if the drill fails for environment reasons).

Run: `git diff --check`
Expected: clean.

- [ ] **Step 3: Exercise the drill on scratch targets (or record NOT-EXERCISED)**

Run the commands from the `pitr.md` drill section verbatim against `sweetroll_drill_pitr*` names only. On success paste wall-clock output into `pitr.md`; on environment failure keep the `NOT-EXERCISED` line and quote the failing command + output in Task 6's record instead of inventing numbers.

- [ ] **Step 4: Commit**

```bash
git add compose.pitr.yaml docs/operations/pitr.md
git commit -m "feat(i7): add opt-in WAL archiving with PITR drill"
```

---

### Task 3: Deployable observability bundle (Prometheus + alerts as files)

**Files:**
- Create: `ops/prometheus/prometheus.yml`
- Create: `ops/prometheus/alerts.yml`
- Create: `src/platform/alerts.test.ts`
- Modify: `docs/operations/slo.md`

**Interfaces:**
- Consumes: series `sweetroll_http_requests_total` and `sweetroll_http_request_duration_seconds` with `le="0.3"`/`le="0.5"` buckets (`src/platform/metrics.ts:10-19`, locked by `src/transport/http/app.test.ts:104-115`); endpoints `GET /health/ready` (503 `{"status":"unavailable"}` DB-down path) and `GET /metrics`.
- Produces (used by Task 6): a file bundle a future host can deploy unchanged, with unit-locked series/labels.

- [ ] **Step 1: Write `ops/prometheus/prometheus.yml`**

Create with exactly this content:

```yaml
# File-only bundle (not deployed): scrape the single artifact's endpoints.
global:
  scrape_interval: 15s
  evaluation_interval: 15s
scrape_configs:
  - job_name: sweetroll
    static_configs:
      - targets: ["localhost:3000"]
    metrics_path: /metrics
  - job_name: sweetroll-ready
    static_configs:
      - targets: ["localhost:3000"]
    metrics_path: /health/ready
```

- [ ] **Step 2: Write `ops/prometheus/alerts.yml`**

Create with exactly this content (expressions must match the series/labels in `slo.md` and `metrics.ts`):

```yaml
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
      - alert: SweetrollRuleActionLatencyBreach
        expr: histogram_quantile(0.95, sum(rate(sweetroll_http_request_duration_seconds_bucket{route="/characters/:characterId/actions/:actionId"}[5m])) by (le)) > 0.5
        for: 10m
        labels:
          severity: page
        annotations:
          summary: "Rule-action p95 latency above 500 ms SLO"
      - alert: SweetrollAvailabilitySLOBreach
        expr: sum(rate(sweetroll_http_requests_total{status_code!~"5.."}[5m])) / sum(rate(sweetroll_http_requests_total[5m])) < 0.999
        for: 10m
        labels:
          severity: page
        annotations:
          summary: "Availability below 99.9% SLO"
```

- [ ] **Step 3: Write the locking unit test `src/platform/alerts.test.ts`**

Create with exactly this content (reads the YAML files as text, no new dependencies):

```ts
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
```

Run: `npx vitest run src/platform/alerts.test.ts` from root.
Expected: FAIL with `ENOENT`/`Cannot find` before Steps 1–2 files exist; PASS after writing them.

- [ ] **Step 4: Point `docs/operations/slo.md` at the bundle**

In `docs/operations/slo.md`, replace the "Alert-rule sketch (example-only, not deployed)" section header with `## Deployable bundle (file-only, not deployed)` and add two lines: `Scrape: ops/prometheus/prometheus.yml` and `Alerts: ops/prometheus/alerts.yml (locked by src/platform/alerts.test.ts)`. Keep the `not-deployed` honesty banner unchanged.

Run: `npx vitest run src/platform/alerts.test.ts && npm run typecheck` from root.
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add ops/prometheus/prometheus.yml ops/prometheus/alerts.yml src/platform/alerts.test.ts docs/operations/slo.md
git commit -m "feat(i7): add file-based SLO scrape and alert bundle"
```

---

### Task 4: Single-artifact deployment (serve built web client from Fastify)

**Files:**
- Create: `src/transport/http/static.ts`
- Create: `src/transport/http/static.test.ts`
- Modify: `src/bootstrap/http.ts`
- Modify: `Dockerfile`
- Modify: `package.json` (add `@fastify/static` dependency — run `npm install`)

**Interfaces:**
- Consumes: `buildHttpApp` in `src/transport/http/*`; built client in `web/dist` (`index.html`, `assets/`, `manifest.webmanifest`); API route prefixes `/api`, `/metrics`, `/health/*` (must never fall through to `index.html`).
- Produces (used by Task 6): `docker build -t sweetroll .` artifact that serves UI + API on one port with verified SPA fallback.

- [ ] **Step 1: Write the failing static test**

Create `src/transport/http/static.test.ts` with exactly this content:

```ts
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerStaticServing } from "./static.js";

describe("static serving", () => {
  it("serves index.html for unknown non-API routes and never for /api", async () => {
    const app = Fastify();
    await app.register(registerStaticServing, { distDir: "web/dist", enabled: true });
    const deep = await app.inject({ method: "GET", url: "/campaigns/abc" });
    expect(deep.statusCode).toBe(200);
    expect(deep.headers["content-type"]).toContain("text/html");
    const api = await app.inject({ method: "GET", url: "/api/unknown-route-xyz" });
    expect(api.statusCode).toBe(404);
    expect(api.headers["content-type"] ?? "").not.toContain("text/html");
  });
});
```

Run: `npx vitest run src/transport/http/static.test.ts` from root.
Expected: FAIL with `Cannot find module './static.js'`.

- [ ] **Step 2: Implement `src/transport/http/static.ts`**

Create with exactly this content:

```ts
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import fastifyStatic from "@fastify/static";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const registerStaticServing: FastifyPluginAsync<{
  distDir: string;
  enabled: boolean;
}> = async (app: FastifyInstance, opts) => {
  if (!opts.enabled) return;
  const root = path.resolve(opts.distDir);
  if (!existsSync(path.join(root, "index.html"))) return;
  await app.register(fastifyStatic, { root, prefix: "/", decorateReply: false });
  app.setNotFoundHandler((request, reply) => {
    const url = request.url.split("?")[0];
    if (url.startsWith("/api") || url.startsWith("/metrics") || url.startsWith("/health")) {
      reply.code(404).send({ code: "not_found", message: "Not found" });
      return;
    }
    reply.type("text/html").send(readFileSync(path.join(root, "index.html"), "utf8"));
  });
};
```

Run: `npm install --save @fastify/static && npx vitest run src/transport/http/static.test.ts` from root.
Expected: PASS (1 passed).

- [ ] **Step 3: Wire the plugin in `src/bootstrap/http.ts` + ship `web/dist` in `Dockerfile`**

In `src/bootstrap/http.ts` after `buildHttpApp({...})` (line 126–135), insert:

```ts
const serveStatic = process.env.SWEETROLL_SERVE_STATIC === "1";
void app.register((await import("../transport/http/static.js")).registerStaticServing, {
  distDir: "web/dist",
  enabled: serveStatic,
});
```

Static `import` at the top is also acceptable if the dynamic import trips `tsc`; keep behavior identical (env-gated, default off).

In `Dockerfile`, in the final stage after `COPY --chown=node:node ./dist ./dist`, insert:

```dockerfile
COPY --chown=node:node web/dist ./web/dist
```

Run: `npm run typecheck && npm run build && docker build -t sweetroll .` from root.
Expected: typecheck clean, build clean, docker build pass. Then verify the artifact serves both: `docker run --rm -e SWEETROLL_SERVE_STATIC=1 -p 3129:3000 sweetroll & sleep 5; curl -s -o /dev/null -w "ui %{http_code}\n" http://localhost:3129/campaigns/abc; curl -s -o /dev/null -w "api %{http_code}\n" http://localhost:3129/api/unknown-route-xyz; docker stop $(docker ps -q --filter publish=3129)` — expect `ui 200` and `api 404`.

- [ ] **Step 4: Commit**

```bash
git add src/transport/http/static.ts src/transport/http/static.test.ts src/bootstrap/http.ts Dockerfile package.json package-lock.json
git commit -m "feat(i7): serve built web client from the single artifact"
```

---

### Task 5: G9 owner-gated re-verification + device/playtest protocol

**Files:**
- Create: `docs/acceptance/g9-2026-09-17-device-playtest.md`

**Interfaces:**
- Consumes: GUI plan G9 boxes (real Android Chrome + iPad Safari, 200% text, built-artifact offline reopening, physical-table + remote playtests); OD-08 template decision; OD-05 production-auth deferral; mockup URL `https://tablefolk-ttrpg-mockups.humdrumrat.chatgpt.site` (blocked HTTP 401 on 2026-09-09).
- Produces (used by Task 6): dated blocked/verified status for every item that cannot close without the owner, plus a runnable playtest script.

- [ ] **Step 1: Write `docs/acceptance/g9-2026-09-17-device-playtest.md`**

Create the file with these exact sections (no invented device results): `## Mockup recheck` (run `curl -s -o /dev/null -w "%{http_code}\n" https://tablefolk-ttrpg-mockups.humdrumrat.chatgpt.site` and paste the code + date; expected still `401` unless the owner republished), `## OD-08 launch templates` (list the three license-neutral reference fixtures from design §6.7/§17.9 and the literal line `No shipped open-license template claimed — license review outstanding`), `## Production auth` (OD-05 deferred; test/prod separation via `resolveAuthMode` done; real-provider sign-in still open with the exact acceptance from release-gates Task 4: real provider return, concurrent first sign-in → one user, expiry, revocation, secure sign-out), `## Device matrix` (empty table with columns Device/OS/Browser/Theme/Width/Result — zero rows claimed), `## Playtest script` (physical-table session + remote session with 4 players, phone GM/player, separate restricted tablet display; capture usability/data-loss/disclosure findings; close blockers before public release), `## Built-artifact check` (deep-link refresh, sign-in return, fully offline shell reopening against the Task 4 image — run only after Task 4 lands).

- [ ] **Step 2: Run the mockup recheck and fill the date + code**

Run: `curl -s -o /dev/null -w "%{http_code}\n" https://tablefolk-ttrpg-mockups.humdrumrat.chatgpt.site; date -u +%F`
Expected: `401` (or paste the actual code if it changed — never claim values without running).

- [ ] **Step 3: Commit**

```bash
git add docs/acceptance/g9-2026-09-17-device-playtest.md
git commit -m "docs(i7): record G9 owner-gated status and playtest protocol"
```

---

### Task 6: Remainder acceptance + status reconciliation

**Files:**
- Create: `docs/acceptance/i7-2026-09-17-hardening-remainder.md`
- Modify: `design_v2.md` (§17.9 status only), `docs/superpowers/plans/2026-09-08-gui-integration.md` (G9 boxes touched by this plan's evidence only)

**Interfaces:**
- Consumes: evidence from Tasks 1–5 (schedule + volume timings, PITR drill or NOT-EXERCISED, bundle test, artifact curl output, G9 protocol).
- Produces: the remainder closure record. Must NOT close: production auth, mockup capture, real-device checks, physical/remote playtests, or any deployment against a host that does not exist.

- [ ] **Step 1: Write the acceptance record**

Create `docs/acceptance/i7-2026-09-17-hardening-remainder.md` with: tested commits table (Tasks 1–5 hashes), per-task commands + verbatim outcomes + limitations (Chromium-only, no real devices, no production traffic, drill volumes stated in rows/bytes, PromQL file-only, artifact verified locally only), the Task 1 volume p95/timing table, Task 4 `ui 200 / api 404` output, and an explicit open-gaps list (production auth, mockup 401, G9 devices/playtests, any NOT-EXERCISED PITR half, no production host).

- [ ] **Step 2: Run full verification**

From root: `npm test`, `TEST_DATABASE_URL=... npm run test:integration --no-file-parallelism`, `npm run typecheck`, `npm run contracts:check`, `npm run build`; from `web/`: `npm test`, `npm run typecheck`, `npm run build`; canonical `E2E_DATABASE_ADMIN_URL=... npm run web:test:e2e`; `docker build -t sweetroll .`; `git diff --check`. A single-test web-unit flake requires two consecutive green reruns before claiming green (precedent 2026-09-15). Record every result in the acceptance record.

- [ ] **Step 3: Update status docs**

In `design_v2.md` §17.9, append the remainder outcome (RPO-schedule + retention + volume timing, PITR opt-in status, file-only observability bundle, single-artifact serving) with the evidence pointer, and restate that full I7/GUI-release stay open per the gaps list. In the GUI plan, check ONLY the G9 boxes this plan's evidence actually satisfies; leave devices, playtests, mockup, and production-auth boxes untouched.

- [ ] **Step 4: Commit**

```bash
git add docs/acceptance/i7-2026-09-17-hardening-remainder.md design_v2.md docs/superpowers/plans/2026-09-08-gui-integration.md
git commit -m "docs(i7): record hardening-remainder acceptance and reconcile status"
```

---

## Self-review

1. **Spec coverage:** design §15 RPO/RTO → Tasks 1–2; §11.4 latency budgets → Task 3 (buckets already landed, bundle locks them); §17.9 task 10 leftovers (SLO dashboards, alerting, backup drill at volume, runbook prose-only halves stay documented — runbook halves (b)/(d) are covered by the Task 3 bundle references and Task 5 protocol, no fake exercise claimed); §17.10 backup/monitoring/alerting/load/runbook → Tasks 1–4 + prior load evidence (not re-run here except via Task 6 matrix); G9 release gates → Tasks 4–5; OD-05/OD-08/mockup → Task 5 (decision-gated, no invented provider/host/licenses).
2. **Placeholder scan:** no TBD/TODO/appropriate-handling/similar-to-Task-N steps remain — every step has literal file content, exact commands, and expected outputs. The only conditional is the honest PITR NOT-EXERCISED fallback, which quotes real output instead of inventing it.
3. **Type consistency:** `registerStaticServing` signature (`{ distDir: string; enabled: boolean }`) is identical in `static.ts` and `static.test.ts` and matches the `http.ts` registration call; alert route label `/characters/:characterId/actions/:actionId` matches `docs/operations/slo.md:16` and the landed follow-up `8a044f2`; scratch DB naming (`sweetroll_drill_*`, `sweetroll_hard_*`) matches the hardening global constraint; cron/prune paths (`ops/backups/`, `scripts/`) match the file map.
