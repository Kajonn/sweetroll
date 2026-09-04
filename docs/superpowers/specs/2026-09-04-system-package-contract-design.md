# System Package Contract and Grammar v0.1 - Design

**Status:** Draft for review

## 1. Purpose

Implement the prerequisites and contract portion of I1 Task 3 from `design_v2.md`: select the three reference-system families, define their capability matrix, resolve the v0.1 math-and-dice grammar ceiling, and provide executable structural contracts for editable system documents, immutable runtime packages, and portable exports.

This increment fixes the vocabulary and wire representation that later package compilation, system authoring, and runtime evaluation depend on. It does not implement those later workflows.

## 2. Scope

**In scope:**

- A license-neutral capability matrix for d20, 2d6 PbtA-style, and d6 counted-success pool systems.
- Grammar v0.1 syntax, typing rules, dice forms, and hard structural budgets.
- Versioned TypeScript and runtime schemas for `SystemDocumentV1`, `SystemPackageV1`, and `SystemExportV1`.
- Strict codecs that bound caller-controlled bytes and return stable diagnostics.
- Canonical JSON serialization and SHA-256 package checksums.
- Committed JSON Schema artifacts, examples, and deterministic reference fixtures.

**Out of scope:**

- Tokenizer, parser, type checker, compiler, or evaluator implementation.
- Semantic package assessment, compatibility comparison, and semantic-version policy.
- System persistence, authoring workflows, HTTP routes, or OpenAPI generation.
- Runtime character state and authoritative roll execution.
- Reroll, explode, push, custom-face, lookup, collection, or effect semantics.
- Launch-template claims or copied rules text. Template licensing remains a separate review.

## 3. Architecture

The package implementation remains private under `src/systems/implementation/package/`. Future `SystemAuthoring` and `SystemRuntime` callers exchange complete workflow values; they do not receive schema-validator, parser, canonicalizer, or repository interfaces.

The contract has three layers:

1. `SystemDocumentV1` is editable source. It contains stable definition IDs and bounded expression strings.
2. `SystemPackageV1` is an immutable runtime artifact. Expressions are typed ASTs with resolved dependency lists, so runtime requests do not parse authoring source.
3. `SystemExportV1` is a portable envelope around a published package and optional non-account provenance. Import creates new system and version identities while preserving definition IDs.

TypeBox schemas are the TypeScript source of truth. Ajv performs strict runtime schema validation, and generated JSON Schema files are committed as the external contract documentation. Checks that require relationships across arrays, such as global ID uniqueness and sheet bindings, run immediately after schema validation in the same codec.

Proposed layout:

```text
src/systems/implementation/package/
  schema.ts                 # TypeBox schemas and inferred TypeScript types
  codec.ts                  # bounded decode and ordered structural diagnostics
  canonical.ts              # RFC 8785 serialization and SHA-256 checksums
  limits.ts                 # platform ceilings
  fixtures/
    d20.ts
    pbta-2d6.ts
    d6-success-pool.ts
docs/contracts/
  system-document-v1.schema.json
  system-package-v1.schema.json
  system-export-v1.schema.json
  grammar-v0.1.md
  capability-matrix-v0.1.md
  examples/
```

## 4. Contract Layers

Every root object contains the literal `schemaVersion: "1.0"`. Schemas reject unknown properties.

### 4.1 SystemDocumentV1

`SystemDocumentV1` contains:

- metadata: name, description, language, and default dice notation;
- entity definitions and their field definitions;
- reference datasets;
- ordered linear sheets and sections;
- action definitions;
- validation definitions; and
- source expressions with declared result type and typed fallback.

Field definitions are a tagged union:

- text;
- integer;
- decimal;
- boolean;
- single choice;
- multi-choice;
- resource with current/max bindings and optional bounds/reset;
- computed number, text, or boolean;
- image attachment reference.

Sheet elements are limited to headings, bound fields or resources, and action buttons. Sections and elements are arrays whose order is presentation order. Tabs, grids, conditional display, reusable fragments, and arbitrary bindings are not represented.

