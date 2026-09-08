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

## Container modes

Build one image with `docker build -t sweetroll .`.
The default command runs HTTP. Run migrations from the same image with
`docker run --rm --env-file .env sweetroll npm run start:migrate`.
