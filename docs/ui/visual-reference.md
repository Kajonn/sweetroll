# Visual reference and route inventory (G0)

**Status (2026-09-24):** original G0 inventory retained as dated history below; current implementation snapshot added here after merged PR #12. Source-mockup capture remains open.
**Plan:** `docs/superpowers/plans/2026-09-08-gui-integration.md` G0.
**Baseline:** `8302bd0` (worktree `docs/g0-reference-and-frontend-checks`).
**Date checked:** 2026-09-08.

## Current implementation snapshot (2026-09-24)

Merged PR #12 (`a2510fb`, merge `29aa782`) gives the app a Tablefolk-inspired visual style. These values are from the **Sweetroll implementation**, not a claim that each exact value was approved from a source screenshot:

| Role | Light | Dark |
| --- | --- | --- |
| Page / panel | `#f6f8f5` / `#ffffff` | `#112522` / `#19352f` |
| Primary / muted text | `#183b37` / `#52655c` | `#edf5ec` / `#bfd1c6` |
| Border / primary action | `#d9e2d8` / `#224b40` | `#34564b` / `#d9ee94` |
| Focus | `#4f6f21` | light accent (`#d9ee94`) |

The body uses the system UI font at 15px/1.55; controls and panels use 6–16px radii and tokenized shadows. `AppShell` now has a white sticky header on tablet/desktop, a horizontally scrollable header navigation on phones, and a narrow player bottom bar; feature views own their columns. The home route presents three starter systems as cards on a sage panel. Creator and character surfaces use the shared tokens. Light, Dark, and Follow device remain device/account display preferences; systems and sheets have no theme field or theme picker.

The route inventory in Section 4 is the **2026-09-08 baseline**. Current `web/src/router.tsx` additionally routes the player library, onboarding, account, invitations, campaigns, campaign detail/scenes, and paired display. The historical sections below remain useful for understanding the migration but must not be read as today's UI structure.

The ten checked-in files under `web/tests/visual/__screenshots__/visual.spec.ts/` are **Sweetroll application screenshots**, reviewed at 360 and 1280px for library, d20 editor, sheet preview, publish dialog, and conflict banner. PR #12 CI passed all web, offline, visual, journey, and verification jobs. This does not establish every view/theme/device combination in G9. No screenshot of the **source mockup** has been committed under `docs/ui/reference/`; earlier direct URL checks returned HTTP 401 (last recorded 2026-09-17), while an owner-backed mockup view was visually inspected for the refresh. G0 source archiving and G9 real-device/playtest/deployment checks remain open.

The remainder of this file describes the original G0 baseline unless it explicitly states a later date.

## 1. Mockup availability

Visual reference target: Tablefolk GUI mockup
(`https://tablefolk-ttrpg-mockups.humdrumrat.chatgpt.site`).

- Direct fetch on 2026-09-08 returned **HTTP 401**. No authenticated
  access was available for that original baseline check.
- Therefore, at that original baseline, **no mockup screenshots were stored**
  under `docs/ui/reference/`, and no mockup spacing, typography, color roles,
  navigation, hierarchy, or interaction states were recorded.
- Per G0, unavailable reference views were recorded rather than inventing
  approved details. PR #12 later implemented the visual refresh from an
  inspected owner-backed reference; the exact source capture remains open.

What the original G0 sections record instead is the reviewable **then-current
app baseline** (tokens, shell, routes) so G1/G2 had a concrete starting
point without depending on the hosted prototype.

## 2. Original token baseline (`web/src/styles/global.css`, 2026-09-08)

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

## 3. Original shell baseline (`web/src/shell/AppShell.tsx`, 2026-09-08)

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

## 4. Original route inventory (2026-09-08; existing routes remain usable)

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
(`web/tests/offline/character.spec.ts`); the `visual.spec.ts`
conflict banner was replaced with a real routed flow in `b5a2586`
(production `ConflictBanner` after a genuine 409; see §8). Theme switching must not remount editors or reset
character state (G2 exit).

## 7. Reference screenshots

`docs/ui/reference/` was empty at the original baseline and remains without
a checked-in source capture (see current snapshot above). When captures land, store representative views
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
