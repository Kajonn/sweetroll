# System Authoring Interface Implementation Plan (I1 Task 7)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the `SystemAuthoring` Module Interface and map it to revision-safe HTTP routes for create (blank/clone/import), open, list, save, preview, publish, export, and lifecycle changes.

**Architecture:** One deep module facade (`src/systems/authoring.ts`) composes the existing persistence repository, package codec, and rules compiler; assessment and document-reconstruction helpers live in `src/systems/implementation/authoring/`. A new migration adds `preview_snapshots`, a `system_versions.lifecycle` column, and a database immutability trigger. A Fastify plugin maps one HTTP route to one Module call each and is registered in `bootstrap/http.ts`.

**Tech Stack:** Node.js 24, TypeScript (strict, NodeNext), Fastify 5, `pg` 8, Vitest 3, PostgreSQL 17.

**Spec:** `design_v2.md` sections 6.5, 11.2–11.6, 12, 13, and 17.3 Task 7. Spec contract file: `docs/superpowers/specs/2026-09-04-system-package-contract-design.md`.

## Global Constraints

- One deep Module per Interface; the HTTP Adapter maps one route to one Module call each and reproduces no authorization, validation, or transaction ordering.
- Authentication occurs before a Module call (HTTP guard); authorization happens inside the Module. Inaccessible resources collapse to `not_found` (owner checks included).
- Module methods return `Result<T> = { ok: true; value: T } | { ok: false; error: AppError }` and never throw to callers.
- Idempotency receipts are required for create (`system_create`) and publish (`system_publish`); reuse with identical input returns the stored result, different input returns `idempotency_mismatch`. Draft save is revision-guarded via `PUT` and uses no receipt. Preview uses no receipt (duplicates are harmless, immutable, expiring).
- A semantically invalid but structurally safe draft may be saved; preview and publication require a valid assessment.
- Publication compiles against the exact draft revision, then locks and rechecks revision + source checksum inside a transaction before inserting the immutable version.
- Semantic-version validation in this increment is format only (`X.Y.Z`); ordering and breaking-change comparison belong to I1 Task 8.
- Published package bytes are immutable, enforced by a PostgreSQL trigger; no code path updates `package_json`, `checksum`, or `semantic_version`.
- Cursor pagination for the system list: `limit` integer 1–100 (default 20), opaque cursor = last `systemId`.
- No worker and no background cleanup; expired previews and receipts are filtered at read time.
- `src/systems/runtime.ts` stays an `export {};` stub; no SystemRuntime behavior in this plan.
- Strict TypeScript must pass: `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noUnusedLocals`.
- Verification gate for every task: `npm test`, then `npm run typecheck`, then commit. Integration tests additionally need `TEST_DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll`.

---

### Task 1: Preserve Expression Context In Compiled Packages

The compiled package loses each expression's `context` (`computed` | `roll` | `validation`), which makes faithful clone/import document reconstruction impossible and will block runtime evaluation later. Add `context` to `CompiledExpressionV1`.

**Files:**
- Modify: `src/systems/implementation/rules/compile-document.test.ts` (add one test)
- Modify: `src/systems/implementation/package/schema/expression.ts`
- Modify: `src/systems/implementation/rules/compile.ts`
- Modify: `src/systems/implementation/package/fixtures/d20.ts`
- Modify: `src/systems/implementation/package/fixtures/d6-success-pool.ts`
- Modify: `src/systems/implementation/package/fixtures/pbta-2d6.ts`
- Modify: `src/systems/implementation/package/schema/test-values.ts`
- Modify: `src/systems/implementation/rules/property.test.ts`
- Modify: `src/systems/implementation/package/schema/package.test.ts`
- Modify: `design_v2.md` (Appendix A), `docs/superpowers/specs/2026-09-04-system-package-contract-design.md`

**Interfaces:**
- Consumes: existing `compileDocument(document, opts)` and `CompiledExpressionV1`.
- Produces: `CompiledExpressionV1.context: "computed" | "roll" | "validation"` — required by every later task (reconstruction in Task 2, publishing in Task 4).

- [x] **Step 1: Add the failing test**

Append to `src/systems/implementation/rules/compile-document.test.ts` (inside the existing top-level `describe`):

```typescript
  it("preserves the expression context in compiled expressions", () => {
    const result = compileDocument(d20Document, {
      systemId: "00000000-0000-4000-8000-000000000000",
      versionId: "00000000-0000-4000-8000-000000000001",
      semanticVersion: "1.0.0",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("compilation failed");
    expect(result.value.expressions.map((e) => e.context)).toEqual(["computed", "roll", "validation"]);
  });
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/systems/implementation/rules/compile-document.test.ts`

Expected: FAIL — `e.context` is `undefined` (the compiled body has no context).

- [x] **Step 3: Add `context` to the compiled expression schema**

In `src/systems/implementation/package/schema/expression.ts`, change `CompiledExpressionV1Schema` to:

```typescript
export const CompiledExpressionV1Schema = Type.Object(
  {
    id: DefinitionIdSchema,
    context: Type.Union([
      Type.Literal("computed"),
      Type.Literal("roll"),
      Type.Literal("validation"),
    ]),
    resultType: ValueTypeSchema,
    inferredType: ValueTypeSchema,
    fallback: ScalarValueSchema,
    dependencies: Type.Array(DefinitionIdSchema, { maxItems: PACKAGE_LIMITS.expressions }),
    cost: Type.Integer({ minimum: 1, maximum: PACKAGE_LIMITS.expressionAstNodes }),
    ast: ExpressionAstV1Schema,
  },
  { additionalProperties: false },
);
```

- [x] **Step 4: Emit `context` from the compiler**

In `src/systems/implementation/rules/compile.ts`, the success return of `compileAst` becomes:

```typescript
  return {
    ok: true,
    value: {
      context: opts.context,
      resultType: opts.resultType,
      inferredType: inferred.type,
      fallback: opts.fallback,
      dependencies: resolveDependencies(ast),
      cost: nodes,
      ast,
    },
  };
```

- [x] **Step 5: Add `context` to fixture and test-value compiled expressions**

Insert `context: "...",` as the second property (immediately after `id`) in each compiled package expression literal:

- `src/systems/implementation/package/fixtures/d20.ts` (`unsignedPackage.expressions`): `defense_expr` → `"computed"`, `check_expr` → `"roll"`, `ability_valid_expr` → `"validation"`.
- `src/systems/implementation/package/fixtures/d6-success-pool.ts` (package `expressions`): `pool_size_expr` → `"computed"`, `pool_roll_expr` → `"roll"`, `pool_valid_expr` → `"validation"`.
- `src/systems/implementation/package/fixtures/pbta-2d6.ts` (package `expressions`): `penalty_expr` → `"computed"`, `move_expr` → `"roll"`, `stat_valid_expr` → `"validation"`.
- `src/systems/implementation/package/schema/test-values.ts` (`const expressions` array): all four (`literal_expr`, `reference_expr`, `binary_expr`, `pool_expr`) → `"computed"`.

Example shape for one entry:

```typescript
    {
      id: "defense_expr",
      context: "computed",
      resultType: "number",
      inferredType: "number",
      fallback: 10,
      dependencies: ["modifier"],
      cost: 3,
      ast: {
        kind: "binary",
        operator: "+",
        left: { kind: "numberLiteral", value: 10 },
        right: { kind: "reference", scope: "fields", id: "modifier" },
      },
    },
```

- [x] **Step 6: Fix inline literals in remaining tests**

- `src/systems/implementation/rules/property.test.ts`: in the `compileExpr` helper (~line 70), add `context: "computed",` immediately after `id: "prop_test",`. The generated ASTs contain no `inputs.` references, so `"computed"` is always valid.
- `src/systems/implementation/package/schema/package.test.ts`: in `packageWithEveryAstVariant()`, add `context: "computed",` immediately after each `id: "..._expr",` line of the pushed literals (`string_expr`, `boolean_expr`, `unary_expr`, `min_expr`, `max_expr`, `round_expr`, `dice_expr`, `keep_high_expr`, `keep_low_expr`, and any remaining pushed entries in the file). The schema validates `context` as a literal union only; `"computed"` passes for all.

- [x] **Step 7: Run all unit tests and typecheck**

Run: `npm test && npm run typecheck`

Expected: all tests PASS (including fixtures, codec, canonical, compile-document) and typecheck exits 0.

- [x] **Step 8: Update the design documents**

- `design_v2.md` Appendix A: change the `expressions` line to `expressions: [ { id, context, resultType, ast, dependencies } ]`.
- `docs/superpowers/specs/2026-09-04-system-package-contract-design.md`: in the compiled package section, add one sentence: "Each compiled expression carries its `context` (`computed`, `roll`, or `validation`) so packages reconstruct faithfully for cloning, importing, and runtime evaluation."

- [x] **Step 9: Commit**

```bash
git add src/systems/implementation design_v2.md docs/superpowers/specs/2026-09-04-system-package-contract-design.md
git commit -m "feat: preserve expression context in compiled packages"
```

---

### Task 2: Assessment And Reconstruction Helpers

Create the internal helpers the Module needs: blank documents, package assessment (decode + compile with placeholder identity), document checksums, input hashing, and document reconstruction from a compiled package.

**Files:**
- Create: `src/systems/implementation/authoring/assess.ts`
- Create: `src/systems/implementation/authoring/assess.test.ts`

**Interfaces:**
- Consumes: `decodeSystemDocument` (package codec), `compileDocument` (rules), `renderExpression` (rules), `d20Document`/`d20Package` fixtures, `canonicalize` from `json-canonicalize`.
- Produces (used by Task 4):
  - `type PackageAssessment = { ok: boolean; diagnostics: PackageDiagnostic[] }`
  - `type AssessedDocument = { ok: true; document: SystemDocumentV1; assessment: PackageAssessment } | { ok: false; document: SystemDocumentV1 | null; assessment: PackageAssessment }` (`document === null` means structurally invalid — not safe to save)
  - `blankSystemDocument(name: string): SystemDocumentV1`
  - `assessDocument(input: unknown): AssessedDocument`
  - `documentChecksum(document: SystemDocumentV1): string` → `sha256:...`
  - `hashInput(value: unknown): string` → `sha256:...`
  - `documentFromPackage(pkg: SystemPackageV1): SystemDocumentV1`

- [x] **Step 1: Write the failing tests**

Create `src/systems/implementation/authoring/assess.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import { decodeSystemDocument } from "../package/codec.js";
import { d20Document, d20Package } from "../package/fixtures/index.js";
import { compileDocument } from "../rules/compile-document.js";
import {
  assessDocument,
  blankSystemDocument,
  documentChecksum,
  documentFromPackage,
  hashInput,
} from "./assess.js";

describe("assessment helpers", () => {
  it("creates a blank document that decodes and assesses cleanly", () => {
    const blank = blankSystemDocument("My System");
    expect(decodeSystemDocument(blank).ok).toBe(true);
    expect(blank.metadata.name).toBe("My System");
    const assessed = assessDocument(blank);
    expect(assessed.ok).toBe(true);
  });

  it("assesses a valid reference document as ok with no diagnostics", () => {
    const assessed = assessDocument(d20Document);
    expect(assessed.ok).toBe(true);
    expect(assessed.assessment).toEqual({ ok: true, diagnostics: [] });
  });

  it("reports diagnostics for structurally invalid input without a document", () => {
    const assessed = assessDocument({ nope: true });
    expect(assessed.ok).toBe(false);
    expect(assessed.document).toBeNull();
    expect(assessed.assessment.ok).toBe(false);
    expect(assessed.assessment.diagnostics.length).toBeGreaterThan(0);
  });

  it("keeps a structurally safe document when expressions fail to compile", () => {
    const broken = blankSystemDocument("Broken");
    broken.entities.push({
      id: "character",
      label: "Character",
      fields: [
        { kind: "text", id: "name", label: "Name", default: "", required: true, minLength: 1, maxLength: 120 },
      ],
    });
    broken.expressions.push({
      id: "broken_expr",
      context: "computed",
      resultType: "number",
      source: "fields.missing_field + 1",
      fallback: 0,
    });
    const assessed = assessDocument(broken);
    expect(assessed.ok).toBe(false);
    expect(assessed.document).not.toBeNull();
    expect(assessed.assessment.diagnostics.length).toBeGreaterThan(0);
  });

  it("reconstructs a document from a package that recompiles to the same checksum", () => {
    const document = documentFromPackage(d20Package);
    const compiled = compileDocument(document, {
      systemId: d20Package.systemId,
      versionId: d20Package.versionId,
      semanticVersion: d20Package.semanticVersion,
    });
    expect(compiled.ok).toBe(true);
    if (compiled.ok) {
      expect(compiled.value.integrity.checksum).toBe(d20Package.integrity.checksum);
    }
  });

  it("produces stable sha256 checksums for documents and inputs", () => {
    expect(documentChecksum(d20Document)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(documentChecksum(d20Document)).toBe(documentChecksum(structuredClone(d20Document)));
    expect(hashInput({ a: 1 })).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(hashInput({ a: 1, b: 2 })).toBe(hashInput({ b: 2, a: 1 }));
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/systems/implementation/authoring/assess.test.ts`

