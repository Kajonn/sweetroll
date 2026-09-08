# Character Creation Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/characters/new` opened without `?systemVersionId=` shows a selectable list of every system version the signed-in actor may create from, instead of a dead-end UUID textbox.

**Architecture:** New read-only backend endpoint `GET /characters/creation-versions` reuses the exact `authorizeVersionUse` SQL predicate (published version, active system, owner-or-public/link) in a single list query, threaded through the existing SystemAuthoring→Characters injection seam. The frontend adds a react-query hook mirroring `useListVersions` and renders the picker inside `CreateCharacter` only when no version is prefilled and no metadata is loaded; the manual UUID box stays as fallback.

**Tech Stack:** TypeScript, Fastify + TypeBox DTOs, Postgres 17 (`pg` Pool), Vitest colocated tests + `tests/integration/*`, React + TanStack Router + `@tanstack/react-query`, Playwright production-browser specs.

**Spec:** `docs/superpowers/specs/2026-09-06-i4-character-sheet-design.md` lines 44 (creation-options policy) and 56 (routes/entry); this plan extends that design with a version-list endpoint and picker UI. Root cause: manual GUI test showed `/characters/new` renders only a free-text "System version ID" box with no discoverable version IDs.

## Global Constraints

- TDD: write the failing test first, watch it fail for the right reason, then implement. No production code before a red test.
- Mirror existing patterns exactly: `creationOptions` for backend/transport, `useListVersions` (`web/src/api/listVersions.ts`) for the hook, `character.create.*` message keys (`web/src/i18n/messages.ts:379-398`) for copy.
- Never invent loaders/ports: reuse `authorizeVersionUse`'s predicate by construction (same WHERE clause), thread through `CreateCharactersModuleInput` (`src/characters/index.ts:357-364`) and `bootstrap/http.ts:73-77`.
- Static character routes register before `/characters/:characterId` (`src/transport/http/characters.ts:444-475`).
- Integration tests use their own schema via `tests/integration/i3-app.ts` (`buildI3App`/`createI3Schema`/`dropI3Schema` pattern in `tests/integration/character-creation-options.test.ts:36-50`); never touch the shared `sweetroll` database rows outside the owned schema. Env: `TEST_DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll` and `AUTHORITATIVE_ROLL_SECRET=development-only-roll-secret-32-bytes`.
- SDD ledger: record briefs, reports, review diffs and any `Ruling:` under `.superpowers/sdd/2026-09-07-creation-picker/` (gitignored, preserved at merge, never committed).
- Commit style: `feat: ...` / `fix: ...` / `docs: ...` / `test: ...`, one task per commit unless a review fix is required (then `fix: ...` on top).
- Do not push or merge without explicit authorization. Do not touch I5 scope, service worker, or offline queue code.

---

## File Structure

