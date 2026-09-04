# System Package Contract and Grammar v0.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver executable, versioned structural contracts, bounded codecs, canonical checksums, and license-neutral fixtures for editable system documents, immutable runtime packages, and portable exports.

**Architecture:** Keep package knowledge private under `src/systems/implementation/package/`. TypeBox schemas are the TypeScript source of truth, Ajv validates strict runtime shapes, relationship checks run in the codec, and RFC 8785 canonical JSON plus SHA-256 identifies immutable packages. Authoring source, compiled packages, and export envelopes remain separate types.

**Tech Stack:** Node 24, TypeScript 5.9 in strict NodeNext mode, TypeBox 0.34.52, Ajv 8.20.0, json-canonicalize 3.0.0, Node `node:crypto`, Vitest 3.

**Spec:** `docs/superpowers/specs/2026-09-04-system-package-contract-design.md`

## Global Constraints

- Do not expose parser, validator, canonicalizer, or persistence interfaces from `src/systems/authoring.ts` or `src/systems/runtime.ts`.
- Every root contract has literal `schemaVersion: "1.0"`; all objects reject unknown properties.
- Definition IDs match `^[a-z][a-z0-9_]{0,63}$` and are globally unique within one document/package.
- Raw JSON input is rejected above 1 MiB before parsing.
- Expression ceilings are 1,024 UTF-8 bytes, 256 AST nodes, and depth 32.
- Roll ceilings are 100 dice and 1,000 sides per die; package limits may lower but never raise these values.
- Collection ceilings are 32 entities, 512 total fields, 64 reference datasets, 1,000 records per dataset, 64 values per record, 32 sheets, 64 sections per sheet, 1,024 total sheet elements, 256 actions, 256 validations, and 1,024 expressions.
- Caller-controlled invalid input returns ordered diagnostics and does not throw.
- Canonical serialization follows RFC 8785; checksum format is `sha256:<64 lowercase hex>` and omits only `integrity.checksum` from its input.
- Fixtures are original capability models and must not reproduce protected game text or claim launch-template licensing.
- Follow the existing strict compiler options, including `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, and `noUnusedLocals`.

---

### Task 1: Contract Dependencies, Limits, and Editable Document Schema

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/systems/implementation/package/limits.ts`
- Create: `src/systems/implementation/package/schema/common.ts`
- Create: `src/systems/implementation/package/schema/document.ts`
- Create: `src/systems/implementation/package/schema/document.test.ts`

**Interfaces:**
- Consumes: TypeBox `Type` and `Static`.
- Produces: `PACKAGE_LIMITS`, `DefinitionIdSchema`, `ScalarValueSchema`, `SystemDocumentV1Schema`, `SystemDocumentV1`, and all document component schemas/types used in Task 2.

- [ ] **Step 1: Install the pinned runtime dependencies**

Run:

```bash
npm install @sinclair/typebox@0.34.52 ajv@8.20.0 json-canonicalize@3.0.0
```

Expected: `package.json` and `package-lock.json` list all three under `dependencies` with exact versions.

- [ ] **Step 2: Write the failing document-schema tests**

Create `src/systems/implementation/package/schema/document.test.ts` with a minimal valid document factory and these assertions:

```typescript
import Ajv from "ajv";
import { describe, expect, it } from "vitest";

import { PACKAGE_LIMITS } from "../limits.js";
import { SystemDocumentV1Schema, type SystemDocumentV1 } from "./document.js";

const validate = new Ajv({ allErrors: true, strict: true }).compile(SystemDocumentV1Schema);

function document(): SystemDocumentV1 {
  return {
    schemaVersion: "1.0",
    metadata: { name: "Pocket Quest", description: "Original fixture", language: "en", defaultDice: "d20" },
    entities: [{ id: "character", label: "Character", fields: [
      { kind: "integer", id: "modifier", label: "Modifier", default: 0, required: true, min: -10, max: 20, step: 1 },
      { kind: "resource", id: "health", label: "Health", default: { current: 6, max: 6 }, min: 0, max: 20, step: 1, resetTo: "max" },
      { kind: "computed", id: "defense", label: "Defense", valueType: "number", expressionId: "defense_expr" },
    ] }],
    referenceData: [],
    sheets: [{ id: "character_sheet", label: "Character", targetEntityId: "character", sections: [{ id: "main", label: "Main", elements: [
      { kind: "field", id: "modifier_element", fieldId: "modifier" },
      { kind: "resource", id: "health_element", resourceId: "health" },
      { kind: "action", id: "check_element", actionId: "check" },
    ] }] }],
    expressions: [
      { id: "defense_expr", context: "computed", resultType: "number", source: "10 + fields.modifier", fallback: 10 },
      { id: "check_expr", context: "roll", resultType: "number", source: "d20 + fields.modifier + inputs.bonus", fallback: 0 },
      { id: "health_valid_expr", context: "validation", resultType: "boolean", source: "fields.health >= 0", fallback: false },
    ],
    actions: [
      { kind: "roll", id: "check", label: "Check", expressionId: "check_expr", inputs: [{ id: "bonus", label: "Bonus", valueType: "integer", required: false, default: 0 }], outputTemplate: "Result: {total}" },
      { kind: "resourceBump", id: "heal", label: "Heal", resourceId: "health", operation: { kind: "delta", amount: 1 } },
    ],
    validations: [{ id: "health_valid", expressionId: "health_valid_expr", severity: "error", message: "Health must be non-negative", targetId: "health" }],
  };
}

describe("SystemDocumentV1Schema", () => {
  it("accepts the editable v1 document and every represented tagged variant", () => {
    expect(validate(document())).toBe(true);
  });

  it.each([
    ["unknown root property", { ...document(), extra: true }],
    ["bad schema version", { ...document(), schemaVersion: "2.0" }],
    ["malformed definition id", { ...document(), entities: [{ ...document().entities[0], id: "Bad-ID" }] }],
  ])("rejects %s", (_name, value) => {
    expect(validate(value)).toBe(false);
  });

  it("rejects an expression over the byte ceiling", () => {
    const value = document();
    value.expressions[0] = { ...value.expressions[0]!, source: "x".repeat(PACKAGE_LIMITS.expressionBytes + 1) };
    expect(validate(value)).toBe(false);
  });
});
```