Expected: FAIL because `./assess.js` does not exist.

- [x] **Step 3: Implement the helpers**

Create `src/systems/implementation/authoring/assess.ts`:

```typescript
import { createHash } from "node:crypto";

import { canonicalize } from "json-canonicalize";

import { decodeSystemDocument } from "../package/codec.js";
import type { PackageDiagnostic } from "../package/diagnostics.js";
import type { SystemDocumentV1, SystemPackageV1 } from "../package/schema/index.js";
import { compileDocument } from "../rules/compile-document.js";
import { renderExpression } from "../rules/render.js";

const ASSESSMENT_SYSTEM_ID = "00000000-0000-4000-8000-000000000000";
const ASSESSMENT_VERSION_ID = "00000000-0000-4000-8000-000000000001";

export type PackageAssessment = {
  ok: boolean;
  diagnostics: PackageDiagnostic[];
};

export type AssessedDocument =
  | { ok: true; document: SystemDocumentV1; assessment: PackageAssessment }
  | { ok: false; document: SystemDocumentV1 | null; assessment: PackageAssessment };

export function blankSystemDocument(name: string): SystemDocumentV1 {
  return {
    schemaVersion: "1.0",
    metadata: { name, description: "", language: "en", defaultDice: "d20" },
    entities: [],
    referenceData: [],
    sheets: [],
    expressions: [],
    actions: [],
    validations: [],
  };
}

export function documentChecksum(document: SystemDocumentV1): string {
  return `sha256:${createHash("sha256").update(canonicalize(document), "utf8").digest("hex")}`;
}

export function hashInput(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalize(value), "utf8").digest("hex")}`;
}

export function assessDocument(input: unknown): AssessedDocument {
  const decoded = decodeSystemDocument(input);
  if (!decoded.ok) {
    return { ok: false, document: null, assessment: { ok: false, diagnostics: decoded.diagnostics } };
  }
  const compiled = compileDocument(decoded.value, {
    systemId: ASSESSMENT_SYSTEM_ID,
    versionId: ASSESSMENT_VERSION_ID,
    semanticVersion: "0.0.0",
  });
  if (!compiled.ok) {
    return {
      ok: false,
      document: decoded.value,
      assessment: { ok: false, diagnostics: compiled.diagnostics },
    };
  }
  return { ok: true, document: decoded.value, assessment: { ok: true, diagnostics: [] } };
}

export function documentFromPackage(pkg: SystemPackageV1): SystemDocumentV1 {
  return {
    schemaVersion: "1.0",
    metadata: {
      name: pkg.name,
      description: pkg.description,
      language: pkg.language,
      defaultDice: pkg.defaultDice,
    },
    entities: structuredClone(pkg.entities),
    referenceData: structuredClone(pkg.referenceData),
    sheets: structuredClone(pkg.sheets),
    expressions: pkg.expressions.map((expression) => ({
      id: expression.id,
      context: expression.context,
      resultType: expression.resultType,
      source: renderExpression(expression.ast),
      fallback: expression.fallback,
    })),
    actions: structuredClone(pkg.actions),
    validations: structuredClone(pkg.validations),
  };
}
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `npm test -- src/systems/implementation/authoring/assess.test.ts`

Expected: PASS with 6 tests. If the roundtrip checksum test fails, fix `documentFromPackage` — do not weaken the test.

- [x] **Step 5: Commit**

```bash
git add src/systems/implementation/authoring
git commit -m "feat: add package assessment and reconstruction helpers"
```

---

### Task 3: Persistence Additions For Authoring

Add `preview_snapshots`, `system_versions.lifecycle`, and the immutability trigger (migration `0003`), then extend the repository with preview, lifecycle, pagination, and transactional publish methods. Draft saves now write their audit record atomically via a new `requestId` input.

**Files:**
- Create: `migrations/0003_create_system_authoring.sql`
- Modify: `src/systems/implementation/persistence/repository.ts`
- Modify: `src/systems/implementation/persistence/index.ts`
- Modify: `tests/integration/system-persistence.test.ts`

**Interfaces:**
- Consumes: existing `SystemPersistenceRepository`, its row mappers, and the `DDL`/setup in `tests/integration/system-persistence.test.ts`.
- Produces (consumed by Task 4):
  - `VersionRecord` gains `lifecycle: string`.
  - `SaveDraftInput` gains `requestId: string`; the draft save transaction appends a `draft_saved` audit record.
  - `createPreviewSnapshot(input: { systemId; sourceRevision: number; package: unknown; expiresAt: Date }): Promise<PreviewSnapshotRecord>`
  - `loadPreviewSnapshot(snapshotId: string): Promise<PreviewSnapshotRecord | null>` (null when missing or expired)
  - `updateSystemLifecycle(systemId, lifecycle: "active" | "archived"): Promise<SystemRecord | null>`
  - `updateVersionLifecycle(versionId, lifecycle: "published" | "deprecated"): Promise<VersionRecord | null>`
  - `listSystemsPage(ownerId, page: { limit: number; cursor: string | null }): Promise<{ systems: SystemRecord[]; nextCursor: string | null }>`
  - `publishVersion(input: PublishVersionInput): Promise<PublishVersionResult>` with `PublishVersionInput = { systemId; expectedRevision: number; sourceChecksum: string; semanticVersion: string; checksum: string; package: unknown; releaseNotes: string; actorId; requestId }` and `PublishVersionResult = { ok: true; version: VersionRecord } | { ok: false; code: "stale_revision"; latestRevision: number | null } | { ok: false; code: "duplicate_version" }`
  - Migration `0003` with tables/columns/trigger listed below.

- [x] **Step 1: Write the migration**

Create `migrations/0003_create_system_authoring.sql`:

```sql
ALTER TABLE system_versions
  ADD COLUMN lifecycle text NOT NULL DEFAULT 'published';

CREATE TABLE preview_snapshots (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  system_id       uuid NOT NULL REFERENCES systems(id) ON DELETE CASCADE,
  source_revision integer NOT NULL,
  package_json    jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL
);

CREATE INDEX preview_snapshots_system_id_idx
  ON preview_snapshots (system_id, created_at DESC);

CREATE FUNCTION system_versions_prevent_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.package_json IS DISTINCT FROM OLD.package_json
     OR NEW.checksum IS DISTINCT FROM OLD.checksum
     OR NEW.semantic_version IS DISTINCT FROM OLD.semantic_version THEN
    RAISE EXCEPTION 'published system versions are immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER system_versions_immutable
  BEFORE UPDATE ON system_versions
  FOR EACH ROW EXECUTE FUNCTION system_versions_prevent_mutation();
```

- [x] **Step 2: Extend the failing integration tests**

In `tests/integration/system-persistence.test.ts`:

1. Update the `DDL` constant: add `lifecycle text NOT NULL DEFAULT 'published',` to the `system_versions` table (after `release_notes`), and append after the `system_audit_records` table:

```sql
  CREATE TABLE preview_snapshots (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    system_id       uuid NOT NULL REFERENCES systems(id) ON DELETE CASCADE,
    source_revision integer NOT NULL,
    package_json    jsonb NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    expires_at      timestamptz NOT NULL
  );
  CREATE FUNCTION system_versions_prevent_mutation() RETURNS trigger
  LANGUAGE plpgsql AS $$
  BEGIN
    IF NEW.package_json IS DISTINCT FROM OLD.package_json
       OR NEW.checksum IS DISTINCT FROM OLD.checksum
       OR NEW.semantic_version IS DISTINCT FROM OLD.semantic_version THEN
      RAISE EXCEPTION 'published system versions are immutable';
    END IF;
    RETURN NEW;
  END;
  $$;
  CREATE TRIGGER system_versions_immutable
    BEFORE UPDATE ON system_versions
    FOR EACH ROW EXECUTE FUNCTION system_versions_prevent_mutation();
```

2. Add `requestId: "req-test",` to every `repo.saveDraft({...})` call (three call sites in "initializes a draft..." and one in "rejects a stale save..."). Existing assertions stay unchanged.

3. Append these tests inside the `describe` block:

