# I1 Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish the executable, observable, and deployable TypeScript foundation required by I1, with `http` and `migrate` process modes backed by PostgreSQL.

**Architecture:** One npm package builds one Node.js container image. Thin bootstrap files compose platform configuration, logging, PostgreSQL, HTTP, metrics, and explicit SQL migration implementations; no business Module behavior or additional deployable is introduced. The same image runs either `http` or `migrate`, and CI publishes that image only from version tags.

**Tech Stack:** Node.js 24 LTS, npm, TypeScript, Fastify 5, `pg` 8, Pino 9, `prom-client` 15, Vitest 3, Docker, PostgreSQL 17, GitHub Actions

**Spec:** `design_v2.md`, especially sections 11, 15, 16, and I1 Task 1 in section 17.3

## Global Constraints

- Keep one modular TypeScript application, one PostgreSQL database, and one deployable artifact.
- Provide only `http` and `migrate` process modes; do not add a worker or asynchronous infrastructure.
- Keep HTTP, platform, and process composition outside the deep Modules.
- Use a thin PostgreSQL driver and explicit, append-only SQL migrations; do not add an ORM or generic persistence seam.
- Add structured logs, server-generated request IDs, liveness, readiness, and baseline Prometheus-format HTTP metrics without logging request bodies, tokens, or database URLs.
- Keep ordinary HTTP operations compatible with the p95 target below 300 ms; health and metrics handlers must perform bounded work.
- Do not add Identity, system-package, rules, authoring, runtime, or database-domain behavior in this plan.
- Use the repository's approved source layout and preserve the existing marker files.

---

### Task 1: Establish The Typed Workspace And Configuration

**Files:**
- Create: `.gitignore`
- Create: `.npmrc`
- Create: `.nvmrc`
- Create: `package.json`
- Create: `package-lock.json` through npm
- Create: `tsconfig.json`
- Create: `src/platform/config.ts`
- Create: `src/platform/config.test.ts`
- Modify: `src/platform/index.ts`

**Interfaces:**
- Consumes: Node.js process environment.
- Produces: `loadConfig(env?: NodeJS.ProcessEnv): AppConfig` and the npm scripts used by every later task.

- [ ] **Step 1: Add repository and Node metadata**

Create `.gitignore`:

```gitignore
node_modules/
dist/
coverage/
.env
.superpowers/
.worktrees/
```

Create `.npmrc`:

```ini
engine-strict=true
save-exact=true
```

Create `.nvmrc`:

```text
24
```

- [ ] **Step 2: Create the npm package and lockfile**

Create `package.json`:

```json
{
  "name": "sweetroll",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=24 <25"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev:http": "tsx watch src/bootstrap/http.ts",
    "migrate": "tsx src/bootstrap/migrate.ts",
    "start:http": "node dist/bootstrap/http.js",
    "start:migrate": "node dist/bootstrap/migrate.js",
    "test": "vitest run --exclude tests/integration/**",
    "test:integration": "vitest run tests/integration",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "fastify": "5.5.0",
    "pg": "8.16.3",
    "pino": "9.9.0",
    "prom-client": "15.1.3"
  },
  "devDependencies": {
    "@types/node": "24.3.0",
    "@types/pg": "8.15.5",
    "tsx": "4.20.5",
    "typescript": "5.9.2",
    "vitest": "3.2.4"
  }
}
```

Run: `npm install --package-lock-only`

Expected: `package-lock.json` is created and npm reports no dependency resolution error.

