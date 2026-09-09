# GUI integration implementation plan

**Status:** Planned; no GUI implementation is claimed by this document.  
**Design authority:** [design_v2.md](../../../design_v2.md), especially Sections 10 and 17.  
**Visual reference:** [Tablefolk GUI mockup](https://tablefolk-ttrpg-mockups.humdrumrat.chatgpt.site).  
**Original baseline:** `be3efc89b536f563c0f11f2f929171dd8129463b`.

**Reconciled baseline:** `d6bfd32b7016a3bdaf7d0b0585b7f4861f34374f` (after PR #1 merge and creation-picker work).

## Goal and boundaries

Bring the mockup's visual hierarchy, calm surfaces, clear navigation, compact character controls, and mobile usability to the existing Sweetroll application. Implement this incrementally in `web/`: retain React, TanStack Router/Query, CSS modules, Radix primitives, Lucide icons, generated API types, and the existing character projection/session model. Keep Sweetroll branding; Tablefolk is a visual reference rather than a product rename.

This is a frontend redesign with targeted lifecycle repairs, not a replacement application. Do not rewrite the backend, change published package formats, duplicate the rules interpreter or character renderer, discard offline queues, or import the mockup's simulated authentication, publishing, or browser-only synchronization. Preserve existing routes and data during migration.

A simple creator remains the default: attributes and descriptions, GUI dice configuration, ordered sheet sections, preview, and publish. Keep supported advanced capabilities behind progressive disclosure; this plan does not expand or remove grammar v0.1. It also does not change the existing offline contract, campaign policy decisions, or historical I1-I4 completion records.

The owner's previously requested GM phone/tablet display, manual fog, and token placement are explicitly scheduled as I7b. They require backend authorization and media work as well as UI; they are not a CSS task. No tactical grid, initiative, movement rules, vision, automatic lighting, combat simulation, arbitrary CSS, or theme editor is introduced.

## Reconciliation with the new commits

PR #1 and its CI scheduling fix are merged. The subsequent changes implement a character-creation version picker and add previously missing implementation-plan records. They do not implement the theme, shell redesign, complete I5 Player app, or GM/display milestones. Keep the delivery sequence below; reuse the new picker instead of rebuilding it.

| Change at the reconciled baseline | Impact on this plan |
| --- | --- |
| `2c07bae`, `e76de22`: creation-version listing, transport/error coverage, ordering checks, and generated OpenAPI/client schema | G4/G6 consume `GET /characters/creation-versions` through `CharactersApi.listCreationVersions()`; do not create another list endpoint |
| `b2e86c8`, `17a1630`: picker inside `CreateCharacter.tsx`, using one inline TanStack query and the existing `loadMetadata` path | Preserve versionless entry and exact-version deep links; keep the accepted inline API seam rather than recreating the abandoned standalone hook |
| `2376105`, `17f6a98`: picker component/browser coverage and spec addendum | Reuse these tests; add account/cache, empty/offline/retry, and visual acceptance coverage rather than duplicating the happy path |
| `d6bfd32`: creation-picker and I4-remediation plans added | These are implementation/history records, not instructions to restart completed I4 work. The picker plan's unchecked recipe and standalone-hook references need its reconciliation note |
| Merged `6cd1c3a`: integration files execute sequentially | Preserve `npm run test:integration` and its unchanged load limits when implementing G0; this does not satisfy the still-missing frontend CI job |

### Newly relevant acceptance gaps

1. **Picker account/cache lifetime (G1, before G4 acceptance).** Its query key is currently `["characters", "creation-versions"]`, with a 30-second stale time and no actor/generation. The route remounts for account changes, but that does not clear the shared QueryClient. The picker must participate in the same account cleanup as creator queries. Disabling a query while offline/signed out does not remove its existing results.
2. **Discovery versus use permission (OD-01, before G4 acceptance).** The new list returns other owners' `link` systems to any signed-in actor, because it copies the create-from-version predicate. That matches the current implementation tests but conflicts with an unlisted/link-only discovery model if OD-01 adopts it. Explicitly resolve which versions may be enumerated. Preserve server authorization for metadata lookup and creation, but do not assume that permission to use a known version implies permission to discover every such system. If links are unlisted, list only owned/explicitly discoverable systems and retain a separate authorized link entry path; add a second-account enumeration test. Do not silently close OD-01 based on the new endpoint.
  *Resolution note 2026-09-09 (OD-1, option A — unlisted/link-only):* OD-01 resolved as option A (unlisted/link-only). `GET /characters/creation-versions` enumerates only systems owned by the requesting actor plus explicitly discoverable (`public`) systems; other owners' `link`-access systems are excluded from enumeration. Permission to use a known version is unchanged — `creation-options` lookup, character creation, and migration from an exact version ID still authorize owner or `public`/`link` access — so a link shared out-of-band keeps working. Covered by the two-account owned/private/link/public matrix test in `tests/integration/character-creation-versions.test.ts`. Design record: `design_v2.md` §13. Picker polish under G4 below remains open; no G4 box is checked by this note.
3. **Picker completion (G4).** ~~The existing manual UUID fallback remains prominent, invalid UUID lookup can show an uncertain-outcome error for a definite 400 validation response, and the list has no bounded pagination.~~ *Closed 2026-09-09 (G4, `8d5f22a`):* picker is the primary entry with retry and a labeled manual fallback; 400/422 mapping was already definite-input-error (G1). Bounded server pagination still open — owned by G6 (library/catalog expansion).
4. **Contract reuse (G4/G6).** ~~OpenAPI and `schema.d.ts` include the new operation, but `CreationVersionEntry`/`CreationVersions` in `web/src/characters/types.ts` are hand-written. Derive them from `operations["get_characters_creation_versions"]` during integration so UI and server contracts cannot drift.~~ *Closed for the picker 2026-09-09 (G4, `8d5f22a`).* G6 pagination work must update generated contracts likewise.

These gaps are implementation work to perform under G1/G4/G6; this reconciliation changes documentation only. Existing editor/save, server revocation, production-authentication, frontend-CI, and deployment tasks remain open.

## Delivery sequence

| Work | Placement | Depends on | Completion evidence |
| --- | --- | --- | --- |
| G0: reference and frontend checks | Start of I4a | Existing I4 | Route/design inventory and CI exercising the real web package |
| G1: editor and account lifecycle repairs | I4a | G0 | Regression cases for dirty edits, conflicts, sign-out, account switching |
| G2: theme and shared controls | I4a | G0 | Light/dark controls, portal inheritance, accessible interaction |
| G3: responsive shell | I4a | G1, G2 | Existing routes use available width and preserve session state |
| G4: polished character play journey | I4a | G3 | Real character edit/roll/offline/recovery journey on phone and desktop |
| G5: simple creator workflow | I4a | G1, G3; reuse G4 patterns | Create, preview, save, reopen, publish using the real API |
| G6: complete Player app | I5 | I4a | Character library, onboarding, account and installation journeys |
| G7: campaign and GM views | I6/I7 | I5, campaign contracts | Authorized player content and mobile GM operation |
| G8: images, scenes and restricted display | I7b | I7, media/display contracts | Phone controls a separate tablet safely; fog and tokens persist |
| G9: release acceptance | Applied per phase; final after I7b | Applicable work above | Built-artifact, real-device, accessibility and playtest evidence |

I4a is a follow-up increment, not a claim that the new work was covered by earlier I4 acceptance. G1 and G2 can proceed independently after G0; integrate both before migrating protected routes. Do not begin I5 feature expansion until I4a passes. G7/G8 use the same components rather than starting a second design system.

## G0 — Capture the reference and establish frontend checks

**Existing files:** `.github/workflows/ci.yml`, `web/package.json`, `web/playwright.config.ts`, `web/playwright.offline.config.ts`, `web/tests/e2e/visual.spec.ts`, `docs/acceptance/`.

- [ ] Capture representative mockup views and record spacing, typography, color roles, navigation, content hierarchy, and interaction states in `docs/ui/visual-reference.md`. Store selected reference screenshots under `docs/ui/reference/` so implementation does not depend solely on a hosted prototype. Record unavailable reference views explicitly rather than inventing approved details.
- [ ] Map every view to an existing or proposed route and milestone. Existing `/`, `/systems/$systemId`, `/characters/new`, and `/characters/$characterId` must remain usable. Any later URL change needs a redirect and deep-link tests.
- [ ] Distinguish platform navigation from character content. Retain the linear projection-driven sheet and I5 Characters/Activity/Account navigation; add Campaigns only in I6. Do not copy prototype sheet tabs into creator-authored navigation.
- [x] Preserve the merged integration-file isolation fix (`6cd1c3a`): `npm run test:integration` uses `--no-file-parallelism`; request concurrency and latency budgets remain enforced.
- [ ] Add a required web CI job with its own lockfile cache and `npm ci`, `npm test`, `npm run typecheck`, and `npm run build` in `web/`; retain backend checks and add root `npm run contracts:check`.
- [ ] Wire representative routed browser tests and the existing production-offline suite into CI with their actual database/server prerequisites. Verify a deliberate frontend failure fails the check.
- [ ] Replace synthetic `page.setContent` visual checks for product states with real routed flows. Review baselines visually before accepting changes.

**Exit:** the reference and route inventory are reviewable, and green CI includes the frontend. No claim of visual completion is based solely on screenshot similarity.

## G1 — Repair the lifecycle before changing its presentation

**Existing files:** `web/src/editor/DocumentEditor.tsx`, `MetadataEditor.tsx`, `web/src/state/draftSync.ts`, `web/src/shell/AppShell.tsx`, `web/src/api/listSystems.ts`, `openSystem.ts`, `web/src/characters/identity.ts`, `CreateCharacter.tsx`, `web/src/router.tsx`, `src/transport/http/identity.ts`, `src/identity/index.ts`.

- [ ] Reproduce the review findings against the current branch before repairing them. Use regression cases through actual components and HTTP contracts.
- [ ] Establish one working editor document with server baseline, dirty state, pending save, and explicit conflict state. Serialize saves; preserve edits made during a save or before a debounced save. Adopt server refreshes only when clean or after an explicit resolution.
- [ ] Make metadata inputs follow that working document. Do not reset only a baseline ref while leaving stale visible input state.
- [ ] Make conflict actions accurate: reload server, or explicitly replace against the current revision. A whole-document overwrite must not be called Merge; implement a three-way merge only if retaining that action. Do not send null as a force-save revision.
- [ ] On sign-out/account switch, unmount protected views, cancel requests and draft timers, clear account-scoped queries/mutations, and reject late responses from previous identities. Preserve the character subsystem's deliberate offline identity boundaries.
- [ ] Include the creation-version picker in account/generation-scoped queries, cancellation, and cleanup. Render no cached account-A names or IDs after remounting for account B or sign-out; guard late list responses and disable selection when offline or a creation/recovery operation blocks a new choice. Keep existing durable creation-attempt guards intact.
- [ ] Return a retryable error when server session revocation fails; keep reliable retry credentials and the pending-logout barrier while hiding local private data immediately. Distinguish unavailable session storage from invalid credentials.

**Exit tests:** local edit plus server refetch; edit during a slow save; reload updates visible inputs; conflict replacement uses the correct revision; route change with pending work; account A response arriving after B signs in; private data absent after sign-out; revocation failure does not return success; cached picker results across account remount/sign-out and late responses; reconnect/revoked-version selection. These fixes are required before the relevant views are considered polished.

## G2 — Theme tokens and shared controls

**Existing files:** `web/src/styles/global.css`, existing CSS modules and Radix wrappers.  
**Suggested new areas:** `web/src/ui/` and `web/src/theme/`; keep them within the current application.

- [ ] Define semantic tokens for page/panel surfaces, primary/muted text, borders, primary actions, focus, error/warning/success, typography, spacing, radii, shadows, and layering. Feature styles consume tokens rather than literal palette colors.
- [ ] Ship light and dark presets with the mockup's restrained green accents, readable type, rounded panels, and clear action hierarchy. Offer Light, Dark, and Follow device. Apply the resolved theme before first paint and to portaled dialogs/popovers.
- [ ] Persist a device preference in I4a. Add the account default in I5 with a device override taking precedence; define the profile contract there if absent. Player-display preferences stay device-local and do not expose account settings.
- [ ] Prove flexibility using a third internal preset changing accent, font, and corners without editing feature components. Do not expose a theme authoring product.
- [ ] Build or consolidate Button, IconButton, FormField, NumberInput, Select, Checkbox, Panel, PageHeader, Dialog/Sheet, Menu, Tabs, EmptyState, and SaveStatus. Wrap existing accessible primitives rather than recreating focus management.
- [ ] Provide pending, disabled, validation, offline, conflict, loading, and empty states with meaningful text. Theme switching must not remount editors or reset character state.
- [ ] Use at least 44x44 CSS-pixel touch targets, visible focus, accessible labels, text enlargement, and reduced-motion support. Compact desktop density must not reduce touch targets. Do not convey status by color alone.

**Exit:** shared controls work by keyboard and touch in both themes, including portals and long labels; contrast is checked against the existing accessibility target. A theme change affects presentation only, not rules, content, token colors, fog semantics, or uploaded artwork.

## G3 — Replace the shared column assumption with view-owned layouts

**Existing files:** `web/src/shell/AppShell.tsx`, `AppShell.module.css`, `web/src/router.tsx`, library/editor/character layout styles.

- [ ] Let AppShell own header, navigation, and one flexible content region. Remove the assumption that a single routed child belongs in the first 240px column of a three-column grid.
- [ ] Keep role-specific navigation and authorization context explicit. The shell must not become a second owner of character or draft state.
- [ ] Let creator pages own their editor/preview panels. Let player sheets own readable content widths. Use `min-width: 0`, wrapping, and overflow rules intentionally.
- [ ] Follow Section 10.1: phone 320-599px, tablet 600-1023px, desktop 1024px+. Test 320/360, 768/1024, and 1280px, portrait and landscape. No device-simulator switches in product navigation.
- [ ] Keep primary actions reachable with a software keyboard open; respect safe areas and ensure sticky headers/footers do not cover focused controls or errors.

**Exit:** existing deep links, back navigation, focus restoration, dirty editor state, and character session lifetimes survive the shell migration. Desktop content uses its intended width; phone forms do not clip or horizontally scroll.

## G4 — Deliver the first polished character journey

**Existing files:** `web/src/characters/CharacterRoute.tsx`, `CharacterSheet.tsx`, `FieldControl.tsx`, `CreateCharacter.tsx`, `CharacterTools.tsx`, `ConflictReview.tsx`, `characters.module.css`, `api.ts`, `types.ts`; `tests/integration/character-creation-versions.test.ts` and `web/tests/offline/character.spec.ts`.

- [x] Basic version picker and API are present: versionless `/characters/new` lists versions, selecting one reuses `loadMetadata`, and a prefilled `?systemVersionId=` bypasses the list. This credits the implemented seam only; G4 visual and privacy acceptance remain open.
- [x] OD-01 discovery semantics resolved as option A (unlisted/link-only) — see the resolution note on gap OD-01 above and `design_v2.md` §13. Enumeration (owned + `public`) vs known-version use (owner or `public`/`link`) covered by the two-account owned/private/link/public matrix test in `tests/integration/character-creation-versions.test.ts`. Known-version permissions unchanged.
  *Closed 2026-09-09 (G4):* `8d5f22a`, `8785c3b`; acceptance `docs/acceptance/gui-2026-09-09-g4-character.md`.
- [x] Picker is the primary normal entry (`8d5f22a`): readable system names plus exact-version short IDs (accessible name unchanged), loading/empty/error/**retry** states, manual version-ID entry as a clearly labeled fallback panel. Exact-version deep links and the `loadMetadata`/create path preserved; signed-out/offline keep their existing dedicated guidance. UUID validation failures were already mapped to definite input errors (G1), untouched.
- [x] Picker response/entry types derived from `operations["get_characters_creation_versions"]` (`8d5f22a`). Inline `useQuery` through the injected `CharactersApi` kept; no parallel fetch path.
- [x] Shared controls composed into creation and the sheet (`8d5f22a`): `Panel`/`FormField`/`Select`/`EmptyState`/`Button` in creation; shared `Button`s for sheet resource bumps, action submits, and the roll-details toggle. Existing server projection rendered as-is (no second renderer). Deliberate partial: `FieldControl` internals, completion inputs, and `CharacterTools` dialogs keep their controls (shared wrappers would double-label); diagnostics/completion chrome and `#character-completion` focus id preserved.
- [ ] Restyle creation, required-field completion, direct edits, resource bumps, action inputs, activity, and tools. Keep export, migration, archive/recovery, and conflict controls reachable.
  *Partial 2026-09-09 (G4):* creation form, picker, resource bumps, action buttons, and roll-details restyled; completion/tools/activity keep existing styling (see partial above). Full restyle deferred — G5 may revisit alongside the creator.
- [ ] Present save/offline/synchronization states clearly without overwhelming the sheet. Preserve idempotency keys, durable attempts, historical receipts, and explicit uncertain-outcome recovery.
  *Unchanged 2026-09-09 (G4):* existing truthful sync/offline/conflict presentation kept; `SaveStatus` adoption not claimed. Covered by offline journey/conflict/export tests (22/22 production offline).
- [x] All three reference families verified through the real routed workflow (`character-sheet.spec.ts` 6/6: d20/PbtA/pool × 360/1280 with keyboard bump, axe, no-overflow; offline journeys per system; repaired versionless-picker journey). Long descriptions, zero/negative values, validation failures, and read-only fields ride the existing projection/tests; no new edge-case failures observed.

**Exit demonstration:** open versionless `/characters/new`, select a permitted system/version without entering an ID, complete creation, and verify an exact-version deep link also works. On a phone, edit an attribute, change a resource, roll, read the result, go offline, edit, reconnect, resolve a conflict, and export. Repeat critical interactions in dark mode and on desktop. This is the first visual acceptance checkpoint before migrating the creator.

## G5 — Apply the same design to the system creator

**Existing areas:** `web/src/library/`, `web/src/editor/`, `web/src/publish/`, `web/src/state/draftSync.ts`.

- [ ] Present the default workflow as basics/descriptions, attributes and dice settings, section order, preview, and publish. Use existing package/API capabilities and stable IDs.
- [ ] Place supported advanced controls behind clearly labeled disclosure. Do not require users to understand the expression grammar for a basic system, and do not silently discard advanced definitions when editing existing systems.
- [ ] On desktop/tablet, place editing beside a live preview when space permits. On phones, support review and small edits with an editor/preview switch; full layout authoring remains desktop/tablet-oriented.
- [ ] Replace unwired metadata classes and inconsistent raw form elements with shared controls. Retain simple ordered sections and move-up/down keyboard controls; no freeform canvas or arbitrary sheet tabs.
- [ ] Connect save status, validation summary, and accurate conflict actions to the repaired G1 state owner. Make publish readiness and the distinction between draft and published version explicit.

**Exit demonstration:** create a simple system without writing an expression, add descriptions and roll settings, order its sheet, preview, save, reopen, publish, and create a character from it. Also verify that editing an existing reference system preserves its supported definitions.

## G6 — Integrate with I5 rather than building a second Player app

- [ ] Build onboarding, character library/search/recent items, personal activity, account preferences, and the installable shell with the shared components. Integrate the existing creation-version picker for system selection; do not recreate its endpoint, metadata loader, or character creation state.
- [ ] Before expanding the picker into a library/catalog, add bounded server pagination and supported filtering under the resolved discovery policy (Section 13), update generated contracts, and test stable page ordering and revocation. The current endpoint returns every matching version in one response; client-side list virtualization alone does not bound that response.
- [ ] Add account theme defaults and device overrides; include loading, empty, permission-denied, unavailable-storage, and expired-session flows.
- [ ] Keep I5 campaign-free and embed the same I4 character renderer/session. Add campaign routes and navigation only with I6 authorization support.
- [ ] Complete real production sign-in and its return journey before I5 acceptance; separate test authentication from production startup. Verify first-sign-in concurrency resolves to one canonical user.

**Exit:** the I5 end-to-end demonstration passes in the visual design without custom HTTP calls or test-only login shortcuts.

## G7 — Reuse the foundation for campaigns and GM operation

- [ ] In I6, style invitation review, campaign list, character claiming/creation, permitted text content, audience labels, and revoked-access states using the shared controls.
- [ ] In I7, build campaign setup, content/notes, members, mobile session board, and a searchable NPC/monster list leading to a full-width sheet. Use existing character capabilities where appropriate and explicit campaign contracts for any new ownership/lifecycle behavior.
- [ ] Keep Session, Content, Characters, Members, and Settings navigation consistent with Section 4. Use panels on larger screens and focused pages/sheets on phones.
- [ ] Make sharing audience persistent and readable; preview-as-player calls the real policy implementation. Shared controls never decide authorization.
- [ ] Verify two authenticated GM devices can operate independently without clobbering changes. This is distinct from handing a restricted display to players.

**Exit:** I6/I7 demonstrations run through the real UI with permission, revocation, and conflict tests; no mock-only campaign screens count as completion.

## G8 — I7b media, simple scenes, and restricted player display

**New capability:** plan its contracts and persistence before implementing canvas controls. Keep it within the modular application and publish versioned HTTP contracts.

- [ ] Introduce authorized image upload/storage with bounded file size/dimensions, validated decoding, safe rendering derivatives, ownership checks, and deletion. GM originals must not use public asset URLs. General document uploads remain outside this increment.
- [ ] Persist a scene's background reference, revision, manual fog mask, and simple token records: image/label, normalized position, size, and visibility. Scene edits use revision checks and an explicit single-writer/conflict flow; do not silently merge concurrent brush operations.
- [ ] Build SceneViewport, FogToolbar, TokenTray, and display-status controls. Support fit/pan/zoom, manually reveal/conceal parts of fog, undo the latest local operation, and drag or tap-to-place/move tokens. Provide keyboard/non-drag alternatives. No grid, movement measurement, initiative, vision, or automated token actions.
- [ ] Define token visibility explicitly: GM-visible hidden tokens never reach players; tokens covered by fog are omitted or safely clipped by the server projection. Store coordinates in scene space so phone/tablet viewports agree.
- [ ] Implement short-lived pairing and revocable credentials scoped to one campaign's display projection. Display clients cannot read GM notes, character sheets, member settings, originals, hidden tokens, or mutation endpoints, even if the device was previously used by a GM.
- [ ] Before entering display mode, remove GM/account views and caches from that browser context. A CSS-hidden GM route is not a player display. Back navigation, reload, error screens, and reconnect must not reveal privileged data.
- [ ] Send server-rendered redacted imagery (or equivalently safe tiles) containing only revealed pixels. A fog overlay over the full original image is insufficient. Scope media caching to authorization/revision; purge display state on revocation and blank it while permission is uncertain.
- [ ] Synchronize authorized scene revisions to paired devices using the existing polling approach first. Show pending/applied/offline status on the GM device; present a safe blank/reconnecting state rather than stale privileged content. Do not broadcast secret payloads.

**Exit demonstration:** a GM uses monster sheets on a phone while an iPad displays an image; reveal and conceal fog, place and move a token, change scene, reconnect, and revoke the display. Inspect display network responses, storage, reload, and direct requests to prove GM originals and secrets are absent. Previously revealed information cannot be made unseen; conceal/revoke prevents subsequent access, not screenshots already taken. Repeat with a remote player viewing the same permitted scene.

## G9 — Release and acceptance gates

- [ ] Keep a view checklist in `docs/acceptance/gui-YYYY-MM-DD.md`: tested commit, commands, device/browser, theme, reference-system fixture, screenshots, manual findings, and remaining limitations. Record only checks actually run.
- [ ] Verify each migrated route at phone/tablet/desktop widths, light/dark, 200% text enlargement, long translated labels, keyboard, and touch. Check real Android Chrome and iPad Safari interactions before release; emulation alone does not prove touch/keyboard behavior.
- [ ] Use actual routed application screenshots with stable fixtures. Require human inspection before replacing baselines; do not hide functional errors to make screenshots pass.
- [ ] Run existing character offline/replay/recovery checks after shared-shell or identity changes. Broaden tests only where changed behavior creates a concrete risk.
- [ ] Ship the built frontend and API together, consistent with Section 11's deployable-artifact direction: static assets, SPA fallback excluding API routes, and production `/api` routing. Verify direct links, refresh, authentication return, CSS/fonts, and offline shell reopening without Vite dev/preview serving production.
- [ ] Before public release, run one physical-table session and one remote session, with phone GM/player interaction and a separate tablet display. Close blocking usability, data-loss, and disclosure findings before declaring acceptance.

## Reconciliation verification

Reviewed source and tests through `d6bfd32`. The historical I4 acceptance and newly committed picker browser test/screenshot are retained as existing evidence, not claimed as a fresh browser or PostgreSQL execution in this review. Fresh targeted checks on that baseline:

- `node node_modules/vitest/vitest.mjs run src/transport/http/characters.test.ts src/transport/http/openapi.test.ts` from the repository root: **35 passed**.
- `node node_modules/vitest/vitest.mjs run src/characters/api.test.ts src/characters/CreateCharacter.test.tsx src/router.test.tsx` from `web/`: **53 passed**.
- `node --import tsx scripts/generate-system-contracts.ts --check` from the root: **passed**.
- A temporary component regression check reproduced the picker leak: render account A's private version, retain the same QueryClient, switch the identity to B and remount the component with B's route key. A's version button remains visible while the 30-second cache entry is fresh, even when B's API stub returns an empty list. The assertion that A's name disappears failed. This exercises the real CreateCharacter component with controlled API/identity inputs; it is not a deployed-browser or backend authorization-bypass claim. The temporary test was kept outside the committed source changes.

The existing tests passing does not close this new G1 gap. This update changes only the plan/specification documents; the corrective application work remains open.

## Implementation handoff

Deliver bounded changes in the sequence above. Each implementation PR states its G task, affected routes, behavior preserved, tests actually run, and before/after screenshots where visual behavior changed. Update this checklist and the corresponding design increment only after acceptance. Documentation changes alone do not close an increment. Keep user-facing screens free of debug controls, implementation terminology, and placeholder buttons for future capabilities.
