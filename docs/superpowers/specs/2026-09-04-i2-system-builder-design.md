# System Builder Frontend — Design (I2)

**Status:** Draft for review

## 1. Purpose

Implement I2 from `design_v2.md §17.4`: a responsive web client that lets a non-programmer create, edit, preview, validate, publish, version, archive, export, and clone-from-template systems entirely through a browser. Ships the missing OpenAPI artifact (§13, §17.1) and a developer-only sign-in route that satisfies the auth contract while a production OIDC adapter remains deferred.

This increment turns `SystemAuthoring` into a product a non-programmer can use. It does not implement character state, campaign collaboration, runtime evaluation, or any I3+ behavior. The player sheet (I4), player app (I5), and GM app (I7) are separate increments.

## 2. Scope

**In scope:**

- A Vite-built React + TypeScript single-page application at `web/` that talks to the existing Fastify HTTP Adapter over cookies.
- An OpenAPI 3.1 artifact at `docs/contracts/openapi-v1.json`, generated from the TypeBox schemas already attached to every route in `src/transport/http/`, plus a thin generated TypeScript types file the web client imports.
- A dev-only sign-in HTTP route that resolves a `{ code, redirectUri }` body through the existing `Identity.completeSignIn` (using `createTestOidcClient` with a small seeded code map) and sets the session cookie. Disabled when `NODE_ENV === "production"`.
- Responsive three-pane shell (sidebar navigation + tree + editor) collapsing to a single column under 768 px, per `design_v2.md §10.1`.
- Authenticated system library: list, create blank/clone/import, archive, recover.
- Single-document draft editor with debounced autosave, expected-revision conflict recovery, server-backed assessment diagnostics, keyboard-first navigation.
- Editors for every field kind in `SystemDocumentV1` (scalar, choice, boolean, resource, computed, image reference), with stable-ID handling and immediate server validation.
- Single-column sheet section/order editor with move controls and complete keyboard operation; no drag-only, no grid layout.
- Editors for action roll source (grammar v0.1), resource bump, validation rule (expression), and reference datasets.
- Deterministic sample-data preview that renders the sheet against a snapshot returned by `previewDraft`, evaluated at phone and desktop widths.
- Validation reporting that links diagnostics to the responsible editor and prevents publishing when `invalid_package` diagnostics are present.
- Publish confirmation, semantic-version selection, release-notes input, version history, deprecation, package export download, and clone-from-template (the three I1 reference fixtures).
- Browser and accessibility tests using Playwright + `@axe-core/playwright`, component tests with Vitest + React Testing Library, and Playwright visual regression at 360 and 1280 px.

**Out of scope (explicitly deferred):**

- Production OIDC adapter (Google, Apple, etc.). The dev sign-in route is the only sign-in path; production wiring is a separate design review.
- Player sheet, Player PWA, GM session board, campaign flows, character state, and offline mutation queue. These belong to I3–I7.
- Visual regression cloud service (Chromatic, Percy). Visual regression uses Playwright's built-in `toHaveScreenshot()` against committed baselines.
- A general-purpose rich-text editor. All editors operate on typed schema fields and grammar v0.1 expressions only.
- Theme switching (light/dark), RTL layout, actual translation catalogs. i18n routing is in place; catalogs are not.
- Third-party launch templates. Clone-from-template is limited to the three I1 reference fixtures until `design_v2.md §18.2` OD-08 license review clears candidates.
- Reordering by drag-and-drop. All move operations use explicit keyboard buttons per `design_v2.md §17.4` Task 4.
- Native mobile wrappers, app-store submission, push notifications, or background sync.
- A backend OpenAPI authoring UI. The OpenAPI artifact is generated, not edited.

## 3. Constraints and design rules

Follows `design_v2.md` sections 10, 11.1, 11.2, 11.4, 13, 14, 15, 16, 17.4:

- One Module Interface per backend Module; the web client is a thin caller of those Interfaces via HTTP. No client-side reimplementation of authorization, validation, transaction ordering, or budget enforcement.
- The web client sends and receives only what the OpenAPI artifact documents. Generated TypeScript types are the only types the client imports for HTTP payloads.
- Generated HTTP client is generated, not hand-written. The single hand-written file wraps `fetch` with cookie credentials, request IDs, and a typed error envelope.
- All user-visible strings route through a typed `t(id, params?)` function backed by a default English message table. No JSX literal English outside the message table.
- WCAG 2.2 AA for every critical flow (per `§10.4`): keyboard reachability for every action, visible focus, label-name association, contrast ratios, no drag-only controls.
- Every action has a documented keyboard shortcut. The status bar lists available shortcuts for the current view.
- Autosave is debounced (default 600 ms) and only fires when the document's structural content actually changes. The client always carries the latest `expectedRevision` and merges server assessments idempotently.
- Conflict recovery uses the `409 latestRevision` envelope: the editor shows a non-blocking banner with "Their changes" and "Your changes" previews, plus accept-theirs / keep-mine / merge-into-server actions. No silent overwrite.
- Display strings are separate from stable IDs. A rename of a label never changes a definition ID.
- Structured allow-list logging on the client: never log session tokens, draft documents, or expression source; surface request IDs in error toasts.
- Phone rendering (360 px) and desktop rendering (1280 px) are both first-class; the builder must be usable end-to-end on a phone, including publish.
- Frontend tests assert observable behavior (rendered text, ARIA, accessible name, keyboard activation) rather than implementation details (CSS class names, component tree depth).
- The dev sign-in route is gated on `NODE_ENV !== "production"` at the bootstrap. The web client routes to it only when `import.meta.env.MODE === "development"`.

## 4. Architecture

The web client is one Vite-built SPA at `web/`. The backend stays a single Fastify process; the SPA is served as static assets from `web/dist/` in production and proxied through Vite in development. The web client is structured into four packages under `web/src/`:

```text
web/
  index.html
  vite.config.ts                # /api proxy → backend; PWA plugin; TS strict; CSS Modules
  tsconfig.json                 # NodeNext, exactOptionalPropertyTypes, verbatimModuleSyntax
  package.json
  src/
    main.tsx                    # mount, hydrate router
    router.tsx                  # TanStack Router route tree
    api/
      schema.d.ts               # GENERATED from docs/contracts/openapi-v1.json
      client.ts                 # typed fetch wrapper (credentials, request IDs, error envelope)
      hooks.ts                  # TanStack Query hooks wrapping every endpoint
    i18n/
      index.ts                  # t(id, params?) — typed message lookup
      messages.ts               # default English message table
    shell/
      AppShell.tsx              # three-pane layout, breakpoint switching, focus management
      NavSidebar.tsx            # system library, templates, account
      TreePanel.tsx             # entity/sheet/action tree, keyboard reordering
      EditorPanel.tsx           # active editor + diagnostics drawer
      StatusBar.tsx             # request ID, conflict banner, shortcut hints, connection state
      ErrorBoundary.tsx         # fault-containment per route
      DevSignInPanel.tsx        # dev-only
    library/
      SystemLibrary.tsx         # list, filter, lifecycle actions
      CreateDraftDialog.tsx     # blank / clone / import
      CloneFromTemplate.tsx     # the three reference fixtures
    editor/
      DocumentEditor.tsx        # orchestrator: tabs for metadata/entities/sheets/actions
      MetadataEditor.tsx
      fields/
        ScalarFieldEditor.tsx
        ChoiceFieldEditor.tsx
        BooleanFieldEditor.tsx
        ResourceFieldEditor.tsx
        ComputedFieldEditor.tsx
        ImageFieldEditor.tsx
      sheet/
        SheetEditor.tsx         # single-column section/order editor, keyboard move
        SectionEditor.tsx
        ElementEditor.tsx       # heading | field | resource | action-button
      actions/
        RollActionEditor.tsx    # grammar v0.1 source + inputs + output template
        ResourceBumpEditor.tsx
      validations/
        ValidationEditor.tsx    # expression source + severity + message
      referenceData/
        ReferenceDataEditor.tsx # typeId + records list
      expressions/
        ExpressionEditor.tsx    # shared expression source editor (grammar v0.1)
        ExpressionDiagnostics.tsx
      id/
        DefinitionIdInput.tsx   # stable ID, with auto-derive from label
    preview/
      PreviewFrame.tsx          # mounts PreviewSheet at 360 or 1280
      PreviewSheet.tsx          # renders the package against embedded sample data
      sampleData.ts             # deterministic sample-character generator per package
    publish/
      PublishDialog.tsx         # semver, release notes, breaking-change warnings, confirm
      VersionHistory.tsx        # list, deprecate, export
    state/
      documentReducer.ts        # local document mutations + autosave trigger
      draftSync.ts              # debounced PUT /systems/:id/draft with optimistic + reconciled
      conflictRecovery.ts       # 409 latestRevision handling
    testing/
      setup.ts                  # RTL config, MSW handlers for tests, axe
```