- [ ] **Step 3: Configure strict TypeScript compilation**

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "rootDir": "src",
    "outDir": "dist",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "skipLibCheck": true,
    "types": ["node", "vitest/globals"]
  },
  "include": ["src/**/*.ts"],
  "exclude": ["dist", "node_modules"]
}
```

- [ ] **Step 4: Write failing configuration tests**

Create `src/platform/config.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("loads explicit settings", () => {
    expect(
      loadConfig({
        DATABASE_URL: "postgres://sweetroll:secret@db:5432/sweetroll",
        HOST: "127.0.0.1",
        LOG_LEVEL: "debug",
        PORT: "4100",
      }),
    ).toEqual({
      databaseUrl: "postgres://sweetroll:secret@db:5432/sweetroll",
      host: "127.0.0.1",
      logLevel: "debug",
      port: 4100,
    });
  });

  it("uses safe process defaults", () => {
    expect(loadConfig({ DATABASE_URL: "postgres://localhost/sweetroll" })).toEqual({
      databaseUrl: "postgres://localhost/sweetroll",
      host: "0.0.0.0",
      logLevel: "info",
      port: 3000,
    });
  });

  it.each([
    [{}, "DATABASE_URL is required"],
    [{ DATABASE_URL: "postgres://localhost/db", PORT: "0" }, "PORT must be an integer from 1 through 65535"],
    [{ DATABASE_URL: "postgres://localhost/db", PORT: "3.5" }, "PORT must be an integer from 1 through 65535"],
    [{ DATABASE_URL: "postgres://localhost/db", LOG_LEVEL: "verbose" }, "LOG_LEVEL must be one of fatal, error, warn, info, debug, trace, silent"],
  ])("rejects invalid environment %#", (env, message) => {
    expect(() => loadConfig(env)).toThrow(message);
  });
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `npm test -- src/platform/config.test.ts`

Expected: FAIL because `src/platform/config.ts` does not exist.

- [ ] **Step 6: Implement configuration decoding**

Create `src/platform/config.ts`:

```typescript
const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export type AppConfig = {
  databaseUrl: string;
  host: string;
  logLevel: LogLevel;
  port: number;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const databaseUrl = env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("DATABASE_URL is required");
  }

  const port = Number(env.PORT ?? "3000");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer from 1 through 65535");
  }

  const logLevel = env.LOG_LEVEL ?? "info";
  if (!LOG_LEVELS.some((candidate) => candidate === logLevel)) {
    throw new Error(`LOG_LEVEL must be one of ${LOG_LEVELS.join(", ")}`);
  }

  return {
    databaseUrl,
    host: env.HOST ?? "0.0.0.0",
    logLevel: logLevel as LogLevel,
    port,
  };
}
```

Replace `src/platform/index.ts` with:

```typescript
export { loadConfig } from "./config.js";
export type { AppConfig, LogLevel } from "./config.js";
```

- [ ] **Step 7: Verify the typed workspace**

Run: `npm test -- src/platform/config.test.ts`

Expected: PASS with 6 tests.

Run: `npm run typecheck`

Expected: exit status 0.

- [ ] **Step 8: Commit the workspace foundation**

Because the repository currently has an unborn `main` branch, this first commit records the already-approved design and scaffold together with the workspace foundation.

```bash
git add AGENTS.md design_v2.md docs/superpowers/plans/2026-09-03-initial-directory-structure.md docs/superpowers/plans/2026-09-03-i1-foundation.md src .gitignore .npmrc .nvmrc package.json package-lock.json tsconfig.json
git commit -m "chore: establish TypeScript workspace"
```

---

### Task 2: Add HTTP Health And Observability

**Files:**
- Create: `src/platform/database.ts`
- Create: `src/platform/logging.ts`
- Create: `src/platform/metrics.ts`
- Create: `src/transport/http/app.ts`
- Create: `src/transport/http/app.test.ts`
- Modify: `src/platform/index.ts`
- Modify: `src/transport/http/index.ts`
- Modify: `src/bootstrap/http.ts`

**Interfaces:**
- Consumes: `AppConfig`, a PostgreSQL `Pool`, and a Pino `Logger` supplied at process composition.
- Produces: `buildHttpApp(input: { logger: Logger; pool: Pool }): FastifyInstance`, `/health/live`, `/health/ready`, `/metrics`, structured request logs, and a server-generated `x-request-id` response header.

- [ ] **Step 1: Write failing HTTP adapter tests**