Extend the accepted fixture in the same test with one instance of each remaining field kind (`text`, `decimal`, `boolean`, `singleChoice`, `multiChoice`, `image`), heading sheet element, reset resource action, warning validation, and string/boolean expression fallback. Assert the complete fixture validates.

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- src/systems/implementation/package/schema/document.test.ts`

Expected: FAIL because `limits.ts` and `schema/document.ts` do not exist.

- [ ] **Step 4: Add exact platform limits and common schemas**

Create `limits.ts`:

```typescript
export const PACKAGE_LIMITS = {
  actions: 256,
  dicePerRoll: 100,
  encodedBytes: 1024 * 1024,
  entities: 32,
  expressionAstDepth: 32,
  expressionAstNodes: 256,
  expressionBytes: 1024,
  expressions: 1024,
  fields: 512,
  referenceDataSets: 64,
  referenceRecordValues: 64,
  referenceRecordsPerSet: 1000,
  sectionsPerSheet: 64,
  sheetElements: 1024,
  sheets: 32,
  sidesPerDie: 1000,
  validations: 256,
} as const;
```

Create `schema/common.ts`:

```typescript
import { Type, type Static } from "@sinclair/typebox";

export const DefinitionIdSchema = Type.String({ pattern: "^[a-z][a-z0-9_]{0,63}$" });
export type DefinitionId = Static<typeof DefinitionIdSchema>;

export const ScalarValueSchema = Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]);
export type ScalarValue = Static<typeof ScalarValueSchema>;

export const ValueTypeSchema = Type.Union([
  Type.Literal("number"), Type.Literal("text"), Type.Literal("boolean"),
]);
export type ValueType = Static<typeof ValueTypeSchema>;
```

- [ ] **Step 5: Implement the editable document schema**

Create `schema/document.ts`. Build every object with `{ additionalProperties: false }` and export its `Static` type. Use these exact discriminators and properties:

```typescript
type FieldV1 =
  | { kind: "text"; id: string; label: string; default: string; required: boolean; minLength: number; maxLength: number }
  | { kind: "integer" | "decimal"; id: string; label: string; default: number; required: boolean; min: number; max: number; step: number }
  | { kind: "boolean"; id: string; label: string; default: boolean; required: boolean }
  | { kind: "singleChoice"; id: string; label: string; required: boolean; default: string | null; options: ChoiceOptionV1[] }
  | { kind: "multiChoice"; id: string; label: string; required: boolean; default: string[]; options: ChoiceOptionV1[] }
  | { kind: "resource"; id: string; label: string; default: { current: number; max: number }; min: number; max: number; step: number; resetTo: "min" | "max" }
  | { kind: "computed"; id: string; label: string; valueType: "number" | "text" | "boolean"; expressionId: string }
  | { kind: "image"; id: string; label: string; required: boolean };

type SheetElementV1 =
  | { kind: "heading"; id: string; text: string; level: 2 | 3 }
  | { kind: "field"; id: string; fieldId: string }
  | { kind: "resource"; id: string; resourceId: string }
  | { kind: "action"; id: string; actionId: string };

type ActionV1 =
  | { kind: "roll"; id: string; label: string; expressionId: string; inputs: ActionInputV1[]; outputTemplate: string }
  | { kind: "resourceBump"; id: string; label: string; resourceId: string; operation: { kind: "delta"; amount: number } | { kind: "reset" } };