The four packages map onto the §17.4 tasks but are co-located so cross-cutting concerns (preview consumes editor state, publish consumes diagnostics from every editor) stay in one workspace:

- **shell** — App shell, navigation, fault containment, request-ID correlation (Task 1)
- **library** — System library, draft creation, clone-from-template, archive (Tasks 2 and 8)
- **editor** — Document tree and every typed editor, sheet editor, autosave, conflict recovery (Tasks 2–7)
- **preview** — Snapshot-driven preview at 360/1280 against deterministic sample data (Tasks 6, 7)
- **publish** — Publish confirmation, semver, release notes, version history, deprecation, export (Task 8)
- **state** — Reducer, debounced autosave, conflict recovery helpers (cross-cutting; Tasks 2, 7)
- **api** + **i18n** — Generated types, typed fetch wrapper, message routing (cross-cutting; Task 1)
- **testing** — Vitest + RTL setup, MSW handlers, axe helpers (cross-cutting; Task 9)

## 5. Backend additions

### 5.1 OpenAPI artifact

The TypeBox schemas already used to decode request and response bodies are the source of truth. The existing `scripts/generate-system-contracts.ts` extends to:

1. Walk every Fastify route registered in `src/transport/http/index.ts`.
2. For each route, read the `schema` property holding TypeBox request body, querystring, params, response, and the response status codes.
3. Emit `docs/contracts/openapi-v1.json` as OpenAPI 3.1 with `info.version = "1.0.0"` and `info.title = "Sweetroll HTTP API"`.
4. Emit `web/src/api/schema.d.ts` via `openapi-typescript` from the same artifact.

The new `npm run contracts:check` invariant asserts both files are up to date and committed. Routes without a TypeBox schema fail the check.

### 5.2 Dev sign-in route

`src/transport/http/dev-signin.ts` exposes:

- `POST /dev/signin` — body `{ code: string; redirectUri: string }`. Resolves through `Identity.completeSignIn` and sets the session cookie via the existing auth hook machinery. Returns `{ userId, displayName, expiresAt }`. Gated on `NODE_ENV !== "production"`; the route handler short-circuits to 404 otherwise.
- `GET /dev/signin/codes` — returns the seeded `Map<string, VerifiedClaims>` so the dev panel can render "Available codes" in development only.

The bootstrap wires `createTestOidcClient(seededCodes)` instead of an empty map when `NODE_ENV !== "production"`. The seeded map carries one entry: `{ "code-dev": { displayName: "Dev User", email: "dev@example.com", provider: "test", subject: "dev-1" } }`. Additional entries can be added per environment without code changes.

The web client renders a `DevSignInPanel` only when `import.meta.env.MODE === "development"`, posts to `/dev/signin`, and redirects to the system library. Production builds tree-shake the panel and the `/dev/signin` routes out.

## 6. Application shell (Task 1)