Create `src/transport/http/app.test.ts`:

```typescript
import { Pool } from "pg";
import pino from "pino";
import { afterAll, describe, expect, it } from "vitest";

import { buildHttpApp } from "./app.js";

const pool = new Pool({ connectionString: "postgres://invalid:invalid@127.0.0.1:1/invalid" });
const app = buildHttpApp({ logger: pino({ enabled: false }), pool });

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe("HTTP platform endpoints", () => {
  it("reports liveness and emits a server request id", async () => {
    const response = await app.inject({ method: "GET", url: "/health/live" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    expect(response.headers["x-request-id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("does not trust a caller-supplied request id", async () => {
    const response = await app.inject({
      headers: { "x-request-id": "caller-controlled" },
      method: "GET",
      url: "/health/live",
    });

    expect(response.headers["x-request-id"]).not.toBe("caller-controlled");
  });

  it("returns bounded readiness failure details", async () => {
    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: "unavailable" });
  });

  it("exports baseline HTTP metrics", async () => {
    await app.inject({ method: "GET", url: "/health/live" });
    const response = await app.inject({ method: "GET", url: "/metrics" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/plain");
    expect(response.body).toContain("sweetroll_http_requests_total");
    expect(response.body).toContain("sweetroll_http_request_duration_seconds");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/transport/http/app.test.ts`

Expected: FAIL because `src/transport/http/app.ts` does not exist.

- [ ] **Step 3: Add the PostgreSQL, logging, and metrics platform helpers**

Create `src/platform/database.ts`:

```typescript
import { Pool } from "pg";

export function createPool(databaseUrl: string): Pool {
  return new Pool({ connectionString: databaseUrl, max: 10 });
}
```

Create `src/platform/logging.ts`:

```typescript
import pino, { type Logger } from "pino";

import type { LogLevel } from "./config.js";

export function createLogger(level: LogLevel): Logger {
  return pino({
    base: { service: "sweetroll" },
    level,
    redact: {
      paths: ["req.headers.authorization", "req.headers.cookie", "databaseUrl"],
      censor: "[REDACTED]",
    },
  });
}
```

Create `src/platform/metrics.ts`:

```typescript
import { Counter, Histogram, Registry } from "prom-client";

export type HttpMetrics = ReturnType<typeof createHttpMetrics>;

export function createHttpMetrics() {
  const registry = new Registry();
  const requests = new Counter({
    help: "Completed HTTP requests",
    labelNames: ["method", "route", "status_code"] as const,
    name: "sweetroll_http_requests_total",
    registers: [registry],
  });
  const duration = new Histogram({
    help: "HTTP response duration in seconds",
    labelNames: ["method", "route", "status_code"] as const,
    name: "sweetroll_http_request_duration_seconds",
    registers: [registry],
  });

  return { duration, registry, requests };
}
```

- [ ] **Step 4: Implement the HTTP application**

Create `src/transport/http/app.ts`:

```typescript
import { randomUUID } from "node:crypto";

import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { Logger } from "pino";

import { createHttpMetrics } from "../../platform/metrics.js";

export function buildHttpApp(input: { logger: Logger; pool: Pool }): FastifyInstance {
  const app = Fastify({ genReqId: () => randomUUID(), loggerInstance: input.logger });
  const metrics = createHttpMetrics();
  const startedAt = new WeakMap<object, bigint>();

  app.addHook("onRequest", async (request) => {
    startedAt.set(request, process.hrtime.bigint());
  });

  app.addHook("onSend", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });

  app.addHook("onResponse", async (request, reply) => {
    const start = startedAt.get(request);
    if (start === undefined) return;
    const labels = {
      method: request.method,
      route: request.routeOptions.url,
      status_code: String(reply.statusCode),
    };
    metrics.requests.inc(labels);
    metrics.duration.observe(
      labels,
      Number(process.hrtime.bigint() - start) / 1_000_000_000,
    );
  });

  app.get("/health/live", async () => ({ status: "ok" }));

  app.get("/health/ready", async (_request, reply) => {
    try {
      await input.pool.query({ text: "SELECT 1", query_timeout: 250 });
      return { status: "ok" };
    } catch {
      return reply.code(503).send({ status: "unavailable" });
    }
  });

  app.get("/metrics", async (_request, reply) => {
    reply.type(metrics.registry.contentType);
    return metrics.registry.metrics();
  });

  return app;
}
```