Actions are tagged as `roll` or `resourceBump`. Roll actions reference one numeric dice expression and declare their required inputs and factual output template. Resource bumps identify one resource and a bounded integer delta or reset operation. This is not a general effect language.

### 4.2 SystemPackageV1

`SystemPackageV1` contains assigned `systemId`, `versionId`, and semantic version plus the compiled form of the document. Each source expression is replaced by a `CompiledExpressionV1` containing:

- expression ID;
- declared and inferred result type;
- versioned discriminated AST;
- ordered, deduplicated field/input dependencies;
- typed fallback; and
- deterministic cost.

Each compiled expression carries its `context` (`computed`, `roll`, or `validation`) so packages reconstruct faithfully for cloning, importing, and runtime evaluation.

The AST supports literal, reference, unary, binary, function-call, dice, keep, and success-count nodes. Published packages contain no expression source that must be parsed during runtime resolution.

The package also contains effective limits and integrity metadata. It is immutable once published.

### 4.3 SystemExportV1

`SystemExportV1` contains:

- the export format version and media type;
- one verified `SystemPackageV1`;
- optional source URL and license/provenance text; and
- export timestamp.

It excludes owner IDs, account data, campaign data, audit records, tokens, and internal database metadata. Importing an export creates a new system lineage and strips the exported system/version identity from the new draft, but preserves definition IDs for compatibility and meaningful cloning.

The media type is `application/vnd.sweetroll.system+json;version=1`.

## 5. Stable Definition IDs

Definition IDs match `^[a-z][a-z0-9_]{0,63}$`. They are unique across all addressable definitions in a package, including entities, fields, reference datasets and records, sheets, sections, actions, validations, and expressions.

References use IDs, never labels or array positions. Labels may change without changing identity. A builder may initially derive a readable ID from a label, but after creation the ID changes only through an explicit breaking edit. Cloning preserves IDs. Package scope prevents collisions between unrelated systems.

Schema validation checks ID syntax. The structural codec checks global uniqueness and non-expression references such as sheet bindings and resource-bump targets. Expression dependencies are checked by the later compiler.

## 6. Grammar v0.1

### 6.1 Values and references

The grammar supports finite integer and decimal numbers, booleans, and bounded UTF-8 strings. References are restricted to `fields.<id>` and `inputs.<id>`. No additional property traversal is legal.

Supported operators, in precedence order, are:

1. parentheses;
2. unary `-` and `!`;
3. multiplication and division: `*`, `/`;
4. addition and subtraction: `+`, `-`;
5. comparisons: `<`, `<=`, `>`, `>=`;
6. equality: `==`, `!=`;
7. boolean conjunction: `&&`;
8. boolean disjunction: `||`.

Supported deterministic functions are `min`, `max`, and `round`. `round` accepts an optional mode of `nearest`, `down`, or `up`; the default is `nearest`. There is no string concatenation, ternary, assignment, loop, collection traversal, aggregation, user-defined function, or network/file access.

### 6.2 Dice

Static dice notation supports `d20`, `2d6`, `4d6kh3`, and `4d6kl1`. `adv(d20)` and `dis(d20)` are typed sugar for rolling two equivalent dice and keeping one high or low.

Dynamic pools use `dice(countExpression, sidesLiteral)`. The count expression must be an integer and may use fields and action inputs; sides must be a positive integer literal. For example:

```text
countSuccesses(dice(fields.attribute + fields.skill, 6), 6)
```

`countSuccesses(diceExpression, threshold)` returns the number of individual dice greater than or equal to the integer threshold. Dice expressions are valid only in action-roll contexts. Computed fields and validations are deterministic.

Rerolls, exploding dice, push mechanics, custom faces, failure cancellation, and arbitrary keep predicates are excluded from v0.1.

### 6.3 Typing and failure behavior

Arithmetic requires numbers. Ordering comparisons require numbers. Equality operands must have the same scalar type. Boolean operators require booleans. Field and input references have the type declared by their definitions. A source expression's inferred type must equal its declared result type and fallback type.

Division by zero and other safe arithmetic failures produce the declared fallback plus a runtime diagnostic. Parse, type, missing-reference, and budget failures reject compilation. Budget exhaustion never returns a partial AST or package.

