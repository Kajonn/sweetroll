# Sweetroll

Sweetroll is the modular TypeScript application described in `design_v2.md`.

## Design and implementation plan

- [Product design and delivery increments](design_v2.md)
- [GUI integration plan](docs/superpowers/plans/2026-09-08-gui-integration.md): I4a frontend integration, I5-I7 view rollout, and I7b simple scenes/player display.

## Requirements

- Node.js 24
- npm
- Docker with Compose

## Local development

1. Run `npm ci`.
2. Run `docker compose up -d postgres`.
3. Run `cp .env.example .env`, then `set -a; . ./.env; set +a` to export its values for the current shell.
4. Run `npm run migrate`.
5. Run `npm run dev:http`.

The HTTP process exposes liveness at `/health/live`, PostgreSQL readiness at
`/health/ready`, and Prometheus-format metrics at `/metrics`.

## Verification

Run `npm test`, `npm run test:integration`, `npm run typecheck`, and `npm run build`.

The integration command runs test files sequentially so database setup and other
suites do not compete with the session-burst test's latency measurements. The
load and concurrency tests still issue concurrent requests internally; their
workloads, correctness assertions, and latency budgets remain unchanged.

## Browser E2E (canonical)

Run the full browser suite through the isolated runner from `web/`:

1. `E2E_DATABASE_ADMIN_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll npm run test:e2e`

The admin URL is a test-service connection with CREATE DATABASE permission,
not a database to reset. The runner creates one run-scoped journey database
and one visual database, migrates through the existing Playwright webServer
command, runs journeys (`SWEETROLL_E2E_SUITE=journeys`, every spec except
`visual.spec.ts`) then visuals (`SWEETROLL_E2E_SUITE=visual`, only
`visual.spec.ts`), and drops only the databases it created. Each phase writes
to its own run-scoped directory under ignored `web/test-results/<runId>/`;
failure traces survive database cleanup. Extra Playwright selection flags
forward to both phases (for example `--repeat-each=5`), except a single
`--output` path, which the runner rejects. Large repeat counts accumulate
fixtures per database and may push catalog fixtures past the first page;
use targeted direct runs with isolated resources for large repeats instead.

Pass `--suite=journeys` or `--suite=visual` to run one phase. Playwright
arguments remain available after that runner option, for example
`npm run test:e2e -- --suite=journeys --shard=2/3`. Each invocation creates
and drops only its selected suite database. Because that database is
ephemeral, journey tests skip best-effort system deletion; direct Playwright
runs against caller-managed databases retain their normal cleanup.

For targeted investigation with caller-managed resources, invoke Playwright
directly (for example `npx playwright test tests/e2e/campaignJourney.spec.ts`)
with `DATABASE_URL`, `CI=1`, and dedicated ports/databases.

CI runs three journey shards plus one visual matrix entry through the same
canonical entry point. Every entry has its own PostgreSQL service and
run-scoped database, so the full campaign/GM/player, smoke, acceptance,
character-sheet, and visual coverage runs concurrently without shared state.
Each entry has a ten-minute job limit. On failure CI uploads its own named
`browser-failure-evidence-*` artifact (7-day retention); traces contain
deterministic test data only.

## Container modes

Build one image with `docker build -t sweetroll .`.
The default command runs HTTP. Run migrations from the same image with
`docker run --rm --env-file .env sweetroll npm run start:migrate`.

## Railway deployment

See [Railway setup](docs/operations/railway.md) for GitHub integration, PostgreSQL,
media storage, environment variables, and the outstanding application-login gate.
