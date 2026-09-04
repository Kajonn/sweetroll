#!/usr/bin/env bash
# I1 acceptance demonstration runner.
#
# This script walks the documented system-authoring interface end to end against
# the compose-managed PostgreSQL instance and captures the result of each step.
# Mode: in-process via createSystemAuthoringModule. The production HTTP bootstrap
# wires an empty OIDC adapter, so we use the deterministic test OIDC client
# (the same pattern as tests/integration/identity-module.test.ts) to obtain a
# real user and authorId, then call the authoring module directly. Result
# outcomes are mapped to HTTP-equivalent status codes using the same table as
# src/transport/http/systems.ts.
#
# Re-runnable: every run derives a fresh idempotency key from Date.now().

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
cd "$REPO_ROOT"

export DATABASE_URL=${DATABASE_URL:-postgres://sweetroll:sweetroll@localhost:5432/sweetroll}
export HOST=${HOST:-0.0.0.0}
export LOG_LEVEL=${LOG_LEVEL:-info}
export PORT=${PORT:-3000}
export TEST_DATABASE_URL=${TEST_DATABASE_URL:-$DATABASE_URL}

echo "=== I1 acceptance demonstration ==="
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
echo "--- Steps 1-9: walk the documented interface ---"
npx tsx scripts/i1-acceptance-demo.ts

echo
echo "=== I1 acceptance demonstration complete ==="