- `AppShell` is the route root for every authenticated page. It establishes the `AuthContext` (a React context wrapping TanStack Query auth state), the `QueryClient` (default 30 s stale time, 5 min gc, refetch on window focus off for write-heavy queries), and the `RouterProvider`.
- Layout uses CSS Grid: `grid-template-columns: 240px minmax(280px, 360px) 1fr` on viewports ≥ 1024 px. Below 768 px the grid collapses to one column and the `TreePanel` becomes a slide-over reachable from a sticky header button. Between 768 px and 1023 px the layout shows sidebar + editor; the tree is a tab in the editor header.
- Focus management: every navigation moves focus to the editor's first heading. Modal dialogs trap focus and restore on close. All Radix primitives are wrapped in a small `A11y` adapter that adds a consistent `data-testid` and a `useShortcut` hook.
- Status bar shows: current route, request ID of the most recent server call, connection state (online/offline, last sync), and a discoverable shortcut help dialog (`?`).
- Fault containment: every route is wrapped in an `ErrorBoundary` that renders a recoverable error card with the request ID, a "Retry" button, and a "Copy diagnostics" clipboard action.
- Generated HTTP client (`web/src/api/client.ts`) wraps `fetch` with: `credentials: "include"`, JSON encode/decode, `x-request-id` header propagated to server (the server already echoes it), typed error envelope `{ error: { code, message, ... }, requestId }`, and a single `ApiError` class with `code`, `message`, `status`, `requestId`.
- TanStack Query keys are typed by `QueryKey = ["system" | "version" | "library", ...args[]]` so cache invalidation stays mechanical.
- TanStack Router uses file-based route trees under `web/src/routes/` only if ergonomics help; an inline route object tree is acceptable.

## 7. System library and draft creation (Task 2)

