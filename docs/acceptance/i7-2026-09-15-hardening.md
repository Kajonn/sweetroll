# I7 Hardening Acceptance — 2026-09-15 (design §17.9 task 10)

Evidence record for the [I7 hardening plan](../superpowers/plans/2026-09-15-i7-hardening.md)
Tasks 1–6. Full I7 remains OPEN per the open-gaps list below.

## Tested commits (branch `feat/i7-hardening`, worktree `.worktrees/i7-hardening`)

| Commit | Subject | Task |
| --- | --- | --- |
| `4548793` | test(i7): add campaign/GM axe and keyboard accessibility spec | 1 |
| `0a6c5d1` | test(i7): prove co-GM shared-edit conflict and independent operation | 2 |
| `c6d0ddc` | feat(i7): align request-duration buckets to latency SLOs with definitions | 4 |
| `8a044f2` | docs(i7): use real action route in SLO example | 4 follow-up |
| `3c93cb4` | feat(i7): add backup procedure with measured restore drill | 5 |
| `544b0eb` | test(i7): prove media-tarball backup path with scratch fixture | 5 follow-up |
| `3369b01` | docs(i7): add incident runbook with backend-down exercise | 6 |
| `d6f7255` | fix(i7): survive abrupt DB loss via pool error listener | 6 follow-up |

Task 7 (this record + status reconciliation) is the commit on top of `d6f7255`.
Task 3 produced evidence only (no commit). Per-task detail (commands, outcomes,
deviations) lives in `.superpowers/sdd/2026-09-15-i7-hardening/task-{1..6}-report.md`.

## Per-task outcomes

- **Task 1 (axe/keyboard):** `web/tests/e2e/campaignAccessibility.spec.ts` (+491 lines,
  no product edits — zero serious/critical axe findings). Isolated-DB run
  (`sweetroll_hard_a11y` on the reachable postgres, ports 3113/5183):
  **15 passed (1.6m)**, `tsc --noEmit` clean. Deviation: no `campaign-list`
  testid exists — list surface uses role assertions; single dark pass on the
  Content tab; invitation token is a Panel, not a dialog.
- **Task 2 (co-GM conflict):** `web/tests/e2e/gmCoGmConflict.spec.ts` (+332 lines,
  no product edits — no 409-handling/clobber defects). Isolated-DB runs
  (`sweetroll_hard_cogm`, ports 3114/5184): **1 passed (11.3s) ×2 fresh DBs**,
  tsc clean. Deviation (required for correctness): content-conflict wire key is
  `expectedContentRevision`, not the brief's `expectedRevision` (character-bump
  field). Proves two-device-operation independence: concurrent bumps on two
  different characters both apply (`9 / 10`, no conflict, distinct
  idempotencyKeys). This is the evidence behind the G7 two-device box check.
- **Task 3 (session-burst load):** no code changes. Verbatim p95 console lines
  (2026-09-15 ~07:03 UTC, Task 3 report; budgets: ordinary p95 ≤ 300 ms,
  rolls ≤ 500 ms — all within budget):

```
[campaign-load] p95 latencies: {"reads":{"count":120,"p95Ms":31.7},"contentWrites":{"count":12,"p95Ms":75.2},"bumps":{"count":32,"p95Ms":150.1},"rolls":{"count":64,"p95Ms":125.8}}
```

```
[load] p95 latencies: {"creates":{"count":50,"p95Ms":151.2},"reads":{"count":500,"p95Ms":19.3},"bumps":{"count":200,"p95Ms":24},"rolls":{"count":200,"p95Ms":22.2}}
```

  Max ordinary p95: 151.2 ms (character creates); max rolls p95: 125.8 ms
  (campaign). 4 files / 8 tests passed (campaign-load 2, character-load 1,
  character-concurrency 4, identity-concurrency 1).
- **Task 4 (SLO buckets):** red-first (`le="0.3"` absent pre-fix) → green
  (`src/transport/http/app.test.ts` 5/5) after one-line buckets change in
  `src/platform/metrics.ts`; `docs/operations/slo.md` maps all five design
  SLOs to series/endpoints with example-only PromQL (honestly marked
  not-deployed) and an example-only alert sketch. Follow-up `8a044f2`
  replaced the placeholder `{route="/api/rules/actions"}` with the real
  route label `{route="/characters/:characterId/actions/:actionId"}`.
- **Task 5 (backup drill):** `scripts/backup.sh` (executable, refuses
  non-scratch targets, no restore path by construction) + drill evidence in
  `docs/operations/backup-restore.md`. Timings (≈1 s granularity bounds on a
  near-empty 101162-byte dump — NOT production-scale evidence): backup ≈ 1 s,
  `pg_restore` into `sweetroll_drill_restore` ≈ 1 s; counts MATCH on all 33
  public tables (`users` 0/0, `systems` 3/3, `system_versions` 3/3,
  `campaigns` 0/0, `characters` 0/0; `migrations_max:
  0020_display_credentials.sql`). Media-tarball follow-up (`544b0eb`): scratch
  8 KiB fixture round-trips byte-identical (sha256
  `043c7bb1…8a07e9d` both sides). Never restored into `sweetroll`.
