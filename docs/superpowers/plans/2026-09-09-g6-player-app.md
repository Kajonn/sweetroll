# G6 Player App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the I5 standalone Player app: onboarding, character library, personal activity, account preferences with theme defaults, installable PWA shell, and the G4 follow-up restyle — all on shared components, campaign-free, reusing the I4 sheet/renderer and the creation-version picker seam.

**Architecture:** Paginate `GET /characters/creation-versions` first (keyset, discovery-preserving); build a `GET /characters`-backed library reusing the picker/creation seam; add Characters/Activity/Account shell routes + onboarding + PWA manifest around the unchanged I4 sheet; store account theme default server-side with device-override precedence; restyle G4 leftovers visually without touching label/focus contracts; harden auth (concurrency, return route, expired-session) without inventing a production provider.

**Tech Stack:** TypeScript/Fastify/PostgreSQL backend; React 18 + TypeScript, TanStack Router/Query, CSS modules + semantic tokens, Radix via `web/src/ui/`, existing `CharactersApi`/system clients, Vitest + Testing Library, Playwright e2e, `openapi-typescript` contracts.

**Spec:** `docs/superpowers/plans/2026-09-08-gui-integration.md` (G6, lines 146-154), `design_v2.md` §§10.2, 10.5, 12.1, 13 (esp. 512-514), 14, 15, 17.7 (I5 tasks 1-6 + demo 717)

## Global Constraints

- Retain React, TanStack Router/Query, CSS modules, Radix primitives, Lucide icons, generated API types, existing character projection/session model; reuse don't rebuild: `CreateCharacter` picker query, `creation-options` loader, I4 sheet/renderer/session.
- Keep Sweetroll branding; Tablefolk mockup is visual reference only (URL still HTTP 401 — invent no values).
- I5 is campaign-free: no campaign/invitation/membership/shared-content/other-player/GM concepts, routes, or nav items. Campaign routes arrive only with I6.
- Do not rewrite backend beyond named endpoints; no grammar v0.1 changes; no offline-contract changes; no second character renderer or character-state implementation.
- OD-01 option A holds: enumerate owned + `public` only; known-ID use (owner/public/link) unchanged; link systems stay undiscoverable.
- Phone 320–599 single column + bottom nav; tablet 600–1023; desktop 1024+; 44×44 targets; visible `:focus-visible`; reduced-motion; feature CSS only semantic tokens (never `var(--color-*)`).
- Cursor pagination required for unbounded lists (§13.498); each endpoint maps to one deep Module call; every error has stable code + message + request ID.
- `npm run test:integration` keeps `--no-file-parallelism` and load limits; `npm run contracts:check` stays green; each PR states G task, routes, behavior preserved, tests run, before/after screenshots where visual changed.

---

## File map

| Area | Files | Responsibility |
|---|---|---|
| Pagination backend | `src/characters/index.ts` (interface+facade ~340,374,695), `src/systems/authoring.ts` (decl ~172, passthrough ~587), `src/systems/implementation/persistence/repository.ts` (impl ~296), `src/transport/http/characters.ts` (schema ~473, handler ~800) | Keyset page + filters under discovery predicate |
| Contracts | `scripts/generate-system-contracts.ts`, `docs/contracts/openapi-v1.json`, `web/src/api/schema.d.ts`, `web/src/characters/types.ts:89-93` | Regenerate + check |
| Library | NEW `web/src/player/` (library, onboarding, activity, account screens); `web/src/characters/api.ts` (+list client); `web/src/router.tsx` (+routes); `web/src/shell/AppShell.tsx` (bottom nav); NEW `web/tests/e2e/player*.spec.ts` | Library/search/recent + shell |
| Theme pref | NEW migration `migrations/00NN_user_preferences.sql`; `src/identity/` (repo+index+http); `web/src/theme/theme.ts`; account screen | Account default + device override |
| G4 restyle | `web/src/characters/FieldControl.tsx`, `CharacterSheet.tsx:87-199`, `CharacterTools.tsx`, `ConflictReview.tsx`, `*.module.css` | Visual restyle, same DOM contracts |
| Auth | `src/identity/repository.ts:87-132`, `src/identity/index.ts:47-101`, `src/transport/http/dev-signin.ts`, `web/src/router.tsx` (+`/cb`), `web/src/characters/identity.ts` | Concurrency, return route, expired-session UI |
| PWA | NEW `web/public/manifest.webmanifest` + icons; `web/index.html`; install prompt wiring; e2e PWA checks | Installable shell |

