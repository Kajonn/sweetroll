# I7 Hardening Remainder Acceptance — 2026-09-17 (design §17.9)

Scope: closure record for plan `docs/superpowers/plans/2026-09-17-i7-hardening-remainder.md`
Tasks 1–5. Base `3aa52bd`; HEAD `484e282` at acceptance time. This record closes
the remainder plan's evidence loop; it does NOT close full I7, GUI release, or
any owner-gated item (see Open gaps). Prior task drills are quoted verbatim
from their reports (not re-run); the Step 2 matrix below was run fresh.

Evidence consumed (gitignored worktree reports, kept out of the commit per
`.gitignore:5:.superpowers/` precedent):

- `.superpowers/sdd/2026-09-17-i7-hardening-remainder/task-1-report.md`
- `.superpowers/sdd/2026-09-17-i7-hardening-remainder/task-2-report.md`
- `.superpowers/sdd/2026-09-17-i7-hardening-remainder/task-3-report.md`
- `.superpowers/sdd/2026-09-17-i7-hardening-remainder/task-4-report.md`
- `.superpowers/sdd/2026-09-17-i7-hardening-remainder/task-5-report.md`

## Tested commits

| Task | Commit (full) | Subject |
|---|---|---|
| 1 | `39498202f2097a83eac69e3d36f17b878d183fe8` | feat(i7): add backup schedule, retention, and volume re-drill |
| 2 | `4d91218861e6f1c422674ef8090d408197462537` | feat(i7): add opt-in WAL archiving with PITR drill |
| 3 | `db1947ea4875d3dea1a7b008db742e1a5f1d0f23` | feat(i7): add file-based SLO scrape and alert bundle |
| 4 | `9b69745d2b9129083f493ddc69b05c13b30d5a27` | feat(i7): serve built web client from the single artifact |
| 5 | `484e282f73518e7ab1209a182a6a4a3ffba39870` | docs(i7): record G9 owner-gated status and playtest protocol |

## Task 1 — Backup schedule, retention, volume re-drill (`3949820`)

Files: created `scripts/backup-prune.sh`, `ops/backups/backup.cron.example`,
`scripts/seed-volume-fixture.ts`; appended scheduled-backup/retention section
to `docs/operations/backup-restore.md`.

Commands + verbatim outcomes (quoted from the Task 1 report):

- Prune self-check:
  `scripts/backup-prune.sh /tmp/opencode/prune-selfcheck 2 --dry-run`
  → `would remove /tmp/opencode/prune-selfcheck/backup-0001`, exit 0
  (`ls` still shows 3 dirs — dry run removed nothing).
- Seeder guard (safety RED):
  `TEST_DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5439/sweetroll npx tsx scripts/seed-volume-fixture.ts 20 50`
  → `refusing: TEST_DATABASE_URL must be a sweetroll_drill_* scratch database`, exit 1.
- Seeder (adapted to actual schema, see limitations):
  `TEST_DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5439/sweetroll_drill_volume npx tsx scripts/seed-volume-fixture.ts 20 50`
  → `seeded campaigns=20 perCampaign=50`.
- Drill DB count: `SELECT count(*) FROM characters` on
  `sweetroll_drill_volume` → `1000`.
- Standard-path backup: `time scripts/backup.sh /tmp/opencode/drill-volume`
  → exit 0, real 0m0.845s, `sweetroll.dump` 101157 bytes, media skipped,
  manifest `migrations_max: 0020_display_credentials.sql`.
- Volume dump (backup.sh's identical `pg_dump -Fc`-via-exec method against
  the drill DB): real 0m0.417s, 141996 bytes.
- Restore into scratch `sweetroll_drill_volume_restore`:
  real 0m0.846s, exit 0.
- Verification: characters source `1000` / restore `1000`; campaigns `20` /
  `20`; `migrations_max` `0020_display_credentials.sql` on both.
- Cleanup verified: no `sweetroll_drill_%` rows remain; dev `sweetroll`
  intact (`SELECT count(*) FROM characters` → `0`).

Limitations: seeder SQL deviates minimally from the brief (brief's verbatim
SQL fails against the real schema: no `settings_json` on campaigns,
`system_versions` PK is `id`, attached character scope requires
`owner_id NULL + campaign_id NOT NULL`); scratch drill DB had to be migrated
before seeding; `backup.sh` hardcodes the `sweetroll` source so the volume
dump used its identical pg_dump method against the drill DB; host port 5432
belongs to an unrelated postgres so the stack ran on 127.0.0.1:5439 via an
out-of-repo override. Drill volumes stated in rows/bytes below; no production
traffic.