```

Also define the following exact containers:

- `EntityDefinitionV1`: `id`, `label`, and `fields` capped at 512 per entity; the codec enforces the cross-entity total.
- `ReferenceDataV1`: `id`, `label`, and up to 1,000 records; each record has `id`, `label`, and a `values` record capped at 64 scalar properties.
- `SheetV1`: `id`, `label`, `targetEntityId`, and up to 64 sections; each section has `id`, `label`, and ordered elements.
- `SourceExpressionV1`: `id`, `context` (`computed`, `roll`, or `validation`), `resultType`, `source` capped at 1,024 JavaScript characters, and scalar `fallback`. The codec performs the exact UTF-8 byte check.
- `ActionInputV1`: `id`, `label`, `valueType` (`integer`, `decimal`, `boolean`, or `text`), `required`, and scalar `default`.
- `ValidationV1`: `id`, `expressionId`, severity (`error` or `warning`), `message`, and `targetId`.
- `SystemDocumentV1Schema`: root metadata and collections capped by `PACKAGE_LIMITS`.

Use finite `Type.Number()` values; Ajv rejects JSON representations of non-finite numbers. Cap labels at 120 characters, descriptions/messages/output templates at 2,000, and ordinary text/default strings at 10,000.

- [ ] **Step 6: Run the document tests and typecheck**

Run: `npm test -- src/systems/implementation/package/schema/document.test.ts`

Expected: PASS with all document shape cases.

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/systems/implementation/package/limits.ts src/systems/implementation/package/schema/common.ts src/systems/implementation/package/schema/document.ts src/systems/implementation/package/schema/document.test.ts
git commit -m "feat: define editable system document contract"
```

---

### Task 2: Compiled Expression, Package, and Export Schemas

**Files:**
- Create: `src/systems/implementation/package/schema/expression.ts`
- Create: `src/systems/implementation/package/schema/package.ts`
- Create: `src/systems/implementation/package/schema/export.ts`
- Create: `src/systems/implementation/package/schema/index.ts`
- Create: `src/systems/implementation/package/schema/test-values.ts`
- Create: `src/systems/implementation/package/schema/package.test.ts`

**Interfaces:**
- Consumes: document component schemas from Task 1.
- Produces: `ExpressionAstV1Schema`, `CompiledExpressionV1Schema`, `SystemPackageV1Schema`, `SystemPackageV1`, `UnsignedSystemPackageV1`, `SystemExportV1Schema`, `SystemExportV1`, and one schema barrel.

- [ ] **Step 1: Write the failing compiled-contract tests**

Create `schema/package.test.ts`. Build a minimal package with metadata IDs `00000000-0000-4000-8000-000000000001` and `00000000-0000-4000-8000-000000000002`, one entity/field, one sheet, and these compiled expressions:

```typescript
const expressions = [
  { id: "literal_expr", resultType: "number", inferredType: "number", fallback: 0, dependencies: [], cost: 1, ast: { kind: "numberLiteral", value: 1 } },
  { id: "reference_expr", resultType: "number", inferredType: "number", fallback: 0, dependencies: ["modifier"], cost: 1, ast: { kind: "reference", scope: "fields", id: "modifier" } },
  { id: "binary_expr", resultType: "number", inferredType: "number", fallback: 0, dependencies: ["modifier"], cost: 3, ast: { kind: "binary", operator: "+", left: { kind: "numberLiteral", value: 10 }, right: { kind: "reference", scope: "fields", id: "modifier" } } },
  { id: "pool_expr", resultType: "number", inferredType: "number", fallback: 0, dependencies: ["attribute", "skill"], cost: 7, ast: { kind: "successCount", dice: { kind: "dice", count: { kind: "binary", operator: "+", left: { kind: "reference", scope: "fields", id: "attribute" }, right: { kind: "reference", scope: "fields", id: "skill" } }, sides: 6 }, threshold: 6 } },
];
```

Add valid instances of string/boolean literals, unary, `min`/`max`/`round` calls, static dice, keep-high, keep-low, and input references. Assert Ajv accepts the package and an export envelope. Assert rejection for an unknown AST kind, `sides: 1001`, AST cost 257, malformed checksum, account-shaped export property `ownerId`, and media type other than `application/vnd.sweetroll.system+json;version=1`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/systems/implementation/package/schema/package.test.ts`

Expected: FAIL because the compiled schemas do not exist.

- [ ] **Step 3: Implement the recursive AST schema**

Create `schema/expression.ts` with `Type.Recursive`. Use this exact AST union:

```typescript
type ExpressionAstV1 =
  | { kind: "numberLiteral"; value: number }
  | { kind: "stringLiteral"; value: string }
  | { kind: "booleanLiteral"; value: boolean }
  | { kind: "reference"; scope: "fields" | "inputs"; id: DefinitionId }
  | { kind: "unary"; operator: "-" | "!"; operand: ExpressionAstV1 }
  | { kind: "binary"; operator: "+" | "-" | "*" | "/" | "==" | "!=" | "<" | "<=" | ">" | ">=" | "&&" | "||"; left: ExpressionAstV1; right: ExpressionAstV1 }
  | { kind: "call"; function: "min" | "max" | "round"; arguments: ExpressionAstV1[]; roundMode?: "nearest" | "down" | "up" }
  | { kind: "dice"; count: ExpressionAstV1; sides: number }
  | { kind: "keep"; mode: "highest" | "lowest"; count: number; dice: ExpressionAstV1 }
  | { kind: "successCount"; dice: ExpressionAstV1; threshold: number };