Replace `src/transport/http/index.ts` with:

```typescript
export { buildHttpApp } from "./app.js";
```

Replace `src/platform/index.ts` with:

```typescript
export { loadConfig } from "./config.js";
export type { AppConfig, LogLevel } from "./config.js";
export { createPool } from "./database.js";
export { createLogger } from "./logging.js";
```

- [ ] **Step 5: Compose the HTTP process**

Replace `src/bootstrap/http.ts` with:

```typescript
import { loadConfig, createLogger, createPool } from "../platform/index.js";
import { buildHttpApp } from "../transport/http/index.js";

const config = loadConfig();
const logger = createLogger(config.logLevel);
const pool = createPool(config.databaseUrl);
const app = buildHttpApp({ logger, pool });

const shutdown = async (signal: string) => {
  logger.info({ signal }, "shutting down HTTP process");
  await app.close();
  await pool.end();
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  logger.fatal({ err: error }, "HTTP process failed to start");
  await pool.end();
  process.exitCode = 1;
}
```

- [ ] **Step 6: Verify HTTP behavior and compilation**

Run: `npm test -- src/transport/http/app.test.ts`

Expected: PASS with 4 tests.

Run: `npm run typecheck && npm run build`

Expected: both commands exit with status 0 and `dist/bootstrap/http.js` exists.

- [ ] **Step 7: Commit HTTP observability**

```bash
git add src/platform src/transport/http src/bootstrap/http.ts
git commit -m "feat: add observable HTTP process"
```

---

### Task 3: Add Explicit PostgreSQL Migration Mode

**Files:**
- Create: `migrations/README.md`
- Create: `src/platform/migrations.ts`
- Create: `tests/fixtures/migrations/0001_create_probe.sql`
- Create: `tests/integration/migrations.test.ts`
- Modify: `src/bootstrap/migrate.ts`

**Interfaces:**
- Consumes: a connected `pg.Client` and a directory containing immutable files named `NNNN_snake_case.sql`.
- Produces: `runMigrations(client: Client, directory: string): Promise<void>`, checksum verification, ordered one-time application, and the `migrate` process mode.

- [ ] **Step 1: Document the migration contract and add a fixture**

Create `migrations/README.md`:

```markdown
# SQL migrations

Production migrations are immutable UTF-8 SQL files named `NNNN_snake_case.sql`.
The migrate process applies files in lexical order and records each SHA-256 checksum in `schema_migrations`.
Never modify an applied file; add a new migration to change the schema.
Each file runs in its own transaction while the process holds a PostgreSQL advisory lock.
```

Create `tests/fixtures/migrations/0001_create_probe.sql`:

```sql
CREATE TABLE migration_probe (
  id integer PRIMARY KEY
);
```

- [ ] **Step 2: Write failing real-PostgreSQL tests**

Create `tests/integration/migrations.test.ts`:

```typescript
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "../../src/platform/migrations.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl === undefined ? describe.skip : describe;

describeWithDatabase("runMigrations", () => {
  const schema = `migration_test_${randomUUID().replaceAll("-", "")}`;
  const directory = fileURLToPath(new URL("../fixtures/migrations", import.meta.url));
  let client: Client;

  beforeEach(async () => {
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
  });

  afterEach(async () => {
    await client.query(`DROP SCHEMA ${schema} CASCADE`);
    await client.end();
  });

  it("applies each migration once and records its checksum", async () => {
    await runMigrations(client, directory);
    await runMigrations(client, directory);

    const tables = await client.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name",
      [schema],
    );
    const records = await client.query<{ filename: string }>(
      "SELECT filename FROM schema_migrations ORDER BY filename",
    );

    expect(tables.rows.map(({ table_name }) => table_name)).toEqual([
      "migration_probe",
      "schema_migrations",
    ]);
    expect(records.rows).toEqual([{ filename: "0001_create_probe.sql" }]);
  });
});
```