### Volume drill timings + character counts

| Step | Wall-clock | Size / counts |
|---|---|---|
| `scripts/backup.sh` (dev source, standard path) | 0.845 s | sweetroll.dump 101157 bytes |
| `pg_dump -Fc` of volume DB (1000 chars) | 0.417 s | sweetroll-volume.dump 141996 bytes |
| `pg_restore --clean --if-exists` into scratch restore DB | 0.846 s | — |
| characters before (source) / after (restore) | — | 1000 / 1000 |
| campaigns before / after | — | 20 / 20 |
| migrations_max both sides | — | 0020_display_credentials.sql |

## Task 2 — Opt-in WAL archiving + PITR drill (`4d91218`)

Files: created `compose.pitr.yaml` (override only; base `compose.yaml`
untouched), `docs/operations/pitr.md` (no timings stated).

PITR drill: NOT-EXERCISED — WAL override validated by config only.
`docs/operations/pitr.md` `## Status` holds the literal line:

```text
PITR drill: NOT-EXERCISED — WAL override validated by config only
```

Blocking evidence (quoted from the Task 2 report; the enabling restart is
owner-gated on the dev volume, so it was NOT run):

```text
$ docker compose exec -T postgres psql -U sweetroll -d sweetroll -tAc "SHOW archive_mode;"
off
```

Blocking command quoted (NOT run): `docker compose -f compose.yaml -f compose.pitr.yaml up -d`.

GREEN evidence (quoted): override config validates without starting
containers (`archive_mode=on`, `archive_command` to
`/var/lib/postgresql/wal_archive/%f`, `sweetroll-wal` volume present);
drill-doc SQL prefix exercised verbatim on scratch `sweetroll_drill_pitr`
(marker table create + `pitr-marker-1` insert/select); cleanup verified (no
` sweetroll_drill_%` rows; dev `sweetroll` untouched — `pitr_markers` absent
as expected; `max(filename)` `0020_display_credentials.sql`);
`SHOW wal_level;` already `replica` on the running instance.

Limitations: no measured backup/replay timings, no marker-2, no recovery
target exist. Nothing beyond the config check and the scratch-SQL prefix may
be quoted as drill evidence. Exercising it requires owner approval for the
override restart, then the doc's steps 4/7 verbatim.

## Task 3 — File-based SLO scrape + alert bundle (`db1947e`)

Files: created `ops/prometheus/prometheus.yml`,
`ops/prometheus/alerts.yml`, `src/platform/alerts.test.ts`; modified
`docs/operations/slo.md` (header swap + 2 pointer lines; not-deployed banner
untouched).

Commands + verbatim outcomes (quoted from the Task 3 report):

- RED (before YAML files exist):
  `npx vitest run src/platform/alerts.test.ts`
  → `× observability bundle > alert expressions reference only shipped series and SLO buckets`
  → `ENOENT: no such file or directory, open 'ops/prometheus/alerts.yml'`.
- GREEN (after writing bundle): same command →
  `Test Files 1 passed (1) / Tests 1 passed (1)`; chained
  `npm run typecheck` clean; `git diff --check` clean.

Limitations: file-only bundle, NOT deployed — no live Prometheus ever
evaluated the rules (PromQL file-only); test reads YAML as text (no
YAML parsing / promtool validation); `slo.md` inline example now duplicates
a subset of `alerts.yml` (kept per brief; locking test asserts series/labels
`le="0.3"` / `le="0.5"` against shipped metrics). No production traffic.

## Task 4 — Single-artifact serving (`9b69745`)

Files: created `src/transport/http/static.ts` (+ `?? ""` token required by
`noUncheckedIndexedAccess`, documented in the Task 4 report),
`src/transport/http/static.test.ts`; modified `src/bootstrap/http.ts`
(env-gated dynamic import), `Dockerfile` (`COPY web/dist` line),
`package.json` + `package-lock.json` (`@fastify/static@10.1.4`).

Commands + verbatim outcomes (quoted from the Task 4 report):

- RED (before `static.ts` existed):
  `npx vitest run src/transport/http/static.test.ts`
  → `FAIL ... Error: Cannot find module './static.js'`.
- GREEN (after): same command →
  `✓ src/transport/http/static.test.ts (1 test) 91ms /
  Test Files 1 passed (1) / Tests 1 passed (1)`.