---

### Task 1: Paginate `GET /characters/creation-versions` with supported filtering

**Files:**
- Modify: `src/systems/implementation/persistence/repository.ts:153,296-319`, `src/systems/authoring.ts:172-174,587-594`, `src/characters/index.ts:165-175,340,374,695-703`, `src/transport/http/characters.ts:201-211,473-485,800-804`
- Regenerate: `docs/contracts/openapi-v1.json`, `web/src/api/schema.d.ts` via `npm run contracts:generate`
- Modify: `web/src/characters/api.ts:17,49-50`, `web/src/characters/types.ts:89-93`, `web/src/characters/CreateCharacter.tsx:152-166,740-754`
- Test: `tests/integration/character-creation-versions.test.ts` (extend), `web/src/characters/api.test.ts:57-64` (extend), NEW `web/src/characters/versionCatalog.test.tsx` (infinite-scroll picker)

**Interfaces:**
- Consumes: `MAX_PAGE_LIMIT=100` convention (`src/systems/authoring.ts:367-387`); `ListCharactersQuery {limit?:1..100, cursor?}` (`src/transport/http/characters.ts:327-330`).
- Produces: `listCreationVersions(ctx, {limit?, cursor?, q?, systemId?}): Promise<{versions, nextCursor}>` — cursor is opaque base64url `{name, createdAt, versionId}`; `q` = case-insensitive substring on system name (`ILIKE %q%`); `systemId` = exact match; both ANDed with the unchanged OD-01 predicate (`published` + `active` + owner-or-public). Ordering stays `s.name ASC, v.created_at DESC, v.id DESC` with keyset `WHERE (s.name, v.created_at, v.id) > (cursor…)` semantics per direction. Web: `listCreationVersions({cursor?, limit?, q?, systemId?})` + picker `useInfiniteQuery` key `["characters","creation-versions",actorId,generation,q?,systemId?]` reusing the same `enabled/staleTime` guards.

- [ ] **Step 1: Write the failing test (backend)**

```ts
// tests/integration/character-creation-versions.test.ts
test("creation-versions paginates with stable order across inserts", async () => {
  // seed 5 owned+public versions; GET page1 limit=2 → 2 versions + nextCursor
  // publish a 6th version; GET page2 with page1 cursor → no duplicates, no skips vs full ordered list
  // TODAY: fails — no limit/cursor params, single unbounded response
});
test("q filters by system name and systemId narrows to one system", async () => {
  // GET ?q=alp → only Alpha systems; GET ?systemId=X → only X's versions
});
test("pagination preserves OD-01: other-owner link systems never enumerated", async () => {
  // two-account matrix from existing test, page through with limit=1, assert link/private absent on every page
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:integration -- character-creation-versions` from root (serial, load limits preserved)
Expected: FAIL (unknown query params / unbounded response)