- `/library` lists systems owned by the current user with cursor pagination, filter by lifecycle, and keyboard navigation (`j`/`k` row, `Enter` open, `a` archive, `Shift+A` recover).
- "New system" dialog offers three sources: blank (asks for a name; default "Untitled system"), clone (asks for a target version; lists the user's published versions), import (asks for a paste of a `SystemExportV1`; validates size against the 1 MiB ceiling before submit).
- "Clone from template" submenu lists the three I1 reference fixtures by name and short description; selecting one calls `POST /systems` with `source: { kind: "clone", versionId: <reference fixture versionId> }`. The reference fixtures are seeded as published versions for the system identity `system-templates` on first boot (a small migration inserts three rows if absent; subsequent boots no-op).
- Each row exposes "Archive" / "Recover" toggles that call `PATCH /systems/:id` and optimistic-update the cache.
- Navigation history is recoverable: every navigation pushes to TanStack Router history; `Alt+Left` returns to the library without losing in-progress edits.

## 8. Document editor (Tasks 3–7)

### 8.1 Layout

`/systems/:systemId` opens the active document. Layout:

- Header: system name (inline edit), language, lifecycle badge, autosave status ("Saved 2 s ago" / "Saving…" / "Conflict — review"), "Preview", "Publish", "Export", "Archive" actions.
- Tabs: Metadata, Entities, Sheets, Actions, Validations, Reference data. Each tab is its own route so deep links work.
- Within a tab, the left column lists entities / sheets / actions / datasets; the right column is the editor for the selected item. Single column on phone, tabs become a stacked accordion.

### 8.2 Autosave and conflict recovery

- Local document state lives in `documentReducer.ts`. Every reducer produces the next `SystemDocumentV1` plus a content-hash. `draftSync.ts` debounces 600 ms, then issues `PUT /systems/:id/draft` with the latest `expectedRevision` (null on first save).
- On `200 ok`, the reducer stores the new revision, latest server assessment, and diagnostics.
- On `409 latestRevision`, the editor shows a non-blocking banner with both documents (a textual diff using the canonical package layout, not the raw JSON). Three buttons: "Reload theirs", "Keep mine (force save)" (sends `expectedRevision: null`), "Merge into server" (sends `expectedRevision: latestRevision` with the local content — the server accepts because we know we match the revision now).
- On `422 invalid_package`, the assessment panel lights up; the publish button is disabled; field-level diagnostics are linked to their editors via anchor scroll and a highlight ring.
- On network error, the editor keeps editing; a "Reconnect & retry" banner appears; the debounced save retries with exponential backoff capped at 30 s.

### 8.3 Field editors (Task 3)

One component per field kind, all sharing a `useFieldEditor` hook that wires label / help / server diagnostic / stable ID:

- `ScalarFieldEditor` — `text | integer | decimal` with type-appropriate input, min/max where the schema allows.
- `ChoiceFieldEditor` — single + multi; options come from either a fixed array or a reference dataset; both paths expose an inline reference picker.
- `BooleanFieldEditor` — tri-state (true / false / unset) with accessible switch.
- `ResourceFieldEditor` — current + max bindings, optional bounds, optional reset rule; the "reset" rule reuses `ExpressionEditor`.
- `ComputedFieldEditor` — result type selector + `ExpressionEditor`; declared fallback is editable.
- `ImageFieldEditor` — image reference (kind placeholder for I2; full upload lands with character increments).

Every editor exposes a stable-ID input. Renaming the label does not touch the ID. Renaming the ID requires confirmation and a breaking-change warning ("This ID is referenced by N sheets / actions / validations. Renaming will break them.").

### 8.4 Sheet section/order editor (Task 4)

- Single column. Sections are an ordered list with explicit "Move up" / "Move down" buttons (keyboard `Alt+Up` / `Alt+Down`) and a number badge showing the position.
- Within a section, elements are an ordered list with the same move controls.
- Add / remove controls use Radix `AlertDialog` for destructive confirmations.
- No drag-and-drop, no grid layout, no conditional display.
- Reordering triggers a single debounced save with the new ordered arrays. The sheet preview reflects the new order within the same save round-trip.

### 8.5 Expression, action, validation, reference-data editors (Task 5)

- `ExpressionEditor` is a textarea backed by the grammar v0.1 tokenizer (reuses the I1 `src/systems/implementation/rules/tokenizer.ts` via a thin client port — exposes only `tokenize(source): { ok: true, tokens: Token[] } | { ok: false, diagnostics: PackageDiagnostic[] }`). Live underline diagnostics for parse and a "Check" button that asks the server for a full assessment.
- `RollActionEditor` wraps `ExpressionEditor` for the roll source and adds inputs (typed list), output template (string with `{inputs.X}` placeholders), and a small "Try it" button that runs the roll against the embedded sample data using the same I1 evaluator port.
- `ResourceBumpEditor` selects one resource, an integer delta, an optional bound, and an optional reset rule.
- `ValidationEditor` selects severity (`error` / `warning`), an `ExpressionEditor` for the condition, and a message key (typed against the i18n table).
- `ReferenceDataEditor` lists records; each record is a row of typed scalar cells keyed by `typeId`. Inline add / remove rows.

### 8.6 Preview and sample data (Task 6)

- `PreviewFrame` mounts `PreviewSheet` at 360 px or 1280 px (a toggle in the editor header, also `Alt+P`).
- `PreviewSheet` renders the sheet structure defined in the package: heading, bound scalar field, resource with current/max display, computed value, action button (which opens a compact roll-result sheet showing dice, modifiers, total, audience — but only for the *preview*: the real player roll is I3/I5).
- `sampleData.ts` is a deterministic generator: given a `SystemPackageV1`, it produces one `Character`-shaped record per entity type with: scalar fields at their default, choices at their first option, booleans at `false`, resources at `current = max`, computed fields at the declared fallback. Computed fields are then evaluated against this sample using the same evaluator port. The same package yields the same sample on every load (no random).
- Preview always renders against a `previewDraft` snapshot, never the mutable draft, per `design_v2.md §17.4` Task 6. The frame displays a "Preview of revision N — expires in HH:MM" banner.

### 8.7 Validation reporting (Task 7)

- A persistent diagnostics drawer on the right edge of the editor (collapse / expand, `Alt+D`) lists every diagnostic from the latest server assessment. Each row has the diagnostic code, message, and a "Jump to" button that focuses the responsible editor and scrolls it into view.
- The publish button is disabled when any diagnostic with `severity: "error"` exists. Warnings show a confirmation step on publish.

## 9. Publish, version, template flows (Task 8)

- `PublishDialog` requires: semver (typed input with "Patch" / "Minor" / "Major" buttons defaulting based on a server hint computed by `comparePackages` against the previous version), release notes (textarea), expected revision.
- It shows the breaking-change findings returned by the server (e.g., `breaking_removed_definition`, `breaking_required_added`, `breaking_type_change`) as a list with links to the affected editors; the dialog requires confirmation per breaking finding.
- "Confirm publish" issues `POST /systems/:id/publish`. Success replaces the dialog with a "Published v1.2.3" card including the new version ID, checksum, and "View versions", "Export", "Close" actions.
- `VersionHistory` lists every published version for the system with lifecycle, semver, created date, and actions: export (downloads `application/vnd.sweetroll.system+json;version=1`), deprecate (calls `PATCH /system-versions/:versionId` with `lifecycle: "deprecated"`), and "Clone into new system".
- Clone-from-template flows use the same `clone` source against the seeded reference fixture versions.

## 10. Visual direction

Linear-inspired, dense but readable, neutral palette, single accent:

- **Typography:** system font stack `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Inter, sans-serif`; monospace `ui-monospace, "JetBrains Mono", SFMono-Regular, Menlo, monospace` for IDs and expression source. Base 14 px / 1.5 line-height; headings 16/20/24.
- **Color:** light theme only in I2 (dark theme deferred). Neutral grays from `#FAFAFA` (background) through `#171717` (foreground); single accent `#4F46E5` (indigo-600) for primary actions and focus rings. Error red `#DC2626`, warning amber `#D97706`, success green `#059669`. Contrast meets WCAG AA.
- **Spacing:** 4 px base grid; common increments 4/8/12/16/24/32. Editor field stack uses 12 px row gap.
- **Radius:** 6 px for inputs, 8 px for cards, 12 px for dialogs. No shadows on inputs; subtle shadow on popovers.
- **Density:** one row of a list ~ 36 px; an editor field row ~ 56 px. Sheet preview mirrors the player sheet density (will align with I4 when I4 ships).
- **Iconography:** `lucide-react` for outline icons at 16 px (inline) and 20 px (toolbar). No emoji in UI chrome.

## 11. Accessibility and i18n

- Every interactive element has an accessible name (Radix primitives plus explicit `aria-label` where the visible label is ambiguous).
- Focus rings: 2 px solid accent + 2 px offset. `focus-visible` only; no focus ring on click.
- Keyboard: every action has a `useShortcut` registration surfaced in the help dialog (`?`) and the status bar tooltip.
- i18n: every user-visible string is keyed (`t("library.createDraft")`, `t("editor.publish.disabled.reason", { diagnostics: 3 })`). The default English message table ships with I2; no other locale is provided. The function falls back to the key with a console warning in development if a key is missing.
- Pluralization uses `Intl.PluralRules`. Numbers, dates, and relative times use `Intl.NumberFormat` / `Intl.DateTimeFormat` / `Intl.RelativeTimeFormat`. Default locale from the user profile (`users.locale`).

## 12. Testing strategy (Task 9)

- **Component tests (Vitest + React Testing Library):** every editor renders a labeled field, accepts input, calls the reducer with the expected action, and reflects server diagnostics. Use MSW to mock the HTTP layer.
- **Hook tests (Vitest):** autosave debounce, conflict recovery merge paths, `t()` fallbacks, `useShortcut` key handling.
- **End-to-end (Playwright):** the acceptance demonstration below plus regression flows for archive/recover, clone-from-template, import/export round-trip, and 409 conflict recovery.
- **Accessibility (axe):** every Playwright test runs `@axe-core/playwright` on the route and asserts no violations of severity ≥ "serious".
- **Visual regression (Playwright `toHaveScreenshot`):** baselines committed under `web/tests/visual/__screenshots__/` for the library, document editor (d20 fixture loaded), sheet preview at 360 and 1280, publish dialog, and conflict-recovery banner. Playwright writes new baselines on first run in CI; subsequent runs diff against the committed baseline.
- **Browser matrix:** Chromium only in I2 CI; Firefox and WebKit covered by Playwright nightly scheduled runs (documented as a follow-up).
- **No SQL in frontend tests.** Frontend never connects to PostgreSQL directly; backend integration tests remain the system-of-record.

## 13. Phased implementation plan (overview)

The implementation plan (delivered by `writing-plans`) breaks I2 into eight phases. Each phase ends with green typecheck, unit + integration + Playwright suites, and a one-paragraph closure commit. Phases are ordered so each is independently demoable:

| Phase | §17.4 tasks covered | Deliverable / demo gate |
|-------|----------------------|---------------------------|
| **I2-A Foundation** | Task 1 (skeleton only), Task 1 (OpenAPI), Task 1 (dev sign-in) | Vite app boots, dev sign-in round-trips a cookie, generated client compiles, OpenAPI artifact committed. |
| **I2-B Shell + library** | Task 1 (full), Task 2 (library + draft creation + archive) | Empty three-pane shell; library list + create blank / clone / import / clone-from-template. |
| **I2-C Metadata + simple field editors** | Task 3 (metadata, scalar, choice, boolean, image) | Entity type with name + 3 fields editable end-to-end; round-trip save to server. |
| **I2-D Resource + computed + sheet editor** | Task 3 (resource, computed), Task 4 | Sheet section/order editor, resource field, computed field with expression. |
| **I2-E Expression editor + action + validation + reference-data** | Task 5 | Grammar-v0.1 expression editor with live diagnostics; action roll editor with "Try it"; validation rule editor; reference-data editor. |
| **I2-F Preview + sample data + diagnostics drawer** | Tasks 6, 7 | Preview at 360 / 1280 from `previewDraft` snapshot; diagnostics drawer links to editors; publish disabled when errors exist. |
| **I2-G Publish + version history + deprecation + export + clone-from-template** | Task 8 | Publish dialog with breaking-change gate; version history; deprecate; export download. |
| **I2-H Test pass + acceptance demo** | Task 9 | All Playwright suites pass with axe; visual baselines committed at 360 and 1280; acceptance demonstration recorded. |

Each phase adds a dedicated top-level file under `docs/acceptance/i2-<phase>-YYYY-MM-DD.md` summarizing the demo. The full I2 acceptance demonstration lands at `docs/acceptance/i2-2026-MM-DD.md`.

## 14. Acceptance demonstration

Following `design_v2.md §17.1` and the §17.4 acceptance line, a non-programmer must be able to perform the following flow using only the web client, with all evidence captured by Playwright:

1. Sign in (dev sign-in panel in development; production sign-in stubbed for the recording).
2. Open the system library, pick "Clone from template → d20 sample", land in the document editor with a fresh draft at revision 1.
3. Rename the system, add a new entity called "Companion" with two scalar fields (`name` text, `loyalty` integer with min 0 / max 5).
4. Add a new sheet section "Companion" with two bound elements (the two new fields).
5. Add a "Pet check-in" validation: `fields.loyalty >= 3`, severity `warning`, message key `editor.validations.petCheckIn`.
6. Open the preview at 360 px and 1280 px; both render the new section.
7. Resolve the one warning diagnostic (set `loyalty` to a value < 3) so the document is publishable.
8. Publish `1.0.0` with release notes; the version history shows the new version; export downloads the JSON envelope; checksum matches.
9. Make a destructive change (delete the `Companion` entity), save, attempt to publish `1.1.0`; the publish dialog lists the breaking-change finding and the publish is blocked.
10. Restore the entity via undo, publish `1.1.0` cleanly.

The recording (`docs/acceptance/i2-2026-MM-DD.md`) links the Playwright trace, axe report, and visual baselines.

## 15. Files and source layout (summary)

New:

- `docs/contracts/openapi-v1.json` — generated OpenAPI artifact.
- `web/` — Vite SPA.
- `web/src/api/schema.d.ts` — generated client types.
- `src/transport/http/dev-signin.ts` — dev-only sign-in route.
- `migrations/0008_seed_system_templates.sql` — three reference fixtures published under `system-templates`.

Modified:

- `src/transport/http/index.ts` — add `buildDevSignInRoutes`; wire into app only when `NODE_ENV !== "production"`.
- `src/bootstrap/http.ts` — register dev routes + use seeded test OIDC client in non-production.
- `src/platform/config.ts` — read `NODE_ENV`.
- `scripts/generate-system-contracts.ts` — emit OpenAPI artifact + `web/src/api/schema.d.ts`.
- `package.json` — add `web` workspace script (`dev`, `build`, `preview`, `test`, `test:e2e`, `test:visual`); add new deps under `web/package.json`.
- `.gitignore` — ignore `web/dist/`, `web/node_modules/`, `web/test-results/`, `web/playwright-report/`.
- `README.md` — `npm run dev` runs backend + web together; how to run acceptance demo.
- `compose.yaml` — optional `web` service for full-stack dev.

## 16. Open questions deferred

- Production OIDC adapter selection (deferred per `design_v2.md §18.2` OD-05).
- Dark theme — explicitly out of I2; will land with I4's player sheet if requested.
- i18n catalog beyond default English — out of I2.
- Three reference fixtures are the only clone-from-template options until OD-08 license review clears candidates.