```typescript
  it("creates and loads unexpired preview snapshots and hides expired ones", async () => {
    const owner = await createUser("Ada");
    const repo = createSystemPersistenceRepository(pool);
    const { systemId } = await repo.createSystem({ ownerId: owner, name: "Pocket Quest" });

    const created = await repo.createPreviewSnapshot({
      systemId,
      sourceRevision: 3,
      package: { schemaVersion: "1.0", name: "preview" },
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(created.sourceRevision).toBe(3);

    const loaded = await repo.loadPreviewSnapshot(created.snapshotId);
    expect(loaded?.systemId).toBe(systemId);
    expect(loaded?.package).toEqual({ schemaVersion: "1.0", name: "preview" });

    const expired = await repo.createPreviewSnapshot({
      systemId,
      sourceRevision: 4,
      package: { schemaVersion: "1.0", name: "expired" },
      expiresAt: new Date(Date.now() - 1_000),
    });
    expect(await repo.loadPreviewSnapshot(expired.snapshotId)).toBeNull();
    expect(await repo.loadPreviewSnapshot(randomUUID())).toBeNull();
  });

  it("changes system and version lifecycle and rejects package mutation", async () => {
    const owner = await createUser("Ada");
    const repo = createSystemPersistenceRepository(pool);
    const { systemId } = await repo.createSystem({ ownerId: owner, name: "Pocket Quest" });
    const version = await repo.insertVersion({
      systemId,
      semanticVersion: "1.0.0",
      checksum: "sha256:aaa",
      package: { schemaVersion: "1.0", name: "one" },
      releaseNotes: "",
    });

    const archived = await repo.updateSystemLifecycle(systemId, "archived");
    expect(archived?.lifecycle).toBe("archived");
    const restored = await repo.updateSystemLifecycle(systemId, "active");
    expect(restored?.lifecycle).toBe("active");
    expect(await repo.updateSystemLifecycle(randomUUID(), "archived")).toBeNull();

    const deprecated = await repo.updateVersionLifecycle(version.versionId, "deprecated");
    expect(deprecated?.lifecycle).toBe("deprecated");
    expect(await repo.updateVersionLifecycle(randomUUID(), "deprecated")).toBeNull();

    await expect(
      pool.query("UPDATE system_versions SET package_json = '{}'::jsonb WHERE id = $1", [version.versionId]),
    ).rejects.toMatchObject({ message: "published system versions are immutable" });
  });

  it("paginates systems with a keyset cursor", async () => {
    const owner = await createUser("Ada");
    const repo = createSystemPersistenceRepository(pool);
    const delay = () => new Promise((resolve) => setTimeout(resolve, 5));
    await repo.createSystem({ ownerId: owner, name: "A" });
    await delay();
    await repo.createSystem({ ownerId: owner, name: "B" });
    await delay();
    await repo.createSystem({ ownerId: owner, name: "C" });

    const page1 = await repo.listSystemsPage(owner, { limit: 2, cursor: null });
    expect(page1.systems.map((s) => s.name)).toEqual(["C", "B"]);
    expect(page1.nextCursor).toBe(page1.systems[1]?.systemId ?? null);

    const page2 = await repo.listSystemsPage(owner, { limit: 2, cursor: page1.nextCursor });
    expect(page2.systems.map((s) => s.name)).toEqual(["A"]);
    expect(page2.nextCursor).toBeNull();
  });

  it("publishes a version transactionally with an audit record and rejects duplicates and stale input", async () => {
    const owner = await createUser("Ada");
    const repo = createSystemPersistenceRepository(pool);
    const { systemId } = await repo.createSystem({ ownerId: owner, name: "Pocket Quest" });
    await repo.saveDraft({
      systemId,
      expectedRevision: null,
      document: { schemaVersion: "1.0", head: "one" },
      sourceChecksum: "sha256:one",
      updatedBy: owner,
      requestId: "req-pub",
    });

    const published = await repo.publishVersion({
      systemId,
      expectedRevision: 1,
      sourceChecksum: "sha256:one",
      semanticVersion: "1.0.0",
      checksum: "sha256:pkg",
      package: { schemaVersion: "1.0", name: "pkg" },
      releaseNotes: "First",
      actorId: owner,
      requestId: "req-pub",
    });
    expect(published.ok).toBe(true);
    if (!published.ok) throw new Error("unexpected");
    expect(published.version.lifecycle).toBe("published");

    const audit = await repo.listAudit(systemId);
    expect(audit.map((r) => r.kind)).toEqual(["version_published", "draft_saved"]);

    const duplicate = await repo.publishVersion({
      systemId,
      expectedRevision: 1,
      sourceChecksum: "sha256:one",
      semanticVersion: "1.0.0",
      checksum: "sha256:other",
      package: { schemaVersion: "1.0", name: "other" },
      releaseNotes: "",
      actorId: owner,
      requestId: "req-pub",
    });
    expect(duplicate).toEqual({ ok: false, code: "duplicate_version" });

    const stale = await repo.publishVersion({
      systemId,
      expectedRevision: 99,
      sourceChecksum: "sha256:one",
      semanticVersion: "1.1.0",
      checksum: "sha256:pkg2",
      package: { schemaVersion: "1.0", name: "pkg2" },
      releaseNotes: "",
      actorId: owner,
      requestId: "req-pub",
    });
    expect(stale).toEqual({ ok: false, code: "stale_revision", latestRevision: 1 });

    const noDraft = await repo.publishVersion({
      systemId: randomUUID(),
      expectedRevision: 1,
      sourceChecksum: "sha256:x",
      semanticVersion: "1.0.0",
      checksum: "sha256:y",
      package: {},
      releaseNotes: "",
      actorId: owner,
      requestId: "req-pub",
    });
    expect(noDraft).toEqual({ ok: false, code: "stale_revision", latestRevision: null });
  });
```

- [x] **Step 3: Run the integration tests to verify they fail**

Run: `TEST_DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll npm run test:integration -- system-persistence.test.ts`

Expected: FAIL/TYPE ERROR — the new repository methods do not exist.

- [x] **Step 4: Implement the repository additions**

In `src/systems/implementation/persistence/repository.ts`:

1. Add `lifecycle: string;` to `VersionRecord`.
2. Add `requestId: string;` to `SaveDraftInput`.
3. Add these types near the other result types:

```typescript
export type PreviewSnapshotRecord = {
  snapshotId: string;
  systemId: SystemId;
  sourceRevision: number;
  package: unknown;
  createdAt: Date;
  expiresAt: Date;
};

export type PublishVersionInput = {
  systemId: SystemId;
  expectedRevision: number;
  sourceChecksum: string;
  semanticVersion: string;
  checksum: string;
  package: unknown;
  releaseNotes: string;
  actorId: UserId;
  requestId: string;
};

export type PublishVersionResult =
  | { ok: true; version: VersionRecord }
  | { ok: false; code: "stale_revision"; latestRevision: number | null }
  | { ok: false; code: "duplicate_version" };
```

4. Extend `SystemPersistenceRepository` with:

```typescript
  createPreviewSnapshot(input: {
    systemId: SystemId;
    sourceRevision: number;
    package: unknown;
    expiresAt: Date;
  }): Promise<PreviewSnapshotRecord>;
  loadPreviewSnapshot(snapshotId: string): Promise<PreviewSnapshotRecord | null>;

  updateSystemLifecycle(
    systemId: SystemId,
    lifecycle: "active" | "archived",
  ): Promise<SystemRecord | null>;
  updateVersionLifecycle(
    versionId: VersionId,
    lifecycle: "published" | "deprecated",
  ): Promise<VersionRecord | null>;

  listSystemsPage(
    ownerId: UserId,
    page: { limit: number; cursor: string | null },
  ): Promise<{ systems: SystemRecord[]; nextCursor: string | null }>;

  publishVersion(input: PublishVersionInput): Promise<PublishVersionResult>;
```

5. Implementations inside `createSystemPersistenceRepository`:

```typescript
    async createPreviewSnapshot(input) {
      const result = await pool.query<PreviewRow>(
        `INSERT INTO preview_snapshots (system_id, source_revision, package_json, expires_at)
         VALUES ($1, $2, $3::jsonb, $4)
         RETURNING id, system_id, source_revision, package_json, created_at, expires_at`,
        [input.systemId, input.sourceRevision, JSON.stringify(input.package), input.expiresAt],
      );
      return toPreviewSnapshot(requireRow(result.rows[0], "createPreviewSnapshot"));
    },

    async loadPreviewSnapshot(snapshotId) {
      const result = await pool.query<PreviewRow>(
        `SELECT id, system_id, source_revision, package_json, created_at, expires_at
           FROM preview_snapshots
          WHERE id = $1 AND expires_at > now()`,
        [snapshotId],
      );
      const row = result.rows[0];
      return row === undefined ? null : toPreviewSnapshot(row);
    },

    async updateSystemLifecycle(systemId, lifecycle) {
      const result = await pool.query<SystemRow>(
        `UPDATE systems SET lifecycle = $2, updated_at = now()
          WHERE id = $1
          RETURNING id, owner_id, name, access, lifecycle, created_at, updated_at`,
        [systemId, lifecycle],
      );
      const row = result.rows[0];
      return row === undefined ? null : toSystemRecord(row);
    },

    async updateVersionLifecycle(versionId, lifecycle) {
      const result = await pool.query<VersionRow>(
        `UPDATE system_versions SET lifecycle = $2
          WHERE id = $1
          RETURNING id, system_id, semantic_version, checksum, package_json, release_notes, lifecycle, created_at`,
        [versionId, lifecycle],
      );
      const row = result.rows[0];
      return row === undefined ? null : toVersionRecord(row);
    },

    async listSystemsPage(ownerId, page) {
      const params: unknown[] = [ownerId, page.limit + 1];
      let where = "owner_id = $1";
      if (page.cursor !== null) {
        params.push(page.cursor);
        where += ` AND (created_at, id) < (SELECT created_at, id FROM systems WHERE id = $${params.length})`;
      }
      const result = await pool.query<SystemRow>(
        `SELECT id, owner_id, name, access, lifecycle, created_at, updated_at
           FROM systems
          WHERE ${where}
          ORDER BY created_at DESC, id DESC
          LIMIT $2`,
        params,
      );
      const hasMore = result.rows.length > page.limit;
      const pageRows = hasMore ? result.rows.slice(0, page.limit) : result.rows;
      const last = pageRows[pageRows.length - 1];
      return {
        systems: pageRows.map(toSystemRecord),
        nextCursor: hasMore && last !== undefined ? last.id : null,
      };
    },

    async publishVersion(input) {
      return publishVersionImpl(pool, input);
    },
```

6. Row/mapper changes: add `lifecycle: string;` to `VersionRow` and map `lifecycle: row.lifecycle` in `toVersionRecord`; include `lifecycle` in the `RETURNING` lists of `insertVersion`, `loadVersion`, and `listVersions`. Add:

```typescript
type PreviewRow = {
  id: string;
  system_id: string;
  source_revision: number;
  package_json: unknown;
  created_at: Date;
  expires_at: Date;
};

function toPreviewSnapshot(row: PreviewRow): PreviewSnapshotRecord {
  return {
    snapshotId: row.id,
    systemId: row.system_id,
    sourceRevision: row.source_revision,
    package: row.package_json,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}
```

7. In `saveDraftImpl`, accept the new `requestId` and append the audit record inside the transaction. In both the insert branch and the update branch, after producing the draft record `draft` and before `COMMIT`, add:

```typescript
      await client.query(
        `INSERT INTO system_audit_records (system_id, actor_id, kind, summary, request_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [input.systemId, input.updatedBy, "draft_saved", `Draft revision ${draft.revision} saved`, input.requestId],
      );