- `src/systems/implementation/persistence/repository.ts` — add `listAuthorizedVersions(actorId)` next to `authorizeVersionUse` (`:270-285`); one SQL query, same predicate plus system-name join.
- `src/systems/authoring.ts` — add `listAuthorizedVersions(ctx)` passthrough next to `authorizeVersionUse` (`:573-581`); same error convention (`not_found` never fires here; `internal` on catch).
- `src/characters/index.ts` — add `listAuthorizedVersions` module input (`:357-364`) and `listCreationVersions(ctx)` facade next to `creationOptions` (`:667-679`).
- `src/bootstrap/http.ts` — wire `listAuthorizedVersions: authoring.listAuthorizedVersions` (`:73-77`).
- `src/transport/http/characters.ts` — add `GET /characters/creation-versions` schema entry (next to `:444-460`) and handler (next to `:766-773`); update path-list test `src/transport/http/openapi.test.ts:29-53`; regenerate contracts (`docs/contracts/openapi-v1.json`, check `package.json` scripts for the generator command) and `web/src/api/schema.d.ts` however the `/characters/creation-options` entry at `:199` got there (check header: generated → regenerate; manual → mirror).
- `tests/integration/character-creation-versions.test.ts` — new, mirrors `character-creation-options.test.ts` (`:36-124` app/schema/seed helpers).
- `web/src/characters/types.ts` — add `CreationVersions` response type next to `CreationOptions` (read the file first, mirror field style).
- `web/src/characters/api.ts` — add `listCreationVersions(): Promise<CreationVersions>` next to `creationOptions` (`:43-46`).
- `web/src/api/listCreationVersions.ts` — new hook mirroring `listVersions.ts` exactly (queryKey `["characters", "creation-versions"]`, `staleTime: 30_000`, `{ enabled }` option).
- `web/src/characters/CreateCharacter.tsx` — render picker when online, signed in, no `initialSystemVersionId`, `metadata === null`; button per version sets version + calls `loadMetadata`.
- `web/src/i18n/messages.ts` — new `character.create.pickVersion.*` keys next to `:379-398`.
- Tests: `web/src/api/listCreationVersions.test.tsx` (mirror `listVersions.test.tsx`), `CreateCharacter.test.tsx` additions, `router.test.tsx` fetch-mock update for the new pathname.
- Browser proof: extend the seeding setup used by `web/tests/e2e/character-sheet.spec.ts:1-45` (read it first) with picker assertions, or the equivalent `web/tests/offline/character.spec.ts:1-60` setup — whichever the implementer verifies first; only one, no duplicate coverage.
- Docs: `design_v2.md` Routes/Presentation sentences for `/characters/new` (grep `characters/new`), addendum at end of `2026-09-06-i4-character-sheet-design.md`.

---

### Task 1: Backend list endpoint

**Files:**
- Modify: `src/systems/implementation/persistence/repository.ts`
- Modify: `src/systems/authoring.ts`
- Modify: `src/characters/index.ts`
- Modify: `src/bootstrap/http.ts`
- Modify: `src/transport/http/characters.ts`
- Modify: `src/transport/http/openapi.test.ts`
- Modify: `docs/contracts/openapi-v1.json`, `web/src/api/schema.d.ts` (via generator if generated, else by hand mirroring creation-options)
- Test: `tests/integration/character-creation-versions.test.ts`, plus unit cases in `src/characters/*.test.ts` and mapping cases in `src/transport/http/characters.test.ts` (mirror the creation-options cases at `:348-430`)

**Interfaces:**
- Consumes: `SystemAuthoring["authorizeVersionUse"]` predicate semantics; `CharacterResult<T>` / `errors.internal()` convention (`src/characters/index.ts:372-406`).
- Produces: `Characters["listCreationVersions"](ctx) -> Promise<CharacterResult<{ versions: Array<{ versionId: string; systemId: string; systemName: string; semanticVersion: string; createdAt: string }> }>>`; `GET /characters/creation-versions` → `200 { data, requestId }`, `401` anonymous, `500` on failure. No `404`/`422`: an empty list is a valid 200.

- [ ] **Step 1: Write the failing repository/authoring/transport tests.** Add to `src/transport/http/characters.test.ts` a case mirroring the creation-options mapping test (`:348-368`): stub `listCreationVersions: async () => ({ ok: true, value: { versions: [...] } })`, inject `GET /characters/creation-versions` with a signed-in cookie, expect 200 with the exact `data` passthrough. Add `"/characters/creation-versions"` to the sorted path list in `openapi.test.ts:29-53` (sort position: after `"/characters/creation-options"`, before `"/characters/{characterId}"`).

- [ ] **Step 2: Run to verify they fail.**

  Run: `npx vitest run src/transport/http/characters.test.ts src/transport/http/openapi.test.ts`
  Expected: FAIL — `listCreationVersions` is not a function / path list mismatch.

- [ ] **Step 3: Implement the repository query.** In `repository.ts`, next to `authorizeVersionUse`, add a method using the identical predicate plus the system-name join:

