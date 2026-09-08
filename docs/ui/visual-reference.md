# Visual reference and route inventory (G0)

**Status:** inventory only. No visual redesign is claimed by this document.
**Plan:** `docs/superpowers/plans/2026-09-08-gui-integration.md` G0.
**Baseline:** `8302bd0` (worktree `docs/g0-reference-and-frontend-checks`).
**Date checked:** 2026-09-08.

## 1. Mockup availability

Visual reference target: Tablefolk GUI mockup
(`https://tablefolk-ttrpg-mockups.humdrumrat.chatgpt.site`).

- Direct fetch on 2026-09-08 returned **HTTP 401**. No authenticated
  access is available from this workspace.
- Therefore **no mockup screenshots are stored** under
  `docs/ui/reference/`, and no spacing, typography, color roles,
  navigation, hierarchy, or interaction states are recorded from the
  mockup in this revision.
- Per G0, unavailable reference views are recorded here explicitly
  rather than inventing approved details. Do not implement Tablefolk
  styling from memory. Revisit this file once authorized reference
  captures exist.

What this file records instead is the reviewable **current-app
baseline** (tokens, shell, routes) so G1/G2 have a concrete starting
point without depending on the hosted prototype.

## 2. Current token baseline (`web/src/styles/global.css`)

Observed `:root` values at this baseline:

- `--color-bg: #fafafa`, `--color-surface: #ffffff`
- `--color-fg: #171717`, `--color-fg-muted: #525252`
- `--color-border: #e5e5e5`
- `--color-accent: #4f46e5` (indigo; **not** the mockup's restrained
  green — G2 replaces this with semantic light/dark presets)
- `--color-accent-fg: #ffffff`
- `--color-error: #dc2626`, `--color-warning: #d97706`,
  `--color-warning-fg: #92400e`, `--color-success: #059669`
- `--font-sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI",
  Inter, sans-serif` at 14px / 1.5
- `--font-mono: ui-monospace, "JetBrains Mono", SFMono-Regular, Menlo,
  monospace`
- Radii: `--radius-sm: 4px`, `--radius-md: 6px`, `--radius-lg: 8px`,
  `--radius-xl: 12px`
- `:focus-visible` is a 2px `--color-accent` outline with 2px offset.

No semantic page/panel/primary/muted/border/focus token layer exists
yet. Feature CSS modules consume these literals directly. G2 introduces
semantic tokens and light/dark/Follow-device presets; this section is
the before-image.

## 3. Current shell baseline (`web/src/shell/AppShell.tsx`)

- `AppShell` owns: banner header (`data-testid="app-header"` with
  "Sweetroll" wordmark, plain `<a href="/characters/new">` link,
  sign-out button + `shell.signOut.*` status, `?` shortcut help),
  `main[role=main]` content region, `StatusBar` footer (random
  per-mount request-id, online flag), `ShortcutHelp` dialog,
  `ErrorBoundary`, dev-only `DevSignInPanel`.
- Layout (`AppShell.module.css`): grid rows `48px 1fr 28px`,
  `height: 100vh`. Content region is currently a **shared three-column
  grid**: `240px minmax(280px,360px) 1fr`, collapsing to `240px 1fr`
  under 1024px and `1fr` under 768px. G3 removes the assumption that a
  single routed child belongs in the first 240px column and lets each
  view own its internal columns.
- The shell does not own character/draft state; it provides
  `AuthContext` + `IdentityContext` (`IdentityGate`) and per-route
  `useCharacterCoordination` handles. G1 repairs sign-out/account-switch
  cleanup (cancel requests/timers, clear account-scoped queries, reject
  late responses) without changing this ownership.

## 4. Route inventory (existing routes remain usable)

Source: `web/src/router.tsx` (`rootRoute` wraps `AppShell` + `Outlet`).

