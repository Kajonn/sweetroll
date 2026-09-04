# I2 System Builder Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a responsive React + TypeScript web client at `web/` that lets a non-programmer create, edit, preview, validate, publish, version, archive, export, and clone-from-template systems entirely through the browser; close the OpenAPI gap from I1; add a developer-only sign-in route; and demonstrate the §17.4 acceptance flow with Playwright + axe + visual regression.

**Architecture:** Vite-built SPA at `web/` with React 18, TanStack Router, TanStack Query, React Hook Form + Zod, Radix UI Primitives, CSS Modules. Backend unchanged in shape — adds an OpenAPI generator extending `scripts/generate-system-contracts.ts` and a `NODE_ENV !== "production"`-gated `POST /dev/signin` route. Eight phases (I2-A through I2-H) each independently demoable.

**Tech Stack:** Node 24, TypeScript 5.9 (strict, NodeNext, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`), Vite 5+, React 18, TanStack Router, TanStack Query, React Hook Form, Zod, Radix UI Primitives, CSS Modules, Vitest, React Testing Library, MSW, Playwright, `@axe-core/playwright`, `openapi-typescript`. Reuses I1 expression engine modules via a thin client port.

**Spec:** `docs/superpowers/specs/2026-09-04-i2-system-builder-design.md`. This plan argues from the spec; executors read both.

**Design:** `design_v2.md` sections 10, 11, 13, 14, 15, 17.4.

## Global Constraints

Verbatim from the spec §3:

- One Module Interface per backend Module; web client is a thin caller over HTTP. No client-side reimplementation of authorization, validation, transaction ordering, or budget enforcement.
- Web client sends and receives only what the OpenAPI artifact documents. Generated TypeScript types are the only types the client imports for HTTP payloads.
- Generated HTTP client is generated, not hand-written. The single hand-written file wraps `fetch` with cookie credentials, request IDs, and a typed error envelope.
- All user-visible strings route through a typed `t(id, params?)` function backed by a default English message table. No JSX literal English outside the message table.
- WCAG 2.2 AA for every critical flow; keyboard reachability for every action; visible focus; label-name association; contrast ratios; no drag-only controls.
- Every action has a documented keyboard shortcut. The status bar lists available shortcuts for the current view.
- Autosave is debounced 600 ms and only fires when structural content actually changes. The client always carries the latest `expectedRevision`.
- Conflict recovery uses the `409 latestRevision` envelope: non-blocking banner with "Their changes" and "Your changes" previews plus accept-theirs / keep-mine / merge-into-server actions.
- Display strings separate from stable IDs. A label rename never changes a definition ID.
- Structured allow-list logging on the client: never log session tokens, draft documents, or expression source; surface request IDs in error toasts.
- Phone (360 px) and desktop (1280 px) rendering are both first-class; the builder is usable end-to-end on a phone.
- Frontend tests assert observable behavior (rendered text, ARIA, accessible name, keyboard activation).
- The dev sign-in route is gated on `NODE_ENV !== "production"` at the bootstrap; the web client routes to it only when `import.meta.env.MODE === "development"`.
- Every phase ends with green `npm run typecheck`, `npm test`, `npm run test:integration`, `npm run contracts:check`, and the web client's `npm run test`, `npm run test:e2e`. Each phase ships a one-paragraph closure commit.

Additional operational rules:

- Web root: `web/`. Use a separate `package.json` and `tsconfig.json` from the backend; root `package.json` proxies the common scripts via `npm --prefix web`.
- Node ≥ 24, no native dependencies; every web dep is JS-only and ships as ESM.
- Vite proxies `/api/*` to `http://localhost:3000` in development. In production the backend serves `web/dist/` as static assets (registered in `src/bootstrap/http.ts` behind `NODE_ENV === "production"`).
- Backend tests (`npm test`, `npm run test:integration`, `npm run contracts:check`) must continue to pass at every checkpoint. Web tests run independently against the same compose stack.
- No `console.log` in committed code; use the structured allow-list logger from `src/platform/logger.ts` for cross-cutting logging on the server; for client, surface diagnostics through `ErrorBoundary` and toasts.
- Every commit message follows the existing repo style: `feat:`, `fix:`, `test:`, `docs:`, `chore:`, `refactor:` prefix + concise summary.

---

## Phase index

| Phase | §17.4 tasks | Tasks in this plan |
|-------|-------------|---------------------|
| **I2-A Foundation** | Task 1 (skeleton, OpenAPI, dev sign-in) | Tasks 1–4 |
| **I2-B Shell + library** | Task 1 (full), Task 2 | Tasks 5–10 |
| **I2-C Metadata + simple field editors** | Task 3 (metadata, scalar, choice, boolean, image) | Tasks 11–14 |
| **I2-D Resource + computed + sheet editor** | Task 3 (resource, computed), Task 4 | Tasks 15–18 |
| **I2-E Expression + action + validation + reference-data** | Task 5 | Tasks 19–23 |
| **I2-F Preview + sample data + diagnostics drawer** | Tasks 6, 7 | Tasks 24–27 |
| **I2-G Publish + version history + export + clone-from-template** | Task 8 | Tasks 28–31 |
| **I2-H Test pass + acceptance demo** | Task 9 | Tasks 32–35 |

Each task is one reviewer gate: independently testable deliverable + one commit.

---

## Phase I2-A — Foundation

### Task 1: Web workspace scaffold + dev scripts

**Files:**
- Create: `web/package.json`
- Create: `web/tsconfig.json`
- Create: `web/vite.config.ts`
- Create: `web/index.html`
- Create: `web/src/main.tsx`
- Create: `web/src/styles/global.css`
- Modify: `package.json` (add `web:*` proxy scripts)
- Modify: `.gitignore`

**Interfaces:**
- Consumes: nothing.
- Produces: a Vite dev server (`npm run web:dev`) that renders an empty `<div id="root">` mounted by a React 18 `createRoot` call. Production build emits `web/dist/`.

- [ ] **Step 1: Create `web/package.json`**

```json
{
  "name": "sweetroll-web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -p tsconfig.json --noEmit && vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:e2e": "playwright test",
    "test:e2e:update": "playwright test --update-snapshots",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@radix-ui/react-dialog": "1.1.2",
    "@radix-ui/react-popover": "1.1.2",
    "@radix-ui/react-toast": "1.2.2",
    "@tanstack/react-query": "5.59.0",
    "@tanstack/react-router": "1.78.0",
    "react": "18.3.1",
    "react-dom": "18.3.1",
    "react-hook-form": "7.53.0",
    "@hookform/resolvers": "3.9.0",
    "zod": "3.23.8",
    "lucide-react": "0.453.0"
  },
  "devDependencies": {
    "@playwright/test": "1.48.0",
    "@axe-core/playwright": "4.10.0",
    "@testing-library/jest-dom": "6.5.0",
    "@testing-library/react": "16.0.1",
    "@testing-library/user-event": "14.5.2",
    "@types/react": "18.3.11",
    "@types/react-dom": "18.3.0",
    "@vitejs/plugin-react": "4.3.2",
    "jsdom": "25.0.1",
    "msw": "2.4.9",
    "typescript": "5.9.2",
    "vite": "5.4.8",
    "vitest": "2.1.2"
  }
}
```

- [ ] **Step 2: Create `web/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "strict": true,
    "exactOptionalPropertyTypes": true,
    "noUncheckedIndexedAccess": true,
    "verbatimModuleSyntax": true,
    "noEmit": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "types": ["vite/client", "@testing-library/jest-dom"]
  },
  "include": ["src", "tests"]
}
```

- [ ] **Step 3: Create `web/vite.config.ts`**

```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: "http://localhost:3000", changeOrigin: true, rewrite: (p) => p.replace(/^\/api/, "") },
    },
  },
  build: { outDir: "dist", sourcemap: true },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/testing/setup.ts"],
    globals: true,
  },
});
```

- [ ] **Step 4: Create `web/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="color-scheme" content="light" />
    <title>Sweetroll</title>
  </head>
  <body>
    <div id="root" data-testid="app-root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 5: Create `web/src/styles/global.css`**

```css
:root {
  --color-bg: #fafafa;
  --color-surface: #ffffff;
  --color-fg: #171717;
  --color-fg-muted: #525252;
  --color-border: #e5e5e5;
  --color-accent: #4f46e5;
  --color-accent-fg: #ffffff;
  --color-error: #dc2626;
  --color-warning: #d97706;
  --color-success: #059669;
  --font-sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Inter, sans-serif;
  --font-mono: ui-monospace, "JetBrains Mono", SFMono-Regular, Menlo, monospace;
  --radius-sm: 4px;
  --radius-md: 6px;
  --radius-lg: 8px;
  --radius-xl: 12px;
}

* { box-sizing: border-box; }

html, body, #root {
  height: 100%;
  margin: 0;
  font-family: var(--font-sans);
  font-size: 14px;
  line-height: 1.5;
  color: var(--color-fg);
  background: var(--color-bg);
  -webkit-font-smoothing: antialiased;
}

button { font: inherit; cursor: pointer; }
:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }
```

- [ ] **Step 6: Create `web/src/main.tsx`**

```typescript
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./styles/global.css";

const root = document.getElementById("root");
if (root === null) throw new Error("Missing #root element");
createRoot(root).render(<StrictMode><div data-testid="app-ready">Sweetroll</div></StrictMode>);
```

- [ ] **Step 7: Create `web/src/testing/setup.ts`**

```typescript
import "@testing-library/jest-dom/vitest";
```

- [ ] **Step 8: Modify root `package.json`**

Add to `"scripts"`:

```json
"web:dev": "npm --prefix web run dev",
"web:build": "npm --prefix web run build",
"web:test": "npm --prefix web run test",
"web:test:e2e": "npm --prefix web run test:e2e",
"web:typecheck": "npm --prefix web run typecheck"
```

- [ ] **Step 9: Modify `.gitignore`**

Append:

```
web/dist/
web/node_modules/
web/test-results/
web/playwright-report/
```

- [ ] **Step 10: Install + verify scaffold**

Run: `npm --prefix web install`
Run: `npm run web:dev &; sleep 4; curl -fsS http://localhost:5173/ | grep -q 'data-testid="app-root"'; kill %1`
Expected: exit code 0.

- [ ] **Step 11: Commit**

```bash
git add web/package.json web/tsconfig.json web/vite.config.ts web/index.html web/src package.json .gitignore package-lock.json
git commit -m "feat(web): scaffold Vite + React 18 + TS workspace"
```

### Task 2: Generate OpenAPI artifact from TypeBox schemas

**Files:**
- Modify: `src/transport/http/index.ts`
- Modify: `src/transport/http/systems.ts`
- Create: `src/transport/http/openapi.ts`
- Modify: `scripts/generate-system-contracts.ts`
- Create: `docs/contracts/openapi-v1.json` (generated)
- Test: `src/transport/http/openapi.test.ts`

**Interfaces:**
- Consumes: existing TypeBox schemas on each route (`request`, `querystring`, `params`, `response`).
- Produces: `buildOpenApiDocument(app: FastifyInstance): OpenAPIV3.Document` and `npm run contracts:generate` also emits `docs/contracts/openapi-v1.json`.

- [ ] **Step 1: Add TypeBox schemas to every route in `src/transport/http/systems.ts`**

Update the file to attach schemas. Example for the `POST /systems` route:

```typescript
import { Type } from "@sinclair/typebox";

const ErrorEnvelope = Type.Object({
  error: Type.Object({
    code: Type.String(),
    message: Type.String(),
    latestRevision: Type.Optional(Type.Integer()),
    diagnostics: Type.Optional(Type.Array(Type.Object({
      code: Type.String(),
      path: Type.String(),
      message: Type.String(),
      severity: Type.Optional(Type.Union([Type.Literal("error"), Type.Literal("warning")])),
    }))),
  }),
  requestId: Type.String(),
});

const WorkspaceDto = Type.Object({
  systemId: Type.String({ format: "uuid" }),
  name: Type.String(),
  lifecycle: Type.Union([Type.Literal("active"), Type.Literal("archived")]),
  revision: Type.Integer(),
  document: Type.Object({}), // intentionally opaque; backend decodes
  assessment: Type.Object({ ok: Type.Boolean(), diagnostics: Type.Array(Type.Object({ code: Type.String(), path: Type.String(), message: Type.String() })) }),
  createdAt: Type.String({ format: "date-time" }),
  updatedAt: Type.String({ format: "date-time" }),
});

app.post("/systems", {
  schema: {
    body: Type.Object({
      source: Type.Union([
        Type.Object({ kind: Type.Literal("blank"), name: Type.String({ minLength: 1 }) }),
        Type.Object({ kind: Type.Literal("clone"), versionId: Type.String({ format: "uuid" }) }),
        Type.Object({ kind: Type.Literal("import"), content: Type.String({ minLength: 1 }) }),
      ]),
      idempotencyKey: Type.String({ minLength: 1 }),
    }),
    response: { 201: Type.Object({ workspace: WorkspaceDto, requestId: Type.String() }) },
  },
}, async (request, reply) => { /* unchanged body */ });
```

Repeat this pattern for every route in `src/transport/http/systems.ts` and the auth hook returns. Routes without a schema will fail `npm run contracts:check`.

- [ ] **Step 2: Write the failing OpenAPI test**

Create `src/transport/http/openapi.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import Fastify from "fastify";