```

8. Add the publish transaction helper at the end of the file:

```typescript
async function publishVersionImpl(pool: Pool, input: PublishVersionInput): Promise<PublishVersionResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query<DraftRow>(
      `SELECT system_id, revision, document_json, source_checksum, updated_by, updated_at
         FROM system_drafts
        WHERE system_id = $1
        FOR UPDATE`,
      [input.systemId],
    );
    const draft = existing.rows[0];
    if (
      draft === undefined ||
      draft.revision !== input.expectedRevision ||
      draft.source_checksum !== input.sourceChecksum
    ) {
      await client.query("COMMIT");
      return { ok: false, code: "stale_revision", latestRevision: draft?.revision ?? null };
    }
    let inserted: VersionRow | undefined;
    try {
      const result = await client.query<VersionRow>(
        `INSERT INTO system_versions (system_id, semantic_version, checksum, package_json, release_notes)
         VALUES ($1, $2, $3, $4::jsonb, $5)
         RETURNING id, system_id, semantic_version, checksum, package_json, release_notes, lifecycle, created_at`,
        [input.systemId, input.semanticVersion, input.checksum, JSON.stringify(input.package), input.releaseNotes],
      );
      inserted = result.rows[0];
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        await client.query("ROLLBACK");
        return { ok: false, code: "duplicate_version" };
      }
      throw error;
    }
    const version = toVersionRecord(requireRow(inserted, "publishVersion"));
    await client.query(
      `INSERT INTO system_audit_records (system_id, actor_id, kind, summary, request_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [input.systemId, input.actorId, "version_published", `Published version ${input.semanticVersion}`, input.requestId],
    );
    await client.query("COMMIT");
    return { ok: true, version };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
```

9. Update `src/systems/implementation/persistence/index.ts` to also export the new types: `PreviewSnapshotRecord`, `PublishVersionInput`, `PublishVersionResult`.

- [x] **Step 5: Run the integration tests to verify they pass**

Run: `TEST_DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll npm run test:integration -- system-persistence.test.ts`

Expected: PASS with 11 tests.

- [x] **Step 6: Apply the real migration and verify**

Run: `DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll npm run migrate`

Expected: "database migrations complete". Confirm with:

```bash
docker exec sweetroll-postgres-1 psql -U sweetroll -d sweetroll -c "\d preview_snapshots" -c "SELECT column_name FROM information_schema.columns WHERE table_name='system_versions' AND column_name='lifecycle';"
```

- [x] **Step 7: Full unit gate and commit**

Run: `npm test && npm run typecheck`

Expected: PASS, exit 0.

```bash
git add migrations/0003_create_system_authoring.sql src/systems/implementation/persistence tests/integration/system-persistence.test.ts
git commit -m "feat: add authoring persistence for previews, lifecycle, and publication"
```

---

### Task 4: The SystemAuthoring Module Interface

Implement the deep Module facade with create (blank/clone/import), open, list, save, preview, publish, export, and lifecycle changes, plus integration tests against real PostgreSQL.

**Files:**
- Modify: `src/systems/authoring.ts` (replace the `export {};` stub)
- Create: `tests/integration/system-authoring.test.ts`

**Interfaces:**
- Consumes: `SystemPersistenceRepository` (Task 3 surface), Task 2 helpers, `decodeSystemExport`, `compileDocument`, `randomUUID`.
- Produces (consumed by Task 5): `createSystemAuthoringModule(input: { repo: SystemPersistenceRepository }): SystemAuthoring` plus public types `Result<T>`, `AppError`, `AppErrorCode`, `RequestContext`, `SystemSummary`, `DraftView`, `VersionSummary`, `AuthoringWorkspace`, `ListSystemsResult`, `PreviewSnapshot`, `PublishedVersion`, `ExportedPackage`, `CreateDraftSource`, `CreateDraftInput`, `SaveDraftInput`, `PreviewDraftInput`, `PublishDraftInput`, `LifecycleChangeInput`, `LifecycleResult`, `SystemAuthoring`.

- [x] **Step 1: Write the failing integration tests**

Create `tests/integration/system-authoring.test.ts`. Reuse the exact `DDL` constant, `beforeAll`/`beforeEach`/`afterAll`, and `createUser` helper from `tests/integration/system-persistence.test.ts` (copy them; the DDL already contains every table this task needs). Add these module-level pieces:

```typescript
import { randomUUID } from "node:crypto";

import { d20Document, d20Export } from "../../src/systems/implementation/package/fixtures/index.js";
import {
  createSystemPersistenceRepository,
  type SystemPersistenceRepository,
} from "../../src/systems/implementation/persistence/index.js";
import {
  createSystemAuthoringModule,
  type SystemAuthoring,
} from "../../src/systems/authoring.js";

// inside describeWithDatabase, after `let pool: Pool;`
let repo: SystemPersistenceRepository;
let authoring: SystemAuthoring;

// at the end of beforeAll, after the admin client setup:
repo = createSystemPersistenceRepository(pool);
authoring = createSystemAuthoringModule({ repo });

const ctx = (actorId: string) => ({ actorId, requestId: randomUUID() });
```

Then add the tests:

```typescript
  it("creates a blank system with an initialized draft", async () => {
    const owner = await createUser("Ada");
    const result = await authoring.createDraft(ctx(owner), {
      source: { kind: "blank", name: "Pocket Quest" },
      idempotencyKey: randomUUID(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unexpected");
    expect(result.value.system.name).toBe("Pocket Quest");
    expect(result.value.draft?.revision).toBe(1);
    expect(result.value.draft?.document.metadata.name).toBe("Pocket Quest");
    expect(result.value.versions).toEqual([]);
    expect(result.value.assessment).toEqual({ ok: true, diagnostics: [] });
  });

  it("replays identical creates from the idempotency key and rejects changed input", async () => {
    const owner = await createUser("Ada");
    const key = randomUUID();
    const first = await authoring.createDraft(ctx(owner), {
      source: { kind: "blank", name: "Same" },
      idempotencyKey: key,
    });
    expect(first.ok).toBe(true);
    const replay = await authoring.createDraft(ctx(owner), {
      source: { kind: "blank", name: "Same" },
      idempotencyKey: key,
    });
    expect(replay.ok).toBe(true);
    if (!first.ok || !replay.ok) throw new Error("unexpected");
    expect(replay.value.system.systemId).toBe(first.value.system.systemId);

    const mismatch = await authoring.createDraft(ctx(owner), {
      source: { kind: "blank", name: "Different" },
      idempotencyKey: key,
    });
    expect(mismatch).toEqual({
      ok: false,
      error: { code: "idempotency_mismatch", message: "This idempotency key was already used with different input." },
    });
  });

  it("creates a system by cloning a published version of the owner", async () => {
    const owner = await createUser("Ada");
    const created = await authoring.createDraft(ctx(owner), {
      source: { kind: "blank", name: "Source" },
      idempotencyKey: randomUUID(),
    });
    if (!created.ok) throw new Error("unexpected");
    const saved = await authoring.saveDraft(ctx(owner), {
      systemId: created.value.system.systemId,
      expectedRevision: 1,
      document: d20Document,
    });
    if (!saved.ok) throw new Error("unexpected");
    const published = await authoring.publish(ctx(owner), {
      systemId: created.value.system.systemId,
      expectedRevision: 2,
      semanticVersion: "1.0.0",
      releaseNotes: "",
      idempotencyKey: randomUUID(),
    });
    if (!published.ok) throw new Error(`publish failed: ${JSON.stringify(published.error)}`);

    const clone = await authoring.createDraft(ctx(owner), {
      source: { kind: "clone", versionId: published.value.versionId },
      idempotencyKey: randomUUID(),
    });
    expect(clone.ok).toBe(true);
    if (!clone.ok) throw new Error("unexpected");
    expect(clone.value.draft?.document.expressions.map((e) => e.id)).toEqual(
      d20Document.expressions.map((e) => e.id),
    );
    expect(clone.value.assessment.ok).toBe(true);
  });

  it("imports an exported package into a new draft and rejects invalid exports", async () => {
    const owner = await createUser("Ada");
    const imported = await authoring.createDraft(ctx(owner), {
      source: { kind: "import", content: JSON.stringify(d20Export) },
      idempotencyKey: randomUUID(),
    });
    expect(imported.ok).toBe(true);
    if (!imported.ok) throw new Error("unexpected");
    expect(imported.value.draft?.document.expressions.length).toBe(3);

    const invalid = await authoring.createDraft(ctx(owner), {
      source: { kind: "import", content: "not json" },
      idempotencyKey: randomUUID(),
    });
    expect(invalid.ok).toBe(false);
    if (invalid.ok) throw new Error("unexpected");
    expect(invalid.error.code).toBe("invalid_package");
    expect(invalid.error.diagnostics?.length).toBeGreaterThan(0);
  });

  it("scopes open and list to the owning actor and paginates", async () => {
    const owner = await createUser("Ada");
    const stranger = await createUser("Bob");
    const first = await authoring.createDraft(ctx(owner), {
      source: { kind: "blank", name: "Mine" },
      idempotencyKey: randomUUID(),
    });
    if (!first.ok) throw new Error("unexpected");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await authoring.createDraft(ctx(owner), {
      source: { kind: "blank", name: "Also Mine" },
      idempotencyKey: randomUUID(),
    });
    if (!second.ok) throw new Error("unexpected");
    const systemId = first.value.system.systemId;

    expect((await authoring.open(ctx(stranger), systemId)).ok).toBe(false);
    const opened = await authoring.open(ctx(owner), systemId);
    expect(opened.ok).toBe(true);
    expect(await authoring.open(ctx(owner), randomUUID())).toEqual({
      ok: false,
      error: { code: "not_found", message: "The requested resource does not exist." },
    });

    const page1 = await authoring.list(ctx(owner), { limit: 1, cursor: null });
    expect(page1.ok).toBe(true);
    if (!page1.ok) throw new Error("unexpected");
    expect(page1.value.systems).toHaveLength(1);
    expect(page1.value.nextCursor).not.toBeNull();

    const page2 = await authoring.list(ctx(owner), { limit: 1, cursor: page1.value.nextCursor });
    if (!page2.ok) throw new Error("unexpected");
    expect(page2.value.systems).toHaveLength(1);
    expect(page2.value.systems[0]?.systemId).not.toBe(page1.value.systems[0]?.systemId);
    expect(page2.value.nextCursor).toBeNull();

    const strangerPage = await authoring.list(ctx(stranger), { limit: 20, cursor: null });
    expect(strangerPage.ok).toBe(true);
    if (!strangerPage.ok) throw new Error("unexpected");
    expect(strangerPage.value.systems).toEqual([]);
  });

  it("saves drafts with an assessment, rejects structural garbage, and reports conflicts", async () => {
    const owner = await createUser("Ada");
    const created = await authoring.createDraft(ctx(owner), {
      source: { kind: "blank", name: "Save" },
      idempotencyKey: randomUUID(),
    });
    if (!created.ok) throw new Error("unexpected");
    const systemId = created.value.system.systemId;

    const saved = await authoring.saveDraft(ctx(owner), {
      systemId,
      expectedRevision: 1,
      document: d20Document,
    });
    expect(saved.ok).toBe(true);
    if (!saved.ok) throw new Error("unexpected");
    expect(saved.value.draft?.revision).toBe(2);
    expect(saved.value.assessment.ok).toBe(true);

    const stale = await authoring.saveDraft(ctx(owner), {
      systemId,
      expectedRevision: 1,
      document: d20Document,
    });
    expect(stale.ok).toBe(false);
    if (stale.ok) throw new Error("unexpected");
    expect(stale.error.code).toBe("conflict");
    expect(stale.error.latestRevision).toBe(2);

    const garbage = await authoring.saveDraft(ctx(owner), {
      systemId,
      expectedRevision: 2,
      document: { broken: true },
    });
    expect(garbage.ok).toBe(false);
    if (garbage.ok) throw new Error("unexpected");
    expect(garbage.error.code).toBe("invalid_package");
    const unchanged = await authoring.open(ctx(owner), systemId);
    if (!unchanged.ok) throw new Error("unexpected");
    expect(unchanged.value.draft?.revision).toBe(2);
  });

  it("saves a semantically invalid but structurally safe draft with failed assessment", async () => {
    const owner = await createUser("Ada");
    const created = await authoring.createDraft(ctx(owner), {
      source: { kind: "blank", name: "Broken" },
      idempotencyKey: randomUUID(),
    });
    if (!created.ok) throw new Error("unexpected");
    const broken = structuredClone(d20Document);
    broken.expressions.push({
      id: "broken_expr",
      context: "computed",
      resultType: "number",
      source: "fields.no_such_field + 1",
      fallback: 0,
    });
    const saved = await authoring.saveDraft(ctx(owner), {
      systemId: created.value.system.systemId,
      expectedRevision: 1,
      document: broken,
    });
    expect(saved.ok).toBe(true);
    if (!saved.ok) throw new Error("unexpected");
    expect(saved.value.assessment.ok).toBe(false);
    expect(saved.value.assessment.diagnostics.length).toBeGreaterThan(0);
  });

  it("previews the current draft and refuses invalid drafts", async () => {
    const owner = await createUser("Ada");
    const created = await authoring.createDraft(ctx(owner), {
      source: { kind: "blank", name: "Preview" },
      idempotencyKey: randomUUID(),
    });
    if (!created.ok) throw new Error("unexpected");
    const systemId = created.value.system.systemId;
    await authoring.saveDraft(ctx(owner), { systemId, expectedRevision: 1, document: d20Document });

    const preview = await authoring.previewDraft(ctx(owner), { systemId });
    expect(preview.ok).toBe(true);
    if (!preview.ok) throw new Error("unexpected");
    expect(preview.value.systemId).toBe(systemId);
    expect(preview.value.sourceRevision).toBe(2);
    expect(preview.value.package.integrity.checksum).toMatch(/^sha256:[0-9a-f]{64}$/);

    await authoring.saveDraft(ctx(owner), {
      systemId,
      expectedRevision: 2,
      document: { broken: true },
    });
    const invalid = await authoring.previewDraft(ctx(owner), { systemId });
    expect(invalid.ok).toBe(false);
    if (invalid.ok) throw new Error("unexpected");
    expect(invalid.error.code).toBe("invalid_package");
  });

  it("publishes an immutable version with audit, idempotency, and conflict handling", async () => {
    const owner = await createUser("Ada");
    const created = await authoring.createDraft(ctx(owner), {
      source: { kind: "blank", name: "Publish" },
      idempotencyKey: randomUUID(),
    });
    if (!created.ok) throw new Error("unexpected");
    const systemId = created.value.system.systemId;
    await authoring.saveDraft(ctx(owner), { systemId, expectedRevision: 1, document: d20Document });
    const key = randomUUID();

    const published = await authoring.publish(ctx(owner), {
      systemId,
      expectedRevision: 2,
      semanticVersion: "1.0.0",
      releaseNotes: "First",
      idempotencyKey: key,
    });
    expect(published.ok).toBe(true);
    if (!published.ok) throw new Error(`publish failed: ${JSON.stringify(published.error)}`);
    expect(published.value.semanticVersion).toBe("1.0.0");
    expect(published.value.package.integrity.checksum).toMatch(/^sha256:[0-9a-f]{64}$/);

    const replay = await authoring.publish(ctx(owner), {
      systemId,
      expectedRevision: 2,
      semanticVersion: "1.0.0",
      releaseNotes: "First",
      idempotencyKey: key,
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok || !published.ok) throw new Error("unexpected");
    expect(replay.value.versionId).toBe(published.value.versionId);

    const mismatch = await authoring.publish(ctx(owner), {
      systemId,
      expectedRevision: 2,
      semanticVersion: "1.0.0",
      releaseNotes: "Changed",
      idempotencyKey: key,
    });
    expect(mismatch).toEqual({
      ok: false,
      error: { code: "idempotency_mismatch", message: "This idempotency key was already used with different input." },
    });

    const duplicate = await authoring.publish(ctx(owner), {
      systemId,
      expectedRevision: 2,
      semanticVersion: "1.0.0",
      releaseNotes: "Again",
      idempotencyKey: randomUUID(),
    });
    expect(duplicate.ok).toBe(false);
    if (duplicate.ok) throw new Error("unexpected");
    expect(duplicate.error.code).toBe("conflict");

    const stale = await authoring.publish(ctx(owner), {
      systemId,
      expectedRevision: 1,
      semanticVersion: "1.1.0",
      releaseNotes: "",
      idempotencyKey: randomUUID(),
    });
    expect(stale.ok).toBe(false);
    if (stale.ok) throw new Error("unexpected");
    expect(stale.error.code).toBe("conflict");
    expect(stale.error.latestRevision).toBe(2);

    const badSemver = await authoring.publish(ctx(owner), {
      systemId,
      expectedRevision: 2,
      semanticVersion: "not-a-version",
      releaseNotes: "",
      idempotencyKey: randomUUID(),
    });
    expect(badSemver.ok).toBe(false);
    if (badSemver.ok) throw new Error("unexpected");
    expect(badSemver.error.code).toBe("bad_request");

    const audit = await repo.listAudit(systemId);
    expect(audit.some((r) => r.kind === "version_published")).toBe(true);
  });

  it("blocks publication from archived systems until restored", async () => {
    const owner = await createUser("Ada");
    const created = await authoring.createDraft(ctx(owner), {
      source: { kind: "blank", name: "Archive" },
      idempotencyKey: randomUUID(),
    });
    if (!created.ok) throw new Error("unexpected");
    const systemId = created.value.system.systemId;
    await authoring.saveDraft(ctx(owner), { systemId, expectedRevision: 1, document: d20Document });

    const archived = await authoring.changeLifecycle(ctx(owner), {
      kind: "system",
      systemId,
      lifecycle: "archived",
    });
    expect(archived).toEqual({ ok: true, value: { kind: "system", systemId, lifecycle: "archived" } });

    const blocked = await authoring.publish(ctx(owner), {
      systemId,
      expectedRevision: 2,
      semanticVersion: "1.0.0",
      releaseNotes: "",
      idempotencyKey: randomUUID(),
    });
    expect(blocked.ok).toBe(false);
    if (blocked.ok) throw new Error("unexpected");
    expect(blocked.error.code).toBe("conflict");

    const restored = await authoring.changeLifecycle(ctx(owner), { kind: "system", systemId, lifecycle: "active" });
    expect(restored.ok).toBe(true);

    const published = await authoring.publish(ctx(owner), {
      systemId,
      expectedRevision: 2,
      semanticVersion: "1.0.0",
      releaseNotes: "",
      idempotencyKey: randomUUID(),
    });
    expect(published.ok).toBe(true);
  });

  it("exports a published version and deprecates it", async () => {
    const owner = await createUser("Ada");
    const stranger = await createUser("Bob");
    const created = await authoring.createDraft(ctx(owner), {
      source: { kind: "blank", name: "Export" },
      idempotencyKey: randomUUID(),
    });
    if (!created.ok) throw new Error("unexpected");
    const systemId = created.value.system.systemId;
    await authoring.saveDraft(ctx(owner), { systemId, expectedRevision: 1, document: d20Document });
    const published = await authoring.publish(ctx(owner), {
      systemId,
      expectedRevision: 2,
      semanticVersion: "1.0.0",
      releaseNotes: "",
      idempotencyKey: randomUUID(),
    });
    if (!published.ok) throw new Error("unexpected");

    const exported = await authoring.exportVersion(ctx(owner), published.value.versionId);
    expect(exported.ok).toBe(true);
    if (!exported.ok) throw new Error("unexpected");
    expect(exported.value.package.integrity.checksum).toBe(published.value.package.integrity.checksum);
    expect(exported.value.mediaType).toBe("application/vnd.sweetroll.system+json;version=1");

    expect((await authoring.exportVersion(ctx(stranger), published.value.versionId)).ok).toBe(false);
    expect((await authoring.exportVersion(ctx(owner), randomUUID())).ok).toBe(false);

    const deprecated = await authoring.changeLifecycle(ctx(owner), {
      kind: "version",
      versionId: published.value.versionId,
      lifecycle: "deprecated",
    });
    expect(deprecated.ok).toBe(true);
    if (!deprecated.ok) throw new Error("unexpected");
    expect(deprecated.value).toMatchObject({
      kind: "version",
      versionId: published.value.versionId,
      lifecycle: "deprecated",
    });
  });
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `TEST_DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll npm run test:integration -- system-authoring.test.ts`

Expected: FAIL because `src/systems/authoring.js` exports no `createSystemAuthoringModule`.

- [x] **Step 3: Implement the Module**

Replace the contents of `src/systems/authoring.ts` with:

```typescript
import { randomUUID } from "node:crypto";

import {
  assessDocument,
  blankSystemDocument,
  documentChecksum,
  documentFromPackage,
  hashInput,
  type PackageAssessment,
} from "./implementation/authoring/assess.js";
import { decodeSystemExport } from "./implementation/package/codec.js";
import type { PackageDiagnostic } from "./implementation/package/diagnostics.js";
import type {
  SystemDocumentV1,
  SystemExportV1,
  SystemPackageV1,
} from "./implementation/package/schema/index.js";
import type {
  DraftRecord,
  SystemId,
  SystemPersistenceRepository,
  SystemRecord,
  UserId,
  VersionId,
  VersionRecord,
} from "./implementation/persistence/index.js";
import { compileDocument } from "./implementation/rules/compile-document.js";

export type Result<T> = { ok: true; value: T } | { ok: false; error: AppError };

export type AppErrorCode =
  | "bad_request"
  | "conflict"
  | "idempotency_mismatch"
  | "internal"
  | "invalid_package"
  | "not_found";

export type AppError = {
  code: AppErrorCode;
  message: string;
  latestRevision?: number | null;
  diagnostics?: PackageDiagnostic[];
};

export type RequestContext = {
  actorId: UserId;
  requestId: string;
};

export type SystemSummary = {
  systemId: SystemId;
  name: string;
  access: string;
  lifecycle: string;
  createdAt: Date;
  updatedAt: Date;
};

export type DraftView = {
  revision: number;
  document: SystemDocumentV1;
  sourceChecksum: string;
  updatedBy: UserId;
  updatedAt: Date;
};

export type VersionSummary = {
  versionId: VersionId;
  systemId: SystemId;
  semanticVersion: string;
  checksum: string;
  releaseNotes: string;
  lifecycle: string;
  createdAt: Date;
};

export type AuthoringWorkspace = {
  system: SystemSummary;
  draft: DraftView | null;
  versions: VersionSummary[];
  assessment: PackageAssessment;
};

export type ListSystemsResult = {
  systems: SystemSummary[];
  nextCursor: SystemId | null;
};

export type PreviewSnapshot = {
  snapshotId: string;
  systemId: SystemId;
  sourceRevision: number;
  package: SystemPackageV1;
  expiresAt: Date;
};

export type PublishedVersion = {
  versionId: VersionId;
  systemId: SystemId;
  semanticVersion: string;
  checksum: string;
  package: SystemPackageV1;
  releaseNotes: string;
  lifecycle: string;
  createdAt: Date;
};

export type ExportedPackage = SystemExportV1;

export type CreateDraftSource =
  | { kind: "blank"; name: string }
  | { kind: "clone"; versionId: VersionId }
  | { kind: "import"; content: string };

export type CreateDraftInput = {
  source: CreateDraftSource;
  idempotencyKey: string;
};

export type SaveDraftInput = {
  systemId: SystemId;
  expectedRevision: number | null;
  document: unknown;
};

export type PreviewDraftInput = {
  systemId: SystemId;
};

export type PublishDraftInput = {
  systemId: SystemId;
  expectedRevision: number;
  semanticVersion: string;
  releaseNotes: string;
  idempotencyKey: string;
};

export type LifecycleChangeInput =
  | { kind: "system"; systemId: SystemId; lifecycle: "active" | "archived" }
  | { kind: "version"; versionId: VersionId; lifecycle: "deprecated" };

export type LifecycleResult =
  | { kind: "system"; systemId: SystemId; lifecycle: string }
  | { kind: "version"; versionId: VersionId; systemId: SystemId; lifecycle: string };

export interface SystemAuthoring {
  createDraft(ctx: RequestContext, input: CreateDraftInput): Promise<Result<AuthoringWorkspace>>;
  open(ctx: RequestContext, systemId: SystemId): Promise<Result<AuthoringWorkspace>>;
  list(
    ctx: RequestContext,
    input: { limit: number; cursor: SystemId | null },
  ): Promise<Result<ListSystemsResult>>;
  saveDraft(ctx: RequestContext, input: SaveDraftInput): Promise<Result<AuthoringWorkspace>>;
  previewDraft(ctx: RequestContext, input: PreviewDraftInput): Promise<Result<PreviewSnapshot>>;
  publish(ctx: RequestContext, input: PublishDraftInput): Promise<Result<PublishedVersion>>;
  exportVersion(ctx: RequestContext, versionId: VersionId): Promise<Result<ExportedPackage>>;
  changeLifecycle(ctx: RequestContext, input: LifecycleChangeInput): Promise<Result<LifecycleResult>>;
}

const SEMANTIC_VERSION_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;
const PREVIEW_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PAGE_LIMIT = 20;
const MAX_PAGE_LIMIT = 100;
const NOT_FOUND_MESSAGE = "The requested resource does not exist.";
const MISMATCH_MESSAGE = "This idempotency key was already used with different input.";

export type CreateSystemAuthoringInput = {
  repo: SystemPersistenceRepository;
};

export function createSystemAuthoringModule(input: CreateSystemAuthoringInput): SystemAuthoring {
  const repo = input.repo;
  const now = () => new Date();

  const errors = {
    bad_request: (message: string): AppError => ({ code: "bad_request", message }),
    not_found: (message: string = NOT_FOUND_MESSAGE): AppError => ({ code: "not_found", message }),
    conflict: (message: string, latestRevision?: number | null): AppError => ({
      code: "conflict",
      message,
      ...(latestRevision === undefined ? {} : { latestRevision }),
    }),
    mismatch: (): AppError => ({ code: "idempotency_mismatch", message: MISMATCH_MESSAGE }),
    invalid_package: (diagnostics: PackageDiagnostic[]): AppError => ({
      code: "invalid_package",
      message: "The system package is invalid.",
      diagnostics,
    }),
    internal: (): AppError => ({ code: "internal", message: "An internal error occurred." }),
  };

  async function authorizeOwner(systemId: SystemId, actorId: UserId): Promise<SystemRecord | null> {
    const system = await repo.openSystem(systemId);
    if (system === null || system.ownerId !== actorId) return null;
    return system;
  }

  function summarize(system: SystemRecord): SystemSummary {
    return {
      systemId: system.systemId,
      name: system.name,
      access: system.access,
      lifecycle: system.lifecycle,
      createdAt: system.createdAt,
      updatedAt: system.updatedAt,
    };
  }

  function summarizeVersion(version: VersionRecord): VersionSummary {
    return {
      versionId: version.versionId,
      systemId: version.systemId,
      semanticVersion: version.semanticVersion,
      checksum: version.checksum,
      releaseNotes: version.releaseNotes,
      lifecycle: version.lifecycle,
      createdAt: version.createdAt,
    };
  }

  function toWorkspace(
    system: SystemRecord,
    draft: DraftRecord | null,
    versions: VersionRecord[],
    assessment: PackageAssessment,
  ): AuthoringWorkspace {
    return {
      system: summarize(system),
      draft:
        draft === null
          ? null
          : {
              revision: draft.revision,
              document: draft.document as SystemDocumentV1,
              sourceChecksum: draft.sourceChecksum,
              updatedBy: draft.updatedBy,
              updatedAt: draft.updatedAt,
            },
      versions: versions.map(summarizeVersion),
      assessment,
    };
  }

  async function receiptResult<T>(
    ctx: RequestContext,
    commandKind: string,
    key: string,
    inputHash: string,
  ): Promise<{ replayed: true; value: T } | { replayed: false } | { replayed: "mismatch" }> {
    const receipt = await repo.loadReceipt({ actorId: ctx.actorId, commandKind, key });
    if (receipt === null) return { replayed: false };
    if (receipt.inputHash !== inputHash) return { replayed: "mismatch" };
    return { replayed: true, value: receipt.result as T };
  }

  return {
    async createDraft(ctx, input) {
      try {
        const inputHash = hashInput(input.source);
        const receipt = await receiptResult<AuthoringWorkspace>(ctx, "system_create", input.idempotencyKey, inputHash);
        if (receipt.replayed === "mismatch") return { ok: false, error: errors.mismatch() };
        if (receipt.replayed === true) return { ok: true, value: receipt.value };

        let document: SystemDocumentV1;
        let name: string;
        if (input.source.kind === "blank") {
          document = blankSystemDocument(input.source.name);
          name = input.source.name;
        } else {
          let pkg: SystemPackageV1;
          if (input.source.kind === "clone") {
            const version = await repo.loadVersion(input.source.versionId);
            const sourceSystem =
              version === null ? null : await repo.openSystem(version.systemId);
            if (version === null || sourceSystem === null || sourceSystem.ownerId !== ctx.actorId) {
              return { ok: false, error: errors.not_found() };
            }
            pkg = version.package as SystemPackageV1;
          } else {
            const decoded = decodeSystemExport(input.source.content);
            if (!decoded.ok) return { ok: false, error: errors.invalid_package(decoded.diagnostics) };
            pkg = decoded.value.package;
          }
          document = documentFromPackage(pkg);
          name = document.metadata.name;
        }

        const system = await repo.createSystem({ ownerId: ctx.actorId, name });
        await repo.appendAudit({
          systemId: system.systemId,
          actorId: ctx.actorId,
          kind: "system_created",
          summary: "System created",
          requestId: ctx.requestId,
        });
        const saved = await repo.saveDraft({
          systemId: system.systemId,
          expectedRevision: null,
          document,
          sourceChecksum: documentChecksum(document),
          updatedBy: ctx.actorId,
          requestId: ctx.requestId,
        });
        if (!saved.ok) return { ok: false, error: errors.internal() };
        const versions = await repo.listVersions(system.systemId);
        const assessed = assessDocument(document);
        const workspace = toWorkspace(system, saved.draft, versions, assessed.assessment);
        await repo.recordReceipt({
          actorId: ctx.actorId,
          commandKind: "system_create",
          key: input.idempotencyKey,
          inputHash,
          result: workspace,
          expiresAt: new Date(now().getTime() + RECEIPT_TTL_MS),
        });
        return { ok: true, value: workspace };
      } catch {
        return { ok: false, error: errors.internal() };
      }
    },

    async open(ctx, systemId) {
      try {
        const system = await authorizeOwner(systemId, ctx.actorId);
        if (system === null) return { ok: false, error: errors.not_found() };
        const [draft, versions] = await Promise.all([
          repo.loadDraft(systemId),
          repo.listVersions(systemId),
        ]);
        const assessment =
          draft === null ? { ok: true, diagnostics: [] } : assessDocument(draft.document).assessment;
        return { ok: true, value: toWorkspace(system, draft, versions, assessment) };
      } catch {
        return { ok: false, error: errors.internal() };
      }
    },

    async list(ctx, input) {
      try {
        const limit = Math.trunc(input.limit);
        if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
          return {
            ok: false,
            error: errors.bad_request(`limit must be an integer from 1 through ${MAX_PAGE_LIMIT}.`),
          };
        }
        const page = await repo.listSystemsPage(ctx.actorId, { limit, cursor: input.cursor });
        return {
          ok: true,
          value: {
            systems: page.systems.map(summarize),
            nextCursor: page.nextCursor,
          },
        };
      } catch {
        return { ok: false, error: errors.internal() };
      }
    },

    async saveDraft(ctx, input) {
      try {
        const system = await authorizeOwner(input.systemId, ctx.actorId);
        if (system === null) return { ok: false, error: errors.not_found() };
        const assessed = assessDocument(input.document);
        if (assessed.document === null) {
          return { ok: false, error: errors.invalid_package(assessed.assessment.diagnostics) };
        }
        const saved = await repo.saveDraft({
          systemId: input.systemId,
          expectedRevision: input.expectedRevision,
          document: assessed.document,
          sourceChecksum: documentChecksum(assessed.document),
          updatedBy: ctx.actorId,
          requestId: ctx.requestId,
        });
        if (!saved.ok) {
          return {
            ok: false,
            error: errors.conflict("The draft was modified by another request.", saved.latestRevision),
          };
        }
        const versions = await repo.listVersions(input.systemId);
        return { ok: true, value: toWorkspace(system, saved.draft, versions, assessed.assessment) };
      } catch {
        return { ok: false, error: errors.internal() };
      }
    },

    async previewDraft(ctx, input) {
      try {
        const system = await authorizeOwner(input.systemId, ctx.actorId);
        if (system === null) return { ok: false, error: errors.not_found() };
        const draft = await repo.loadDraft(input.systemId);
        if (draft === null) return { ok: false, error: errors.not_found("The system has no draft to preview.") };
        const assessed = assessDocument(draft.document);
        if (!assessed.ok || assessed.document === null) {
          return { ok: false, error: errors.invalid_package(assessed.assessment.diagnostics) };
        }
        const compiled = compileDocument(assessed.document, {
          systemId: input.systemId,
          versionId: randomUUID(),
          semanticVersion: "0.0.0",
        });
        if (!compiled.ok) return { ok: false, error: errors.invalid_package(compiled.diagnostics) };
        const snapshot = await repo.createPreviewSnapshot({
          systemId: input.systemId,
          sourceRevision: draft.revision,
          package: compiled.value,
          expiresAt: new Date(now().getTime() + PREVIEW_TTL_MS),
        });
        return {
          ok: true,
          value: {
            snapshotId: snapshot.snapshotId,
            systemId: snapshot.systemId,
            sourceRevision: snapshot.sourceRevision,
            package: compiled.value,
            expiresAt: snapshot.expiresAt,
          },
        };
      } catch {
        return { ok: false, error: errors.internal() };
      }
    },

    async publish(ctx, input) {
      try {
        if (!SEMANTIC_VERSION_PATTERN.test(input.semanticVersion)) {
          return {
            ok: false,
            error: errors.bad_request("semanticVersion must be X.Y.Z with non-negative integers."),
          };
        }
        const system = await authorizeOwner(input.systemId, ctx.actorId);
        if (system === null) return { ok: false, error: errors.not_found() };
        if (system.lifecycle === "archived") {
          return { ok: false, error: errors.conflict("An archived system cannot publish versions.") };
        }

        const inputHash = hashInput({
          expectedRevision: input.expectedRevision,
          semanticVersion: input.semanticVersion,
          releaseNotes: input.releaseNotes,
        });
        const receipt = await receiptResult<PublishedVersion>(ctx, "system_publish", input.idempotencyKey, inputHash);
        if (receipt.replayed === "mismatch") return { ok: false, error: errors.mismatch() };
        if (receipt.replayed === true) return { ok: true, value: receipt.value };

        const draft = await repo.loadDraft(input.systemId);
        if (draft === null) return { ok: false, error: errors.not_found("The system has no draft to publish.") };
        if (draft.revision !== input.expectedRevision) {
          return {
            ok: false,
            error: errors.conflict("The draft was modified by another request.", draft.revision),
          };
        }
        const assessed = assessDocument(draft.document);
        if (!assessed.ok || assessed.document === null) {
          return { ok: false, error: errors.invalid_package(assessed.assessment.diagnostics) };
        }
        const compiled = compileDocument(assessed.document, {
          systemId: input.systemId,
          versionId: randomUUID(),
          semanticVersion: input.semanticVersion,
        });
        if (!compiled.ok) return { ok: false, error: errors.invalid_package(compiled.diagnostics) };

        const result = await repo.publishVersion({
          systemId: input.systemId,
          expectedRevision: draft.revision,
          sourceChecksum: draft.sourceChecksum,
          semanticVersion: input.semanticVersion,
          checksum: compiled.value.integrity.checksum,
          package: compiled.value,
          releaseNotes: input.releaseNotes,
          actorId: ctx.actorId,
          requestId: ctx.requestId,
        });
        if (!result.ok) {
          if (result.code === "stale_revision") {
            return {
              ok: false,
              error: errors.conflict("The draft was modified by another request.", result.latestRevision),
            };
          }
          return {
            ok: false,
            error: errors.conflict(
              "A version with this semantic version or identical content already exists for this system.",
            ),
          };
        }

        const published: PublishedVersion = {
          versionId: result.version.versionId,
          systemId: result.version.systemId,
          semanticVersion: result.version.semanticVersion,
          checksum: result.version.checksum,
          package: compiled.value,
          releaseNotes: result.version.releaseNotes,
          lifecycle: result.version.lifecycle,
          createdAt: result.version.createdAt,
        };
        await repo.recordReceipt({
          actorId: ctx.actorId,
          commandKind: "system_publish",
          key: input.idempotencyKey,
          inputHash,
          result: published,
          expiresAt: new Date(now().getTime() + RECEIPT_TTL_MS),
        });
        return { ok: true, value: published };
      } catch {
        return { ok: false, error: errors.internal() };
      }
    },

    async exportVersion(ctx, versionId) {
      try {
        const version = await repo.loadVersion(versionId);
        if (version === null) return { ok: false, error: errors.not_found() };
        const system = await repo.openSystem(version.systemId);
        if (system === null || system.ownerId !== ctx.actorId) return { ok: false, error: errors.not_found() };
        const exported: ExportedPackage = {
          schemaVersion: "1.0",
          mediaType: "application/vnd.sweetroll.system+json;version=1",
          exportedAt: new Date().toISOString(),
          package: version.package as SystemPackageV1,
        };
        return { ok: true, value: exported };
      } catch {
        return { ok: false, error: errors.internal() };
      }
    },

    async changeLifecycle(ctx, input) {
      try {
        if (input.kind === "system") {
          const system = await authorizeOwner(input.systemId, ctx.actorId);
          if (system === null) return { ok: false, error: errors.not_found() };
          const updated = await repo.updateSystemLifecycle(input.systemId, input.lifecycle);
          if (updated === null) return { ok: false, error: errors.not_found() };
          await repo.appendAudit({
            systemId: updated.systemId,
            actorId: ctx.actorId,
            kind: input.lifecycle === "archived" ? "system_archived" : "system_restored",
            summary: input.lifecycle === "archived" ? "System archived" : "System restored",
            requestId: ctx.requestId,
          });
          return {
            ok: true,
            value: { kind: "system" as const, systemId: updated.systemId, lifecycle: updated.lifecycle },
          };
        }
        const version = await repo.loadVersion(input.versionId);
        if (version === null) return { ok: false, error: errors.not_found() };
        const system = await repo.openSystem(version.systemId);
        if (system === null || system.ownerId !== ctx.actorId) return { ok: false, error: errors.not_found() };
        const updated = await repo.updateVersionLifecycle(input.versionId, input.lifecycle);
        if (updated === null) return { ok: false, error: errors.not_found() };
        await repo.appendAudit({
          systemId: updated.systemId,
          actorId: ctx.actorId,
          kind: "version_deprecated",
          summary: `Version ${updated.semanticVersion} deprecated`,
          requestId: ctx.requestId,
        });
        return {
          ok: true,
          value: {
            kind: "version" as const,
            versionId: updated.versionId,
            systemId: updated.systemId,
            lifecycle: updated.lifecycle,
          },
        };
      } catch {
        return { ok: false, error: errors.internal() };
      }
    },
  };
}
```

The Module requires an injected repository (process composition injects it; tests inject a real one built over the test pool).

- [x] **Step 4: Run the integration tests to verify they pass**

Run: `TEST_DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll npm run test:integration -- system-authoring.test.ts`

Expected: PASS with 11 tests. Debug failures inside the Module; do not weaken assertions.

- [x] **Step 5: Full gate and commit**

Run: `npm test && TEST_DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll npm run test:integration && npm run typecheck`

Expected: all PASS, exit 0.

```bash
git add src/systems/authoring.ts tests/integration/system-authoring.test.ts
git commit -m "feat: add SystemAuthoring module interface"
```

---

### Task 5: Revision-Safe HTTP Routes

Map the Module to versioned REST routes with one route per Module call, an authentication guard, and stable error mapping.

**Files:**
- Create: `src/transport/http/systems.ts`
- Create: `src/transport/http/systems.test.ts`
- Modify: `src/transport/http/index.ts`
- Modify: `src/bootstrap/http.ts`

**Interfaces:**
- Consumes: `SystemAuthoring` + public types from `src/systems/authoring.js`; `request.auth` (`AuthContext` from `auth-hook.ts`); fixture `d20Export`/`d20Package` for stub payloads.
- Produces: `buildSystemsRoutes(input: { authoring: SystemAuthoring }): FastifyPluginCallback` registering:
  - `POST /systems` → `createDraft` (201, body `{ source, idempotencyKey }`)
  - `GET /systems?limit=&cursor=` → `list`
  - `GET /systems/:systemId` → `open`
  - `PUT /systems/:systemId/draft` → `saveDraft` (body `{ expectedRevision, document }`)
  - `POST /systems/:systemId/preview` → `previewDraft`
  - `POST /systems/:systemId/publish` → `publish` (body `{ expectedRevision, semanticVersion, releaseNotes, idempotencyKey }`)
  - `PATCH /systems/:systemId` → `changeLifecycle` (body `{ lifecycle: "active" | "archived" }`)
  - `PATCH /system-versions/:versionId` → `changeLifecycle` (body `{ lifecycle: "deprecated" }`)
  - `GET /system-versions/:versionId/export` → `exportVersion` (content type `application/vnd.sweetroll.system+json;version=1`)

  Error mapping: `bad_request`→400, `not_found`→404, `conflict`→409, `idempotency_mismatch`→409, `invalid_package`→422, `internal`→500. Error body: `{ error: { code, message, ...details }, requestId }`. Every success response includes `requestId`. Unauthenticated requests get 401 `unauthorized`.

  Note: `GET /system-versions/{id}` from the design's representative route table is intentionally omitted — the Module Interface (§11.3) has no matching call; version summaries are available via `open` and the package via the export route.

- [x] **Step 1: Write the failing HTTP contract tests**

Create `src/transport/http/systems.test.ts`:

```typescript
import { randomUUID } from "node:crypto";

