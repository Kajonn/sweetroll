# I7 Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close design §17.9 task 10 (WCAG review, session load evidence, SLO/metrics, backup-restoration drill, incident runbook) with repo-scoped, actually-executed evidence.

**Architecture:** No new infrastructure is invented: axe coverage extends the existing `@axe-core/playwright` pattern to campaign/GM/display routes; co-GM conflict proof reuses the gmSetupJourney role-management flow with two isolated contexts; load evidence re-runs the existing burst suites; SLO work aligns histogram buckets to the documented latency budgets and records queryable definitions; backup drill runs `pg_dump`/`pg_restore` inside this repo's own compose postgres against scratch databases only; the runbook exercise kills and restarts a scratch-port backend.

**Tech Stack:** Vitest, Playwright Chromium, `@axe-core/playwright`, `prom-client`, PostgreSQL 17 (`pg_dump`/`pg_restore` via `docker compose exec`), pino logs, existing `/health/*` + `/metrics`.

**Spec:** `design_v2.md` §§12.3, 15, 17.9 (task 10), 17.10; GUI plan G7/G9; [release gates](2026-09-12-campaign-acceptance-release-gates.md) Tasks 3–4; [I7b spec](2026-09-14-i7b-scenes-display-design.md) §hardening-excluded (this plan is that separate slice).

## Global Constraints

- One deployable artifact; no package-format change; no new production service, cloud resource, or OIDC provider.
- All browser specs run with caller-managed resources: fresh scratch DB, `AUTHORITATIVE_ROLL_SECRET=development-only-roll-secret-32-bytes`, dedicated `BACKEND_PORT`/`WEB_PORT`, `CI=1`, `SWEETROLL_BACKEND_TARGET=http://localhost:<backend>`; `workers: 1`, `retries: 0` preserved.
- Destructive drill commands (CREATE/DROP DATABASE, pg_restore) run ONLY inside this repo's compose postgres (`docker compose exec postgres ...`) against `sweetroll_drill*` scratch databases. Never target `localhost:5432` from host tooling (that port belongs to another project's postgres) and never touch the `sweetroll` dev database.
- New authorization/cache failures found by Tasks 1–2 block acceptance and receive their own regression-first repair; never weaken the test to fit current behavior.
- Record tested commit, commands, actual result, and limitations in `docs/acceptance/i7-2026-09-15-hardening.md`. Do not claim production, physical-device, or deployment acceptance from local Chromium results.
- Preview-as-player, launch-template licensing, production auth, mockup capture, and G9 playtests stay open and are not closed by this plan.

---

## File map

| File | Responsibility |
| --- | --- |
| `web/tests/e2e/campaignAccessibility.spec.ts` (create) | Axe + keyboard + overflow checks for campaign/GM/display routes |
| `web/tests/e2e/gmCoGmConflict.spec.ts` (create) | Two-user (GM + co-GM) shared-content conflict + independent-resource proof |
| `src/platform/metrics.ts` (modify) | Histogram buckets aligned to 300/500 ms SLOs |
| `src/transport/http/app.test.ts` (modify) | Lock exposition of SLO-relevant bucket lines |
| `docs/operations/slo.md` (create) | SLO definitions mapped to prom series + example PromQL/alerts (docs, not deployed infra) |
| `scripts/backup.sh` (create) | `pg_dump -Fc` via compose exec + media-dir tar; refuses non-scratch targets |
| `docs/operations/backup-restore.md` (create) | Procedure, PITR gap, drill evidence |
| `docs/operations/runbook.md` (create) | Incident procedures + exercise evidence |
| `docs/acceptance/i7-2026-09-15-hardening.md` (create) | Acceptance record for all tasks |

---

### Task 1: Campaign/GM axe accessibility spec

**Files:**
- Create: `web/tests/e2e/campaignAccessibility.spec.ts`
- Modify: none expected (product edits only for reproduced findings, same rule as Task 2 of the I4 remediation)