```ts
async listAuthorizedVersions(actorId: UserId) {
  const result = await pool.query<{
    version_id: string; system_id: string; system_name: string;
    semantic_version: string; created_at: Date;
  }>(
    `SELECT v.id AS version_id, s.id AS system_id, s.name AS system_name,
            v.semantic_version, v.created_at
       FROM system_versions v
       JOIN systems s ON s.id = v.system_id
      WHERE v.lifecycle = 'published'
        AND s.lifecycle = 'active'
        AND (s.owner_id = $1 OR s.access IN ('public', 'link'))
      ORDER BY s.name ASC, v.created_at DESC, v.id DESC`,
    [actorId],
  );
  return result.rows.map(row => ({
    versionId: row.version_id,
    systemId: row.system_id,
    systemName: row.system_name,
    semanticVersion: row.semantic_version,
    createdAt: row.created_at.toISOString(),
  }));
}
```

  Declare its row type next to the `AuthorizedVersionUse` row type and export the summary type. Add the authoring passthrough next to `authorizeVersionUse` (`authoring.ts:573-581`) with the same try/catch → `errors.internal()` shape, add the `Characters` facade method next to `creationOptions` (`characters/index.ts:667-679`), extend `CreateCharactersModuleInput` (`:357-364`) with `listAuthorizedVersions: SystemAuthoring["listAuthorizedVersions"]`, and wire it in `bootstrap/http.ts:73-77`.

- [ ] **Step 4: Implement the transport route.** Mirror the creation-options schema entry (`characters.ts:444-460`) with path `/characters/creation-versions`, `operationId: "get_characters_creation_versions"`, no querystring, and a handler mirroring `:766-773` that calls `characters.listCreationVersions(ctxOf(request))` and returns `{ data: result.value, requestId: request.id }`. Place both adjacent to the creation-options blocks, before the dynamic `:characterId` route.

- [ ] **Step 5: Write the failing integration test.** Create `tests/integration/character-creation-versions.test.ts` mirroring `character-creation-options.test.ts:36-124` (`makeApp`, `cookieHeader`, `insertVersion`). Seed: own published version, other-owner public version, other-owner link-access version, other-owner private version, own deprecated-lifecycle version, version on an archived system. Assert `GET /characters/creation-versions` returns 200 with exactly the first three versionIds (order: system name ASC, newest first), and that row counts in `systems`/`system_versions` are unchanged by the GET. Assert 401 without a cookie.

- [ ] **Step 6: Run the integration test to verify it fails, then passes.**

  Run: `TEST_DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll AUTHORITATIVE_ROLL_SECRET=development-only-roll-secret-32-bytes npx vitest run tests/integration/character-creation-versions.test.ts`
  Expected first: FAIL (route 404). After Steps 3-4: PASS.

- [ ] **Step 7: Regenerate contracts and schema types.** Check `package.json` scripts for the OpenAPI/schema generator commands (the I4 plan used a contracts regeneration step; `npm run contracts:check` verifies). Regenerate `docs/contracts/openapi-v1.json` and `web/src/api/schema.d.ts` if generated; otherwise hand-mirror the `/characters/creation-options` entries. Verify: `npm run contracts:check`, `npm test` (full unit suite), and the integration suite for characters.

- [ ] **Step 8: Commit.**

```bash
git add src/ tests/ docs/contracts/ web/src/api/schema.d.ts
git commit -m "feat: list authorized creation versions for character picker"
```

### Task 2: Frontend picker on /characters/new

**Files:**
- Modify: `web/src/characters/types.ts`, `web/src/characters/api.ts`, `web/src/characters/CreateCharacter.tsx`, `web/src/i18n/messages.ts`, `web/src/router.test.tsx`
- Create: `web/src/api/listCreationVersions.ts`, `web/src/api/listCreationVersions.test.tsx`
- Test: `web/src/characters/CreateCharacter.test.tsx` additions

**Interfaces:**
- Consumes: `GET /characters/creation-versions` → `{ data: { versions: [{ versionId, systemId, systemName, semanticVersion, createdAt }] }, requestId }` (Task 1); `loadMetadata(version)` (`CreateCharacter.tsx:232-268`); `ApiError` status branches (`:253-264`).
- Produces: picker UI visible exactly when online AND signed in AND no `initialSystemVersionId` AND `metadata === null`; selecting version `v` sets the version box to `v.versionId` and loads its metadata through the unchanged `loadMetadata` path (so all existing guards/pending/expired behavior apply untouched).