import cookie from "@fastify/cookie";
import Fastify, { type FastifyInstance } from "fastify";
import pino from "pino";
import { afterAll, describe, expect, it } from "vitest";

import { d20Export, d20Package } from "../../systems/implementation/package/fixtures/index.js";
import type {
  AuthoringWorkspace,
  PreviewSnapshot,
  PublishedVersion,
  SystemAuthoring,
} from "../../systems/authoring.js";
import type { AuthContext, Identity } from "../../identity/index.js";
import { buildAuthHook } from "./auth-hook.js";
import { buildSystemsRoutes } from "./systems.js";

const actorId = randomUUID();

const fakeIdentity: Identity = {
  completeSignIn: async () => {
    throw new Error("not used");
  },
  resolveSession: async (): Promise<AuthContext> => ({
    state: "authenticated",
    actorId,
    sessionId: randomUUID(),
  }),
  signOut: async () => ({ ok: true, value: undefined }),
} as unknown as Identity;

const workspace = (): AuthoringWorkspace => ({
  system: {
    systemId: randomUUID(),
    name: "Test",
    access: "private",
    lifecycle: "active",
    createdAt: new Date(0),
    updatedAt: new Date(0),
  },
  draft: null,
  versions: [],
  assessment: { ok: true, diagnostics: [] },
});