```

Require integer `sides`, keep `count`, and success threshold. Bound sides and keep count with `PACKAGE_LIMITS`; bound call arguments to 2. Define `CompiledExpressionV1` exactly as tested, with dependencies capped at 1,024 and cost capped at 256. AST node count/depth are relationship checks in Task 3 because JSON Schema cannot express them reliably.

- [ ] **Step 4: Implement package and export schemas**

Create `schema/package.ts` by reusing Task 1 component schemas. `SystemPackageV1` has root `schemaVersion`, published metadata (`systemId`, `versionId`, `semanticVersion`, `name`, `description`, `language`, `defaultDice`), document collections, compiled expressions, effective limits, and `integrity: { checksum }`. UUIDs use pattern `^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`; semantic versions use `^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`; checksums use `^sha256:[0-9a-f]{64}$`.

Use this exact effective-limit shape, with each value an integer from 1 through its corresponding platform ceiling:

```typescript
type EffectivePackageLimitsV1 = {
  expressionBytes: number;
  expressionAstNodes: number;
  expressionAstDepth: number;
  dicePerRoll: number;
  sidesPerDie: number;
};
```

Export:

```typescript
export type UnsignedSystemPackageV1 = Omit<SystemPackageV1, "integrity">;

type SystemExportV1 = {
  schemaVersion: "1.0";
  mediaType: "application/vnd.sweetroll.system+json;version=1";
  exportedAt: string;
  provenance?: { sourceUrl?: string; license?: string };
  package: SystemPackageV1;
};
```

Use UTC timestamp pattern `^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{3})?Z$`; do not use Ajv format plugins. Create `schema/index.ts` that exports schemas and types from `common.ts`, `document.ts`, `expression.ts`, `package.ts`, and `export.ts`.

Move the valid document factory from Task 1's test into `schema/test-values.ts`, and add `validUnsignedPackage()` and `validSignedShapePackage()` factories. The signed-shape factory uses `sha256:` followed by 64 zeroes; it is schema-valid but is not treated as integrity-verified until Task 4. Keep this helper out of `schema/index.ts` so production code cannot import test values accidentally.

- [ ] **Step 5: Run compiled-contract tests and typecheck**

Run: `npm test -- src/systems/implementation/package/schema/package.test.ts`

Expected: PASS.

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/systems/implementation/package/schema/
git commit -m "feat: define compiled system package contracts"
```

---

### Task 3: Bounded Decode and Structural Diagnostics

**Files:**
- Create: `src/systems/implementation/package/diagnostics.ts`
- Create: `src/systems/implementation/package/structural.ts`
- Create: `src/systems/implementation/package/codec.ts`
- Create: `src/systems/implementation/package/codec.test.ts`
- Modify: `src/systems/implementation/package/index.ts`

**Interfaces:**
- Consumes: all Task 1-2 schemas and types.
- Produces: `PackageDiagnostic`, `DecodeResult<T>`, `decodeSystemDocument(input: unknown)`, `decodeSystemPackage(input: unknown)`, and `decodeSystemExport(input: unknown)`.

- [ ] **Step 1: Write failing codec tests**

Create `codec.test.ts` using the valid document factory from `schema/test-values.ts`. Test these exact outcomes:

```typescript
expect(decodeSystemDocument(validDocument)).toEqual({ ok: true, value: validDocument });
expect(decodeSystemDocument(new TextEncoder().encode(JSON.stringify(validDocument))).ok).toBe(true);
expect(decodeSystemDocument("{" )).toEqual({
  ok: false,
  diagnostics: [{ code: "invalid_json", path: "", message: "Input is not valid JSON." }],
});
expect(decodeSystemDocument(new Uint8Array(PACKAGE_LIMITS.encodedBytes + 1))).toEqual({
  ok: false,
  diagnostics: [{ code: "document_too_large", path: "", message: "Input exceeds 1048576 bytes." }],
});
```