Canonical rendering removes insignificant whitespace, uses explicit keep-high/keep-low notation, and preserves AST meaning. It does not claim algebraic equivalence between differently structured expressions.

## 7. Limits

Platform ceilings are fixed for schema version 1:

- encoded document/export size: 1 MiB before JSON parsing;
- expression source: 1,024 UTF-8 bytes;
- expression AST: 256 nodes and depth 32;
- dice: 100 dice per roll and 1,000 sides per die;
- entities: 32;
- fields across all entities: 512;
- reference datasets: 64, with 1,000 records per dataset and 64 scalar values per record;
- sheets: 32, with 64 sections per sheet and 1,024 elements across all sheets;
- actions: 256;
- validations: 256;
- compiled expressions: 1,024.

Package-declared limits may lower but never raise platform ceilings. Collection and byte limits are checked before expensive relationship validation.

## 8. Capability Matrix

The fixtures are original, license-neutral capability models rather than launch templates.

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

The fixtures deliberately do not model class progression tables, branching move outcomes, equipment aggregation, opposed tests, push/reroll rules, or automated roll consequences. Those exclusions are recorded rather than approximated through unsafe general-purpose expressions.

## 9. Decode and Diagnostics

Codecs accept bytes or an unknown JavaScript value and return a result; caller-controlled invalid data does not throw.

```typescript
type PackageDiagnostic = {
  code: string; // PackageDiagnosticCode for decode; rule codes (invalid_syntax, invalid_expression, missing_reference, limit_exceeded) flow through the same shape
  path: string; // JSON Pointer
  message: string;
};

type DecodeResult<T> =
  | { ok: true; value: T }
  | { ok: false; diagnostics: PackageDiagnostic[] };
```

Diagnostics are sorted by JSON Pointer, then stable code. Required codes include `document_too_large`, `invalid_json`, `invalid_schema`, `invalid_definition_id`, `duplicate_definition_id`, `missing_reference`, `limit_exceeded`, and `checksum_mismatch`. Messages contain no caller secrets and do not expose internal stack traces.

Structural decoding means the value is bounded, typed, and safe to inspect. It is not proof that expressions compile or that the package is publishable. Those semantic checks belong to the later package assessment pipeline.

## 10. Canonicalization and Integrity

Canonical serialization follows RFC 8785 JSON Canonicalization Scheme. Object keys are sorted by that scheme; authored array order remains significant.

The checksum is lowercase `sha256:<64 hex characters>`. It covers the canonical `SystemPackageV1` with only `integrity.checksum` omitted. Verification decodes the package, recomputes the checksum, and compares the complete value. A checksum proves byte-independent package identity, not trust or authorization; imported packages are always decoded and later semantically assessed.

Changing presentation order changes the checksum because order affects the rendered sheet. Object-key insertion order and insignificant source formatting do not.

## 11. Testing

Unit and contract tests cover:

- valid decoding for every tagged field, sheet element, action, expression AST, and export variant;
- missing and unknown properties, wrong scalar types, malformed IDs, duplicate IDs, and dangling structural references;
- every collection and byte ceiling at its boundary and one value above it;
- canonical equality across object-key insertion order;
- array-order sensitivity;
- checksum generation, verification, and tamper detection;
- decode/canonicalize/decode round trips;
- generated JSON Schema artifact stability; and
- all three capability fixtures as valid documents and packages.

Tests remain deterministic and do not require PostgreSQL. Parser/compiler tests, property tests over expression evaluation, fuzzing, and budget-exhaustion runtime tests are delivered with the parser and assessment increments.

## 12. Acceptance Demonstration

Using only committed fixtures and package APIs:

1. Decode one document for each of the d20, 2d6, and counted-success families.
2. Decode corresponding precompiled package fixtures containing typed ASTs.
3. Canonicalize and checksum each package deterministically.
4. Export and decode a portable envelope without account data.
5. Reject an oversized document, duplicate definition ID, dangling sheet binding, unknown property, and checksum-tampered package with stable ordered diagnostics.

The demonstration does not claim that expression source has been parsed or evaluated; that is the next rules-engine increment.