**Interfaces:**
- Consumes: `AxeBuilder` pattern from `web/tests/e2e/character-sheet.spec.ts:80-83`; dev-signin panel (`getByTestId("dev-signin")`); campaign creation UI from `web/tests/e2e/gmSessionJourney.spec.ts` `runJourney` steps 1–2 (read, do not copy blindly — this spec needs only one campaign + one note + one scene, seeded through the same UI path).
- Produces (used by Task 7): axe-clean evidence for GM/player campaign surfaces.

- [ ] **Step 1: Write the spec.** Create `web/tests/e2e/campaignAccessibility.spec.ts` covering, each at 360 and 1280 px width (height 800) in light mode plus one 360 px dark-mode pass (`page.emulateMedia({ colorScheme: "dark" })`): `/campaigns` list, campaign detail Characters tab, Content tab (one GM-only + one all-player note seeded), Session tab, Members tab, Campaign settings display-pairing section, and `/display` code-entry. Per route: assert `expectNoPageHorizontalOverflow` semantics (`document.documentElement.scrollWidth <= window.innerWidth + 1`), run `await new AxeBuilder({ page }).analyze()` and assert zero `serious`/`critical` violations (exact shape from character-sheet.spec.ts:80-83), keyboard-check one primary control per route (`focus()` + `toBeFocused()` + `keyboard.press("Enter")` produces the visible committed state, same as the sheet spec's bump check). Seed one campaign through the UI (clone d20 via `clone-from-template-d20`, create campaign, author one note); clean up cloned systems in `afterEach` via `DELETE /api/systems/:id` (pattern from visual.spec.ts:27-32).

```ts
import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "@playwright/test";

test("campaigns list at 360px: axe, keyboard, no overflow", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/");
  await page.getByTestId("dev-signin").click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible({ timeout: 30_000 });
  await page.goto("/campaigns");
  await expect(page.getByTestId("campaign-list")).toBeAttached();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations.filter(v => v.impact === "serious" || v.impact === "critical")).toEqual([]);
});
```

- [ ] **Step 2: Run to verify it fails or exposes findings.** Run: `docker exec sweetroll-postgres-1 psql -U sweetroll -d postgres -c "CREATE DATABASE sweetroll_hard_a11y;"` (compose postgres; adjust container name from `docker compose ps` if it differs), then from `web/`: `DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll_hard_a11y AUTHORITATIVE_ROLL_SECRET=development-only-roll-secret-32-bytes BACKEND_PORT=3113 WEB_PORT=5183 CI=1 SWEETROLL_BACKEND_TARGET=http://localhost:3113 npx playwright test tests/e2e/campaignAccessibility.spec.ts --reporter=list`. NOTE: `localhost:5432` here resolves inside the isolated webServer backend which must reach the intended postgres — if the host port belongs to another project, create the scratch DB in the reachable postgres via its container (`docker exec <that-container> psql ...`) exactly as verified 2026-09-15, and still run ALL drill/destructive steps only against `sweetroll_hard_*` scratch DBs. Expected: FAIL with `Cannot find module` (spec absent) on first run; after writing, any axe/keyboard failure is a reproduced finding — fix the responsible component minimally (same-component rule) or record as open with the exact violation.
- [ ] **Step 3: Make it pass with minimal changes.** Product edits only for reproduced findings; test-only fixes otherwise. Re-run the Step 2 command on a fresh scratch DB. Expected: PASS.
- [ ] **Step 4: Commit.** `git add web/tests/e2e/campaignAccessibility.spec.ts` plus any fixed component/test files; `git commit -m "test(i7): add campaign/GM axe and keyboard accessibility spec"`.

---

### Task 2: Co-GM two-user conflict proof

**Files:**
- Create: `web/tests/e2e/gmCoGmConflict.spec.ts`
- Modify: none expected (same reproduced-findings-only rule as Task 1)

**Interfaces:**
- Consumes: role-management UI flow from `web/tests/e2e/gmSetupJourney.spec.ts:195-206` (invite → accept → `Change role` → `Confirm role change`); two-context pattern from `web/tests/e2e/gmSessionJourney.spec.ts:278` (`browser.newContext`, never two tabs sharing one query cache); revision-guard retry pattern from `gmSessionJourney.spec.ts` steps 11–12 (stale `expectedRevision` → explicit refresh → fresh key retry).
- Produces (used by Task 7): closes the release-gates Task 3 gap (same-account peer proof exists; two-user co-GM proof does not).

- [ ] **Step 1: Write the spec.** Create `web/tests/e2e/gmCoGmConflict.spec.ts`, one test, default desktop viewport: owner (`code-test-a`) creates a campaign through the UI and invites `code-test-b` (mirror `gmSetupJourney` invite steps); `code-test-b` accepts in a second context; owner promotes `code-test-b` to co-GM behind the confirm dialog (mirror `gmSetupJourney.spec.ts:195-206` selectors). Then: both contexts open the same content note editor; owner commits first; co-GM commits stale → assert explicit conflict UI (never "Merge"), co-GM re-reads and retries with a fresh `idempotencyKey` (assert `postDataJSON().idempotencyKey` differs and `expectedRevision` advanced, mirroring the gmSessionJourney retry assertions); assert both commits' effects present and no acknowledged update clobbered. Finally: owner and co-GM concurrently bump two DIFFERENT characters' resources (independent resources) and assert both apply with no conflict. `workers: 1`, `retries: 0` untouched.

```ts
const retryBody = (await retryRequest).postDataJSON() as Record<string, unknown>;
expect(retryBody.expectedRevision).not.toBe(firstBody.expectedRevision);
expect(retryBody.idempotencyKey).not.toBe(firstBody.idempotencyKey);
```

- [ ] **Step 2: Run to verify it fails.** Same isolated-DB command shape as Task 1 Step 2 with a fresh `sweetroll_hard_cogm` DB and ports `3114`/`5184`. Expected: FAIL with `Cannot find module` before writing; after writing, any 409-handling/clobber failure is a reproduced defect for regression-first repair.
- [ ] **Step 3: Make it pass.** Same rule as Task 1. Re-run on a fresh scratch DB. Expected: PASS.
- [ ] **Step 4: Commit.** `git add web/tests/e2e/gmCoGmConflict.spec.ts` plus any fixed files; `git commit -m "test(i7): prove co-GM shared-edit conflict and independent operation"`.

---

### Task 3: Session-burst load evidence

**Files:**
- Modify: none (evidence only). If a load suite fails, its failure is a blocker for Task 7 and gets its own repair; budgets are reported, never weakened to force green (existing comment in `tests/integration/campaign-load.test.ts:365`).

**Interfaces:**
- Consumes: `tests/integration/campaign-load.test.ts` (four-player burst, p95 ≤ 300 ms ordinary / ≤ 500 ms rolls), `tests/integration/character-load.test.ts` (session burst, same budgets), `tests/integration/character-concurrency.test.ts`, `tests/integration/identity-concurrency.test.ts`.
- Produces (used by Task 7): dated p95 table for the acceptance record.

- [ ] **Step 1: Run the load suites without competing load.** Ensure no e2e servers/dev runs are active against the target DB. Run: `TEST_DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll npx vitest run tests/integration/campaign-load.test.ts tests/integration/character-load.test.ts tests/integration/character-concurrency.test.ts tests/integration/identity-concurrency.test.ts --no-file-parallelism` from root. Capture the `[campaign-load] p95 latencies` and `[load] p95 latencies` console lines verbatim into the Task 7 acceptance record. Expected: PASS with ordinary p95 ≤ 300 ms, rolls ≤ 500 ms.
- [ ] **Step 2: Record only.** No commit unless a repair was required (then commit the repair separately with its red-first evidence).

---

### Task 4: SLO definitions + SLO-aligned histogram buckets

**Files:**
- Modify: `src/platform/metrics.ts` (custom `buckets` on the duration histogram)
- Modify: `src/transport/http/app.test.ts` (extend the `exports baseline HTTP metrics` test)
- Create: `docs/operations/slo.md`

**Interfaces:**
- Consumes: budgets in `design_v2.md` §§11.4 (p95 < 300 ms ordinary, < 500 ms bounded rule actions) and 15 (99.9% availability, RPO ≤ 15 min, RTO ≤ 4 h); existing series `sweetroll_http_requests_total`, `sweetroll_http_request_duration_seconds` (`src/platform/metrics.ts`); existing exposition test (`src/transport/http/app.test.ts:104-112`).
- Produces (used by Tasks 6–7): buckets that resolve 300/500 ms SLO queries; `docs/operations/slo.md` mapping each SLO to its series + example PromQL (documented, not deployed).

- [ ] **Step 1: Write the failing lock test.** In `src/transport/http/app.test.ts`, extend `exports baseline HTTP metrics`: after the existing assertions, assert the exposition contains a `le="0.3"` bucket line and a `le="0.5"` bucket line for `sweetroll_http_request_duration_seconds`:

```ts
expect(response.body).toContain('sweetroll_http_request_duration_seconds_bucket{');
expect(response.body).toMatch(/le="0\.3"/);
expect(response.body).toMatch(/le="0\.5"/);
```

- [ ] **Step 2: Run to verify it fails.** Run: `npx vitest run src/transport/http/app.test.ts` from root. Expected: FAIL on `le="0.3"` (prom-client defaults are `0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10` — `0.5` present, `0.3` absent).
- [ ] **Step 3: Implement SLO-aligned buckets.** In `src/platform/metrics.ts`, add `buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.3, 0.5, 1, 2.5, 5, 10]` to the `duration` Histogram (default set plus the 300 ms ordinary-operation SLO boundary; 500 ms already present). No other change.
- [ ] **Step 4: Run to verify it passes.** Same command as Step 2, then `npm run typecheck` from root. Expected: PASS, clean.
- [ ] **Step 5: Write `docs/operations/slo.md`.** Table mapping each design SLO (availability 99.9%, ordinary p95 < 300 ms, rule-action p95 < 500 ms, RPO ≤ 15 min, RTO ≤ 4 h) to: measuring series/endpoint (`/metrics` series incl. new buckets, `/health/ready` for availability probing), an example PromQL expression (e.g. `histogram_quantile(0.95, sum(rate(sweetroll_http_request_duration_seconds_bucket[5m])) by (le))`), and current deployment status honestly marked `not-deployed: no production Prometheus/alertmanager; expressions validated for syntax only, not evaluated against production traffic`. Include an alert-rule sketch (YAML) labeled example-only.
- [ ] **Step 6: Commit.** `git add src/platform/metrics.ts src/transport/http/app.test.ts docs/operations/slo.md`; `git commit -m "feat(i7): align request-duration buckets to latency SLOs with definitions"`.

---

### Task 5: Backup script + restore drill

**Files:**
- Create: `scripts/backup.sh`
- Create: `docs/operations/backup-restore.md`

**Interfaces:**
- Consumes: compose postgres service (`compose.yaml`: service `postgres`, db `sweetroll`, volume `sweetroll-postgres`, media volume `sweetroll-media` mounted at `/app/data/media`); `pg_dump`/`pg_restore` inside the compose container (`docker compose exec -T postgres ...` needs no published ports); `SWEETROLL_MEDIA_DIR ?? <repo>/data/media` disk layout (`src/campaigns/media.ts`).
- Produces (used by Task 7): repeatable backup procedure + measured drill evidence. Honest gap: no WAL archiving/PITR — RPO equals backup frequency until that is separately designed.

- [ ] **Step 1: Write `scripts/backup.sh`.** Executable bash script with `set -euo pipefail`. Usage: `scripts/backup.sh <output-dir>`. Steps: (1) refuse unless `output-dir` is given and empty-or-new; (2) `docker compose exec -T postgres pg_dump -U sweetroll -Fc sweetroll > <output-dir>/sweetroll.dump`; (3) `tar -czf <output-dir>/media.tar.gz -C data media` (skip with warning if `data/media` absent); (4) write `<output-dir>/manifest.txt` with timestamp, `git rev-parse HEAD`, `migrations` max applied version (`docker compose exec -T postgres psql -U sweetroll -d sweetroll -tAc "SELECT max(version) FROM ..."` — check the actual migrations tracking table name in `src/bootstrap/migrate.ts` first and use it verbatim), and file checksums. Guard: script aborts if `output-dir` resolves inside `data/` or matches `sweetroll` dev/prod database names — it backs up ONLY the compose postgres `sweetroll` database and never restores over it (restore targets are `sweetroll_drill_*` only; the script takes no restore-target argument at all).

```bash
#!/usr/bin/env bash
set -euo pipefail
out="${1:?usage: scripts/backup.sh <output-dir>}"
mkdir -p "$out"
docker compose exec -T postgres pg_dump -U sweetroll -Fc sweetroll > "$out/sweetroll.dump"
```

- [ ] **Step 2: Dry-run the script.** Run: `scripts/backup.sh /tmp/opencode/drill-backup` from root with the compose stack up (`docker compose up -d`). Expected: exit 0, `sweetroll.dump` + `media.tar.gz` (or recorded skip warning) + `manifest.txt` present. This is the RED-equivalent: missing manifest fields or a failed dump fail here before any docs are written.
- [ ] **Step 3: Execute the restore drill on scratch targets.** Run: `docker compose exec postgres psql -U sweetroll -d postgres -c "CREATE DATABASE sweetroll_drill_restore;"`; `docker compose exec -T postgres pg_restore -U sweetroll -d sweetroll_drill_restore --clean --if-exists /tmp/opencode/drill-backup/sweetroll.dump` (copy the dump into the container first if needed: `docker compose cp /tmp/opencode/drill-backup/sweetroll.dump postgres:/tmp/drill.dump`); verify with row/table counts vs manifest (`SELECT count(*) FROM <each restored table>` on both databases — compare at least `users`, `systems`, `system_versions`, `campaigns`, `characters`); record wall-clock times for backup and restore; `docker compose exec postgres psql -U sweetroll -d postgres -c "DROP DATABASE sweetroll_drill_restore;"`. Expected: counts match, timings recorded. NEVER restore into `sweetroll`, never drop anything except `sweetroll_drill_*`.
- [ ] **Step 4: Write `docs/operations/backup-restore.md`.** Procedure (exact commands from Steps 2–3), manifest format, verification queries, measured timings, RPO/RTO assessment against design §15 (RPO ≤ 15 min requires scheduled backups — currently manual: record as open gap with no invented scheduler), PITR status (`not-configured`: no WAL archiving in `compose.yaml`; point-in-time recovery within a backup window is not possible — record, do not implement here), media-file backup coverage (I7b originals/derivatives under `data/media`).
- [ ] **Step 5: Commit.** `git add scripts/backup.sh docs/operations/backup-restore.md`; `git commit -m "feat(i7): add backup procedure with measured restore drill"`.

---

### Task 6: Incident runbook + exercise

**Files:**
- Create: `docs/operations/runbook.md`

**Interfaces:**
- Consumes: `/health/live` + `/health/ready` (incl. 503 `{"status":"unavailable"}` DB-down path, unit-tested in `src/transport/http/app.test.ts`); structured pino logs with request IDs; `SWEETROLL_TEST_AUTH` offline-test precedent for scratch-port processes; metrics from Task 4.
- Produces (used by Task 7): exercised procedures with evidence, not prose-only.

- [ ] **Step 1: Write `docs/operations/runbook.md` skeleton.** Sections: severity levels; alert-to-action table for (a) `/health/ready` 503, (b) p95 alerts from Task 4 firing, (c) postgres container down, (d) disk-full on media volume; per-incident steps (detect via endpoint, correlate via `requestId` in pino logs with `jq` example, mitigate, verify, post-mortem template). Leave an `## Exercise log` section with `NOT YET EXERCISED` markers — Step 2 replaces them.
- [ ] **Step 2: Exercise backend-down + readiness.** With a scratch DB + ports (same isolated pattern as Task 1, e.g. DB `sweetroll_hard_runbook`, ports `3115`/`5185`): start the backend (`DATABASE_URL=... AUTHORITATIVE_ROLL_SECRET=... PORT=3115 npm run dev:http` in background, capture PID); assert `curl -sf http://localhost:3115/health/ready`; kill the PID; assert `curl` fails (connection refused) and record the exact error + time-to-detect (one poll interval, state the 5 s manual cadence used); restart the same command; assert `/health/ready` 200 again and record time-to-recover; kill and clean up. Also exercise the DB-down path without touching real data: start the backend pointed at a DROPPED scratch DB name and assert `/health/ready` returns 503 `{"status":"unavailable"}` (mirrors the unit test over real HTTP). Record all commands/outputs/timings into the Exercise log.
- [ ] **Step 3: Commit.** `git add docs/operations/runbook.md`; `git commit -m "docs(i7): add incident runbook with backend-down exercise"`.

---

### Task 7: Hardening acceptance + status reconciliation

**Files:**
- Create: `docs/acceptance/i7-2026-09-15-hardening.md`
- Modify: `design_v2.md` (§17.9 status only), `docs/superpowers/plans/2026-09-08-gui-integration.md` (G7/G9 boxes touched by this plan's evidence only)

**Interfaces:**
- Consumes: evidence from Tasks 1–6 (spec results, p95 table, drill timings, exercise log).
- Produces: the task-10 closure record. Must NOT close: preview-as-player, launch-template licensing, production auth, mockup capture, G9 real-device/playtest/deployment gates, RPO-scheduling/PITR gaps (recorded open in Tasks 4–5).

- [ ] **Step 1: Write the acceptance record.** `docs/acceptance/i7-2026-09-15-hardening.md`: tested commits, per-task commands + outcomes + limitations (Chromium-only, no real devices, no production traffic, small-volume drill DB, example-only PromQL), the Task 3 p95 table verbatim, Task 5 timings, Task 6 exercise log summary, and an explicit open-gaps list (see above).
- [ ] **Step 2: Run full verification.** Root `npm test`, `TEST_DATABASE_URL=... npm run test:integration --no-file-parallelism` (flag already in the script; keep the env var), `npm run typecheck`, `npm run contracts:check`, `npm run build`; web `npm test`, `npm run typecheck`, `npm run build`; canonical `E2E_DATABASE_ADMIN_URL=... npm run web:test:e2e` (now including the two new specs); `docker build -t sweetroll .`; `git diff --check`. Record results in the acceptance record. A single-test web-unit flake requires two consecutive green reruns before claiming green (precedent 2026-09-15: 1 failed/1030 → 1031/1031 ×2).
- [ ] **Step 3: Update status docs.** In `design_v2.md` §17.9, append the hardening outcome (task 10 items done with evidence pointer; full I7 still open per the gaps list). In the GUI plan, check ONLY the G7 two-device-operation box if Task 2 proves it, with an evidence note; leave preview-as-player, device, and G9 boxes untouched.
- [ ] **Step 4: Commit.** `git add docs/acceptance/i7-2026-09-15-hardening.md design_v2.md docs/superpowers/plans/2026-09-08-gui-integration.md`; `git commit -m "docs(i7): record hardening acceptance and reconcile task-10 status"`.