- **Task 6 (runbook):** `docs/operations/runbook.md` (severity levels,
  4-incident alert-to-action table, detect→correlate→mitigate→verify steps,
  requestId/jq correlation, post-mortem template, zero `NOT YET EXERCISED`
  markers). Exercise log summary (scratch DB + port 3115, 5 s poll cadence):
  Drill 1 — killed own backend PIDs → `Failed to connect` / `ready HTTP 000`
  (curl exit 7), detect one poll, restart green `{"status":"ok"}` / 200 in
  ~5 s startup (≤10 s at cadence); request-id correlation verified over real
  HTTP. Drill 2 — `docker pause` on the worktree compose postgres →
  `ready HTTP 503 {"status":"unavailable"}` in 0.26 s while `live` stayed 200;
  unpause → 200 within one poll; `DROP ... WITH (FORCE)` → sustained 503,
  process alive, exactly one `idle client error` log line (post-`d6f7255`;
  pre-fix the backend crashed — `createPool` had no `'error'` listener,
  fixed red-first with `src/platform/database.test.ts` coverage).

## Task 7 full verification matrix (this tree, HEAD `d6f7255` + record)

Competing-load check: main-checkout dev servers (3000/5173) LISTENING but idle
(CPU TIME frozen over a 10 s window); no vitest/playwright processes running;
nothing killed. DB access via the worktree's own compose postgres
(`i7-hardening-postgres-1`, host `localhost:5434` — host 5432 belongs to the
unrelated `i6-backend-postgres-1`, so 5432 was never touched).

| # | Command (from worktree root unless noted) | Result |
| --- | --- | --- |
| 1 | `npm test` (root unit) | **29 files / 320 pass** (13.8s) |
| 2 | `TEST_DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5434/sweetroll npm run test:integration --no-file-parallelism` | **29 files / 348 pass** (96.5s). This run's p95: `[load]` creates 163.4 / reads 21.1 / bumps 24.2 / rolls 28.3; `[campaign-load]` reads 30.1 / contentWrites 83.4 / bumps 148.6 / rolls 142.8 (recaptured targeted) — all within budget |
| 3 | `npm run typecheck` (root) | clean |
| 4 | `npm run contracts:check` (root) | clean |
| 5 | `npm run build` (root) | clean |
| 6 | `npm test` (from `web/`) | flake sequence then green per the single-flake rule: 1 failed/1030 → green → **1031/1031** → 1 failed/1030 → 1 failed/1030 (both: `AppShell > null→actor settle … leaks no account-A cache`, timing-sensitive, pre-existing — Tasks 1–6 never touch AppShell; passes in isolation 19/19, rest-of-suite 1012/1012) → **1031/1031 ×2 consecutive** (07:39:56, 07:40:20 UTC). Green claimed on the consecutive pair |
| 7 | `npm run typecheck` (from `web/`) | clean |
| 8 | `npm run build` (from `web/`) | clean (pre-existing chunk-size advisory only) |
| 9 | `E2E_DATABASE_ADMIN_URL=postgres://sweetroll:sweetroll@localhost:5434/postgres AUTHORITATIVE_ROLL_SECRET=development-only-roll-secret-32-bytes BACKEND_PORT=3121 WEB_PORT=5189 SWEETROLL_BACKEND_TARGET=http://localhost:3121 npm run web:test:e2e` | **journeys 41/41 pass (3.6m) incl. both new specs** (campaignAccessibility 15/15, gmCoGmConflict 1/1); **visuals 10/10 pass (20.2s)**. Dedicated ports required — defaults 3000/5173 are occupied by the main-checkout dev servers |
| 10 | `docker build -t sweetroll .` | pass |
| 11 | `git diff --check` | clean |

Scratch artifacts from the matrix (worktree `data/` runtime bytes from the e2e
scratch backends, run-scoped `sweetroll_e2e_*` DBs auto-dropped by the runner)
were removed; `git status` clean apart from this task's three intended files.

## Limitations

Chromium-only (no WebKit/Gecko); no real devices (emulation does not prove
touch/keyboard — G9); no production traffic (PromQL validated for syntax only,
not evaluated); drill DB near-empty (101 KB dump — timings are
small-volume bounds, re-drill at production-like volume before quoting RTO);
backup schedule is manual; media-dir fixture drill used a scratch file, not
production originals; runbook (b)/(d) halves are prose-only (no prod
Prometheus, no induced disk pressure).

## Open gaps (explicitly NOT closed by this plan)

- Preview-as-player (real-policy preview still open; Task 2 proves conflict
  handling, not per-player view correctness).
- Launch-template licensing (OD-08 — reference fixtures only, no shipped
  licensed catalog).
- Production auth (no real provider by owner decision; test/prod separation
  only).
- Mockup capture (HTTP 401 — dark/contrast sign-off outstanding).
- G9 real-device checks, physical-table + remote playtests, and
  built-artifact/deployment gates.
- RPO scheduling (backups manual — RPO ≤ 15 min needs a scheduler, not
  designed here) and PITR (no WAL archiving in `compose.yaml`).
- Example-only PromQL/alerts (Task 4) — syntax-validated, not deployed or
  evaluated.