- `npm run typecheck` → clean, exit 0. `npm run build` → clean, exit 0.
  `git diff --check` → clean.
- `docker build -t sweetroll .` → pass
  (`naming to docker.io/library/sweetroll:latest done`).

### Runtime curl output — single artifact serves UI + API (unrouted path)

Container run with `-e SWEETROLL_SERVE_STATIC=1` against the compose
postgres; startup log `auth mode active: locked (dev sign-in routes disabled)`.
Verbatim (quoted from the Task 4 report):

```text
$ curl -s -o /dev/null -w "ui-fallback %{http_code}\n" http://localhost:3129/some-spa-route
ui-fallback 200
$ curl -s -D - -o /dev/null http://localhost:3129/some-spa-route | grep -i content-type
content-type: text/html
$ curl -s -o /dev/null -w "api %{http_code}\n" http://localhost:3129/api/unknown-route-xyz
api 404
$ curl -s http://localhost:3129/api/unknown-route-xyz
{"code":"not_found","message":"Not found"}
$ curl -s -D - -o /dev/null http://localhost:3129/api/unknown-route-xyz | grep -i content-type
content-type: application/json; charset=utf-8
$ curl -s -D - -o /dev/null http://localhost:3129/metrics/unknown | grep -i content-type
content-type: application/json; charset=utf-8        (404)
$ curl -s -D - -o /dev/null http://localhost:3129/health/unknown | grep -i content-type
content-type: application/json; charset=utf-8        (404)
$ curl -s -o /dev/null -w "asset %{http_code}\n" http://localhost:3129/manifest.webmanifest
asset 200
$ curl -s -o /dev/null -w "metrics %{http_code}\n" http://localhost:3129/metrics
metrics 200
$ curl -s -o /dev/null -w "ready %{http_code}\n" http://localhost:3129/health/ready
ready 200
$ curl -s http://localhost:3129/ | head -c 60
<!doctype html> ... (index.html served at /)
```

Expectation `ui 200 / api 404` holds for non-API paths. Note: the brief's
suggested probe `/campaigns/abc` hits a real API route first and returns
`400 {"error":{"code":"bad_request","message":"params/id must match format \"uuid\""}}`
— correct API precedence (API routes win over SPA fallback) — so the
fallback was verified with the genuinely unrouted path `/some-spa-route`.

Limitations: `web/dist` is a gitignored local build output, not part of the
commit (reproducible via `npm --prefix web run build`; `Dockerfile COPY`
needs that prior web build); registration is env-gated
`SWEETROLL_SERVE_STATIC=1`, default off in dev; runtime verified locally
only (curl checks + scratch compose postgres); no production host, no device
checks.

## Task 5 — G9 owner-gated status + playtest protocol (`484e282`)

Files: created `docs/acceptance/g9-2026-09-17-device-playtest.md` only.
Doc-only task; no unit/e2e suites apply (`git diff --check` clean,
post-commit `git status --short` clean).

