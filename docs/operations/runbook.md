# Incident runbook

Response procedures for the four known failure modes below. All commands
assume the repo root unless stated. Health semantics come from
`src/transport/http/app.ts` (`GET /health/live` never touches the database;
`GET /health/ready` runs `SELECT 1` and returns 503
`{"status":"unavailable"}` when the database is unreachable — unit-tested in
`src/transport/http/app.test.ts`). Latency/availability budgets and
example-only PromQL/alerts are defined in `docs/operations/slo.md`
(`not-deployed`: no production Prometheus/alertmanager).
Structured logs are pino JSON with a server-generated `requestId` per request
(`x-request-id` response header; caller-supplied IDs are never trusted —
`src/transport/http/app.test.ts`).

## Severity levels

| Severity | Definition | Response |
| --- | --- | --- |
| SEV-1 | All requests failing or data loss risk (backend down, postgres down, disk-full blocking writes) | Page immediately; mitigate first, post-mortem within 48 h |
| SEV-2 | Degraded: SLO breach on one signal (p95 over budget, readiness flapping 503) | Respond within 1 h; post-mortem within 1 week |
| SEV-3 | Early warning or single-component anomaly with no user impact | Next-business-day triage; post-mortem optional |

## Alert-to-action table

| # | Alert / signal | Severity | Runbook section |
| --- | --- | --- | --- |
| (a) | `GET /health/ready` returns 503 `{"status":"unavailable"}` | SEV-2 (SEV-1 if sustained > 10 min) | [Readiness 503](#a-healthready-503) |
| (b) | p95 latency alert firing (ordinary > 300 ms, rule actions > 500 ms; see `docs/operations/slo.md`) | SEV-2 | [p95 SLO breach](#b-p95-slo-breach) |
| (c) | Postgres container down / unreachable | SEV-1 | [Postgres down](#c-postgres-container-down) |
| (d) | Disk-full on the media volume (`SWEETROLL_MEDIA_DIR` / `data/media`) | SEV-1 (writes blocked) | [Media disk-full](#d-disk-full-on-media-volume) |

## Correlating with request IDs

Every HTTP response carries the server-generated request ID:

```bash
curl -si http://localhost:3000/health/live | grep -i x-request-id
```

Find that request's log lines (pino JSON on stdout) with `jq`:

```bash
node dist/bootstrap/http.js 2>&1 | tee backend.log
# in another shell, after reproducing with <request-id>:
jq -c 'select(.requestId == "<request-id>")' backend.log
# all 5xx completions in the last deployment:
jq -c 'select(.msg == "request completed" and .statusCode >= 500)' backend.log
```

Log records carry only allow-listed metadata (`method`, `requestId`,
`route`, `statusCode`, `durationSeconds`); `Authorization` headers, cookies,
query secrets, and `databaseUrl` are redacted (see `src/platform/logging.ts`
and the allow-list test in `src/transport/http/app.test.ts`). Never paste
full log lines containing customer content into tickets — quote the
`requestId`, `route`, and `statusCode` only.

## (a) `/health/ready` 503

1. **Detect:** `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/health/ready`
   — `200` healthy, `503` means the `SELECT 1` probe failed.
2. **Correlate:** grab the `x-request-id` header and filter logs with the
   `jq` pattern above; a burst of 503s on one route points at the database,
   not the router.
3. **Mitigate:** check postgres reachability
   (`docker compose ps`; `docker compose exec -T postgres pg_isready -U sweetroll`);
   restart the database container if it is down, otherwise restart the backend
   process. Do not restore backups here — see `docs/operations/backup-restore.md`
   for data-loss cases.
4. **Verify:** poll `/health/ready` until `200 {"status":"ok"}`; confirm
   `/metrics` request counters are incrementing again.
5. **Post-mortem:** use the template below.

## (b) p95 SLO breach

1. **Detect:** example-only alert `SweetrollLatencySLOBreach` (see
   `docs/operations/slo.md`); ad-hoc check via `/metrics`
   (`sweetroll_http_request_duration_seconds_bucket`, `le="0.3"` / `le="0.5"`).
2. **Correlate:** `jq -c 'select(.msg == "request completed") | {requestId, route, statusCode, durationSeconds}' backend.log | sort -t: -k4 -n | tail`
   to find the slow routes; compare against the Task 3 load-test p95 baselines
   before blaming a deploy.
3. **Mitigate:** shed load (stop load tests / duplicate pollers first);
   scale vertically only as a stopgap; file a performance issue with the slow
   `route` + p95 numbers if the breach survives load-shedding.
4. **Verify:** re-evaluate the SLO PromQL over a fresh 5-minute window;
   confirm p95 back under 300 ms ordinary / 500 ms rule actions.
5. **Post-mortem:** use the template below.

## (c) Postgres container down

1. **Detect:** `/health/live` 200 but `/health/ready` 503, plus
   `docker compose ps` showing `postgres` exited/unhealthy.
2. **Correlate:** backend logs show readiness probes failing with fresh
   `requestId`s on every poll — liveness stays green, proving the backend
   process itself is alive.
3. **Mitigate:** `docker compose up -d postgres`, then
   `docker compose exec -T postgres pg_isready -U sweetroll`. If the data
   volume is corrupt or dropped, follow `docs/operations/backup-restore.md`
   (restore into a scratch database first, never over `sweetroll`).
4. **Verify:** `/health/ready` returns 200; spot-check row counts on
   `users`, `campaigns`, `characters` against the last backup manifest.
5. **Post-mortem:** use the template below.

## (d) Disk-full on media volume

1. **Detect:** media uploads fail (5xx on media routes) while `/health/ready`
   stays 200; `df -h "$(dirname "$SWEETROLL_MEDIA_DIR")"` (default
   `<repo>/data/media`, see `src/campaigns/media.ts`) shows ~100% use.
2. **Correlate:** filter logs for the failing media `route` + `statusCode`
   with the `jq` pattern above; confirm failures cluster on media writes,
   not reads.
3. **Mitigate:** free space (prune old container layers / rotate `backend.log`
   first — never delete `data/media` originals); add capacity; re-check `df`.
   Media files are covered by `media.tar.gz` in `scripts/backup.sh` — if
   originals were lost, restore from the latest backup per
   `docs/operations/backup-restore.md`.
4. **Verify:** re-upload a scratch asset; confirm `/metrics` shows successful
   media-route completions; `df` back under 80%.
5. **Post-mortem:** use the template below.

## Post-mortem template

Copy per incident:

```text
Date:
Severity:
Detection (which alert/endpoint, time-to-detect):
Impact (who, how long):
Root cause:
Mitigation (commands run):
Verification (endpoint/log evidence):
Follow-ups (owner + due):
```

## Exercise log

Exercised 2026-09-15 ~05:12–05:16 UTC from the repo worktree against
scratch resources only: scratch DB `sweetroll_hard_runbook`, scratch port
3115 (5185 unused — backend only, no web server needed). Tested commit:
the Task 6 working tree. The `sweetroll` dev database was never touched;
the user's dev servers (ports 3000/5173) stayed up throughout (re-verified
200 after every step). Only the scratch backend's own PIDs were killed.
Manual poll cadence: 5 s.

Container identity (verified with `docker ps` before touching anything):
host `localhost:5432` is served by `i6-backend-postgres-1` (another
project's container), so only uniquely-named scratch DBs were created and
dropped there. The DB-down half additionally used the worktree's own
compose postgres (`i7-hardening-postgres-1`, reachable at
`localhost:5434`) — pausing the shared container was out of the question,
and pausing the worktree's own container is fully isolated (this matches
the plan's global constraint that destructive steps run only against this
repo's compose postgres).

### Drill 1 — backend-down (kill + restart)

Setup (scratch DB in the reachable postgres, migrated, backend started):

```bash
docker exec i6-backend-postgres-1 psql -U sweetroll -d postgres \
  -c "CREATE DATABASE sweetroll_hard_runbook;"
# CREATE DATABASE
DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll_hard_runbook \
  AUTHORITATIVE_ROLL_SECRET=development-only-roll-secret-32-bytes \
  npm run migrate
# ... "database migrations complete"
DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll_hard_runbook \
  AUTHORITATIVE_ROLL_SECRET=development-only-roll-secret-32-bytes \
  PORT=3115 nohup npm run dev:http > /tmp/opencode/runbook-backend-3115.log 2>&1 &
# PID=973605 (npm wrapper; live server child: tsx watch PID 973625)
```

Healthy baseline (05:12:36–05:12:55Z, ~19 s after start — tsx watch
compile time):

```bash
$ curl -s -o /dev/null -w "ready HTTP %{http_code}\n" http://localhost:3115/health/ready
ready HTTP 200
```

Kill (the npm wrapper died but its `tsx watch` child survived the first
`kill`, still serving on 3115 — the exact surviving child PID 973625,
verified by its `.worktrees/i7-hardening` command line, was then killed;
the main-checkout dev-server PIDs 943428/943429 were never touched):

```bash
$ date -u +%FT%TZ; kill <scratch-backend-PIDs>; sleep 3; date -u +%FT%TZ
2026-09-15T05:13:05Z
2026-09-15T05:13:08Z
$ curl -sv http://localhost:3115/health/ready
* Failed to connect to localhost port 3115 after 0 ms: Couldn't connect to server
$ curl -s -o /dev/null -w "ready HTTP %{http_code}\n" http://localhost:3115/health/ready
ready HTTP 000
curl_exit=7
$ ss -ltn | grep 3115 || echo "port 3115 closed"
port 3115 closed
```

Time-to-detect: one 5 s poll interval (kill 05:13:05Z, refusal observed
at the 05:13:08Z poll).

Restart (same command, 05:13:13Z) and recovery:

```bash
$ curl -s http://localhost:3115/health/ready
{"status":"ok"}
ready HTTP 200 after ~10s of 5s polling   # restarted 05:13:13Z, green at 05:13:18Z
```

Time-to-recover: ~5 s process startup, detected on the second 5 s poll
(≤ 10 s at the 5 s manual cadence). Request-ID correlation verified over
real HTTP during the healthy window: response header
`x-request-id: 876af514-8352-4fc0-b26f-146541a3a17a` matched both the
`request started` and `request completed` (`statusCode: 200`) pino lines
via `grep "$RID" backend.log` (the `jq` form in "Correlating with
request IDs" selects the same records).

### Drill 2 — DB-down readiness (503 `{"status":"unavailable"}`)

Two literal approaches were tried first and both are recorded here
because they constrain the procedure:

1. Starting the backend pointed at a never-created DB
   (`sweetroll_hard_runbook_gone`, confirmed absent) never listens:
   `seedReferenceTemplates` fails at startup with
   `error: database "sweetroll_hard_runbook_gone" does not exist`
   (FATAL 3D000) before `app.listen`. No endpoint to probe.
2. `DROP DATABASE sweetroll_hard_runbook WITH (FORCE)` from under a
   running backend kills the backend process instead of yielding 503:
   the pool (`src/platform/database.ts`, no `pool.on("error")` handler)
   crashes node on the terminated idle-client error, so the port closes
   (`Failed to connect ... port 3115`, curl exit 7). DB-down manifests
   as backend-down in that case — follow Drill 1, then the postgres
   procedure in section (c).

Exercised equivalent (05:15:25–05:15:32Z): backend on the live scratch DB
in the worktree's own compose postgres, then the database frozen with
`docker pause` (hangs queries without terminating connections, so the
readiness probe's `query_timeout: 250` fires and the 503 path from
`src/transport/http/app.ts` is taken — the same path the unit test
`returns bounded readiness failure details` covers in
`src/transport/http/app.test.ts`):

```bash
$ docker exec i7-hardening-postgres-1 psql -U sweetroll -d postgres \
    -c "CREATE DATABASE sweetroll_hard_runbook;"
# (migrated + backend on PORT=3115 with DATABASE_URL=...@localhost:5434/... as in Drill 1;
#  ready HTTP 200 at 05:15:10Z)
$ docker pause i7-hardening-postgres-1   # 2026-09-15T05:15:25Z
i7-hardening-postgres-1
$ time curl -s -w "\nready HTTP %{http_code}\n" http://localhost:3115/health/ready
{"status":"unavailable"}
ready HTTP 503
real  0m0.260s
$ curl -s -w "\nlive HTTP %{http_code}\n" http://localhost:3115/health/live
{"status":"ok"}
live HTTP 200
$ docker unpause i7-hardening-postgres-1 # 2026-09-15T05:15:32Z
i7-hardening-postgres-1
$ curl -s -w "\nready HTTP %{http_code}\n" http://localhost:3115/health/ready
{"status":"ok"}
ready HTTP 200
```

Result: `/health/ready` → 503 `{"status":"unavailable"}` in 0.26 s while
`/health/live` stayed 200 (liveness/readiness split works as documented),
and readiness recovered to 200 within one 5 s poll after unpause.
Time-to-detect: one 5 s poll interval; time-to-recover: ≤ ~7 s
(unpause 05:15:32Z, green at the next poll).

Cleanup (all verified): scratch backend PIDs killed (`ps` shows no
worktree `tsx` process, port 3115 closed),
`DROP DATABASE sweetroll_hard_runbook` in the worktree postgres (no
`sweetroll_hard_*` DBs left there) and on the shared postgres (only
Task 1's `sweetroll_hard_a11y` remains — not ours, left alone). All
three postgres containers healthy afterwards; dev servers on 3000/5173
returning 200.

### Open exercise gaps (not covered by this drill)

- p95 alert (b) and media disk-full (d) procedures are prose-only: no
  production Prometheus/alertmanager exists (`not-deployed` per
  `docs/operations/slo.md`), and no disk pressure was induced. Their
  detect/correlate steps reference real endpoints (`/metrics` buckets,
  `df` + log filters) but were not executed end-to-end.
- The FORCE-drop crash in attempt 2 above (pool without an `error`
  handler) is a robustness finding for a future task, not fixed here
  (docs-only task, no product changes).