- [ ] **Step 3: Write minimal implementation**
  - Repository: `listAuthorizedVersions(actorId, {limit, cursor, q, systemId})` — keep the exact OD-01 `WHERE` (published/active/owner-or-public), add `AND s.name ILIKE %q%` when `q`, `AND s.system_id=$n` when `systemId`, keyset page with `limit+1` probe mirroring `repository.ts:400-422`, `nextCursor` = encoded last row or null.
  - Thread `{limit,cursor,q,systemId}` through authoring passthrough (validate `1..100`, default `20`, exactly like `ListSystemsQuery` in `src/transport/http/systems.ts:235-250,492-502`) and the Characters facade.
  - HTTP: add `querystring` schema to the route; handler forwards `req.query`; response adds `nextCursor`.
  - `npm run contracts:generate`; update `web/src/characters/types.ts` derivation (still from `operations["get_characters_creation_versions"]`); extend `api.listCreationVersions` with optional query; convert picker to `useInfiniteQuery` (same key + filters, same `enabled`/30s-stale guards, flat-map pages for the list, existing retry/empty/manual-fallback UI unchanged).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:integration -- character-creation-versions` from root; `npx vitest run src/characters/api.test.tsx src/characters/versionCatalog.test.tsx src/characters/CreateCharacter.test.tsx` from `web/`; `npm run contracts:check` from root
Expected: PASS, PASS, PASS

- [ ] **Step 5: Commit**

```bash
git add src/systems src/characters src/transport docs/contracts web/src/characters tests/integration/character-creation-versions.test.ts
git commit -m "feat(g6): paginate creation-versions with name/system filters"
```

---

### Task 2: Character library (list/search/recent + lifecycle workflows)

**Files:**
- Modify: `web/src/characters/api.ts` (add `listCharacters({cursor?,limit?})` → existing `GET /characters` at `src/transport/http/characters.ts:437-455`; add `duplicateCharacter(id)` → NEW `POST /characters/:id/duplicate`, see backend below)
- Backend: `src/characters/index.ts` (NEW `duplicateCharacter` Module command: new row, same pinned `systemVersionId`, deep-copied `state_json`, new idempotency key scope, owner-only, archived sources rejected), `src/transport/http/characters.ts` (route + handler, one Module call)
- Create: `web/src/player/CharacterLibrary.tsx` (+`.module.css`, `.test.tsx`), `web/src/player/characterQueries.ts` (`useInfiniteQuery ["characters","library",actorId,generation]`, limit 20, same guards as picker)
- Modify: `web/src/router.tsx:75-94` (NEW `/characters` route; keep the 4 existing), `web/src/shell/AppShell.tsx:170-201` (nav entry — full bottom nav arrives Task 3; here add the route only)
- Test: `tests/integration/characters-duplicate.test.ts` (NEW: owner-only, same version pin, state copy, archived→4xx, idempotent retry), `web/tests/e2e/playerLibrary.spec.ts` (NEW: list/search/recent/create/duplicate/archive/recover)

**Interfaces:**
- Consumes: Task 1 picker seam (`CreateCharacter` + `creation-options` untouched — library links to `/characters/new`, never rebuilds creation state); `GET /characters` response `{characters,nextCursor}`; per-character archive/recover in `CharacterTools.tsx:59-63,75-102`.
- Produces: `useCharacterLibrary()` → `{pages, search(q), recent}` — recent = first page ordered by server (no separate endpoint; client marks recently-opened ids from the same data); library row actions route to existing tools/dialogs for archive/recover and to `/characters/new?systemVersionId=` for create-from-system.

- [ ] **Step 1: Write the failing test (backend duplicate)**

```ts
// tests/integration/characters-duplicate.test.ts
test("owner duplicates a character: same version pin, copied state, new id", async () => {
  // POST /characters (seed) → POST /characters/:id/duplicate → 201, different id, same systemVersionId, equal state
  // TODAY: fails — 404 no route
});
test("duplicate rejects archived source and foreign characters", async () => {
  // archived → 4xx; other owner → 404 (generic, no existence leak)
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:integration -- characters-duplicate` from root
Expected: FAIL (404)

- [ ] **Step 3: Write minimal implementation**
  - `src/characters`: `duplicateCharacter(ctx, {characterId, idempotencyKey})` — owner-only, source must be unarchived, `INSERT` new row with copied `state_json` + same `system_version_id`, audit record; wire `POST /characters/:id/duplicate` (401/404/4xx mapping per existing conventions, stable code + requestId).
  - Web `api.listCharacters` (query `{cursor,limit}`) + `api.duplicateCharacter`; `characterQueries.ts` infinite query; `CharacterLibrary.tsx` built from shared `Panel/PageHeader/EmptyState/Button/FormField/Select` with search input (client `q` over loaded pages + server `GET /characters`… note: server list has no `q` — search filters loaded pages and offers "load more"; document this honestly in code comment), recent rail (first N of first page), rows linking to `/characters/$characterId`, create button → `/characters/new`, duplicate/archive/recover via existing dialogs/APIs. Soft-delete = archive (existing `archived_at` semantics — no new backend state).
  - Route `/characters` + nav entry; no other routes touched; campaign-free (no new concepts).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:integration -- characters-duplicate characters` from root; `npx vitest run src/player/CharacterLibrary.test.tsx src/characters/api.test.tsx` from `web/`; `npx playwright test tests/e2e/playerLibrary.spec.ts` from `web/` (backend per `playwright.config.ts`)
Expected: PASS all

- [ ] **Step 5: Commit**

```bash
git add src/characters src/transport tests/integration/characters-duplicate.test.ts web/src/player web/src/characters/api.ts web/src/router.tsx web/src/shell/AppShell.tsx web/tests/e2e/playerLibrary.spec.ts
git commit -m "feat(g6): character library with search, recent, and lifecycle workflows"
```

---

### Task 3: Player shell (nav, onboarding, activity, account, PWA installable)

**Files:**
- Create: `web/src/player/Onboarding.tsx` (`/welcome`: first-run welcome + "create first character" entry; persisted flag `localStorage["sweetroll:onboarding:{actorId}"]`), `web/src/player/PersonalActivity.tsx` (`/activity`: cross-character feed by fanning out existing per-character `api.activity` over library ids — no new endpoint), `web/src/player/Account.tsx` (`/account`: profile via `useMe`, locale display, session list = current session only + sign-out, storage/sync/recovery guidance reusing `StatusBar`/`useOfflineAvailability` texts), `web/public/manifest.webmanifest` + `web/public/icons/icon-{192,512}.png` (export from Sweetroll brand mark at 512px source; maskable purpose), install-prompt wiring in `AppShell` (`beforeinstallprompt` capture → shared `Button`, dismissed persisted per device)
- Modify: `web/src/router.tsx` (`/welcome`, `/activity`, `/account`; anonymous → `/welcome` for first-run, else sign-in prompt), `web/src/shell/AppShell.tsx` (fixed bottom nav Characters `/characters` · Activity `/activity` · Account `/account` on phone 320–599 via `env(safe-area-inset-bottom)`; existing header kept on desktop), `web/index.html` (manifest `<link>`, `theme-color`, `apple-touch-icon`)
- Test: `web/src/player/shell.test.tsx` (routes/nav/first-run flag/anonymous gating), `web/tests/e2e/playerShell.spec.ts` (phone bottom nav, onboarding→library, install prompt presence, PWA checks: manifest 200, `serviceWorker.ready`, `display-mode` standalone matrix where supported)

**Interfaces:**
- Consumes: Task 2 `useCharacterLibrary`; I4 sheet/tools/session untouched; `useMe` (`web/src/api/hooks.ts:7-12`); offline readiness (`web/src/offline/register.ts`).
- Produces: shell routes mount under `AppShell`; `/welcome` flag key `sweetroll:onboarding:{actorId}` consumed by Task 7 e2e; account screen owns the theme-default control added in Task 4 (mount point `AccountThemeSection`).

- [ ] **Step 1: Write the failing test**

```tsx
// web/src/player/shell.test.tsx
test("anonymous first-run routes to /welcome with create-first-character entry", () => {
  render(<Router initialPath="/characters" anonymous firstRun />); // exact harness per repo router tests
  expect(screen.getByRole("heading", { name: /welcome/i })).toBeInTheDocument();
  // TODAY: fails — no /welcome, no flag
});
test("phone bottom nav has Characters/Activity/Account", () => {
  // render AppShell at 360px, expect three nav links with bottom-nav landmark
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/player/shell.test.tsx` from `web/`
Expected: FAIL (no such routes/nav)

- [ ] **Step 3: Write minimal implementation**
  - Routes + bottom nav (CSS: `position:sticky; bottom:0`, `padding-bottom:env(safe-area-inset-bottom)`, 44px targets, shown only `@media(max-width:599px)`; desktop keeps header anchors).
  - `/welcome`: welcome copy + picker-link entry (`/characters/new`) + "view library" link; sets flag on dismiss; never blocks sign-in.
  - `/activity`: per-character `api.activity` fan-out over the first library page (bounded: max 10 characters, first page only — comment the bound), merged by timestamp desc, shared `EmptyState` when none, per-item links to sheets; no new endpoint, no secrets beyond what each activity call already authorizes.
  - `/account`: `useMe` profile, theme section mount (Task 4), session/sign-out (existing `POST /signout` + local purge), storage + sync + recovery guidance (reuse existing offline texts, not new copy), all five states: loading skeleton, empty (no profile fields), permission-denied (403 → sign-in prompt), unavailable-storage (existing `shell.characterStorageUnavailable` pattern), expired-session (Task 6's re-auth entry — mount point only, behavior in Task 6).
  - PWA: manifest (name Sweetroll, short_name, start_url `/characters`, scope `/`, display `standalone`, icons 192/512 maskable), index.html links, `beforeinstallprompt` → deferred prompt + `Button "Install"`; e2e asserts manifest 200 + valid JSON + icons 200 (real installability proof stays G9 device work).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/player/shell.test.tsx src/player/CharacterLibrary.test.tsx` from `web/`; `npx playwright test tests/e2e/playerShell.spec.ts` from `web/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/player web/src/router.tsx web/src/shell web/index.html web/public/manifest.webmanifest web/public/icons web/tests/e2e/playerShell.spec.ts
git commit -m "feat(g6): player shell with onboarding, activity, account, and PWA install"
```

---

### Task 4: Account theme default with device override

**Files:**
- Create: `migrations/00NN_user_preferences.sql` (`user_preferences(user_id PK/FK users, theme_default TEXT NULL CHECK (theme_default IN ('light','dark','system')), updated_at)` — next sequence number at implementation time)
- Modify: `src/identity/repository.ts` (get/set preference, actor-scoped), `src/identity/index.ts` (Module methods `getThemeDefault`/`setThemeDefault`), `src/transport/http/identity.ts` (`GET/PATCH /me/preferences`, 401 anonymous, stable codes)
- Modify: `web/src/theme/theme.ts` (resolution: stored device preference ?? account default ?? `system`; document precedence in the `theme.ts:14-16` comment), `web/src/player/Account.tsx` (`AccountThemeSection`: device `Select` + account-default `Select` + loading/error states), `web/src/shell/AppShell.tsx:42-70` (ThemeSwitcher resolves via the same function — no fork)
- Test: `tests/integration/identity-preferences.test.ts` (actor isolation, invalid value 4xx, anonymous 401), `web/src/theme/accountTheme.test.ts` (precedence matrix: device>account>system; account load failure → device-only fallback)

**Interfaces:**
- Consumes: Task 3 `AccountThemeSection` mount point; `THEME_STORAGE_KEY="sweetroll:theme"` device store (unchanged).
- Produces: `resolveTheme({device, accountDefault})` in `web/src/theme/theme.ts` — single resolver used by switcher + account screen; `api.getPreferences/patchPreferences` client.

- [ ] **Step 1: Write the failing test (backend)**

```ts
// tests/integration/identity-preferences.test.ts
test("account theme default is actor-isolated", async () => {
  // A PATCH /me/preferences {theme_default:"dark"} → 200; B GET → null (default); A GET → "dark"
  // TODAY: fails — 404 no route
});
test("invalid value rejected, anonymous rejected", async () => {
  // PATCH {theme_default:"neon"} → 4xx; signed-out GET → 401
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:integration -- identity-preferences` from root
Expected: FAIL (404)

- [ ] **Step 3: Write minimal implementation**
  - Migration + repo (`getUserPreference/setUserPreference` by actor id) + Module methods + `GET/PATCH /me/preferences` (validate enum, `PATCH` partial; audit not required — preference, not security event).
  - Web resolver: `effectiveTheme = devicePreference !== null ? device : (accountDefault ?? "system")` (device override wins; "Follow device" clears device key, revealing account default); switcher + account screen share it; account fetch failure → device-only with inline notice (never blocks theme application).
  - Before-paint script in `web/index.html:8-42` unchanged (device-only at paint; account default applies on hydration — comment this honestly; no flash-of-wrong-theme guarantee beyond device value).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:integration -- identity-preferences` from root; `npx vitest run src/theme/accountTheme.test.ts src/theme/theme.test.ts` from `web/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add migrations/00NN_user_preferences.sql src/identity web/src/theme web/src/player/Account.tsx web/src/shell/AppShell.tsx tests/integration/identity-preferences.test.ts
git commit -m "feat(g6): account theme default with device override"
```

---

### Task 5: G4 follow-up restyle (visual only, contracts frozen)

**Files:**
- Modify (styles + shared stateless chrome ONLY): `web/src/characters/FieldControl.tsx` (restyle native inputs via CSS to match shared controls; NO wrapper components), `web/src/characters/CharacterSheet.tsx:87-199` (ActionControl inputs + completion chrome), `web/src/characters/CharacterTools.tsx` (launcher + dialog chrome → shared `Button`/`Panel` typography; keep `dialogTrap.ts` flow), `web/src/characters/ConflictReview.tsx` (correction inputs chrome + confirm dialog buttons; keep section root + focus ids), related `characters.module.css`
- Test: existing `FieldControl.test.tsx` (accessible names `Name/Origin/Ready/Strength/Weight/Swift` must not change), `CharacterTools.test.tsx`, `ConflictReview.test.tsx`, `dialogTrap.test.ts` (all must pass UNCHANGED — restyle proves itself by not breaking them), + NEW `web/src/characters/g4Restyle.test.tsx` (token-only CSS assertions mirroring `controls.test.tsx:19-42` + `aria-pressed`/roles spot checks)

**Interfaces:**
- Consumes: Tasks 1-4 (no API changes here); `dialogTrap.ts:8-55` flow (untouched).
- Produces: visually unified sheet/tools/conflict (no API/behavior change — pure presentation task).

- [ ] **Step 1: Write the failing test**

```tsx
// web/src/characters/g4Restyle.test.tsx
import css from "./characters.module.css"; // authored-CSS assertion pattern per controls.test.tsx:19-42
test("character controls consume only semantic tokens", () => {
  const src = readCssModule("characters.module.css"); // helper: fs read of the module source
  expect(src).not.toMatch(/var\(--color-/);
});
test("tool dialog buttons keep dialogTrap roles (no Radix swap)", () => {
  render(<CharacterTools ... />); // open ActivityDialog
  expect(screen.getByRole("dialog")).toBeInTheDocument(); // custom trap root, not Radix
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/characters/g4Restyle.test.tsx` from `web/`
Expected: FAIL (`var(--color-*)` present and/or roles differ)

- [ ] **Step 3: Write minimal implementation**
  - CSS: align native `input/select/textarea/button` inside character surfaces with shared-control look via semantic tokens (44px, `:focus-visible`, radii, spacing); replace `toolButton/dialogButton/dialogField/checkRow` visuals with token equivalents; migrate ONLY label-free buttons to shared `Button` (launcher, submit, toggles — buttons carry no `<label>`, so no double-label risk).
  - FORBIDDEN in this task: wrapping `FieldControl`/ActionControl/ConflictReview inputs in `FormField/Select/NumberInput/Checkbox`; swapping custom `role=dialog` trap for shared Radix `Dialog`; renaming `#character-completion`, `field-{id}` ids, `*-errors`/`*-commit-error` describedby chains, or any accessible name; changing commit semantics (draft/Enter/blur dedup, `Number()` coercion, checkbox retry).
  - Keep `dialogTrap.ts` byte-identical; keep transaction guards (`manageBlocked/queued/uncertain/offline/readOnly`, expiry/revision gates).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/characters/g4Restyle.test.tsx src/characters/FieldControl.test.tsx src/characters/CharacterTools.test.tsx src/characters/ConflictReview.test.tsx src/characters/dialogTrap.test.ts src/characters/CharacterRoute.test.tsx` from `web/`
Expected: PASS (existing suites unmodified and green)

- [ ] **Step 5: Commit**

```bash
git add web/src/characters
git commit -m "feat(g6): restyle character surfaces on shared tokens without contract changes"
```

---

### Task 6: Auth hardening (no new provider)

**Files:**
- Modify: `src/identity/repository.ts:87-132` (advisory-lock first-sign-in: `SELECT pg_advisory_xact_lock(hashtext(provider||subject))` inside the transaction before SELECT-then-INSERT; second concurrent caller blocks, then sees the first row → canonical `userId`, no orphan), `src/transport/http/dev-signin.ts:34-37` (document + enforce: `/dev/*` registers ONLY when `nodeEnv!=="production"` OR explicit `SWEETROLL_TEST_AUTH=1`; add startup log line stating which auth mode is active), `src/bootstrap/http.ts:48-62` (same rule, single `resolveAuthMode()` helper), `src/identity/index.ts:52-54,80-83` (return `session_expired` for expired (not anonymous) so UI can distinguish), `src/transport/http/auth-hook.ts:29-32` (surface expired distinctly instead of silent-anonymous+clear — keep cookie clearing), `web/src/router.tsx` (NEW `/cb` route: reads provider redirect params, calls existing `identity.refresh()`, then deep-link restores to the pre-sign-in path stored in `sessionStorage["sweetroll:postSignin"]`), `web/src/characters/identity.ts:87-91` (map `session_expired` → expired-session UI entry owned by Account screen), `web/src/player/Account.tsx` (expired-session re-auth panel: "Sign in again" → stores current path → provider-agnostic start entry)
- Test: `tests/integration/identity-concurrency.test.ts` (NEW: `Promise.all` ×8 first-sign-ins, same subject → one `userId`, one `users` row, others canonical), `web/src/player/expiredSession.test.tsx` (expired → Account re-auth panel → post-sign-in path restore)

**Interfaces:**
- Consumes: Task 3 Account screen re-auth mount point; Task 4 preference fetch (401 → anonymous handling already exists).
- Produces: canonical-user guarantee; `/cb` return journey usable by ANY configured OIDC adapter (test adapter today); explicit auth-mode startup log.
- EXPLICITLY OUT: a production OIDC provider adapter (Google/Apple/custom issuer, JWKS, PKCE start). No provider credentials exist in-repo and none are invented here — tracked as the G6 open item below; the `/cb` + refresh + restore path is provider-agnostic and proven with the deterministic test adapter.

- [ ] **Step 1: Write the failing test (concurrency)**

```ts
// tests/integration/identity-concurrency.test.ts
test("8 concurrent first sign-ins resolve to one canonical user", async () => {
  const results = await Promise.all(Array.from({length:8}, () => completeSignIn(freshCodeSameSubject)));
  expect(new Set(results.map(r => r.userId)).size).toBe(1);
  expect(await countUsersForSubject(subject)).toBe(1);
  // TODAY: fails — orphan users, distinct ids
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:integration -- identity-concurrency` from root
Expected: FAIL (multiple userIds)

- [ ] **Step 3: Write minimal implementation**
  - Advisory lock + `/dev` gating + `resolveAuthMode()` + `session_expired` surfacing + `/cb` route + Account re-auth panel per Files above. `/cb` must validate nothing provider-specific: read `sessionStorage` post-sign-in path (default `/characters`), call `refresh()`, navigate. Keep `SWEETROLL_TEST_AUTH=1` working for offline/prod-test configs (documented, logged).
  - No secrets, no issuer URLs, no JWKS, no provider SDK in this task.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:integration -- identity-concurrency identity-module` from root; `npx vitest run src/player/expiredSession.test.tsx src/characters/identity.test.tsx src/shell/AppShell.test.tsx` from `web/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/identity src/transport src/bootstrap web/src/router.tsx web/src/characters/identity.ts web/src/player/Account.tsx tests/integration/identity-concurrency.test.ts web/src/player/expiredSession.test.tsx
git commit -m "feat(g6): first-sign-in canonical user, sign-in return route, expired-session flow"
```

**G6 open item (owner decision, NOT this plan): production OIDC provider adapter.** Requires choosing a provider/issuer, client credentials, JWKS verification, and PKCE login-start UI. Nothing in this plan invents those. If the owner wants I5 acceptance against a real provider, that is a separate scoped task after this plan lands.

---

### Task 7: Exit demonstration, acceptance, and G6 closeout

**Files:**
- Create: `web/tests/e2e/playerJourney.spec.ts` (onboarding→system select→create→play multiple→recent find→connection loss→export→sign-out clears data), `docs/acceptance/gui-YYYY-MM-DD-g6-player.md` (NEW)
- Modify: `docs/superpowers/plans/2026-09-08-gui-integration.md` (check G6 boxes only with evidence), `design_v2.md` §17.7 only if the design itself changed (per AGENTS.md — prefer untouched)
- Test: full gates — `npm test` + `npm run typecheck` + `npm run build` from `web/`; `npm run test:integration` + `npm run contracts:check` from root; `npx playwright test tests/e2e/playerJourney.spec.ts tests/e2e/playerLibrary.spec.ts tests/e2e/playerShell.spec.ts` from `web/`

**Interfaces:**
- Consumes: Tasks 1-6 (all Player surfaces + auth + theme).
- Produces: I5 acceptance evidence; G6 closeout.

- [ ] **Step 1: Write the failing test (e2e first)**

```ts
// web/tests/e2e/playerJourney.spec.ts
test("I5 exit: sign in on phone, select system, create+play two characters, find recent, survive offline, export, sign out clears data", async ({ page }) => {
  // 1. /welcome onboarding → 2. picker select (no ID typed) → 3. create hero A → play (bump+roll)
  // 4. create hero B → 5. /characters recent shows both, open A → 6. offline edit → reconnect (no dupes)
  // 7. export A (download event) → 8. sign out → private data absent (library empty-state, no cached names)
  // TODAY: fails — no /welcome, no /characters, no bottom nav
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx playwright test tests/e2e/playerJourney.spec.ts` from `web/` (backend per `playwright.config.ts`)
Expected: FAIL (no routes)

- [ ] **Step 3: Write minimal implementation**
  - Only gap-closing fixes in Tasks 1-6 scope (no new features): e2e-found wiring bugs, missing empty-states, sign-out purge holes (verify `queryClient` purge + IndexedDB per-account isolation on sign-out — the G1 `a32a214` pattern extended to library/activity caches).

- [ ] **Step 4: Run tests to verify they pass**

Run: full gates listed above
Expected: PASS all; visual baselines: regenerate ONLY with owner approval (G9 rule — ask, do not self-approve)

- [ ] **Step 5: Record acceptance + commit**

```bash
git add web/tests/e2e/playerJourney.spec.ts docs/acceptance/gui-YYYY-MM-DD-g6-player.md docs/superpowers/plans/2026-09-08-gui-integration.md
git commit -m "feat(g6): player exit demonstration with acceptance evidence"
```

Acceptance note lists ONLY checks actually run (commit, commands, device/browser, theme incl. account-default matrix, fixture, screenshots, findings, limitations incl. production-OIDC open item + any real-device G9 remainder).

---

## Self-review

- **Spec coverage:** G6-148 onboarding/library/search/recent/activity/account/installable + G4 follow-up → Tasks 2,3,5. G6-149 pagination/filtering/contracts/ordering/revocation → Task 1. G6-150 theme defaults/overrides + five flows → Tasks 3,4,6. G6-151 campaign-free + same renderer/session → Tasks 2,3 (no campaign code anywhere). G6-152/154 sign-in return + test/prod separation + concurrency → Task 6 (adapter explicitly open). Exit demo → Task 7.
- **Placeholder scan:** fixed — every step names exact files, commands, expected FAIL/PASS, commit message; no TBD/TODO/appropriates; Task 5 states the no-wrap rule as concrete forbiddens, not "be careful".
- **Type consistency:** `listCreationVersions(ctx,{limit,cursor,q,systemId})` (T1) → picker key extension (T1) → library reuses picker seam (T2); `resolveTheme({device,accountDefault})` (T4) ← `AccountThemeSection` mount (T3); `sweetroll:onboarding:{actorId}` + `sweetroll:postSignin` keys (T3/T6) distinct by purpose; `user_preferences.theme_default` values match `light|dark|system` device type.