Mockup recheck (run live 2026-09-17, quoted from the Task 5 report):

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://tablefolk-ttrpg-mockups.humdrumrat.chatgpt.site; date -u +%F
```

```text
401
2026-09-17
```

Status: still blocked HTTP 401 (was 401 on 2026-09-09). The doc records:
three license-neutral OD-08 reference fixtures plus the literal line
`No shipped open-license template claimed — license review outstanding`;
OD-05 production-auth deferral with the exact release-gates Task 4
acceptance still open (real provider return, concurrent first sign-in →
one user, expiry, revocation, secure sign-out); an empty device matrix
(columns Device/OS/Browser/Theme/Width/Result, zero rows claimed); a
runnable physical-table + 4-player remote playtest script; and a
built-artifact check gated on Task 4 landing (`9b69745` present). All
owner-gated items remain open by design.

## Step 2 — Full verification matrix (run fresh 2026-09-17, HEAD `484e282`)

Environment: worktree compose project `i7-hardening-remainder`,
postgres:17-alpine on 127.0.0.1:5439 (host 5432 belongs to the unrelated
main-repo `sweetroll-postgres-1`, never touched). Scratch integration DB
`sweetroll_hard_int1` (created, migrated, dropped afterwards); E2E used the
canonical runner's run-scoped DBs on dedicated ports BACKEND_PORT=3126 /
WEB_PORT=5126. No new specs added — existing suites only.

| # | Command | Outcome |
|---|---|---|
| 1 | `npm test` (root) | **PASS** — Test Files 31 passed (31), Tests 326 passed (326) |
| 2 | `TEST_DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5439/sweetroll_hard_int1 npm run test:integration --no-file-parallelism` | **PASS** — Test Files 30 passed (30), Tests 351 passed (351), 90.93s |
| 3 | `npm run typecheck` (root) | **PASS** — clean, exit 0 |
| 4 | `npm run contracts:check` | **PASS** — clean, exit 0 |
| 5 | `npm run build` (root) | **PASS** — clean, exit 0 |
| 6 | `npm test` (web/) | **PASS** — Test Files 104 passed (104), Tests 1047 passed (1047), first run, no flake (no rerun required under the two-consecutive-greens rule) |
| 7 | `npm run typecheck` (web/) | **PASS** — clean, exit 0 |
| 8 | `npm run build` (web/) | **PASS** — `✓ built in 3.02s`, `dist/index.html` present (pre-existing chunk-size >500 kB warning only) |
| 9 | canonical `E2E_DATABASE_ADMIN_URL=postgres://sweetroll:sweetroll@localhost:5439/postgres AUTHORITATIVE_ROLL_SECRET=development-only-roll-secret-32-bytes BACKEND_PORT=3126 WEB_PORT=5126 SWEETROLL_BACKEND_TARGET=http://localhost:3126 npm run web:test:e2e` | **PASS** — journeys 43/43 (3.6m), visuals 10/10 (19.6s). Chromium-only; no real devices. First attempt without the roll-secret env failed at webServer startup (`AUTHORITATIVE_ROLL_SECRET is required outside tests`, run `63e619fb…`); rerun with the CI-precedent env was green. Runner-created `sweetroll_e2e_*` DBs auto-cleaned (verified none remain) |
| 10 | `docker build -t sweetroll .` (after web build) | **PASS** — `naming to docker.io/library/sweetroll:latest done`. Default `~/.docker/config.json` (`credsStore: desktop.exe`) fails in this WSL env, so the build ran with an empty `DOCKER_CONFIG=/tmp/opencode/docker-cfg` for anonymous public pulls only (Task 4 precedent); no repo files affected |
| 11 | `git diff --check` | **PASS** — clean |

Post-matrix cleanup: `sweetroll_hard_int1` dropped (no `sweetroll_hard_*`,
`sweetroll_drill_*`, or `sweetroll_e2e_*` rows remain); dev `sweetroll`
intact (`characters` 0, `max(filename)` `0020_display_credentials.sql`).

Limitations of the matrix: Chromium-only e2e; no real devices; no
production traffic; artifact verified locally only (Step 2 ran `docker
build`, not the Task 4 runtime curl — the curl output above is Task 4's
quoted evidence, not re-run here).

## G9 reconciliation ruling

Checked boxes in `docs/superpowers/plans/2026-09-08-gui-integration.md` G9:
**none**. Rationale per box: view-checklist (no per-view device/browser
evidence produced); real-device/touch/keyboard/200% text (no device runs);
routed screenshots (no new captures); offline/replay broadening (no
shared-shell/identity change in this plan, not applicable); built-artifact
gate (Task 4 verified SPA fallback + API 404 locally, but sign-in return
and fully-offline shell reopening were not exercised — the Task 5 protocol
states a bare `docker build` alone does not close this gate); playtests
(protocol only, no sessions run). Devices, playtests, mockup, and
production-auth boxes stay untouched.

## Open gaps (explicit — none closed by this plan)

- Production auth (OD-05 deferred): real-provider sign-in/return,
  concurrent first sign-in → one user, expiry, revocation, secure sign-out.
- Mockup capture: still blocked HTTP 401, re-verified 2026-09-17.
- G9 real-device checks (Android Chrome + iPad Safari, touch, virtual
  keyboard, installed PWA) and 200% text / long-label / contrast sign-off.
- G9 physical-table + remote playtests (script exists, no sessions run).
- G9 built-artifact gate remainder: sign-in return + fully-offline shell
  reopening on the Task 4 image.
- PITR drill: NOT-EXERCISED (WAL override validated by config only).
- No production host: no deployment was run against any host.
- Observability: file-only PromQL, never evaluated by a live Prometheus;
  `slo.md` inline example duplicates a subset of `alerts.yml`.
- Dockerfile `COPY web/dist` requires a prior web build (no web-build
  stage in the Dockerfile).