Add cases for invalid UTF-8, unknown property (`invalid_schema` with an RFC 6901 path), multibyte expression source over 1,024 bytes (`limit_exceeded`), 513 total fields, 1,025 total sheet elements, duplicate IDs in different definition kinds, missing sheet field/action/resource targets, missing resource-bump target, package AST over 256 nodes, AST depth 33, and package effective limit above a platform ceiling. Assert multiple diagnostics are ordered by `path`, then `code`.

- [ ] **Step 2: Run the codec test to verify it fails**

Run: `npm test -- src/systems/implementation/package/codec.test.ts`

Expected: FAIL because `codec.ts` does not exist.

- [ ] **Step 3: Define diagnostics and Ajv mapping**

Create `diagnostics.ts`:

```typescript
export type PackageDiagnosticCode =
  | "checksum_mismatch"
  | "document_too_large"
  | "duplicate_definition_id"
  | "invalid_definition_id"
  | "invalid_json"
  | "invalid_schema"
  | "limit_exceeded"
  | "missing_reference";

export type PackageDiagnostic = { code: PackageDiagnosticCode; path: string; message: string };
export type DecodeResult<T> = { ok: true; value: T } | { ok: false; diagnostics: PackageDiagnostic[] };

export function sortDiagnostics(values: PackageDiagnostic[]): PackageDiagnostic[] {
  return values.toSorted((a, b) => a.path.localeCompare(b.path) || a.code.localeCompare(b.code));
}
```

Map Ajv's `instancePath` to JSON Pointer. For `required`, append the escaped missing property; for `additionalProperties`, append the escaped extra property. Map ID-pattern failures to `invalid_definition_id`; all other Ajv failures use `invalid_schema`. Deduplicate equal code/path pairs.

- [ ] **Step 4: Implement relationship and budget checks**

Create `structural.ts` with one private traversal shared by documents and packages. It must:

- collect every ID and report every occurrence after the first as `duplicate_definition_id`;
- resolve sheet target entities, field/resource/action elements, computed expression IDs, roll expression IDs, validation expression/target IDs, and resource-bump targets;
- require resource targets to refer to `kind: "resource"` fields;
- count fields and sheet elements across parent arrays;
- use `Buffer.byteLength(source, "utf8")` for expression source limits;
- walk each package AST iteratively, count every node, and track depth without recursion;
- reject effective package limits above `PACKAGE_LIMITS`; and
- produce exact JSON Pointer paths to the offending property.

Do not check expression operand types, expression dependency existence, semantic-version compatibility, or authoring policy in this file.

- [ ] **Step 5: Implement the bounded codecs**

Create `codec.ts`. Compile each schema once at module initialization with `new Ajv({ allErrors: true, strict: true })`. For string/`Uint8Array` input:

1. calculate bytes and return `document_too_large` before decoding/parsing;
2. decode bytes with `new TextDecoder("utf-8", { fatal: true })`;
3. catch decode/`JSON.parse` failure and return `invalid_json`;
4. run the matching Ajv validator;
5. run structural checks only after shape validation; and
6. return a deep-cloned typed value using `structuredClone` so later caller mutation cannot alter validator-owned state.

For object input, start at step 4. `decodeSystemPackage` verifies structural limits but checksum verification is added by Task 4. `decodeSystemExport` validates its envelope, calls package structural checks, then Task 4 will add checksum verification.

Update `package/index.ts` to export only the three codecs and their input/output types needed by sibling systems implementation code. Do not export Ajv, schemas, or structural helpers from this package-level barrel.

- [ ] **Step 6: Run codec and package tests**

Run: `npm test -- src/systems/implementation/package/codec.test.ts src/systems/implementation/package/schema/`

Expected: PASS.

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/systems/implementation/package/
git commit -m "feat: decode bounded system package contracts"
```

---

### Task 4: Canonical Serialization and Package Integrity

**Files:**
- Create: `src/systems/implementation/package/canonical.ts`
- Create: `src/systems/implementation/package/canonical.test.ts`
- Modify: `src/systems/implementation/package/codec.ts`
- Modify: `src/systems/implementation/package/codec.test.ts`
- Modify: `src/systems/implementation/package/schema/test-values.ts`
- Modify: `src/systems/implementation/package/index.ts`

**Interfaces:**
- Consumes: `UnsignedSystemPackageV1`, `SystemPackageV1`, and structural package validation.
- Produces: `canonicalizePackage`, `calculatePackageChecksum`, `signSystemPackage`, and checksum verification inside package/export decode.

- [ ] **Step 1: Write failing canonicalization tests**

Create `canonical.test.ts` around a valid unsigned package:

```typescript
const signed = signSystemPackage(unsignedPackage);
expect(signed.integrity.checksum).toMatch(/^sha256:[0-9a-f]{64}$/);
expect(calculatePackageChecksum(signed)).toBe(signed.integrity.checksum);

