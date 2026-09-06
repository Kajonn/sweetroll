#!/usr/bin/env bash
# I3 character-backend acceptance demonstration runner.
#
# This script walks the documented character HTTP surface end to end against the
# compose-managed PostgreSQL instance and captures the result of each step in
# docs/acceptance/i3-2026-09-05-transcript.log.
#
# Mode: in-process over the production route definitions. The production HTTP
# bootstrap (src/bootstrap/http.ts) wires an empty OIDC adapter, so we use the
# deterministic test OIDC client (the same pattern as
# tests/integration/character-http-acceptance.test.ts) to sign in real users,
# then drive every request through Fastify `inject` so the exact same routes,
# auth hook, and response envelope the web server would use are exercised.
#
# Re-runnable: every run derives fresh idempotency keys from Date.now(). Record
# a transcript by redirecting the full run, e.g.:
#   bash scripts/i3-character-acceptance-demo.sh > docs/acceptance/i3-2026-09-05-transcript.log 2>&1

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
cd "$REPO_ROOT"

export DATABASE_URL=${DATABASE_URL:-postgres://sweetroll:sweetroll@localhost:5432/sweetroll}
export HOST=${HOST:-0.0.0.0}
export LOG_LEVEL=${LOG_LEVEL:-info}
export PORT=${PORT:-3000}
export TEST_DATABASE_URL=${TEST_DATABASE_URL:-$DATABASE_URL}
export AUTHORITATIVE_ROLL_SECRET=${AUTHORITATIVE_ROLL_SECRET:-development-only-roll-secret-32-bytes}

echo "=== I3 character-backend acceptance demonstration ==="
echo "DATABASE_URL=$DATABASE_URL"
echo "REPO_ROOT=$REPO_ROOT"

echo
echo "--- Step 0: bring up compose postgres ---"
docker compose up -d postgres

echo "--- Step 0: wait for pg_isready ---"
for i in $(seq 1 30); do
  if docker compose exec -T postgres pg_isready -U sweetroll -d sweetroll > /dev/null 2>&1; then
    echo "postgres is ready (after ${i}s)"
    break
  fi
  sleep 1
  if [ "$i" = "30" ]; then
    echo "postgres failed to become ready within 30s" >&2
    exit 1
  fi
done

echo
echo "--- Step 0: run migrations ---"
npm run migrate

echo
echo "--- Steps: walk the character HTTP surface ---"
npx tsx scripts/i3-character-acceptance-demo.ts

echo
echo "=== I3 character-backend acceptance demonstration complete ==="