function makeAuthoring(overrides: Partial<SystemAuthoring> = {}): SystemAuthoring {
  const base: SystemAuthoring = {
    createDraft: async () => ({ ok: true, value: workspace() }),
    open: async () => ({ ok: true, value: workspace() }),
    list: async () => ({ ok: true, value: { systems: [], nextCursor: null } }),
    saveDraft: async () => ({ ok: true, value: workspace() }),
    previewDraft: async () => ({
      ok: true,
      value: {
        snapshotId: randomUUID(),
        systemId: randomUUID(),
        sourceRevision: 1,
        package: d20Package,
        expiresAt: new Date(Date.now() + 60_000),
      } satisfies PreviewSnapshot,
    }),
    publish: async () => ({
      ok: true,
      value: {
        versionId: randomUUID(),
        systemId: randomUUID(),
        semanticVersion: "1.0.0",
        checksum: d20Package.integrity.checksum,
        package: d20Package,
        releaseNotes: "",
        lifecycle: "published",
        createdAt: new Date(0),
      } satisfies PublishedVersion,
    }),
    exportVersion: async () => ({ ok: true, value: d20Export }),
    changeLifecycle: async () => ({
      ok: true,
      value: { kind: "system", systemId: randomUUID(), lifecycle: "archived" },
    }),
  };
  return { ...base, ...overrides };
}