const reordered = { ...signed, metadata: { language: "en", name: signed.metadata.name, description: signed.metadata.description, defaultDice: signed.metadata.defaultDice, semanticVersion: signed.metadata.semanticVersion, versionId: signed.metadata.versionId, systemId: signed.metadata.systemId } };
expect(calculatePackageChecksum(reordered)).toBe(signed.integrity.checksum);

const reversed = { ...signed, sheets: signed.sheets.toReversed() };
expect(calculatePackageChecksum(reversed)).not.toBe(signed.integrity.checksum);
```

Also assert `canonicalizePackage` is stable, signing does not mutate its input, changing a nested value changes the checksum, `decodeSystemPackage` accepts signed data, and package/export codecs return one `checksum_mismatch` diagnostic at `/integrity/checksum` or `/package/integrity/checksum` after tampering.

- [ ] **Step 2: Run integrity tests to verify they fail**

Run: `npm test -- src/systems/implementation/package/canonical.test.ts`

Expected: FAIL because `canonical.ts` does not exist.

- [ ] **Step 3: Implement RFC 8785 checksum helpers**

Create `canonical.ts`:

```typescript
import { createHash } from "node:crypto";
import { canonicalize } from "json-canonicalize";

import type { SystemPackageV1, UnsignedSystemPackageV1 } from "./schema/index.js";

function checksumInput(value: SystemPackageV1 | UnsignedSystemPackageV1): unknown {
  return { ...value, integrity: {} };
}

export function canonicalizePackage(value: SystemPackageV1 | UnsignedSystemPackageV1): string {
  return canonicalize(checksumInput(value));
}

export function calculatePackageChecksum(value: SystemPackageV1 | UnsignedSystemPackageV1): string {
  return `sha256:${createHash("sha256").update(canonicalizePackage(value), "utf8").digest("hex")}`;
}

export function signSystemPackage(value: UnsignedSystemPackageV1): SystemPackageV1 {
  const unsigned = structuredClone(value);
  return { ...unsigned, integrity: { checksum: calculatePackageChecksum(unsigned) } };
}
```

- [ ] **Step 4: Verify integrity in codecs**

After schema and structural validation, compare `calculatePackageChecksum(value)` to `value.integrity.checksum`. Add `checksum_mismatch` without exposing either checksum value. For an export, prefix package diagnostic paths with `/package`. Export `signSystemPackage` from package `index.ts`; keep raw checksum/canonical helpers private to this implementation directory.

Add `validSignedPackage()` to `schema/test-values.ts` by passing `validUnsignedPackage()` to `signSystemPackage`. Update codec success cases to use that helper; retain `validSignedShapePackage()` only in pure schema tests where checksum semantics are intentionally not evaluated.

- [ ] **Step 5: Run all package tests and typecheck**

Run: `npm test -- src/systems/implementation/package/`

Expected: PASS.

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/systems/implementation/package/
git commit -m "feat: add canonical system package integrity"
```

---

### Task 5: Reference Fixtures and Contract Documentation

**Files:**
- Create: `src/systems/implementation/package/fixtures/d20.ts`
- Create: `src/systems/implementation/package/fixtures/pbta-2d6.ts`
- Create: `src/systems/implementation/package/fixtures/d6-success-pool.ts`
- Create: `src/systems/implementation/package/fixtures/fixtures.test.ts`
- Create: `scripts/generate-system-contracts.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `docs/contracts/system-document-v1.schema.json`
- Create: `docs/contracts/system-package-v1.schema.json`
- Create: `docs/contracts/system-export-v1.schema.json`
- Create: `docs/contracts/grammar-v0.1.md`
- Create: `docs/contracts/capability-matrix-v0.1.md`
- Create: `docs/contracts/examples/d20-system-export-v1.json`

**Interfaces:**
- Consumes: schemas, codecs, and `signSystemPackage` from Tasks 1-4.
- Produces: three deterministic document/package fixtures, generated JSON Schema artifacts, one valid export example, and `npm run contracts:generate`.

- [ ] **Step 1: Write failing fixture acceptance tests**

Create `fixtures/fixtures.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import { decodeSystemDocument, decodeSystemExport, decodeSystemPackage } from "../index.js";
import { d20Document, d20Export, d20Package } from "./d20.js";
import { d6SuccessPoolDocument, d6SuccessPoolPackage } from "./d6-success-pool.js";
import { pbta2d6Document, pbta2d6Package } from "./pbta-2d6.js";