- [ ] **Step 3: Run the integration test to verify it fails**

Run: `TEST_DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll npm run test:integration -- migrations.test.ts`

Expected: FAIL because `src/platform/migrations.ts` does not exist.

- [ ] **Step 4: Implement the migration runner**

Create `src/platform/migrations.ts`:

```typescript
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Client } from "pg";

const MIGRATION_NAME = /^\d{4}_[a-z0-9_]+\.sql$/;
const LOCK_ID = 1_938_465_725;

export async function runMigrations(client: Client, directory: string): Promise<void> {
  const filenames = (await readdir(directory)).filter((name) => MIGRATION_NAME.test(name)).sort();

  await client.query("SELECT pg_advisory_lock($1)", [LOCK_ID]);
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    for (const filename of filenames) {
      const sql = await readFile(join(directory, filename), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const existing = await client.query<{ checksum: string }>(
        "SELECT checksum FROM schema_migrations WHERE filename = $1",
        [filename],
      );

      if (existing.rowCount === 1) {
        if (existing.rows[0]?.checksum !== checksum) {
          throw new Error(`Applied migration checksum changed: ${filename}`);
        }
        continue;
      }

      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)",
          [filename, checksum],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_ID]);
  }
}
```

- [ ] **Step 5: Compose the migrate process**

Replace `src/bootstrap/migrate.ts` with:

```typescript
import { fileURLToPath } from "node:url";

import { Client } from "pg";

import { loadConfig } from "../platform/config.js";
import { createLogger } from "../platform/logging.js";
import { runMigrations } from "../platform/migrations.js";

const config = loadConfig();
const logger = createLogger(config.logLevel);
const client = new Client({ connectionString: config.databaseUrl });
const directory = fileURLToPath(new URL("../../migrations", import.meta.url));

try {
  await client.connect();
  await runMigrations(client, directory);
  logger.info("database migrations complete");
} catch (error) {
  logger.error({ err: error }, "database migrations failed");
  process.exitCode = 1;
} finally {
  await client.end();
}
```

- [ ] **Step 6: Verify migration behavior**

Run: `TEST_DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll npm run test:integration -- migrations.test.ts`

Expected: PASS with 1 test.

Run: `npm run typecheck && npm run build`

Expected: both commands exit with status 0 and `dist/bootstrap/migrate.js` exists.

- [ ] **Step 7: Commit migration mode**

```bash
git add migrations src/platform/migrations.ts src/bootstrap/migrate.ts tests
git commit -m "feat: add explicit SQL migration mode"
```

---

### Task 4: Package One Artifact And Local Environment

**Files:**
- Create: `.dockerignore`
- Create: `.env.example`
- Create: `Dockerfile`
- Create: `compose.yaml`
- Create: `README.md`

**Interfaces:**
- Consumes: the build and process scripts from Tasks 1 through 3.
- Produces: one `sweetroll` image runnable as either HTTP or migrations, plus a local PostgreSQL environment.

- [ ] **Step 1: Add local environment configuration**

Create `.env.example`:

```dotenv
DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll
HOST=0.0.0.0
LOG_LEVEL=info
PORT=3000
TEST_DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll
```

Create `compose.yaml`:

```yaml
services:
  postgres:
    image: postgres:17-alpine
    environment:
      POSTGRES_DB: sweetroll
      POSTGRES_PASSWORD: sweetroll
      POSTGRES_USER: sweetroll
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U sweetroll -d sweetroll"]
      interval: 2s
      timeout: 2s
      retries: 15
    ports:
      - "5432:5432"
    volumes:
      - sweetroll-postgres:/var/lib/postgresql/data

volumes:
  sweetroll-postgres:
```

