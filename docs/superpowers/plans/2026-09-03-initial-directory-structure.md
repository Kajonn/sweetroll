# Initial Directory Structure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create the approved I1 source layout with minimal TypeScript marker files and no implementation behavior.

**Architecture:** The scaffold follows the deep `Identity`, `SystemAuthoring`, and `SystemRuntime` Modules described in the design. Private package, rules, and persistence code stays under the systems implementation; HTTP, platform, and process composition remain outside those Modules.

**Tech Stack:** TypeScript source layout only; no dependencies or build tooling are introduced.

**Spec:** `design_v2.md`, especially sections 11.1 through 11.6.

## Global Constraints

- Keep the scaffold limited to the source layout approved in `design_v2.md`.
- Do not introduce package dependencies, runtime behavior, speculative Interfaces, or extra deployables.
- Use `Module`, `Interface`, `Implementation`, `Seam`, and `Adapter` consistently in file comments.
- Keep private package, rules, and persistence markers under `src/systems/implementation/`.

---

### Task 1: Create The I1 Source Scaffold

**Files:**
- Create: `src/identity/index.ts`
- Create: `src/systems/authoring.ts`
- Create: `src/systems/runtime.ts`
- Create: `src/systems/implementation/package/index.ts`
- Create: `src/systems/implementation/rules/index.ts`
- Create: `src/systems/implementation/persistence/index.ts`
- Create: `src/transport/http/index.ts`
- Create: `src/platform/index.ts`
- Create: `src/bootstrap/http.ts`
- Create: `src/bootstrap/migrate.ts`

**Interfaces:**
- Consumes: The source layout and ownership rules in `design_v2.md` section 11.
- Produces: Directory and file locations for later I1 implementation plans; no callable Interface or runtime behavior.

- [x] **Step 1: Create marker files**

Each file contains one responsibility comment and `export {};` so TypeScript treats it as a module without publishing a premature Interface.

```typescript
// Houses the implementation named by this file's location in design_v2.md.
export {};
```

- [x] **Step 2: Verify every approved marker exists**

Run:

```bash
test -f src/identity/index.ts -a -f src/systems/authoring.ts -a -f src/systems/runtime.ts -a -f src/systems/implementation/package/index.ts -a -f src/systems/implementation/rules/index.ts -a -f src/systems/implementation/persistence/index.ts -a -f src/transport/http/index.ts -a -f src/platform/index.ts -a -f src/bootstrap/http.ts -a -f src/bootstrap/migrate.ts
```

Expected: exit status 0 with no output.

- [x] **Step 3: Review scope**

Confirm that no dependency manifest, build configuration, generated file, database schema, or implementation behavior was added.

No commit step is included because the workspace is not a Git repository.