- [ ] **Step 1: Write the failing hook test.** Create `web/src/api/listCreationVersions.test.tsx` mirroring `web/src/api/listVersions.test.tsx:1-60`: stub client fetch resolving `{ versions: [...], requestId: "r" }`, assert the hook returns the array and fetches `/characters/creation-versions`; assert `enabled: false` performs no fetch.

- [ ] **Step 2: Run to verify it fails.**

  Run: `npm run web:test -- src/api/listCreationVersions.test.tsx` (from repo root; if the script does not accept a path filter, run from `web/` with `npx vitest run src/api/listCreationVersions.test.tsx`)
  Expected: FAIL with module not found.

- [ ] **Step 3: Implement the API type, client method, and hook.** In `types.ts` add (mirror `CreationOptions` style):

```ts
export type CreationVersionEntry = {
  versionId: string;
  systemId: string;
  systemName: string;
  semanticVersion: string;
  createdAt: string;
};
export type CreationVersions = { data: { versions: CreationVersionEntry[] }; requestId: string };
```

  In `api.ts` add `listCreationVersions: () => client.fetch<CreationVersions>("GET", "/characters/creation-versions")` and extend the `CharactersApi` type. Create `listCreationVersions.ts` mirroring `listVersions.ts`:

```ts
export function useCreationVersions(
  client: ApiClient,
  options: { enabled?: boolean } = {},
): UseQueryResult<CreationVersionEntry[]> {
  return useQuery({
    queryKey: ["characters", "creation-versions"],
    queryFn: async () =>
      client.fetch<CreationVersions>("GET", "/characters/creation-versions").then(r => r.data.versions),
    enabled: options.enabled ?? true,
    staleTime: 30_000,
  });
}
```