| Route | Component | Milestone | G-plan | Notes |
| --- | --- | --- | --- | --- |
| `/` | `SystemLibrary` + `CloneFromTemplate` (`data-testid="library-route"`) | I2 done; G5 restyles | G0, G5 | Authenticated system library; template clone entry. E2E: `visual.spec.ts` library/editor/preview/publish baselines. Must remain usable; any URL change needs redirect + deep-link tests. |
| `/systems/$systemId` | `DocumentEditor` (`client`, `systemId`) | I2 done; G5 restyles | G0, G1, G5 | Draft metadata/sheets/actions/validations/reference editors, autosave (`useDraftSync`), conflict banner, preview frame, publish dialog, version history. G1 repairs dirty/conflict/save lifecycle before presentation changes. |
| `/characters/new` (+ optional `?systemVersionId=`) | `NewCharacterRoute` via `CharactersApi` + shared store + `IdentityGate` | I4 done; G4 polishes | G0, G1, G4 | Versionless entry lists creation-versions (`listCreationVersions`); exact-version deep link bypasses list via `loadMetadata`. Remount key: `creationViewKey(actorId, generation, systemVersionId)`. Manual UUID fallback remains (G4 moves it behind labeled disclosure). |
| `/characters/$characterId` | `CharacterDetail` (`api`, `store`, `identity`, `coordination`, navigation) | I4 done; G4 polishes | G0, G1, G4 | Projection-driven sheet, edits/bumps/actions/rolls, activity/tools/conflict/export/migration/recovery. Coordination handle is per-route-lifetime (`useCharacterCoordination`). |

No other product routes exist at this baseline. `DevSignInPanel`
mounts only when `import.meta.env.MODE === "development"`.

## 5. Platform navigation vs character content (constraint)

Per design Sections 4 and 10 and GUI plan G0:

- **Platform navigation (owned by shell / Player app):**
  I5 `Characters / Activity / Account` bottom navigation (mobile-first,
  platform-owned, thumb-reachable). `Campaigns` is added only in I6.
- **Character content (owned by projection):** single-column linear
  scroll — sticky identity + primary-resource summary, ordered
  attribute/description sections, flat action buttons, compact roll
  sheet (dice, modifiers, total, audience). System creators cannot add
  navigation destinations or split the linear sheet into tabs.
- **Do not copy** any prototype sheet tabs into creator-authored
  navigation. Creator pages own editor/preview panels (G5); player
  sheets own readable content widths (G3/G4).
- Future milestones reuse the same components, not a second design
  system: G6 (I5 onboarding/library/account/install), G7 (I6/I7
  campaigns + GM session board), G8 (I7b scenes/restricted display),
  each gated on its backend/media/display contracts.

## 6. Interaction states to preserve (G1–G4 checklist pointer)

Every view must implement loading, empty, validation, saving/pending,
disabled, offline, conflict, permission-denied, and error/retry states
with meaningful text — not color alone. Current coverage lives in
`CharacterRoute/CharacterSheet/FieldControl/ConflictReview`,
`DocumentEditor/MetadataEditor/draftSync`, and offline specs
(`web/tests/offline/character.spec.ts`); `visual.spec.ts` conflict
banner is still synthetic `page.setContent` and G0 replaces it with a
real routed flow. Theme switching must not remount editors or reset
character state (G2 exit).

## 7. Reference screenshots

`docs/ui/reference/` is intentionally empty in this revision (see
Section 1). When authorized captures land, store representative views
here with filename, source URL, capture date, and which details were
unavailable — and update this file. Do not commit prototype data or
simulated-service screens as production implementations.

## 8. G0 visual review findings (2026-09-08)

`web/tests/e2e/visual.spec.ts` no longer uses synthetic `page.setContent`
checks: the conflict-banner baseline now renders the production
`ConflictBanner` mounted by `DocumentEditor` after a genuine 409
(clone d20 fixture, settle mount autosave, rival `PUT
/systems/:id/draft` with the current revision, local rename so the
debounced autosave fires stale). Verified locally against real
Postgres + dev servers: 2/2 conflict tests pass with regenerated
`conflict-banner-{360,1280}.png`; the other 8 visual tests pass
unchanged against their committed baselines.

Reviewed the regenerated baselines before accepting:

- 1280px: full banner — warning icon, "modified by another save
  (revision 3)" message, Reload theirs / Keep mine (force save) /
  Merge into server, dismiss control. Correct.
- 360px: banner element measures ~605px in a 360px viewport
  (`documentElement.scrollWidth` stays 360, so the overflow is clipped
  inside the editor pane rather than scrolling the page). The baseline
  honestly captures this crop; it is **not** fixed here. G3 owns the
  view-owned-layout repair (phone forms must not clip or horizontally
  scroll); G1 lifecycle repairs come first per plan dependencies. Do
  not "fix" this baseline by hiding the overflow.