import { buildHttpApp } from "./index.js";
import { buildOpenApiDocument } from "./openapi.js";
import { buildSystemsRoutes } from "./systems.js";
import type { SystemAuthoring } from "../../systems/authoring.js";

describe("buildOpenApiDocument", () => {
  it("emits an OpenAPI 3.1 document with every systems route", async () => {
    const app = Fastify();
    void app.register(buildSystemsRoutes({ authoring: {} as SystemAuthoring }));
    await app.ready();
    const doc = buildOpenApiDocument(app);
    expect(doc.openapi).toBe("3.1.0");
    expect(Object.keys(doc.paths ?? {}).sort()).toEqual([
      "/system-versions/{versionId}",
      "/system-versions/{versionId}/export",
      "/systems",
      "/systems/{systemId}",
      "/systems/{systemId}/draft",
      "/systems/{systemId}/preview",
      "/systems/{systemId}/publish",
    ]);
    for (const path of Object.keys(doc.paths ?? {})) {
      for (const method of Object.keys(doc.paths?.[path] ?? {})) {
        const op = doc.paths?.[path][method];
        expect(op?.operationId, `${method} ${path}`).toBeTypeOf("string");
      }
    }
    await app.close();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- src/transport/http/openapi.test.ts`
Expected: FAIL — `./openapi.js` does not resolve.

- [ ] **Step 4: Implement `src/transport/http/openapi.ts`**

```typescript
import type { FastifyInstance } from "fastify";

export type OpenApiComponents = Record<string, unknown>;
export type OpenApiDocument = {
  openapi: "3.1.0";
  info: { title: string; version: string };
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: Record<string, unknown>; responses: Record<string, unknown> };
};

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;

export function buildOpenApiDocument(app: FastifyInstance): OpenApiDocument {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of app.printRoutes({ method: true }).matched) {
    const [method, ...rest] = route.split(" ");
    const path = rest.join(" ").trim();
    if (method === undefined || path.length === 0) continue;
    const lower = method.toLowerCase();
    if (!(HTTP_METHODS as readonly string[]).includes(lower)) continue;
    const op = app[lower as "get"]?.["schema"]; // populated by Fastify route schema
    paths[path] ??= {};
    paths[path][lower] = {
      operationId: `${lower}_${path.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_|_$/g, "")}`,
      requestBody: op?.body !== undefined ? { content: { "application/json": { schema: op.body } } } : undefined,
      parameters: [
        ...(op?.params !== undefined ? [Object.entries(op.params).map(([k, v]) => ({ name: k, in: "path", required: true, schema: v }))] : []),
        ...(op?.querystring !== undefined ? [Object.entries(op.querystring).map(([k, v]) => ({ name: k, in: "query", schema: v }))] : []),
      ].flat(),
      responses: op?.response ?? {},
    };
  }
  return {
    openapi: "3.1.0",
    info: { title: "Sweetroll HTTP API", version: "1.0.0" },
    paths,
    components: { schemas: {}, responses: {} },
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- src/transport/http/openapi.test.ts`
Expected: PASS.

- [ ] **Step 6: Extend `scripts/generate-system-contracts.ts`**

Add to the existing script:

```typescript
import Fastify from "fastify";
import { buildHttpApp } from "../src/transport/http/index.js";
import { buildSystemsRoutes } from "../src/transport/http/systems.js";
import { buildOpenApiDocument } from "../src/transport/http/openapi.js";
import type { SystemAuthoring } from "../src/systems/authoring.js";
import { writeFileSync, readFileSync } from "node:fs";

async function emitOpenApi(outDir: string): Promise<void> {
  const app = Fastify();
  void app.register(buildSystemsRoutes({ authoring: {} as SystemAuthoring }));
  await app.ready();
  const doc = buildOpenApiDocument(app);
  const target = `${outDir}/docs/contracts/openapi-v1.json`;
  const json = JSON.stringify(doc, null, 2) + "\n";
  if (checkMode) {
    const current = readFileSync(target, "utf-8");
    if (current !== json) throw new Error(`openapi-v1.json is stale; run \`npm run contracts:generate\``);
  } else {
    writeFileSync(target, json);
  }
  await app.close();
}
```

Call `emitOpenApi(process.cwd())` after the existing contract generation.

- [ ] **Step 7: Run generation and commit**

Run: `npm run contracts:generate`
Expected: `docs/contracts/openapi-v1.json` exists.

Run: `npm run contracts:check`
Expected: exit 0.

```bash
git add src/transport/http/openapi.ts src/transport/http/openapi.test.ts src/transport/http/systems.ts src/transport/http/index.ts scripts/generate-system-contracts.ts docs/contracts/openapi-v1.json
git commit -m "feat(api): generate OpenAPI 3.1 artifact from TypeBox schemas"
```

### Task 3: Generated client types + typed fetch wrapper

**Files:**
- Create: `web/src/api/schema.d.ts` (generated)
- Create: `web/src/api/client.ts`
- Create: `web/src/api/client.test.ts`
- Modify: `scripts/generate-system-contracts.ts`

**Interfaces:**
- Consumes: `docs/contracts/openapi-v1.json`.
- Produces: `apiClient.fetch<TBody, TResp>(method, path, init?): Promise<TResp>` that throws `ApiError` with `{ code, message, status, requestId }`.

- [ ] **Step 1: Extend `scripts/generate-system-contracts.ts` to emit `web/src/api/schema.d.ts`**

```typescript
import { execSync } from "node:child_process";

// after emitOpenApi:
const target = `${outDir}/web/src/api/schema.d.ts`;
const generated = execSync(
  `npx --yes openapi-typescript ${outDir}/docs/contracts/openapi-v1.json --output ${target}`,
  { stdio: ["ignore", "pipe", "pipe"] },
).toString();
// openapi-typescript writes the file directly; we only check it in check mode
if (checkMode) {
  const current = readFileSync(target, "utf-8");
  // Compare against the just-generated bytes via a second run into a temp file.
  const tmp = `${target}.new`;
  writeFileSync(tmp, execSync(`npx --yes openapi-typescript ${outDir}/docs/contracts/openapi-v1.json`).toString());
  if (readFileSync(tmp, "utf-8") !== current) throw new Error(`schema.d.ts is stale`);
  execSync(`rm ${tmp}`);
}
```

Add `openapi-typescript` to root `devDependencies` (no version pin needed if `--yes` is used).

- [ ] **Step 2: Run generation**

Run: `npm run contracts:generate`
Expected: `web/src/api/schema.d.ts` exists.

- [ ] **Step 3: Write the failing client test**

Create `web/src/api/client.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";

import { ApiError, createApiClient } from "./client.js";

describe("createApiClient", () => {
  it("returns parsed JSON on 2xx", async () => {
    const fetch_ = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "x-request-id": "req-1" } }));
    const client = createApiClient({ baseUrl: "http://api", fetch: fetch_ as typeof fetch });
    const out = await client.fetch("GET", "/foo");
    expect(out).toEqual({ ok: true });
    expect(fetch_).toHaveBeenCalledWith("http://api/foo", expect.objectContaining({ credentials: "include" }));
  });

  it("throws ApiError with code + status + requestId on 4xx", async () => {
    const fetch_ = vi.fn(async () => new Response(JSON.stringify({ error: { code: "bad_request", message: "no" }, requestId: "r-2" }), { status: 400, headers: { "content-type": "application/json" } }));
    const client = createApiClient({ baseUrl: "http://api", fetch: fetch_ as typeof fetch });
    await expect(client.fetch("POST", "/x", { body: { a: 1 } })).rejects.toMatchObject({ code: "bad_request", status: 400, requestId: "r-2" });
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npm run web:test -- src/api/client.test.ts`
Expected: FAIL — `./client.js` does not resolve.

- [ ] **Step 5: Implement `web/src/api/client.ts`**

```typescript
export type ApiErrorCode = string;

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly requestId: string;

  constructor(input: { code: ApiErrorCode; message: string; status: number; requestId: string }) {
    super(input.message);
    this.code = input.code;
    this.status = input.status;
    this.requestId = input.requestId;
  }
}

export type ApiClient = {
  fetch<TResp = unknown, TBody = unknown>(method: string, path: string, init?: { body?: TBody; headers?: Record<string, string>; query?: Record<string, string | number | null | undefined> }): Promise<TResp>;
};

export type CreateApiClientInput = {
  baseUrl: string;
  fetch?: typeof fetch;
};

export function createApiClient(input: CreateApiClientInput): ApiClient {
  const f = input.fetch ?? fetch;
  return {
    async fetch(method, path, init) {
      const url = new URL(input.baseUrl + path);
      if (init?.query !== undefined) {
        for (const [k, v] of Object.entries(init.query)) {
          if (v === null || v === undefined) continue;
          url.searchParams.set(k, String(v));
        }
      }
      const headers: Record<string, string> = { accept: "application/json", ...(init?.headers ?? {}) };
      const requestId = crypto.randomUUID();
      headers["x-request-id"] = requestId;
      const response = await f(url.toString(), {
        method,
        credentials: "include",
        headers,
        body: init?.body === undefined ? undefined : JSON.stringify(init.body),
      });
      const text = await response.text();
      const parsed: unknown = text.length === 0 ? null : JSON.parse(text);
      if (!response.ok) {
        const env = parsed as { error?: { code?: string; message?: string }; requestId?: string } | null;
        throw new ApiError({
          code: env?.error?.code ?? `http_${response.status}`,
          message: env?.error?.message ?? response.statusText,
          status: response.status,
          requestId: env?.requestId ?? requestId,
        });
      }
      return parsed as never;
    },
  };
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm run web:test -- src/api/client.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add scripts/generate-system-contracts.ts web/src/api/schema.d.ts web/src/api/client.ts web/src/api/client.test.ts
git commit -m "feat(web): generated client types and typed fetch wrapper"
```

### Task 4: Dev sign-in route + bootstrap wiring

**Files:**
- Modify: `src/platform/config.ts` (add `nodeEnv`, `devSeedCodes`)
- Create: `src/transport/http/dev-signin.ts`
- Create: `src/transport/http/dev-signin.test.ts`
- Modify: `src/bootstrap/http.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: existing `Identity` Module and `createTestOidcClient`.
- Produces: `POST /dev/signin` (gated on `NODE_ENV !== "production"`) and `GET /dev/signin/codes`; the bootstrap wires a seeded `createTestOidcClient` when `NODE_ENV !== "production"`.

- [ ] **Step 1: Extend `src/platform/config.ts`**

Add to `AppConfig`:

```typescript
nodeEnv: "development" | "production" | "test";
```

In `loadConfig`:

```typescript
const nodeEnvRaw = env.NODE_ENV ?? "development";
if (nodeEnvRaw !== "development" && nodeEnvRaw !== "production" && nodeEnvRaw !== "test") {
  throw new Error("NODE_ENV must be development, production, or test");
}
return { ..., nodeEnv: nodeEnvRaw };
```

- [ ] **Step 2: Write the failing dev-signin test**

Create `src/transport/http/dev-signin.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { Type } from "@sinclair/typebox";

import type { Identity } from "../../identity/index.js";
import { buildDevSignInRoutes } from "./dev-signin.js";

const buildIdentity = (): Identity => ({
  completeSignIn: async () => ({ ok: true, value: { token: "tok", userId: "u", sessionId: "s", expiresAt: new Date(0) } }),
  resolveSession: async () => ({ state: "anonymous" }),
  signOut: async () => ({ ok: true, value: undefined }),
});

describe("buildDevSignInRoutes", () => {
  it("returns 404 in production", async () => {
    const app = Fastify();
    void app.register(buildDevSignInRoutes({ identity: buildIdentity(), nodeEnv: "production" }));
    const res = await app.inject({ method: "POST", url: "/dev/signin", payload: { code: "x", redirectUri: "y" } });
    expect(res.statusCode).toBe(404);
  });

  it("returns 200 in development", async () => {
    const app = Fastify();
    void app.register(buildDevSignInRoutes({ identity: buildIdentity(), nodeEnv: "development" }));
    const res = await app.inject({ method: "POST", url: "/dev/signin", payload: { code: "x", redirectUri: "y" } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["set-cookie"]).toContain("session=tok");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- src/transport/http/dev-signin.test.ts`
Expected: FAIL — `./dev-signin.js` does not resolve.

- [ ] **Step 4: Implement `src/transport/http/dev-signin.ts`**

```typescript
import type { FastifyPluginCallback } from "fastify";
import fp from "fastify-plugin";
import { Type } from "@sinclair/typebox";

import type { Identity } from "../../identity/index.js";

const BODY = Type.Object({ code: Type.String({ minLength: 1 }), redirectUri: Type.String({ minLength: 1 }) });
const RESP = Type.Object({ userId: Type.String(), sessionId: Type.String(), expiresAt: Type.String() });
const SEEDED_CODES: ReadonlyArray<{ code: string; displayName: string; email: string }> = [
  { code: "code-dev", displayName: "Dev User", email: "dev@example.com" },
];

export type BuildDevSignInRoutesInput = {
  identity: Identity;
  nodeEnv: "development" | "production" | "test";
  cookieName?: string;
  secure?: boolean;
  maxAgeSeconds?: number;
};

export const buildDevSignInRoutes: (input: BuildDevSignInRoutesInput) => FastifyPluginCallback =
  ({ identity, nodeEnv, cookieName = "session", secure = false, maxAgeSeconds = 30 * 86_400 }) =>
  fp(async (app) => {
    if (nodeEnv === "production") return;
    app.post("/dev/signin", {
      schema: { body: BODY, response: { 200: RESP } },
    }, async (request, reply) => {
      const body = request.body as { code: string; redirectUri: string };
      const result = await identity.completeSignIn({ code: body.code, redirectUri: body.redirectUri, previousToken: undefined });
      if (!result.ok) return reply.code(400).send({ error: { code: result.error.code, message: result.error.message }, requestId: request.id });
      reply.setCookie(cookieName, result.value.token, { httpOnly: true, sameSite: "lax", path: "/", secure, maxAge: maxAgeSeconds });
      return { userId: result.value.userId, sessionId: result.value.sessionId, expiresAt: result.value.expiresAt.toISOString() };
    });

    app.get("/dev/signin/codes", async () => ({ codes: SEEDED_CODES }));
  });
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- src/transport/http/dev-signin.test.ts`
Expected: PASS.

- [ ] **Step 6: Wire dev sign-in into `src/bootstrap/http.ts`**

Replace the empty `createTestOidcClient(new Map())` with seeded codes in non-production, and register the dev routes:

```typescript
import { buildDevSignInRoutes } from "../transport/http/dev-signin.js";

const seed = new Map([
  ["code-dev", { displayName: "Dev User", email: "dev@example.com", provider: "test", subject: "dev-1" }],
]);

const identity = createIdentityModule({
  oidc: config.nodeEnv === "production" ? createTestOidcClient(new Map()) : createTestOidcClient(seed),
  pool,
  sessionTtlMs: config.sessionTtlDays * 86_400_000,
});

// ...
void app.register(buildSystemsRoutes({ authoring }));
void app.register(buildDevSignInRoutes({ identity, nodeEnv: config.nodeEnv, cookieName: config.sessionCookieName, secure: config.cookieSecure, maxAgeSeconds: config.sessionTtlDays * 86_400 }));
```

- [ ] **Step 7: Update `.env.example`**

Append: `NODE_ENV=development`

- [ ] **Step 8: Run full backend suite**

Run: `npm run typecheck && npm test && TEST_DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll npm run test:integration && npm run contracts:check`
Expected: all green.

- [ ] **Step 9: Commit**

```bash
git add src/platform/config.ts src/transport/http/dev-signin.ts src/transport/http/dev-signin.test.ts src/bootstrap/http.ts .env.example
git commit -m "feat(api): dev-only sign-in route and seeded test OIDC client"
```

---

## Phase I2-B — Shell + library

### Task 5: App shell + auth context

**Files:**
- Create: `web/src/shell/AppShell.tsx`
- Create: `web/src/shell/AppShell.module.css`
- Create: `web/src/shell/ErrorBoundary.tsx`
- Create: `web/src/shell/StatusBar.tsx`
- Create: `web/src/shell/StatusBar.module.css`
- Create: `web/src/shell/AppShell.test.tsx`
- Modify: `web/src/main.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: `<AppShell>{children}</AppShell>` renders a `<header>`, three-pane `<main>` (sidebar | tree | editor), and a `<footer>` status bar. Provides an `AuthProvider` that exposes `useAuth(): { state, userId? }`.

- [ ] **Step 1: Write the failing AppShell test**

Create `web/src/shell/AppShell.test.tsx`:

```typescript
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AppShell } from "./AppShell.js";

describe("AppShell", () => {
  it("renders header, main, and footer landmarks", () => {
    render(<AppShell>content</AppShell>);
    expect(screen.getByRole("banner")).toBeInTheDocument();
    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(screen.getByRole("contentinfo")).toBeInTheDocument();
    expect(screen.getByTestId("status-bar")).toHaveTextContent("Online");
  });

  it("renders children in the main region", () => {
    render(<AppShell><span data-testid="child">x</span></AppShell>);
    expect(screen.getByTestId("child")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run web:test -- src/shell/AppShell.test.tsx`
Expected: FAIL — `./AppShell.js` does not resolve.

- [ ] **Step 3: Create `web/src/shell/AppShell.module.css`**

```css
.shell {
  display: grid;
  grid-template-rows: 48px 1fr 28px;
  height: 100vh;
}
.main {
  display: grid;
  grid-template-columns: 240px minmax(280px, 360px) 1fr;
  min-height: 0;
}
@media (max-width: 1023px) {
  .main { grid-template-columns: 240px 1fr; }
}
@media (max-width: 767px) {
  .main { grid-template-columns: 1fr; }
}
```

- [ ] **Step 4: Create `web/src/shell/StatusBar.tsx` and `StatusBar.module.css`**

`StatusBar.module.css`:

```css
.bar { display: flex; gap: 12px; align-items: center; padding: 0 12px; border-top: 1px solid var(--color-border); font-size: 12px; color: var(--color-fg-muted); }
.spacer { flex: 1; }
.indicator { width: 8px; height: 8px; border-radius: 50%; background: var(--color-success); }
.offline { background: var(--color-warning); }
```

`StatusBar.tsx`:

```typescript
import styles from "./StatusBar.module.css";

export function StatusBar({ requestId, online }: { requestId?: string; online: boolean }) {
  return (
    <footer role="contentinfo" className={styles.bar} data-testid="status-bar">
      <span className={`${styles.indicator} ${online ? "" : styles.offline}`} aria-hidden />
      <span>{online ? "Online" : "Offline"}</span>
      <span className={styles.spacer} />
      {requestId !== undefined && <span data-testid="request-id">{requestId}</span>}
      <kbd>?</kbd><span>Shortcuts</span>
    </footer>
  );
}
```

- [ ] **Step 5: Create `web/src/shell/ErrorBoundary.tsx`**

```typescript
import { Component, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { error: Error | null };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };
  static getDerivedStateFromError(error: Error): State { return { error }; }
  override render() {
    if (this.state.error !== null) {
      return (
        <div role="alert" data-testid="error-boundary">
          <h2>Something went wrong</h2>
          <pre>{this.state.error.message}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}
```

- [ ] **Step 6: Implement `web/src/shell/AppShell.tsx`**

```typescript
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

import { ErrorBoundary } from "./ErrorBoundary.js";
import { StatusBar } from "./StatusBar.js";
import styles from "./AppShell.module.css";

export type AuthState = { state: "loading" } | { state: "anonymous" } | { state: "authenticated"; userId: string };

const AuthContext = createContext<AuthState>({ state: "loading" });
export const useAuth = (): AuthState => useContext(AuthContext);

export function AuthProvider({ initial, children }: { initial: AuthState; children: ReactNode }) {
  return <AuthContext.Provider value={initial}>{children}</AuthContext.Provider>;
}

export function AppShell({ children }: { children: ReactNode }) {
  const [online] = useState(true);
  const requestId = useMemo(() => (typeof crypto !== "undefined" ? crypto.randomUUID() : "req"), []);
  return (
    <div className={styles.shell}>
      <header role="banner" data-testid="app-header">Sweetroll</header>
      <ErrorBoundary>
        <main role="main" className={styles.main}>{children}</main>
      </ErrorBoundary>
      <StatusBar requestId={requestId} online={online} />
    </div>
  );
}
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npm run web:test -- src/shell/AppShell.test.tsx`
Expected: PASS.

- [ ] **Step 8: Wire AppShell into `web/src/main.tsx`**

Replace the StrictMode body:

```typescript
createRoot(root).render(
  <StrictMode>
    <AppShell>
      <div data-testid="placeholder">Library coming next</div>
    </AppShell>
  </StrictMode>,
);
```

- [ ] **Step 9: Commit**

```bash
git add web/src/shell web/src/main.tsx
git commit -m "feat(web): app shell with three-pane layout and error boundary"
```

### Task 6: i18n + useShortcut + ShortcutHelp dialog

**Files:**
- Create: `web/src/i18n/index.ts`
- Create: `web/src/i18n/messages.ts`
- Create: `web/src/i18n/index.test.ts`
- Create: `web/src/shell/useShortcut.ts`
- Create: `web/src/shell/useShortcut.test.tsx`
- Create: `web/src/shell/ShortcutHelp.tsx`
- Create: `web/src/shell/ShortcutHelp.module.css`

**Interfaces:**
- Consumes: nothing.
- Produces: `t(id: string, params?: Record<string, string | number>): string` (default English from `messages.ts`, console-warns in dev on missing key); `useShortcut(combo: string, handler: () => void)` (parses combos like `?`, `Alt+Up`, `j`, `Shift+A`, ignores typing in inputs); `<ShortcutHelp open onOpenChange />` listing every registered shortcut.

- [ ] **Step 1: Write failing `t()` test**

Create `web/src/i18n/index.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { t, registerLocale, resetLocale } from "./index.js";

describe("t", () => {
  it("returns the default English string for a known id", () => {
    expect(t("library.title")).toBe("Library");
  });

  it("warns and returns the key when missing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    resetLocale();
    expect(t("nope.missing")).toBe("nope.missing");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("interpolates params", () => {
    registerLocale({ "editor.publish.disabled.reason": "Cannot publish ({diagnostics} diagnostics)" });
    expect(t("editor.publish.disabled.reason", { diagnostics: 3 })).toBe("Cannot publish (3 diagnostics)");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run web:test -- src/i18n/index.test.ts`
Expected: FAIL — `./index.js` does not resolve.

- [ ] **Step 3: Implement `web/src/i18n/messages.ts`**

```typescript
export type MessageTable = Record<string, string>;
export const defaultMessages: MessageTable = {
  "library.title": "Library",
  "library.createDraft": "New system",
  "library.cloneFromTemplate": "Clone from template",
  "editor.publish.disabled.reason": "Publish disabled — {count} error diagnostics must be resolved.",
  "status.online": "Online",
  "status.offline": "Offline",
  "status.shortcuts": "Shortcuts",
  "shortcutHelp.title": "Keyboard shortcuts",
  "shortcutHelp.close": "Close",
  // add one entry per user-visible string in subsequent tasks; PR-time grep ensures none are missed
};
```

- [ ] **Step 4: Implement `web/src/i18n/index.ts`**

```typescript
import { defaultMessages, type MessageTable } from "./messages.js";

let current: MessageTable = { ...defaultMessages };

export function registerLocale(table: MessageTable): void { current = { ...current, ...table }; }
export function resetLocale(): void { current = { ...defaultMessages }; }

export function t(id: string, params?: Record<string, string | number>): string {
  const msg = current[id];
  if (msg === undefined) {
    if (import.meta.env?.MODE !== "production") console.warn(`[i18n] missing key: ${id}`);
    return id;
  }
  if (params === undefined) return msg;
  return msg.replace(/\{(\w+)\}/g, (_, k: string) => (params[k] !== undefined ? String(params[k]) : `{${k}}`));
}

export function listKeys(): string[] { return Object.keys(current); }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run web:test -- src/i18n/index.test.ts`
Expected: PASS.

- [ ] **Step 6: Write failing `useShortcut` test**

Create `web/src/shell/useShortcut.test.tsx`:

```typescript
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { useShortcut } from "./useShortcut.js";

function Probe({ combo, onFire }: { combo: string; onFire: () => void }) {
  useShortcut(combo, onFire);
  return <input aria-label="t" />;
}

describe("useShortcut", () => {
  it("fires on the matching combo", async () => {
    const fire = vi.fn();
    render(<Probe combo="j" onFire={fire} />);
    await userEvent.keyboard("j");
    expect(fire).toHaveBeenCalled();
  });

  it("ignores typing inside an input", async () => {
    const fire = vi.fn();
    const { getByLabelText } = render(<Probe combo="j" onFire={fire} />);
    await userEvent.type(getByLabelText("t"), "j");
    expect(fire).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `npm run web:test -- src/shell/useShortcut.test.tsx`
Expected: FAIL — `./useShortcut.js` does not resolve.

- [ ] **Step 8: Implement `web/src/shell/useShortcut.ts`**

```typescript
import { useEffect } from "react";

const isTextInput = (el: EventTarget | null): boolean => {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
};

export function parseCombo(combo: string): { key: string; alt: boolean; shift: boolean; ctrl: boolean } {
  const parts = combo.split("+");
  return {
    key: (parts.at(-1) ?? "").toLowerCase(),
    alt: parts.includes("Alt"),
    shift: parts.includes("Shift"),
    ctrl: parts.includes("Ctrl") || parts.includes("Meta"),
  };
}

export function useShortcut(combo: string, handler: () => void): void {
  useEffect(() => {
    const target = parseCombo(combo);
    const onKey = (e: KeyboardEvent) => {
      if (isTextInput(e.target)) return;
      if (e.key.toLowerCase() !== target.key) return;
      if (e.altKey !== target.alt) return;
      if (e.shiftKey !== target.shift) return;
      if (e.ctrlKey !== target.ctrl) return;
      e.preventDefault();
      handler();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [combo, handler]);
}
```

- [ ] **Step 9: Run test to verify it passes**

Run: `npm run web:test -- src/shell/useShortcut.test.tsx`
Expected: PASS.

- [ ] **Step 10: Implement `web/src/shell/ShortcutHelp.tsx` and `ShortcutHelp.module.css`**

The component shows a dialog listing every registered shortcut (collected via a module-level registry `registerShortcut(label, combo)` called by feature components on mount).

```typescript
import * as Dialog from "@radix-ui/react-dialog";
import { t } from "../i18n/index.js";
import styles from "./ShortcutHelp.module.css";

const registry = new Map<string, { combo: string; label: string }>();
export function registerShortcut(combo: string, label: string): () => void {
  const id = `${combo}::${label}`;
  registry.set(id, { combo, label });
  return () => registry.delete(id);
}
export function listShortcuts(): ReadonlyArray<{ combo: string; label: string }> {
  return Array.from(registry.values()).sort((a, b) => a.combo.localeCompare(b.combo));
}

export function ShortcutHelp({ open, onOpenChange }: { open: boolean; onOpenChange: (b: boolean) => void }) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content className={styles.content} aria-describedby={undefined}>
          <Dialog.Title>{t("shortcutHelp.title")}</Dialog.Title>
          <ul>
            {listShortcuts().map(({ combo, label }) => (
              <li key={`${combo}-${label}`}><kbd>{combo}</kbd><span>{label}</span></li>
            ))}
          </ul>
          <Dialog.Close>{t("shortcutHelp.close")}</Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
```

- [ ] **Step 11: Wire into AppShell**

In `web/src/shell/AppShell.tsx`, add a `?` shortcut that opens `<ShortcutHelp />` (use the new `useShortcut` hook) and a help icon in the header that opens the same dialog.

- [ ] **Step 12: Commit**

```bash
git add web/src/i18n web/src/shell/useShortcut.ts web/src/shell/useShortcut.test.tsx web/src/shell/ShortcutHelp.tsx web/src/shell/ShortcutHelp.module.css web/src/shell/AppShell.tsx
git commit -m "feat(web): i18n t() function, useShortcut hook, shortcut help dialog"
```

### Task 7: TanStack Router + auth check route

**Files:**
- Create: `web/src/router.tsx`
- Create: `web/src/api/hooks.ts`
- Create: `web/src/api/hooks.test.tsx`
- Create: `web/src/api/server.ts`
- Create: `web/src/shell/DevSignInPanel.tsx`
- Create: `web/src/shell/DevSignInPanel.module.css`

**Interfaces:**
- Consumes: `createApiClient`, `AuthState`.
- Produces: a `createRouter()` returning a configured TanStack Router; `useMe()` hook that returns the current user; `DevSignInPanel` for development only.

- [ ] **Step 1: Create `web/src/api/server.ts`**

```typescript
import type { components } from "./schema.js";

export type UserSummary = components["schemas"]["UserSummary"];
export type SystemSummary = components["schemas"]["SystemSummary"];
export type SystemWorkspace = components["schemas"]["SystemWorkspace"];
export type PreviewSnapshot = components["schemas"]["PreviewSnapshot"];
export type PublishedVersion = components["schemas"]["PublishedVersion"];
export type PackageDiagnostic = components["schemas"]["PackageDiagnostic"];
export type DocumentAssessment = components["schemas"]["DocumentAssessment"];
```

(Mirrors what `openapi-typescript` generates; if exact names differ after generation, align them in this file.)

- [ ] **Step 2: Write the failing hooks test**

Create `web/src/api/hooks.test.tsx`:

```typescript
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createApiClient } from "./client.js";
import { useMe } from "./hooks.js";

describe("useMe", () => {
  it("returns anonymous when no session", async () => {
    const client = createApiClient({ baseUrl: "http://x", fetch: vi.fn(async () => new Response(JSON.stringify({ state: "anonymous" }), { status: 200 })) as typeof fetch });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useMe(client), { wrapper: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider> });
    await waitFor(() => expect(result.current.data).toEqual({ state: "anonymous" }));
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run web:test -- src/api/hooks.test.tsx`
Expected: FAIL — `./hooks.js` does not resolve.

- [ ] **Step 4: Implement `web/src/api/hooks.ts`**

```typescript
import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import type { ApiClient } from "./client.js";

export type MeState = { state: "authenticated"; userId: string } | { state: "anonymous" };

export function useMe(client: ApiClient): UseQueryResult<MeState> {
  return useQuery({
    queryKey: ["me"],
    queryFn: async () => client.fetch<MeState>("GET", "/me"),
    staleTime: 60_000,
  });
}
```

Add a backend `GET /me` route in `src/transport/http/identity.ts` that returns the `AuthContext` (anonymous or authenticated with `userId`). Make sure to add the schema and include it in the OpenAPI generator.

- [ ] **Step 5: Implement `web/src/shell/DevSignInPanel.tsx`**

```typescript
import { useState } from "react";

import styles from "./DevSignInPanel.module.css";

export function DevSignInPanel({ onSignedIn }: { onSignedIn: () => void }) {
  const [code, setCode] = useState("code-dev");
  return (
    <form
      className={styles.panel}
      onSubmit={async (e) => {
        e.preventDefault();
        const res = await fetch("/dev/signin", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, redirectUri: window.location.origin + "/cb" }) });
        if (res.ok) onSignedIn();
      }}
    >
      <label htmlFor="code">Dev code</label>
      <input id="code" value={code} onChange={(e) => setCode(e.target.value)} />
      <button type="submit" data-testid="dev-signin">Sign in</button>
    </form>
  );
}
```

- [ ] **Step 6: Implement `web/src/router.tsx`**

```typescript
import { createRootRoute, createRoute, createRouter, Outlet } from "@tanstack/react-router";

import { AppShell } from "./shell/AppShell.js";

const rootRoute = createRootRoute({ component: () => <AppShell><Outlet /></AppShell> });
const indexRoute = createRoute({ getParentRoute: rootRoute, path: "/", component: () => <div data-testid="library-placeholder">Library</div> });
const systemRoute = createRoute({ getParentRoute: rootRoute, path: "/systems/$systemId", component: () => <div data-testid="system-placeholder">System</div> });

const routeTree = rootRoute.addChildren([indexRoute, systemRoute]);

export function createAppRouter() { return createRouter({ routeTree }); }
export const router = createAppRouter();
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npm run web:test -- src/api/hooks.test.tsx`
Expected: PASS.

- [ ] **Step 8: Run backend suite + web typecheck**

Run: `npm run typecheck && npm test && npm run web:typecheck`
Expected: all green.

- [ ] **Step 9: Commit**

```bash
git add web/src/router.tsx web/src/api/server.ts web/src/api/hooks.ts web/src/api/hooks.test.tsx web/src/shell/DevSignInPanel.tsx web/src/shell/DevSignInPanel.module.css src/transport/http/identity.ts
git commit -m "feat(web): router, auth hook, dev sign-in panel"
```

### Task 8: System library list

**Files:**
- Create: `web/src/library/SystemLibrary.tsx`
- Create: `web/src/library/SystemLibrary.module.css`
- Create: `web/src/library/SystemLibrary.test.tsx`
- Create: `web/src/api/listSystems.ts`
- Create: `web/src/api/listSystems.test.tsx`

**Interfaces:**
- Consumes: `apiClient`, `/systems` GET.
- Produces: `<SystemLibrary />` lists systems with `useInfiniteQuery`, keyboard navigation, lifecycle filter.

- [ ] **Step 1: Write failing client query test**

Create `web/src/api/listSystems.test.tsx`:

```typescript
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createApiClient } from "./client.js";
import { useSystemLibrary } from "./listSystems.js";

describe("useSystemLibrary", () => {
  it("returns pages of systems", async () => {
    const fetch_ = vi.fn(async () => new Response(JSON.stringify({ systems: [{ systemId: "s1", name: "A", lifecycle: "active", updatedAt: "2026-01-01T00:00:00Z" }], nextCursor: null, requestId: "r" }), { status: 200 }));
    const client = createApiClient({ baseUrl: "http://x", fetch: fetch_ as typeof fetch });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useSystemLibrary(client), { wrapper: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider> });
    await waitFor(() => expect(result.current.data?.pages[0].systems[0].name).toBe("A"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run web:test -- src/api/listSystems.test.tsx`
Expected: FAIL — `./listSystems.js` does not resolve.

- [ ] **Step 3: Implement `web/src/api/listSystems.ts`**

```typescript
import { useInfiniteQuery } from "@tanstack/react-query";

import type { ApiClient } from "./client.js";
import type { SystemSummary } from "./server.js";

export type LibraryPage = { systems: SystemSummary[]; nextCursor: string | null; requestId: string };

export function useSystemLibrary(client: ApiClient) {
  return useInfiniteQuery({
    queryKey: ["system", "library"],
    queryFn: async ({ pageParam }) => client.fetch<LibraryPage>("GET", "/systems", { query: { cursor: pageParam, limit: 20 } }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run web:test -- src/api/listSystems.test.tsx`
Expected: PASS.

- [ ] **Step 5: Implement `web/src/library/SystemLibrary.tsx`**

```typescript
import { useEffect, useRef } from "react";

import { createApiClient } from "../api/client.js";
import { useSystemLibrary } from "../api/listSystems.js";

import styles from "./SystemLibrary.module.css";

export function SystemLibrary({ client }: { client: ApiClient }) {
  const { data, fetchNextPage, hasNextPage } = useSystemLibrary(client);
  const ref = useRef<HTMLUListElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "j" || e.key === "ArrowDown") moveActive(el, 1);
      if (e.key === "k" || e.key === "ArrowUp") moveActive(el, -1);
    };
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
  }, []);
  return (
    <ul ref={ref} className={styles.list} aria-label="Systems" data-testid="system-library">
      {data?.pages.flatMap((p) => p.systems).map((s, i) => (
        <li key={s.systemId} data-testid={`system-row-${i}`} tabIndex={-1}>
          <a href={`/systems/${s.systemId}`}>{s.name}</a>
          <span aria-label={`lifecycle ${s.status}`}>{s.status}</span>
        </li>
      ))}
      {hasNextPage && <li><button onClick={() => fetchNextPage()}>Load more</button></li>}
    </ul>
  );
}

function moveActive(el: HTMLUListElement, delta: number) {
  const items = Array.from(el.querySelectorAll<HTMLLIElement>('[data-testid^="system-row-"]'));
  const active = items.findIndex((i) => i.getAttribute("data-active") === "true");
  const next = Math.max(0, Math.min(items.length - 1, active + delta));
  items.forEach((i, idx) => (idx === next ? i.setAttribute("data-active", "true") : i.removeAttribute("data-active")));
  items[next]?.focus();
}
```

- [ ] **Step 6: Write the failing component test**

Create `web/src/library/SystemLibrary.test.tsx`:

```typescript
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createApiClient } from "../api/client.js";
import { SystemLibrary } from "./SystemLibrary.js";

describe("SystemLibrary", () => {
  it("renders a row per system", async () => {
    const fetch_ = vi.fn(async () => new Response(JSON.stringify({ systems: [{ systemId: "s1", name: "A", lifecycle: "active", updatedAt: "2026-01-01T00:00:00Z" }, { systemId: "s2", name: "B", lifecycle: "active", updatedAt: "2026-01-02T00:00:00Z" }], nextCursor: null, requestId: "r" }), { status: 200 }));
    const client = createApiClient({ baseUrl: "http://x", fetch: fetch_ as typeof fetch });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><SystemLibrary client={client} /></QueryClientProvider>);
    expect(await screen.findByText("A")).toBeInTheDocument();
    expect(screen.getByText("B")).toBeInTheDocument();
  });
});
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npm run web:test -- src/library/SystemLibrary.test.tsx`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add web/src/library web/src/api/listSystems.ts web/src/api/listSystems.test.tsx
git commit -m "feat(web): system library list with keyboard navigation"
```

### Task 9: Create draft dialog (blank / clone / import)

**Files:**
- Create: `web/src/library/CreateDraftDialog.tsx`
- Create: `web/src/library/CreateDraftDialog.module.css`
- Create: `web/src/library/CreateDraftDialog.test.tsx`
- Create: `web/src/api/createDraft.ts`
- Modify: `web/src/library/SystemLibrary.tsx`

**Interfaces:**
- Consumes: `apiClient`, `/systems` POST.
- Produces: `CreateDraftDialog` that posts blank / clone / import and invalidates the library query.

- [ ] **Step 1: Implement `web/src/api/createDraft.ts`**

```typescript
import { useMutation, useQueryClient } from "@tanstack/react-query";

import type { ApiClient } from "./client.js";
import type { SystemWorkspace } from "./server.js";

export type CreateDraftInput = {
  source: { kind: "blank"; name: string } | { kind: "clone"; versionId: string } | { kind: "import"; content: string };
  idempotencyKey: string;
};

export function useCreateDraft(client: ApiClient) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateDraftInput) => client.fetch<{ workspace: SystemWorkspace; requestId: string }, CreateDraftInput>("POST", "/systems", { body: input }).then((r) => r.workspace),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["system", "library"] }); },
  });
}
```

- [ ] **Step 2: Implement `web/src/library/CreateDraftDialog.tsx`**

```typescript
import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";

import { useCreateDraft } from "../api/createDraft.js";
import type { ApiClient } from "../api/client.js";

import styles from "./CreateDraftDialog.module.css";

export function CreateDraftDialog({ client, open, onOpenChange }: { client: ApiClient; open: boolean; onOpenChange: (b: boolean) => void }) {
  const [kind, setKind] = useState<"blank" | "clone" | "import">("blank");
  const [name, setName] = useState("Untitled system");
  const [versionId, setVersionId] = useState("");
  const [content, setContent] = useState("");
  const mutation = useCreateDraft(client);

  const submit = async () => {
    const source = kind === "blank" ? { kind: "blank", name } : kind === "clone" ? { kind: "clone", versionId } : { kind: "import", content };
    const out = await mutation.mutateAsync({ source, idempotencyKey: crypto.randomUUID() });
    onOpenChange(false);
    location.assign(`/systems/${out.systemId}`);
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content className={styles.content} aria-describedby={undefined}>
          <Dialog.Title>Create draft</Dialog.Title>
          <fieldset>
              <legend>Source</legend>
              {(["blank", "clone", "import"] as const).map((k) => (
                <label key={k}><input type="radio" name="kind" checked={kind === k} onChange={() => setKind(k)} /> {k}</label>
              ))}
            </fieldset>
          {kind === "blank" && <label>Name<input value={name} onChange={(e) => setName(e.target.value)} /></label>}
          {kind === "clone" && <label>Version ID<input value={versionId} onChange={(e) => setVersionId(e.target.value)} /></label>}
          {kind === "import" && <label>Export JSON<textarea rows={8} value={content} onChange={(e) => setContent(e.target.value)} /></label>}
          <button onClick={submit} disabled={mutation.isRunning} data-testid="create-draft-submit">Create</button>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
```

- [ ] **Step 3: Write the failing component test**

Create `web/src/library/CreateDraftDialog.test.tsx`:

```typescript
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { createApiClient } from "../api/client.js";
import { CreateDraftDialog } from "./CreateDraftDialog.js";

describe("CreateDraftDialog", () => {
  it("posts a blank draft on submit", async () => {
    const fetch_ = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/systems") && init?.method === "POST") {
        return new Response(JSON.stringify({ workspace: { systemId: "s1", revision: 1, document: {}, assessment: { ok: true, diagnostics: [] }, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }, requestId: "r" }), { status: 201 });
      }
      return new Response("{}", { status: 200 });
    });
    const client = createApiClient({ baseUrl: "http://x", fetch: fetch_ as typeof fetch });
    const qc = new QueryClient();
    render(<QueryClientProvider client={qc}><CreateDraftDialog client={client} open onOpenChange={() => {}} /></QueryClientProvider>);
    await userEvent.click(screen.getByTestId("create-draft-submit"));
    expect(fetch_).toHaveBeenCalledWith(expect.stringContaining("/systems"), expect.objectContaining({ method: "POST" }));
  });
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run web:test -- src/library/CreateDraftDialog.test.tsx`
Expected: PASS.

- [ ] **Step 5: Wire CreateDraftDialog into SystemLibrary**

Add a "New system" button at the top of `SystemLibrary` that opens `CreateDraftDialog`.

- [ ] **Step 6: Commit**

```bash
git add web/src/library web/src/api/createDraft.ts
git commit -m "feat(web): create-draft dialog (blank/clone/import)"
```

### Task 10: Archive / recover / clone-from-template

**Files:**
- Create: `web/src/api/lifecycle.ts`
- Create: `web/src/api/lifecycle.test.tsx`
- Create: `web/src/library/CloneFromTemplate.tsx`
- Create: `web/src/library/CloneFromTemplate.test.tsx`
- Create: `migrations/0008_seed_system_templates.sql`
- Modify: `src/systems/implementation/persistence/index.ts` (seed on boot if absent)
- Modify: `src/bootstrap/migrate.ts` (apply new migration)

**Interfaces:**
- Consumes: `apiClient`, `/systems/:id` PATCH, the three seeded reference fixtures.
- Produces: `useChangeLifecycle(client)` hook; `<CloneFromTemplate />` lists the three fixtures and triggers create-clone.

- [ ] **Step 1: Add migration `migrations/0008_seed_system_templates.sql`**

```sql
-- Inserts three reference systems (one per capability matrix fixture) and one published version per system.
-- No-op if rows already exist (idempotency via ON CONFLICT).
INSERT INTO systems (id, owner_id, name, access, lifecycle, created_at, updated_at)
VALUES
  ('00000000-0000-0000-0000-000000000a01', NULL, 'Template: d20', 'link', 'active', now(), now()),
  ('00000000-0000-0000-0000-000000000a02', NULL, 'Template: PbtA 2d6', 'link', 'active', now(), now()),
  ('00000000-0000-0000-0000-000000000a03', NULL, 'Template: d6 success pool', 'link', 'active', now(), now())
ON CONFLICT (id) DO NOTHING;
-- versions are inserted with deterministic IDs; one per system; package payloads generated by a separate
-- loadReferenceFixtures() call during migrate so we don't inline huge JSON in SQL.
INSERT INTO system_versions (id, system_id, semantic_version, checksum, package_json, release_notes, lifecycle, created_at)
VALUES
  ('11111111-1111-1111-1111-111111111a01', '00000000-0000-0000-0000-000000000a01', '1.0.0', 'pending', '{}', 'Template seed', 'active', now())
ON CONFLICT (id) DO NOTHING;
```

Replace `package_json` and `checksum` for each row in code at migrate time using the existing fixtures in `src/systems/implementation/package/fixtures/`.

- [ ] **Step 2: Implement `web/src/api/lifecycle.ts`**

```typescript
import { useMutation, useQueryClient } from "@tanstack/react-query";

import type { ApiClient } from "./client.js";

export function useChangeLifecycle(client: ApiClient) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { systemId: string; lifecycle: "active" | "archived" }) =>
      client.fetch("PATCH", `/systems/${input.systemId}`, { body: { lifecycle: input.lifecycle } }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["system", "library"] }); },
  });
}
```

- [ ] **Step 3: Implement `web/src/library/CloneFromTemplate.tsx`**

Renders three buttons, one per fixture (hard-coded `versionId` map). Click → `useCreateDraft` with `{ kind: "clone", versionId }`. On success, navigate to `/systems/:id`.

- [ ] **Step 4: Tests**

Cover the happy path (one template clone) and confirm the library is invalidated.

- [ ] **Step 5: Run integration tests with new migration**

Run: `TEST_DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll npm run migrate && npm run test:integration`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add web/src/api/lifecycle.ts web/src/api/lifecycle.test.tsx web/src/library/CloneFromTemplate.tsx web/src/library/CloneFromTemplate.test.tsx migrations/0008_seed_system_templates.sql src/systems/implementation/persistence/index.ts src/bootstrap/migrate.ts
git commit -m "feat(web): archive/recover + seeded template fixtures"
```

---

## Phase I2-C — Metadata + simple field editors

### Task 11: DocumentEditor shell + tabs + route

**Files:**
- Create: `web/src/editor/DocumentEditor.tsx`
- Create: `web/src/editor/DocumentEditor.module.css`
- Create: `web/src/editor/DocumentEditor.test.tsx`
- Create: `web/src/api/openSystem.ts`
- Modify: `web/src/router.tsx`

**Interfaces:**
- Consumes: `/systems/:systemId` GET, `/systems/:systemId/draft` PUT.
- Produces: `<DocumentEditor systemId={...} />` with tab nav (Metadata / Entities / Sheets / Actions / Validations / Reference data), header (name inline edit, lifecycle, autosave status), and an empty tab body per tab.

- [ ] **Step 1: Write failing DocumentEditor test**

```typescript
it("renders the tab nav and a header with system name", async () => { /* fetch mock + render */ });
```

- [ ] **Step 2: Implement `DocumentEditor.tsx`**

Header with system name + autosave status placeholder; `<Tabs>` using Radix Tabs primitives or simple links (`<a href="?tab=metadata">`) with `aria-current="page"`. Each tab body is a placeholder.

- [ ] **Step 3: Wire route**

Replace `/systems/$systemId` placeholder in `web/src/router.tsx` with `<DocumentEditor systemId={systemId} />`.

- [ ] **Step 4: Tests + commit**

```bash
git add web/src/editor/DocumentEditor.tsx web/src/editor/DocumentEditor.module.css web/src/editor/DocumentEditor.test.tsx web/src/api/openSystem.ts web/src/router.tsx
git commit -m "feat(web): document editor shell with tabs"
```

### Task 12: Metadata editor (name, description, language, default dice)

**Files:**
- Create: `web/src/editor/MetadataEditor.tsx`
- Create: `web/src/editor/MetadataEditor.test.tsx`
- Create: `web/src/state/documentReducer.ts`
- Create: `web/src/state/documentReducer.test.ts`

**Interfaces:**
- Consumes: `Document` shape from `web/src/api/server.ts`.
- Produces: `documentReducer(state, action)` pure function with actions `setMetadata`, `addEntity`, `removeEntity`, `updateField`, etc.

- [ ] **Step 1: Write failing reducer test**

```typescript
it("setMetadata replaces name + description", () => {
  const next = documentReducer(blankDocument(), { type: "setMetadata", patch: { name: "X", description: "y" } });
  expect(next.document.metadata.name).toBe("X");
});
```

- [ ] **Step 2: Implement reducer**

Pure function operating on `SystemDocumentV1`. Initial blank document mirrors the JSON schema's defaults.

- [ ] **Step 3: Implement MetadataEditor**

Form fields bound via reducer `dispatch`. Saves triggered on blur via `draftSync` (Task 13 wires it).

- [ ] **Step 4: Tests + commit**

```bash
git add web/src/editor/MetadataEditor.tsx web/src/editor/MetadataEditor.test.tsx web/src/state/documentReducer.ts web/src/state/documentReducer.test.ts
git commit -m "feat(web): metadata editor + document reducer"
```

### Task 13: Autosave + conflict recovery

**Files:**
- Create: `web/src/state/draftSync.ts`
- Create: `web/src/state/draftSync.test.ts`
- Create: `web/src/state/conflictRecovery.ts`
- Create: `web/src/state/conflictRecovery.test.ts`
- Create: `web/src/editor/ConflictBanner.tsx`
- Create: `web/src/editor/ConflictBanner.test.tsx`

**Interfaces:**
- Consumes: `useSaveDraft(client)` mutation (from `web/src/api/saveDraft.ts`).
- Produces: `createDraftSync({ client, systemId, debounceMs })` returning `{ save, status, banner }`. `banner` is non-null when a `409` recovery needs user action.

- [ ] **Step 1: Implement `web/src/api/saveDraft.ts`**

```typescript
export function useSaveDraft(client: ApiClient) {
  return useMutation({
    mutationFn: (input: { systemId: string; expectedRevision: number | null; document: unknown }) =>
      client.fetch<{ workspace: SystemWorkspace; requestId: string }>("PUT", `/systems/${input.systemId}/draft`, { body: { expectedRevision: input.expectedRevision, document: input.document } }),
  });
}
```

- [ ] **Step 2: Implement `draftSync.ts`**

Debounce 600 ms, skip if `documentHash` unchanged, optimistic status transitions: `idle → saving → saved | conflict | error`.

- [ ] **Step 3: Implement `conflictRecovery.ts`**

Pure functions to merge "theirs" / "mine" / "force save" into a payload.

- [ ] **Step 4: Implement ConflictBanner**

Non-blocking banner with three buttons (Reload theirs / Keep mine / Merge into server). Use Radix `AlertDialog` only for destructive confirms.

- [ ] **Step 5: Tests + commit**

```bash
git add web/src/state web/src/editor/ConflictBanner.tsx web/src/editor/ConflictBanner.test.tsx web/src/api/saveDraft.ts
git commit -m "feat(web): debounced autosave with 409 conflict recovery"
```

### Task 14: Scalar / choice / boolean / image field editors

**Files:**
- Create: `web/src/editor/fields/ScalarFieldEditor.tsx`
- Create: `web/src/editor/fields/ChoiceFieldEditor.tsx`
- Create: `web/src/editor/fields/BooleanFieldEditor.tsx`
- Create: `web/src/editor/fields/ImageFieldEditor.tsx`
- Create: `web/src/editor/fields/DefinitionIdInput.tsx`
- Create: `web/src/editor/fields/DefinitionIdInput.test.tsx`
- Create: `web/src/editor/EntityList.tsx`
- Create: `web/src/editor/EntityList.test.tsx`

**Interfaces:**
- Consumes: `documentReducer`, the `FieldV1` schema types.
- Produces: per-field-kind editors; `<EntityList />` lists entities with add/remove; all wired into the `Entities` tab.

- [ ] **Step 1: Write failing DefinitionIdInput test**

```typescript
it("warns when renaming an ID referenced elsewhere", () => { /* render + mock references */ });
```

- [ ] **Step 2: Implement DefinitionIdInput**

Validates `^[a-z][a-z0-9_]{0,63}$`; shows "Referenced by N" footer; confirmation dialog on rename.

- [ ] **Step 3: Implement ScalarFieldEditor / ChoiceFieldEditor / BooleanFieldEditor / ImageFieldEditor**

Each takes `field: FieldV1` and `onChange`; renders labeled input(s) with accessible name.

- [ ] **Step 4: Implement EntityList**

Lists entities, add (via "Add entity" button), remove (via confirmation dialog). Selecting an entity shows its fields using the editors above.

- [ ] **Step 5: Tests + commit**

```bash
git add web/src/editor/fields web/src/editor/EntityList.tsx web/src/editor/EntityList.test.tsx
git commit -m "feat(web): scalar/choice/boolean/image field editors + entity list"
```

---

## Phase I2-D — Resource + computed + sheet editor

### Task 15: Resource field editor

**Files:**
- Create: `web/src/editor/fields/ResourceFieldEditor.tsx`
- Create: `web/src/editor/fields/ResourceFieldEditor.test.tsx`

**Interfaces:**
- Consumes: `FieldV1` of kind `"resource"`.
- Produces: editor for current binding (field ID), max binding, min/max bounds, optional reset rule.

- [ ] **Step 1: Write failing test**

```typescript
it("renders current + max + bounds inputs", () => { /* */ });
```

- [ ] **Step 2: Implement ResourceFieldEditor**

Form fields bound to the reducer. The reset rule is a stub input (wired in Task 19).

- [ ] **Step 3: Tests + commit**

```bash
git add web/src/editor/fields/ResourceFieldEditor.tsx web/src/editor/fields/ResourceFieldEditor.test.tsx
git commit -m "feat(web): resource field editor"
```

### Task 16: Expression port for the client (tokenizer reuse)

**Files:**
- Create: `web/src/ports/expressions.ts`
- Create: `web/src/ports/expressions.test.ts`

**Interfaces:**
- Consumes: the I1 tokenizer source copied into `web/src/ports/tokenizer-impl.ts` (a tiny inlined subset sufficient for live diagnostics: literal numbers/booleans, references, operators, parentheses). For I2-C this only validates syntax.
- Produces: `tokenizeExpression(source: string): { ok: true, tokens } | { ok: false, diagnostics }`.

- [ ] **Step 1: Copy + adapt tokenizer**

Extract the tokenizer logic from `src/systems/implementation/rules/tokenizer.ts` (lines 1-120) into `web/src/ports/tokenizer-impl.ts` with the same public API. Strip the "adv/dis" sugar handling (kept for v0.1; not needed in UI v0).

- [ ] **Step 2: Tests**

Mirror the existing I1 tokenizer tests for the subset the client uses.

- [ ] **Step 3: Commit**

```bash
git add web/src/ports/expressions.ts web/src/ports/expressions.test.ts web/src/ports/tokenizer-impl.ts
git commit -m "feat(web): expression tokenizer port (grammar v0.1 syntax)"
```

### Task 17: Computed field editor

**Files:**
- Create: `web/src/editor/fields/ComputedFieldEditor.tsx`
- Create: `web/src/editor/fields/ComputedFieldEditor.test.tsx`

**Interfaces:**
- Consumes: `FieldV1` of kind `"computed"`, the `tokenizeExpression` port.
- Produces: result-type selector + expression textarea with live token diagnostics + declared fallback input.

- [ ] **Step 1: Implement ComputedFieldEditor**

Renders a textarea; on each keystroke, calls `tokenizeExpression` and underlines bad tokens. Also includes result-type select (`number` / `text` / `boolean`).

- [ ] **Step 2: Tests**

Use `userEvent.type` to add bad input; assert diagnostic appears with code `invalid_syntax`.

- [ ] **Step 3: Commit**

```bash
git add web/src/editor/fields/ComputedFieldEditor.tsx web/src/editor/fields/ComputedFieldEditor.test.tsx
git commit -m "feat(web): computed field editor with live tokenizer diagnostics"
```

### Task 18: Sheet section/order editor + element editor

**Files:**
- Create: `web/src/editor/sheet/SheetEditor.tsx`
- Create: `web/src/editor/sheet/SheetEditor.module.css`
- Create: `web/src/editor/sheet/SectionEditor.tsx`
- Create: `web/src/editor/sheet/ElementEditor.tsx`
- Create: `web/src/editor/sheet/SheetEditor.test.tsx`

**Interfaces:**
- Consumes: `SheetV1` and its sections/elements; the definition-id picker.
- Produces: ordered list of sections; ordered list of elements per section; explicit "Move up" / "Move down" buttons (`Alt+Up` / `Alt+Down`); no drag.

- [ ] **Step 1: Tests**

Render a sheet with two sections and three elements; simulate `Alt+Down` on the first element; assert order changes.

- [ ] **Step 2: Implement SheetEditor / SectionEditor / ElementEditor**

CSS uses a single column; numeric badge shows position. Element types: heading / field / resource / action-button.

- [ ] **Step 3: Commit**

```bash
git add web/src/editor/sheet
git commit -m "feat(web): sheet section/order editor with keyboard move"
```

---

## Phase I2-E — Expression + action + validation + reference-data

### Task 19: Expression editor with server-backed assessment

**Files:**
- Create: `web/src/editor/expressions/ExpressionEditor.tsx`
- Create: `web/src/editor/expressions/ExpressionEditor.test.tsx`
- Create: `web/src/api/assessDraft.ts`

**Interfaces:**
- Consumes: `/systems/:systemId/preview` POST (returns assessment in workspace) plus the client tokenizer port for live syntax errors.
- Produces: a textarea with: live underlining of syntax errors, a "Check" button that calls `/preview` and renders typed AST + dependency list.

- [ ] **Step 1: Implement `web/src/api/assessDraft.ts`**

```typescript
export function useAssessDraft(client: ApiClient) {
  return useMutation({
    mutationFn: (systemId: string) => client.fetch<{ snapshot: PreviewSnapshot; requestId: string }>("POST", `/systems/${systemId}/preview`),
  });
}
```

- [ ] **Step 2: Implement ExpressionEditor**

Two-pane layout: source textarea on left, "Compile result" panel on right showing diagnostics. Underlines in source mirror diagnostics' paths.

- [ ] **Step 3: Tests**

Mock `/preview` with a known `limit_exceeded` diagnostic; assert it renders.

- [ ] **Step 4: Commit**

```bash
git add web/src/editor/expressions web/src/api/assessDraft.ts
git commit -m "feat(web): expression editor with server assessment"
```

### Task 20: Roll action editor with "Try it"

**Files:**
- Create: `web/src/editor/actions/RollActionEditor.tsx`
- Create: `web/src/editor/actions/RollActionEditor.test.tsx`
- Create: `web/src/api/evaluateExpression.ts`
- Create: `web/src/ports/evaluateExpression.ts`

**Interfaces:**
- Consumes: the I1 evaluator (adapted for the client via a port that runs against sample data) and the I1 canonical renderer.
- Produces: roll action editor with roll source, inputs, output template, and a "Try it" button that runs the evaluator and shows the roll result sheet (dice, modifiers, total, audience).

- [ ] **Step 1: Build `web/src/ports/evaluateExpression.ts`**

This ports a thin subset of the I1 evaluator: parse → typecheck → evaluate. The package bundle for the editor reuses `src/systems/implementation/rules/{tokenizer,parser,typecheck,evaluate}.ts` via a Vite alias and inlines them into the web bundle (they are pure functions, ~600 LOC total).

Add to `web/vite.config.ts`:

```typescript
resolve: { alias: { "@sweetroll/rules": resolve(__dirname, "../src/systems/implementation/rules/index.ts") } },
```

But keep the port isolated so the web client never imports `@sweetroll/*` directly outside `web/src/ports/`.

- [ ] **Step 2: Implement `RollActionEditor.tsx`**

- [ ] **Step 3: Tests + commit**

```bash
git add web/src/editor/actions web/src/api/evaluateExpression.ts web/src/ports/evaluateExpression.ts web/vite.config.ts
git commit -m "feat(web): roll action editor with Try-it evaluator"
```

### Task 21: Resource bump editor

**Files:**
- Create: `web/src/editor/actions/ResourceBumpEditor.tsx`
- Create: `web/src/editor/actions/ResourceBumpEditor.test.tsx`

**Interfaces:**
- Consumes: `ActionV1` of kind `"resourceBump"`.
- Produces: resource select + delta input + optional bound + optional reset rule input.

- [ ] **Step 1: Implement + test + commit**

```bash
git add web/src/editor/actions/ResourceBumpEditor.tsx web/src/editor/actions/ResourceBumpEditor.test.tsx
git commit -m "feat(web): resource bump action editor"
```

### Task 22: Validation rule editor

**Files:**
- Create: `web/src/editor/validations/ValidationEditor.tsx`
- Create: `web/src/editor/validations/ValidationEditor.test.tsx`

**Interfaces:**
- Consumes: `ValidationV1`.
- Produces: severity selector + condition (reuses `ExpressionEditor`) + message key input (typed against the i18n table).

- [ ] **Step 1: Implement + test + commit**

```bash
git add web/src/editor/validations
git commit -m "feat(web): validation rule editor"
```

### Task 23: Reference data editor

**Files:**
- Create: `web/src/editor/referenceData/ReferenceDataEditor.tsx`
- Create: `web/src/editor/referenceData/ReferenceDataEditor.test.tsx`

**Interfaces:**
- Consumes: `ReferenceDataV1`.
- Produces: typeId header + record list with inline add/remove rows.

- [ ] **Step 1: Implement + test + commit**

```bash
git add web/src/editor/referenceData
git commit -m "feat(web): reference data editor"
```

---

## Phase I2-F — Preview + sample data + diagnostics drawer

### Task 24: Sample data generator

**Files:**
- Create: `web/src/preview/sampleData.ts`
- Create: `web/src/preview/sampleData.test.ts`

**Interfaces:**
- Consumes: `SystemPackageV1`.
- Produces: `generateSample(package: SystemPackageV1): Record<EntityTypeId, SampleRecord>` that is deterministic.

- [ ] **Step 1: Tests**

For the d20, PbtA, and counted-success fixtures, generate twice and assert identical output.

- [ ] **Step 2: Implement**

Walks each entity; sets scalars to declared defaults; choices to first option; booleans to false; resources to `current = max`; computes derived fields using the port evaluator. No `Math.random`.

- [ ] **Step 3: Commit**

```bash
git add web/src/preview/sampleData.ts web/src/preview/sampleData.test.ts
git commit -m "feat(web): deterministic sample-data generator"
```

### Task 25: PreviewSheet + PreviewFrame

**Files:**
- Create: `web/src/preview/PreviewSheet.tsx`
- Create: `web/src/preview/PreviewSheet.module.css`
- Create: `web/src/preview/PreviewFrame.tsx`
- Create: `web/src/preview/PreviewSheet.test.tsx`

**Interfaces:**
- Consumes: a `SystemPackageV1` and the generated sample.
- Produces: a single-column sheet rendering (heading, bound field, resource with current/max display, computed value, action button which opens a compact roll-result sheet).

- [ ] **Step 1: Tests**

Render the d20 fixture; assert every sheet element appears.

- [ ] **Step 2: Implement PreviewSheet**

- [ ] **Step 3: Implement PreviewFrame**

A toggle `360 | 1280` wraps `PreviewSheet` in an iframe-like container with the chosen width; `Alt+P` shortcut.

- [ ] **Step 4: Commit**

```bash
git add web/src/preview
git commit -m "feat(web): preview sheet and frame at 360/1280 widths"
```

### Task 26: Diagnostics drawer

**Files:**
- Create: `web/src/editor/DiagnosticsDrawer.tsx`
- Create: `web/src/editor/DiagnosticsDrawer.test.tsx`

**Interfaces:**
- Consumes: latest assessment from the editor's reducer state.
- Produces: a right-edge drawer listing every diagnostic with a "Jump to" button.

- [ ] **Step 1: Tests**

Inject a known assessment; assert each diagnostic renders with the correct code.

- [ ] **Step 2: Implement**

Each "Jump to" dispatches a custom event (`focus-editor:{path}`) the editor listens for.

- [ ] **Step 3: Commit**

```bash
git add web/src/editor/DiagnosticsDrawer.tsx web/src/editor/DiagnosticsDrawer.test.tsx
git commit -m "feat(web): diagnostics drawer with editor focus"
```

### Task 27: Publish gate (button disabled when errors exist)

**Files:**
- Modify: `web/src/editor/DocumentEditor.tsx`

**Interfaces:**
- Consumes: latest assessment.
- Produces: publish button is `disabled` when any diagnostic has `severity: "error"`. Tooltip explains the count.

- [ ] **Step 1: Tests**

Render DocumentEditor with a synthetic error assessment; assert button has `aria-disabled="true"` and tooltip text.

- [ ] **Step 2: Implement**

- [ ] **Step 3: Commit**

```bash
git add web/src/editor/DocumentEditor.tsx
git commit -m "feat(web): disable publish when error diagnostics exist"
```

---

## Phase I2-G — Publish + version history + export + clone-from-template

### Task 28: Publish dialog with breaking-change confirmation

**Files:**
- Create: `web/src/publish/PublishDialog.tsx`
- Create: `web/src/publish/PublishDialog.test.tsx`
- Create: `web/src/api/publish.ts`

**Interfaces:**
- Consumes: `POST /systems/:id/publish`.
- Produces: dialog with semver input + release notes + per-breaking-finding confirmation list.

- [ ] **Step 1: Tests**

Mock publish returning `breaking_removed_definition`; assert the finding is listed and the confirm button stays disabled until checked.

- [ ] **Step 2: Implement**

- [ ] **Step 3: Commit**

```bash
git add web/src/publish web/src/api/publish.ts
git commit -m "feat(web): publish dialog with breaking-change gate"
```

### Task 29: Version history + deprecate

**Files:**
- Create: `web/src/publish/VersionHistory.tsx`
- Create: `web/src/publish/VersionHistory.test.tsx`
- Create: `web/src/api/listVersions.ts`
- Create: `web/src/api/deprecateVersion.ts`

**Interfaces:**
- Consumes: `GET /systems/:id/versions` (added in this task) + `PATCH /system-versions/:versionId`.
- Produces: list of versions with deprecate + export actions.

- [ ] **Step 1: Add `GET /systems/:id/versions` route**

```typescript
app.get("/systems/:systemId/versions", async (request, reply) => {
  const result = await authoring.listVersions(ctxOf(request), { systemId: (request.params as { systemId: string }).systemId });
  if (!result.ok) return sendError(reply, result.error, request.id);
  return { versions: result.value.versions, requestId: request.id };
});
```

(Confirm `SystemAuthoring.listVersions` exists; if not, add a minimal list-by-system-id method.)

- [ ] **Step 2: Implement VersionHistory**

Table with semver, lifecycle badge, created date; row actions: Export, Deprecate, Clone.

- [ ] **Step 3: Tests + commit**

```bash
git add web/src/publish web/src/api/listVersions.ts web/src/api/deprecateVersion.ts src/transport/http/systems.ts
git commit -m "feat(web): version history with deprecate + export"
```

### Task 30: Package export download

**Files:**
- Create: `web/src/api/exportVersion.ts`
- Modify: `web/src/publish/VersionHistory.tsx`

**Interfaces:**
- Consumes: `GET /system-versions/:versionId/export`.
- Produces: a download triggered by clicking "Export" — uses `Blob` + `URL.createObjectURL`.

- [ ] **Step 1: Implement + test + commit**

```bash
git add web/src/api/exportVersion.ts web/src/publish/VersionHistory.tsx
git commit -m "feat(web): package export download"
```

### Task 31: Clone-from-template fixture picker

**Files:**
- Create: `web/src/publish/CloneFromTemplate.tsx`
- Create: `web/src/publish/CloneFromTemplate.test.tsx`
- Create: `web/src/api/listTemplates.ts`

**Interfaces:**
- Consumes: a small `GET /templates` endpoint (added in this task) that returns the three reference fixture version IDs and labels.
- Produces: a list of three templates; clicking one creates a clone via `useCreateDraft`.

- [ ] **Step 1: Add `GET /templates` route**

```typescript
app.get("/templates", async () => ({ templates: [
  { templateId: "d20", label: "d20 sample", versionId: "11111111-1111-1111-1111-111111111a01" },
  { templateId: "pbta2d6", label: "PbtA 2d6 sample", versionId: "..." },
  { templateId: "d6success", label: "d6 success pool sample", versionId: "..." },
] }));
```

- [ ] **Step 2: Implement + test + commit**

```bash
git add web/src/publish web/src/api/listTemplates.ts src/transport/http/systems.ts
git commit -m "feat(web): clone-from-template picker"
```

---

## Phase I2-H — Test pass + acceptance demo

### Task 32: Playwright config + test bootstrap

**Files:**
- Create: `web/playwright.config.ts`
- Create: `web/tests/e2e/setup/global-setup.ts`
- Create: `web/tests/e2e/setup/test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: Playwright boots the backend (`docker compose up -d postgres` + `npm run migrate` + `npm run dev:http`), then runs Vite dev server (`npm run web:dev`) and the web client tests against `http://localhost:5173`.

- [ ] **Step 1: Configure**

```typescript
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  retries: 0,
  use: { baseURL: "http://localhost:5173", trace: "retain-on-failure" },
  webServer: [
    { command: "npm run migrate && npm run dev:http", url: "http://localhost:3000/health/ready", reuseExistingServer: !process.env.CI, timeout: 60_000 },
    { command: "npm run web:dev", url: "http://localhost:5173", reuseExistingServer: !process.env.CI, timeout: 60_000 },
  ],
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
```

- [ ] **Step 2: Smoke test**

`web/tests/e2e/smoke.spec.ts`:

```typescript
import { test, expect } from "@playwright/test";

test("smoke: app shell renders", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("app-header")).toBeVisible();
});
```

- [ ] **Step 3: Commit**

```bash
git add web/playwright.config.ts web/tests
git commit -m "test(web): Playwright config and smoke test"
```

### Task 33: Acceptance demonstration flow

**Files:**
- Create: `web/tests/e2e/acceptance.spec.ts`
- Create: `docs/acceptance/i2-2026-09-04.md`

**Interfaces:**
- Consumes: all I2 features.
- Produces: one Playwright spec that performs the 10-step acceptance flow from the spec §14.

- [ ] **Step 1: Implement**

```typescript
import { test, expect } from "@playwright/test";

test("acceptance: clone template, edit, preview, publish, breaking-change gate", async ({ page }) => {
  // 1. Dev sign-in
  await page.goto("/");
  await page.getByTestId("dev-signin").click();

  // 2. Clone d20
  await page.getByRole("button", { name: /clone from template/i }).click();
  await page.getByRole("button", { name: /d20 sample/i }).click();

  // 3-7. Edit, validate, preview at 360/1280
  // 8. Publish 1.0.0
  // 9. Make destructive change, attempt 1.1.0, expect 422 + breaking-change banner
  // 10. Restore, publish 1.1.0 cleanly

  await expect(page.getByTestId("version-history")).toContainText("1.1.0");
});
```

- [ ] **Step 2: Add axe scan**

```typescript
import AxeBuilder from "@axe-core/playwright";

test("a11y: library passes axe", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("dev-signin").click();
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
});
```

- [ ] **Step 3: Record the acceptance demonstration**

Run the spec under Playwright with `--trace on`. Save trace under `docs/acceptance/i2-2026-09-04-trace.zip`. Author `docs/acceptance/i2-2026-09-04.md` summarizing the run.

- [ ] **Step 4: Commit**

```bash
git add web/tests/e2e/acceptance.spec.ts docs/acceptance/i2-2026-09-04.md docs/acceptance/i2-2026-09-04-trace.zip
git commit -m "test(web): acceptance demonstration end-to-end"
```

### Task 34: Visual regression baselines

**Files:**
- Create: `web/tests/e2e/visual.spec.ts`
- Create: `web/tests/visual/__screenshots__/*` (generated)

**Interfaces:**
- Consumes: `toHaveScreenshot` from Playwright.
- Produces: committed baselines at 360 and 1280 for: library, document editor (d20 loaded), sheet preview, publish dialog, conflict banner.

- [ ] **Step 1: Generate baselines**

Run: `npm run web:test:e2e:update`
Expected: baselines committed under `web/tests/visual/__screenshots__/`.

- [ ] **Step 2: Lock the run**

Re-run `npm run web:test:e2e` without `--update-snapshots`; expect all baselines to match.

- [ ] **Step 3: Commit**

```bash
git add web/tests/e2e/visual.spec.ts web/tests/visual
git commit -m "test(web): visual regression baselines at 360 and 1280"
```

### Task 35: Final closure — update design and tick all boxes

**Files:**
- Modify: `design_v2.md` (§17.4 + §17.2 table)

**Interfaces:**
- Consumes: completed I2.
- Produces: design document reflects I2 closure; increment table updated.

- [ ] **Step 1: Update `design_v2.md`**

- Add the I2 row to the increment table at §17.2 (completed 2026-09-04): "A non-programmer can create and publish a playable system entirely through the web interface."
- Append a close-out note at §17.4: "**I2 closed 2026-09-04.** All nine tasks implemented. Web client at `web/`, generated OpenAPI artifact at `docs/contracts/openapi-v1.json`, dev-only sign-in route, seeded reference templates. Acceptance demonstration recorded at `docs/acceptance/i2-2026-09-04.md`."

- [ ] **Step 2: Run full suite one final time**

Run: `npm run typecheck && npm test && TEST_DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll npm run test:integration && npm run contracts:check && npm run web:typecheck && npm run web:test && npm run web:test:e2e`
Expected: all green.

- [ ] **Step 3: Commit**

```bash
git add design_v2.md
git commit -m "docs: mark I2 closed and update increment table"
```

---

## Notes for executors

- Every task's commit lands on the current working branch. Phase closures land as separate commits; the phase boundaries are observable in `git log`.
- Web test commands run from `web/` (`npm --prefix web run test`); backend test commands run from root.
- `npm run contracts:check` must pass at every checkpoint. Routes added without TypeBox schemas will fail it.
- The dev sign-in route is gated on `NODE_ENV !== "production"`. Production deployments must set `NODE_ENV=production` in the deploy environment.
- Visual regression baselines are committed to git; Playwright diffs against them on every run.
- If any task's tests fail because of an upstream schema change (e.g., the generated `web/src/api/schema.d.ts`), regenerate with `npm run contracts:generate` before continuing.