describe("reference system contracts", () => {
  it.each([
    ["d20", d20Document, d20Package],
    ["2d6", pbta2d6Document, pbta2d6Package],
    ["d6 success pool", d6SuccessPoolDocument, d6SuccessPoolPackage],
  ])("decodes the %s source and compiled fixture", (_name, document, packageValue) => {
    expect(decodeSystemDocument(document).ok).toBe(true);
    expect(decodeSystemPackage(packageValue).ok).toBe(true);
  });

  it("round-trips the portable d20 export", () => {
    expect(decodeSystemExport(JSON.stringify(d20Export))).toEqual({ ok: true, value: d20Export });
    expect(JSON.stringify(d20Export)).not.toMatch(/ownerId|actorId|email|token|audit/i);
  });
});
```

- [ ] **Step 2: Run fixture tests to verify they fail**

Run: `npm test -- src/systems/implementation/package/fixtures/fixtures.test.ts`

Expected: FAIL because fixture modules do not exist.

- [ ] **Step 3: Implement the three original fixtures**

Create each fixture with deterministic UUIDs and timestamps. Each module exports one `SystemDocumentV1` and one signed `SystemPackageV1`; `d20.ts` also exports `d20Export`.

Use these exact capabilities and IDs:

- d20: fields `ability`, `modifier`, `proficient`, `ancestry`, `health`, `defense`; expressions `defense_expr`, `check_expr`, `ability_valid_expr`; roll source `d20 + fields.modifier + inputs.bonus`; actions `check`, `damage`, `heal`; one linear character sheet.
- 2d6: fields `move_stat`, `description`, `playbook`, `condition`, `harm`, `current_penalty`; expressions `penalty_expr`, `move_expr`, `stat_valid_expr`; roll source `2d6 + fields.move_stat + inputs.forward`; actions `make_move`, `mark_harm`; one linear character sheet. Output remains factual and does not encode branching outcome bands.
- d6 success pool: fields `attribute`, `skill`, `specialty`, `condition`, `stress`, `pool_size`; expressions `pool_size_expr`, `pool_roll_expr`, `pool_valid_expr`; roll source `countSuccesses(dice(fields.attribute + fields.skill + inputs.bonus_dice, 6), 6)`; actions `test_pool`, `mark_stress`, `clear_stress`; one linear character sheet.

Construct compiled ASTs by hand to match each source. Dependencies are lexicographically ordered and deduplicated. Use `signSystemPackage` after constructing each unsigned package. Do not add copied setting, class, move, item, or flavor text.

- [ ] **Step 4: Run fixture tests to verify they pass**

Run: `npm test -- src/systems/implementation/package/fixtures/fixtures.test.ts`

Expected: PASS with four cases.

- [ ] **Step 5: Add deterministic contract generation**

Create `scripts/generate-system-contracts.ts` that imports the three root schemas and `d20Export`, creates `docs/contracts/examples`, and renders each JSON file as `JSON.stringify(value, null, 2) + "\n"`. Resolve paths from `process.cwd()` and define only these four generated files:

```typescript
const outputs = new Map<string, unknown>([
  ["docs/contracts/system-document-v1.schema.json", SystemDocumentV1Schema],
  ["docs/contracts/system-package-v1.schema.json", SystemPackageV1Schema],
  ["docs/contracts/system-export-v1.schema.json", SystemExportV1Schema],
  ["docs/contracts/examples/d20-system-export-v1.json", d20Export],
]);
```

When invoked without flags, write the outputs. When invoked with `--check`, read each existing file and set `process.exitCode = 1` after listing any path whose exact content differs; do not write in check mode. Add these scripts to `package.json`:

```json
"contracts:generate": "tsx scripts/generate-system-contracts.ts",
"contracts:check": "tsx scripts/generate-system-contracts.ts --check"
```

Run `npm run contracts:generate` and inspect all four files for deterministic trailing-newline output.

- [ ] **Step 6: Write grammar and capability documentation**

Create `docs/contracts/grammar-v0.1.md` with this content, expanding the limits table with the remaining collection ceilings from `PACKAGE_LIMITS`:

```markdown
# Expression Grammar v0.1

## Values And References

Literals are finite numbers, booleans, and bounded strings. References are only `fields.<id>` and `inputs.<id>`.

## Operators

| Precedence | Forms |
|------------|-------|
| 1 | parentheses |
| 2 | `-`, `!` |
| 3 | `*`, `/` |
| 4 | `+`, `-` |
| 5 | `<`, `<=`, `>`, `>=` |
| 6 | `==`, `!=` |
| 7 | `&&` |
| 8 | `||` |

## Functions And Dice

| Form | Result |
|------|--------|
| `min(number, number)` | Smaller number |
| `max(number, number)` | Larger number |
| `round(number, mode?)` | Rounded number; mode is `nearest`, `down`, or `up` |
| `d20`, `2d6` | Static dice result |
| `4d6kh3`, `4d6kl1` | Keep highest/lowest dice result |
| `adv(d20)`, `dis(d20)` | Roll twice and keep high/low |
| `dice(count, sides)` | Dynamic dice pool; count is an integer expression and sides is a literal |
| `countSuccesses(dice, threshold)` | Number of dice at or above the threshold |

Examples: `d20 + fields.modifier`, `2d6 + fields.stat`, `4d6kh3`, and `countSuccesses(dice(fields.attribute + fields.skill, 6), 6)`.