- [ ] **Step 2: Add the single production artifact**

Create `.dockerignore`:

```dockerignore
.git
.superpowers
coverage
dist
node_modules
```

Create `Dockerfile`:

```dockerfile
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
RUN npm prune --omit=dev

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
USER node
COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node package.json ./package.json
COPY --chown=node:node migrations ./migrations
EXPOSE 3000
CMD ["npm", "run", "start:http"]
```

- [ ] **Step 3: Document exact development and process commands**

Create `README.md`:

```markdown
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
```

- [ ] **Step 4: Verify the complete local artifact**

Run: `docker compose up -d --wait postgres`

Expected: the `postgres` service becomes healthy.

Run: `TEST_DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll npm run test:integration`

Expected: PASS.

Run: `docker build -t sweetroll:i1-foundation .`

Expected: one image builds successfully and defaults to `npm run start:http`.

Run: `docker run --rm --network host -e DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll sweetroll:i1-foundation npm run start:migrate`

Expected: exit status 0 with a structured `database migrations complete` log.

- [ ] **Step 5: Commit local and deployment packaging**

```bash
git add .dockerignore .env.example Dockerfile compose.yaml README.md
git commit -m "chore: package application runtime"
```

---

### Task 5: Add Continuous Verification And Image Delivery

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/release.yml`

**Interfaces:**
- Consumes: npm verification scripts, PostgreSQL 17, and the root Dockerfile.
- Produces: required CI evidence on pushes and pull requests, plus a GHCR image tagged from `v*.*.*` releases.

- [ ] **Step 1: Add CI with real PostgreSQL**

Create `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  verify:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:17-alpine
        env:
          POSTGRES_DB: sweetroll
          POSTGRES_PASSWORD: sweetroll
          POSTGRES_USER: sweetroll
        ports:
          - 5432:5432
        options: >-
          --health-cmd "pg_isready -U sweetroll -d sweetroll"
          --health-interval 2s
          --health-timeout 2s
          --health-retries 15
    env:
      TEST_DATABASE_URL: postgres://sweetroll:sweetroll@localhost:5432/sweetroll
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          cache: npm
          node-version-file: .nvmrc
      - run: npm ci
      - run: npm test
      - run: npm run test:integration
      - run: npm run typecheck
      - run: npm run build
      - run: docker build -t sweetroll:ci .
```

- [ ] **Step 2: Add versioned image delivery without deployment assumptions**

Create `.github/workflows/release.yml`:

```yaml
name: Release image

on:
  push:
    tags: ["v*.*.*"]

permissions:
  contents: read
  packages: write

jobs:
  image:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/metadata-action@v5
        id: meta
        with:
          images: ghcr.io/${{ github.repository }}
          tags: type=semver,pattern={{version}}
      - uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
```

- [ ] **Step 3: Run the full local verification sequence**

Run: `npm ci && npm test && TEST_DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll npm run test:integration && npm run typecheck && npm run build && docker build -t sweetroll:i1-foundation .`

Expected: dependency installation succeeds, all tests pass, TypeScript compiles, and the image builds.

- [ ] **Step 4: Review scope against I1 Task 1**

Confirm all of the following:

- One npm package and one Dockerfile exist.
- Only `http` and `migrate` process modes exist.
- PostgreSQL migrations are explicit SQL and tested against real PostgreSQL.
- Logs are structured and redact authorization, cookie, and database URL fields.
- HTTP responses contain server-generated request IDs.
- Liveness, readiness, request count, and request-duration metrics are available.
- CI verifies tests, types, compilation, and the image; release automation publishes the same image.
- No worker, ORM, event bus, outbox, Identity behavior, system package, rules engine, or System Interfaces were implemented.

- [ ] **Step 5: Commit CI and image delivery**

```bash
git add .github/workflows/ci.yml .github/workflows/release.yml
git commit -m "ci: verify and publish application image"
```
