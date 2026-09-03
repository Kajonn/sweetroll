# Sweetroll

Sweetroll is the modular TypeScript application described in `design_v2.md`.

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

## Container modes

Build one image with `docker build -t sweetroll .`.
The default command runs HTTP. Run migrations from the same image with
`docker run --rm --env-file .env sweetroll npm run start:migrate`.