async function build(authoring: SystemAuthoring): Promise<FastifyInstance> {
  const app = Fastify({ genReqId: () => randomUUID(), loggerInstance: pino({ enabled: false }) });
  await app.register(cookie);
  await app.register(
    buildAuthHook({ identity: fakeIdentity, cookieName: "session", secure: true, maxAgeSeconds: 3600 }),
  );
  await app.register(buildSystemsRoutes({ authoring }));
  await app.ready();
  return app;
}

describe("systems HTTP routes", () => {
  const apps: FastifyInstance[] = [];

  afterAll(async () => {
    for (const app of apps) await app.close();
  });

  it("rejects unauthenticated requests with 401", async () => {
    const app = Fastify({ loggerInstance: pino({ enabled: false }) });
    apps.push(app);
    await app.register(cookie);
    await app.register(
      buildAuthHook({
        identity: {
          ...fakeIdentity,
          resolveSession: async () => ({ state: "anonymous" }),
        } as unknown as Identity,
        cookieName: "session",
        secure: true,
        maxAgeSeconds: 3600,
      }),
    );
    await app.register(buildSystemsRoutes({ authoring: makeAuthoring() }));
    await app.ready();

    const response = await app.inject({ method: "GET", url: "/systems" });
    expect(response.statusCode).toBe(401);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("unauthorized");
    expect(response.headers["x-request-id"]).toBeDefined();
  });

  it("maps POST /systems to createDraft and returns 201", async () => {
    let received: unknown;
    const app = await build(
      makeAuthoring({
        createDraft: async (_ctx, input) => {
          received = input;
          return { ok: true, value: workspace() };
        },
      }),
    );
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/systems",
      headers: { cookie: "session=t" },
      payload: { source: { kind: "blank", name: "New" }, idempotencyKey: "key-1" },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().requestId).toBeDefined();
    expect(received).toEqual({ source: { kind: "blank", name: "New" }, idempotencyKey: "key-1" });
  });

  it("rejects an invalid create body with 400", async () => {
    const app = await build(makeAuthoring());
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/systems",
      headers: { cookie: "session=t" },
      payload: { source: { kind: "wat" }, idempotencyKey: "key-1" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("bad_request");
  });

  it("maps GET /systems to list and validates limit", async () => {
    let received: unknown;
    const app = await build(
      makeAuthoring({
        list: async (_ctx, input) => {
          received = input;
          return { ok: true, value: { systems: [], nextCursor: null } };
        },
      }),
    );
    apps.push(app);

    const ok = await app.inject({
      method: "GET",
      url: "/systems?limit=5&cursor=abc",
      headers: { cookie: "session=t" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ systems: [], nextCursor: null, requestId: expect.any(String) });
    expect(received).toEqual({ limit: 5, cursor: "abc" });

    const bad = await app.inject({
      method: "GET",
      url: "/systems?limit=999",
      headers: { cookie: "session=t" },
    });
    expect(bad.statusCode).toBe(400);
  });

  it("maps module errors to stable HTTP statuses", async () => {
    const app = await build(
      makeAuthoring({
        open: async () => ({ ok: false, error: { code: "not_found", message: "The requested resource does not exist." } }),
        saveDraft: async () => ({
          ok: false,
          error: { code: "conflict", message: "The draft was modified by another request.", latestRevision: 7 },
        }),
        publish: async () => ({
          ok: false,
          error: {
            code: "invalid_package",
            message: "The system package is invalid.",
            diagnostics: [{ code: "invalid_schema", path: "/metadata", message: "bad" }],
          },
        }),
      }),
    );
    apps.push(app);
    const headers = { cookie: "session=t" };

    const missing = await app.inject({ method: "GET", url: `/systems/${randomUUID()}`, headers });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("not_found");

    const conflict = await app.inject({
      method: "PUT",
      url: `/systems/${randomUUID()}/draft`,
      headers,
      payload: { expectedRevision: 1, document: {} },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.latestRevision).toBe(7);

    const invalid = await app.inject({
      method: "POST",
      url: `/systems/${randomUUID()}/publish`,
      headers,
      payload: { expectedRevision: 1, semanticVersion: "1.0.0", releaseNotes: "", idempotencyKey: "k" },
    });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json().error.diagnostics).toHaveLength(1);
  });

  it("maps preview, lifecycle, and export routes", async () => {
    const app = await build(makeAuthoring());
    apps.push(app);
    const headers = { cookie: "session=t" };

    const preview = await app.inject({ method: "POST", url: `/systems/${randomUUID()}/preview`, headers, payload: {} });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().snapshot.package.integrity.checksum).toBe(d20Package.integrity.checksum);

    const archive = await app.inject({
      method: "PATCH",
      url: `/systems/${randomUUID()}`,
      headers,
      payload: { lifecycle: "archived" },
    });
    expect(archive.statusCode).toBe(200);
    expect(archive.json().lifecycle.lifecycle).toBe("archived");

    const badLifecycle = await app.inject({
      method: "PATCH",
      url: `/systems/${randomUUID()}`,
      headers,
      payload: { lifecycle: "deleted" },
    });
    expect(badLifecycle.statusCode).toBe(400);

    const deprecate = await app.inject({
      method: "PATCH",
      url: `/system-versions/${randomUUID()}`,
      headers,
      payload: { lifecycle: "deprecated" },
    });
    expect(deprecate.statusCode).toBe(200);

    const badDeprecate = await app.inject({
      method: "PATCH",
      url: `/system-versions/${randomUUID()}`,
      headers,
      payload: { lifecycle: "published" },
    });
    expect(badDeprecate.statusCode).toBe(400);

    const exported = await app.inject({
      method: "GET",
      url: `/system-versions/${randomUUID()}/export`,
      headers,
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.headers["content-type"]).toContain("application/vnd.sweetroll.system+json");
    expect(exported.json().package.integrity.checksum).toBe(d20Package.integrity.checksum);
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/transport/http/systems.test.ts`

Expected: FAIL because `./systems.js` does not exist.

- [x] **Step 3: Implement the routes plugin**

Create `src/transport/http/systems.ts`:

```typescript
import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";

import type {
  AppError,
  CreateDraftSource,
  SystemAuthoring,
} from "../../systems/authoring.js";

export type BuildSystemsRoutesInput = {
  authoring: SystemAuthoring;
};

const STATUS_BY_CODE: Record<AppError["code"], number> = {
  bad_request: 400,
  not_found: 404,
  conflict: 409,
  idempotency_mismatch: 409,
  invalid_package: 422,
  internal: 500,
};

const badRequest = (message: string): AppError => ({ code: "bad_request", message });

function isValidSource(source: unknown): source is CreateDraftSource {
  if (typeof source !== "object" || source === null) return false;
  const candidate = source as Record<string, unknown>;
  if (candidate.kind === "blank") return typeof candidate.name === "string" && candidate.name.length > 0;
  if (candidate.kind === "clone") return typeof candidate.versionId === "string";
  if (candidate.kind === "import") return typeof candidate.content === "string";
  return false;
}

export const buildSystemsRoutes: (input: BuildSystemsRoutesInput) => FastifyPluginCallback =
  ({ authoring }) =>
  fp(async (app) => {
    app.addHook("preHandler", async (request, reply) => {
      if (request.auth.state !== "authenticated") {
        return reply.code(401).send({
          error: { code: "unauthorized", message: "Authentication is required." },
          requestId: request.id,
        });
      }
    });

    const ctxOf = (request: FastifyRequest) => ({
      actorId: request.auth.state === "authenticated" ? request.auth.actorId : "",
      requestId: request.id,
    });

    const sendError = (reply: FastifyReply, error: AppError, requestId: string) =>
      reply.code(STATUS_BY_CODE[error.code]).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.latestRevision === undefined ? {} : { latestRevision: error.latestRevision }),
          ...(error.diagnostics === undefined ? {} : { diagnostics: error.diagnostics }),
        },
        requestId,
      });

    app.post("/systems", async (request, reply) => {
      const body = request.body as { source?: unknown; idempotencyKey?: unknown } | undefined;
      if (
        body === undefined ||
        typeof body.idempotencyKey !== "string" ||
        body.idempotencyKey.length === 0 ||
        !isValidSource(body.source)
      ) {
        return sendError(reply, badRequest("The request body is invalid."), request.id);
      }
      const result = await authoring.createDraft(ctxOf(request), {
        source: body.source,
        idempotencyKey: body.idempotencyKey,
      });
      if (!result.ok) return sendError(reply, result.error, request.id);
      return reply.code(201).send({ workspace: result.value, requestId: request.id });
    });

    app.get("/systems", async (request, reply) => {
      const query = request.query as { limit?: string; cursor?: string } | undefined;
      const rawLimit = query?.limit;
      const limit = rawLimit === undefined ? 20 : Number(rawLimit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        return sendError(reply, badRequest("limit must be an integer from 1 through 100."), request.id);
      }
      const result = await authoring.list(ctxOf(request), { limit, cursor: query?.cursor ?? null });
      if (!result.ok) return sendError(reply, result.error, request.id);
      return { systems: result.value.systems, nextCursor: result.value.nextCursor, requestId: request.id };
    });

    app.get("/systems/:systemId", async (request, reply) => {
      const params = request.params as { systemId: string };
      const result = await authoring.open(ctxOf(request), params.systemId);
      if (!result.ok) return sendError(reply, result.error, request.id);
      return { workspace: result.value, requestId: request.id };
    });

    app.put("/systems/:systemId/draft", async (request, reply) => {
      const params = request.params as { systemId: string };
      const body = request.body as { expectedRevision?: unknown; document?: unknown } | undefined;
      if (
        body === undefined ||
        (typeof body.expectedRevision !== "number" && body.expectedRevision !== null) ||
        typeof body.document !== "object" ||
        body.document === null
      ) {
        return sendError(reply, badRequest("The request body is invalid."), request.id);
      }
      const result = await authoring.saveDraft(ctxOf(request), {
        systemId: params.systemId,
        expectedRevision: body.expectedRevision as number | null,
        document: body.document,
      });
      if (!result.ok) return sendError(reply, result.error, request.id);
      return { workspace: result.value, requestId: request.id };
    });

    app.post("/systems/:systemId/preview", async (request, reply) => {
      const params = request.params as { systemId: string };
      const result = await authoring.previewDraft(ctxOf(request), { systemId: params.systemId });
      if (!result.ok) return sendError(reply, result.error, request.id);
      return { snapshot: result.value, requestId: request.id };
    });

    app.post("/systems/:systemId/publish", async (request, reply) => {
      const params = request.params as { systemId: string };
      const body = request.body as
        | { expectedRevision?: unknown; semanticVersion?: unknown; releaseNotes?: unknown; idempotencyKey?: unknown }
        | undefined;
      if (
        body === undefined ||
        typeof body.expectedRevision !== "number" ||
        typeof body.semanticVersion !== "string" ||
        typeof body.releaseNotes !== "string" ||
        typeof body.idempotencyKey !== "string" ||
        body.idempotencyKey.length === 0
      ) {
        return sendError(reply, badRequest("The request body is invalid."), request.id);
      }
      const result = await authoring.publish(ctxOf(request), {
        systemId: params.systemId,
        expectedRevision: body.expectedRevision,
        semanticVersion: body.semanticVersion,
        releaseNotes: body.releaseNotes,
        idempotencyKey: body.idempotencyKey,
      });
      if (!result.ok) return sendError(reply, result.error, request.id);
      return { version: result.value, requestId: request.id };
    });

    app.patch("/systems/:systemId", async (request, reply) => {
      const params = request.params as { systemId: string };
      const body = request.body as { lifecycle?: unknown } | undefined;
      if (body === undefined || (body.lifecycle !== "active" && body.lifecycle !== "archived")) {
        return sendError(reply, badRequest("lifecycle must be active or archived."), request.id);
      }
      const result = await authoring.changeLifecycle(ctxOf(request), {
        kind: "system",
        systemId: params.systemId,
        lifecycle: body.lifecycle,
      });
      if (!result.ok) return sendError(reply, result.error, request.id);
      return { lifecycle: result.value, requestId: request.id };
    });

    app.patch("/system-versions/:versionId", async (request, reply) => {
      const params = request.params as { versionId: string };
      const body = request.body as { lifecycle?: unknown } | undefined;
      if (body === undefined || body.lifecycle !== "deprecated") {
        return sendError(reply, badRequest("lifecycle must be deprecated."), request.id);
      }
      const result = await authoring.changeLifecycle(ctxOf(request), {
        kind: "version",
        versionId: params.versionId,
        lifecycle: "deprecated",
      });
      if (!result.ok) return sendError(reply, result.error, request.id);
      return { lifecycle: result.value, requestId: request.id };
    });

    app.get("/system-versions/:versionId/export", async (request, reply) => {
      const params = request.params as { versionId: string };
      const result = await authoring.exportVersion(ctxOf(request), params.versionId);
      if (!result.ok) return sendError(reply, result.error, request.id);
      reply.header("content-type", "application/vnd.sweetroll.system+json;version=1");
      return result.value;
    });
  });
```

- [x] **Step 4: Export the plugin and wire the bootstrap process**

Replace `src/transport/http/index.ts` with:

```typescript
export { buildHttpApp } from "./app.js";
export { buildAuthHook } from "./auth-hook.js";
export { buildSystemsRoutes } from "./systems.js";
```

In `src/bootstrap/http.ts`, add imports and registration:

```typescript
import { createSystemAuthoringModule } from "../systems/authoring.js";
import { createSystemPersistenceRepository } from "../systems/implementation/persistence/index.js";
import { buildSystemsRoutes } from "../transport/http/index.js";
```

After the `identity` constant, add:

```typescript
const authoring = createSystemAuthoringModule({
  repo: createSystemPersistenceRepository(pool),
});
```

After `const app = buildHttpApp({...});`, before the shutdown handlers, add:

```typescript
void app.register(buildSystemsRoutes({ authoring }));
```

- [x] **Step 5: Run the HTTP tests to verify they pass**

Run: `npm test -- src/transport/http/systems.test.ts`

Expected: PASS with 5 tests.

- [x] **Step 6: Full gate and commit**

Run: `npm test && TEST_DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll npm run test:integration && npm run typecheck && npm run build`

Expected: all PASS, exit 0.

```bash
git add src/transport/http src/bootstrap/http.ts
git commit -m "feat: expose SystemAuthoring over revision-safe HTTP routes"
```

---

### Task 6: End-To-End Verification And Plan Completion

**Files:**
- Modify: `docs/superpowers/plans/2026-09-04-system-authoring.md` (this file — checkboxes)

- [x] **Step 1: Apply migrations to the local database**

Run: `docker compose up -d --wait postgres && DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll npm run migrate`

Expected: "database migrations complete" (migration `0003` applied exactly once).

- [x] **Step 2: Run the complete verification suite**

Run: `npm test && TEST_DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll npm run test:integration && npm run typecheck && npm run build`

Expected: every command exits 0. Unit tests ≥ 153, integration tests ≥ 31.

- [x] **Step 3: Review scope against I1 Task 7**

Confirm all of the following:

- `SystemAuthoring` exposes exactly the eight §11.3 methods through `src/systems/authoring.ts`.
- Creation handles blank, clone, and import sources; save returns the current package assessment.
- Draft save, preview, publish, export, and lifecycle routes each map to exactly one Module call.
- Publication rechecks revision and source checksum under lock and never updates an existing version (DB trigger enforces it).
- Authorization is enforced inside the Module; ownership violations collapse to `not_found`.
- Idempotency receipts cover create and publish; save relies on expected revision.
- No SystemRuntime behavior was added; `src/systems/runtime.ts` is untouched.
- Semantic-version ordering and breaking-change comparison remain unimplemented (I1 Task 8).

- [x] **Step 4: Mark the plan complete and commit**

Set every `- [ ]` in this file to `- [x]`, then:

```bash
git add docs/superpowers/plans/2026-09-04-system-authoring.md
git commit -m "docs: mark system authoring plan complete"
```
