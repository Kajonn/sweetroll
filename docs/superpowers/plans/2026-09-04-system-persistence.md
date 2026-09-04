# System Authoring Persistence Implementation Plan (I1 Task 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the PostgreSQL persistence layer for the System Authoring Module: `systems`, `system_drafts`, `system_versions`, `idempotency_receipts`, and `system_audit_records`, with a repository that records drafts, immutable published versions, lifecycle metadata, idempotency receipts, and audit records.

**Architecture:** Keep SQL private under `src/systems/implementation/persistence/`. The repository is injected with a `pg.Pool` (deep-module rules). It stores only the relational columns from design §12 — identifiers, ownership, lifecycle, versions, and audit — never the validated package semantics, which remain owned by the package implementation. Versioned package JSONB is validated by the package codec before write; the repository treats the serialized document/package as an opaque validated JSON payload.

**Tech Stack:** Node 24, TypeScript, `pg` 8 (real PostgreSQL 17), Vitest 3.

**Spec:** `design_v2.md` sections 11.5, 12, 12.1, 12.2, and 13.1; package contract in `docs/superpowers/specs/2026-09-04-system-package-contract-design.md`.

## Global Constraints

- One Modular interface per Module; the `SystemAuthoring` Interface is implemented in a later task. This increment exposes only a **persistence repository Interface** used by that future module and its tests.
- Do not expose parser, validator, canonicalizer, or persistence interfaces from `src/systems/authoring.ts` or `src/systems/runtime.ts`.
- Dependencies (`Pool`) are injected, never created inside the implementation.
- No generic persistence seam; system SQL is tested with real PostgreSQL.
- Expose no `Parser`, `Validator`, `Rules`, or repository Interfaces; the repository Interface here is an internal construction seam, not a product API.
- Mutable aggregates carry an integer revision; update requests include the expected revision (design §12.2). This increment implements the revision read/write; conflict semantics live in the future module.
- Immutable published versions are never mutated by this layer: `system_versions` rows and package bytes are write-once.
- Idempotency receipts are scoped to `(actor_id, command_kind, key)`, store an `input_hash` for mismatch detection, and expire.
- Every persistent mutation with retry risk requires an idempotency key (design §13.1) — the repository stores receipts; callers allocate keys.
- Never log package bodies, characters, or secrets (structured allow-list logging).
- Integration tests follow the existing unique-schema pattern in `tests/integration/` and gate on `TEST_DATABASE_URL`.

---

### Task 1: Systems Schema Migration And Repository

**Files:**
- Create: `migrations/0002_create_systems.sql`
- Create: `src/systems/implementation/persistence/repository.ts`
- Create: `src/systems/implementation/persistence/index.ts` (barrel)
- Create: `tests/integration/system-persistence.test.ts`

**Interfaces:**
- Consumes: a connected `pg.Pool`.
- Produces: `SystemPersistenceRepository` with `createSystem`, `openSystem`, `listSystems`, `saveDraft`, `loadDraft`, `insertVersion`, `loadVersion`, `listVersions`, `recordReceipt`, `loadReceipt`, `appendAudit`, `listAudit`, and types `SystemId`, `VersionId`, `SystemRecord`, `DraftRecord`, `VersionRecord`, `IdempotencyReceipt`, `AuditRecord`.

- [x] **Step 1: Write the systems schema migration**

Create `migrations/0002_create_systems.sql`:

```sql
CREATE TABLE systems (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id   uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  name       text NOT NULL,
  access     text NOT NULL DEFAULT 'private',
  lifecycle  text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE system_drafts (
  system_id       uuid PRIMARY KEY REFERENCES systems(id) ON DELETE CASCADE,
  revision        integer NOT NULL DEFAULT 1,
  document_json   jsonb NOT NULL,
  source_checksum text NOT NULL,
  updated_by      uuid NOT NULL REFERENCES users(id),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE system_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  system_id       uuid NOT NULL REFERENCES systems(id) ON DELETE CASCADE,
  semantic_version text NOT NULL,
  checksum        text NOT NULL UNIQUE,
  package_json    jsonb NOT NULL,
  release_notes   text NOT NULL DEFAULT '',
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (system_id, semantic_version)
);

CREATE TABLE idempotency_receipts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  command_kind text NOT NULL,
  key          text NOT NULL,
  input_hash   text NOT NULL,
  result_json  jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  UNIQUE (actor_id, command_kind, key)
);

CREATE TABLE system_audit_records (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  system_id   uuid NOT NULL REFERENCES systems(id) ON DELETE CASCADE,
  actor_id    uuid NOT NULL REFERENCES users(id),
  kind        text NOT NULL,
  summary     text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  request_id  text NOT NULL
);

CREATE INDEX system_drafts_updated_at_idx ON system_drafts (updated_at DESC);
CREATE INDEX system_versions_system_id_idx ON system_versions (system_id, created_at DESC);
CREATE INDEX system_audit_records_system_id_idx ON system_audit_records (system_id, occurred_at DESC);
```