## Types, Fallbacks, And Limits

Arithmetic and ordering require numbers. Equality operands have the same scalar type. Boolean composition requires booleans. Every expression declares a result type and same-typed fallback. Safe arithmetic failures return the fallback and a diagnostic; parse, type, reference, and budget failures reject compilation.

| Limit | Ceiling |
|-------|---------|
| Encoded input | 1 MiB |
| Expression source | 1,024 UTF-8 bytes |
| AST | 256 nodes, depth 32 |
| Dice | 100 dice, 1,000 sides |

Also list: 32 entities, 512 total fields, 64 reference datasets, 1,000 records per dataset, 64 values per record, 32 sheets, 64 sections per sheet, 1,024 total sheet elements, 256 actions, 256 validations, and 1,024 expressions.

## Exclusions

Rerolls, exploding dice, pushes, custom faces, failure cancellation, property traversal, collections, effects, loops, assignment, and user-defined functions are not part of v0.1.
```

Create `docs/contracts/capability-matrix-v0.1.md` with these two tables:

```markdown
# Capability Matrix v0.1

| Capability | d20 fixture | 2d6 PbtA-style fixture | d6 success-pool fixture |
|------------|-------------|------------------------|-------------------------|
| Scalar fields | ability and stored modifier | move stat and description | attribute and skill ratings |
| Choice/boolean | ancestry and proficiency | playbook and marked condition | specialty and condition |
| Resource | hit points | harm | stress |
| Computed value | defense from numeric fields | current penalty | total pool size |
| Roll | `d20 + fields.modifier` | `2d6 + fields.stat` | dynamic d6 pool counted at threshold 6 |
| Action input | situational modifier | forward modifier | bonus dice |
| Built-in state action | hit-point bump | harm bump | stress reset/bump |
| Validation | bounded ability | bounded stat | non-negative pool |
| Linear sheet | sections, fields, resource, roll | sections, fields, resource, move | sections, fields, resource, roll |

## Excluded

| Capability | Status |
|------------|--------|
| Class progression tables | Deferred |
| Branching move outcomes | Deferred |
| Equipment aggregation | Deferred |
| Opposed tests | Deferred |
| Push and reroll rules | Deferred |
| Automated roll consequences | Deferred |
```

- [ ] **Step 7: Prove generated artifacts are stable**

Run: `npm run contracts:generate`

Run: `npm run contracts:check`

Expected: exit 0 with no differing paths.

- [ ] **Step 8: Run full verification**

Run: `npm test`

Expected: all unit tests pass, including schema, codec, integrity, and fixture suites.

Run: `npm run typecheck`

Expected: exit 0.

Run: `npm run build`

Expected: exit 0; scripts outside `src` are intentionally not emitted.

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json scripts/generate-system-contracts.ts src/systems/implementation/package/fixtures/ docs/contracts/
git commit -m "docs: publish system package v1 contracts"
```

---

### Task 6: Acceptance and Regression Verification

**Files:**
- Modify only if verification exposes a defect in files created by Tasks 1-5.

**Interfaces:**
- Consumes: the complete package contract implementation.
- Produces: evidence that the increment satisfies its acceptance demonstration without PostgreSQL.

- [ ] **Step 1: Run focused acceptance tests**

Run:

```bash
npm test -- src/systems/implementation/package/
```

Expected: every package contract test passes. Confirm output includes document variants, compiled AST variants, bounded invalid inputs, duplicate/missing references, canonical checksums, tamper rejection, and all three fixtures.

- [ ] **Step 2: Regenerate contracts and verify a clean diff**

Run: `npm run contracts:check`

Run: `git status --short`

Expected: check exits 0 and the worktree has no generated contract changes. Any difference is a generation-stability defect and must be fixed before continuing.

- [ ] **Step 3: Run repository verification**

Run: `npm test`

Expected: all unit tests pass.

Run: `TEST_DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll npm run test:integration`

Expected: all existing PostgreSQL integration tests pass; this increment adds no database tests.

Run: `npm run typecheck`

Expected: exit 0.

Run: `npm run build`

Expected: exit 0.

- [ ] **Step 4: Inspect scope and security invariants**

Run: `git diff 3842392..HEAD -- src/systems/authoring.ts src/systems/runtime.ts src/transport src/bootstrap`

Expected: no public Module Interface, HTTP route, or runtime process-mode changes from this increment.

Run: `rg -n "ownerId|actorId|email|token|audit" docs/contracts/examples src/systems/implementation/package/fixtures --glob '!fixtures.test.ts'`

Expected: no matches.

- [ ] **Step 5: Record the final checkpoint**

Run: `git status --short`

Expected: clean worktree. No additional commit is needed when verification makes no changes. If a defect was fixed, rerun Steps 1-4 and commit only that fix with a focused `fix:` message.