- [ ] **Step 4: Write the failing component tests.** In `CreateCharacter.test.tsx` add: (a) renders version buttons for the picker response when no `initialSystemVersionId` is given (mock the query hook result via the same seam existing tests use to inject `api` — read the top of the test file first; if the hook cannot be injected, mock `@tanstack/react-query`'s `useQuery` for this suite the way `VersionHistory.test.tsx` stubs fetch); (b) clicking a version fills the "System version ID" box and calls `api.creationOptions` with that versionId; (c) picker hidden when `initialSystemVersionId` is provided; (d) picker fetch error shows the new `character.create.pickVersion.error` alert without breaking the manual box.

- [ ] **Step 5: Run to verify they fail.**

  Run: component test file only (same runner note as Step 2).
  Expected: FAIL — no picker elements rendered.

- [ ] **Step 6: Implement the picker.** In `CreateCharacter.tsx`, after the Look up button block (`:692-698`) and inside the same `<form>`, render only when `initialSystemVersionId === undefined && metadata === null`:

```tsx
{showPicker ? (
  <section aria-labelledby="create-character-picker-title">
    <h2 id="create-character-picker-title">{t("character.create.pickVersion.title")}</h2>
    {pickerLoading ? <p role="status">{t("character.create.pickVersion.loading")}</p> : null}
    {pickerError ? <p role="alert">{t("character.create.pickVersion.error")}</p> : null}
    {pickerVersions?.length === 0 ? <p role="status">{t("character.create.pickVersion.empty")}</p> : null}
    <ul>
      {(pickerVersions ?? []).map(v => (
        <li key={v.versionId}>
          <button type="button" onClick={() => { setVersionId(v.versionId); void loadMetadata(v.versionId); }}>
            {v.systemName} {v.semanticVersion}
          </button>
        </li>
      ))}
    </ul>
  </section>
) : null}
```

  where `showPicker = initialSystemVersionId === undefined && metadata === null` and the hook is enabled under the same condition plus online/signed-in (`actorId !== null && online`). Add messages: `character.create.pickVersion.title: "Choose a system version"`, `.loading: "Loading available versions…"`, `.error: "Available versions could not be loaded. Enter a system version ID manually."`, `.empty: "No system versions are available for character creation."` Button label format: `{systemName} {semanticVersion}` (no new key needed; versionId exposed via `title` attribute for debuggability is optional — keep minimal, skip it).

- [ ] **Step 7: Fix the router fetch mocks.** `web/src/router.test.tsx` tests rendering `/characters/new` without a version (`:49-62`, `:231+`) will now fire `/api/characters/creation-versions`; the fallthrough mock returns `{ systems: [] }` which breaks the hook. Add an explicit branch returning `{ data: { versions: [] }, requestId: "r" }` next to the existing creation-options branches (`:207`, `:240`).

- [ ] **Step 8: Run the web suite.**

  Run: `npm run web:test` then `npm run web:typecheck`
  Expected: PASS, including updated router tests.

- [ ] **Step 9: Commit.**

```bash
git add web/
git commit -m "feat: pick system version on the character creation page"
```

### Task 3: Browser proof and design update

**Files:**
- Modify: `web/tests/e2e/character-sheet.spec.ts` (or `web/tests/offline/character.spec.ts` — implementer reads both setups first and extends exactly one) and `design_v2.md`, `docs/superpowers/specs/2026-09-06-i4-character-sheet-design.md`
- Test: the extended spec

**Interfaces:**
- Consumes: seeded reference versions from the chosen spec's existing setup (`character-sheet.spec.ts:1-45`, `character.spec.ts:1-60`); the picker UI contract from Task 2.
- Produces: production-browser proof that a signed-in user reaches entity selection from a versionless `/characters/new` through the picker alone; design docs stating the new endpoint + picker.

- [ ] **Step 1: Write the failing browser test.** Read both spec setups first. Extend exactly one spec with: goto `/characters/new` (no search), expect the "Choose a system version" heading, click the button for a seeded system (e.g. the d20 reference), expect the Entity select to appear with that system's entities, select one, fill name, submit, land on the sheet. Reuse that file's existing sign-in, seeding, viewport and evidence conventions verbatim.

- [ ] **Step 2: Run it to verify it fails, then passes.** Run per that file's config (`web/playwright.config.ts` e2e or `web/playwright.offline.config.ts` offline — match the file extended).

- [ ] **Step 3: Update the design documents.** In `design_v2.md`, find the Routes/Presentation passage describing `/characters/new` (grep `characters/new`) and add: the `GET /characters/creation-versions` endpoint (same authorization policy as create) and the picker UI with manual-ID fallback. Append an addendum section to `docs/superpowers/specs/2026-09-06-i4-character-sheet-design.md` recording the endpoint, picker visibility rule (only without prefilled version and before metadata loads), and that selection reuses `loadMetadata` unchanged.

- [ ] **Step 4: Run full verification.** `npm test`, integration characters suite, `npm run typecheck`, `npm run contracts:check`, `npm run web:test`, `npm run web:typecheck`, plus the extended browser spec. Record commands/exits/counts in the task report.

- [ ] **Step 5: Commit.**

```bash
git add web/tests/ design_v2.md docs/superpowers/specs/2026-09-06-i4-character-sheet-design.md
git commit -m "test: prove creation picker journey and record the design"
```

---

## Self-Review

- Spec coverage: design lines 44 (policy reuse — Task 1 same-predicate query) and 56 (entry — Task 2 picker + Task 3 proof) both have tasks. Root-cause report's misleading-400 note is explicitly deferred, not silently dropped (see below).
- Placeholder scan: every step names exact files, line anchors, commands and expected outputs; no TBD/TODO/similar-to.
- Type consistency: `CreationVersionEntry`/`CreationVersions` names are used identically in Tasks 1–3; endpoint path `/characters/creation-versions` and operationId `get_characters_creation_versions` match the openapi sorted-list position.

**Known deferred item:** typing garbage in the manual UUID box still surfaces the generic `character.create.uncertain` error for a 400 validation failure. Out of scope for this plan (picker removes the dead end); file it as a follow-up, do not bundle it.