- [x] **Step 2: Write the failing repository tests**

Create `tests/integration/system-persistence.test.ts` that creates a unique schema containing the identity and systems tables (users must exist for FKs), then exercises the repository:

```typescript
import { randomUUID } from "node:crypto";

import { Client, Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createSystemPersistenceRepository } from "../../src/systems/implementation/persistence/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl === undefined ? describe.skip : describe;

const DDL = `
  CREATE TABLE users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    display_name text,
    locale text NOT NULL DEFAULT 'en',
    status text NOT NULL DEFAULT 'active',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE systems (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    name text NOT NULL,
    access text NOT NULL DEFAULT 'private',
    lifecycle text NOT NULL DEFAULT 'active',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE system_drafts (
    system_id uuid PRIMARY KEY REFERENCES systems(id) ON DELETE CASCADE,
    revision integer NOT NULL DEFAULT 1,
    document_json jsonb NOT NULL,
    source_checksum text NOT NULL,
    updated_by uuid NOT NULL REFERENCES users(id),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE system_versions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    system_id uuid NOT NULL REFERENCES systems(id) ON DELETE CASCADE,
    semantic_version text NOT NULL,
    checksum text NOT NULL UNIQUE,
    package_json jsonb NOT NULL,
    release_notes text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (system_id, semantic_version)
  );
  CREATE TABLE idempotency_receipts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    command_kind text NOT NULL,
    key text NOT NULL,
    input_hash text NOT NULL,
    result_json jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    UNIQUE (actor_id, command_kind, key)
  );
  CREATE TABLE system_audit_records (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    system_id uuid NOT NULL REFERENCES systems(id) ON DELETE CASCADE,
    actor_id uuid NOT NULL REFERENCES users(id),
    kind text NOT NULL,
    summary text NOT NULL,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    request_id text NOT NULL
  );
`;
```

The test body creates two users, creates a system, saves/loads a draft with revisions, inserts and loads a version, records/loads an idempotency receipt (reuse vs mismatched input), and appends/lists audit records. Assert exact revision increments, immutable version fields, checksum uniqueness, receipt reuse behavior, and audit ordering.

- [x] **Step 3: Run the integration tests to verify they fail**

Run: `TEST_DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll npm run test:integration -- system-persistence.test.ts`

Expected: FAIL because `src/systems/implementation/persistence/index.js` does not resolve.

- [x] **Step 4: Implement the repository**

Create `src/systems/implementation/persistence/repository.ts` exporting `createSystemPersistenceRepository(pool)` implementing the Interface above. Use parameterized SQL, return typed rows, and perform multi-statement operations inside a transaction with an advisory `client` (connect/BEGIN/COMMIT/ROLLBACK, always `release()`). Expose the complete repository through `src/systems/implementation/persistence/index.ts` (replace the current `export {};` stub).

- [x] **Step 5: Run the integration tests to verify they pass**

Run: `TEST_DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll npm run test:integration -- system-persistence.test.ts`

Expected: PASS with the repository cases.

- [x] **Step 6: Run the real migration against the compose database**

Run: `docker compose up -d --wait postgres` then `DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll npm run migrate`

Expected: `database migrations complete`; the five new tables exist.

- [x] **Step 7: Verify the full suite**

Run: `npm test && TEST_DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll npm run test:integration && npm run typecheck && npm run build`

Expected: all suites green; typecheck and build exit 0.

- [x] **Step 8: Commit**

```bash
git add migrations/0002_create_systems.sql src/systems/implementation/persistence/ tests/integration/system-persistence.test.ts
git commit -m "feat: add system authoring persistence"
```
