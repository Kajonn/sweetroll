# GUI testing of the rules coverage features

**Test plan · 12 November 2026 · Owner decided D1–D3 on 2026-11-12; D4 is open and blocks only T3**

## Goal

Show that the features of the [rules coverage plan](2026-11-10-rules-coverage.md)
(stages R0–R8) work for a creator, a player and a GM in the browser, at phone,
tablet and desktop widths, by keyboard and with assistive technology.

This plan adds tests and evidence only. It adds no feature and changes no
contract. A defect found here is fixed under the stage that owns it. It does
not close any G9 release gate (physical devices, real provider sign-in, human
visual sign-off, table and remote playtests stay open, design Section 18.2).

## What is covered today

Each stage has one browser journey that runs creator → player → GM on one
fixture:

| Stage | Feature | Journey |
|-------|---------|---------|
| R1 | Resource amount and direct input | Sheet unit tests; no journey of its own |
| R2 | Conditionals, text and choice comparison | `rulesGrammar.spec.ts` |
| R3 | Tables, entry aggregates, computed maximum | `rulesData.spec.ts` |
| R4 | Dynamic pools, explode, reroll, keep | `dynamicPools.spec.ts` (four fixtures) |
| R5 | Outcome bands and details | `rulesOutcomes.spec.ts` |
| R6 | Custom dice and symbols | `customDice.spec.ts` (two fixtures) |
| R7 | Targeted and opposed rolls | `opposedRolls.spec.ts` (three browser contexts) |
| R8 | Card decks | `cardDecks.spec.ts` |

Gaps these journeys leave:

1. All eight run at the default desktop viewport only. None sets 360 or 768 px.
2. None runs an accessibility scan or a keyboard-only pass.
3. No visual baseline shows a new control (`visual.spec.ts` has six screenshots,
   all older).
4. R1 has no browser journey of its own, online or offline.
5. Error and edge states are thin: empty deck, rejected publish with a located
   diagnostic, arithmetic failure on a roll, a target that was archived.
6. Only R7 uses more than one signed-in user. A shared campaign deck (R8) and a
   roll audience seen by another player are tested through the API, not the GUI.
7. No run against a hosted deployment.
8. Long labels, enlarged text and dark theme are unchecked for the new editors.

## Approach

Three layers, cheapest first. Each layer has its own exit and can be approved
separately.

### T1 — Extend the automated journeys

Reuse the existing fixtures and specs. No new fixture is needed.

1. **Viewports.** Run the player and GM parts of each stage journey at
   360×640, 768×1024 and 1280×800. Assert no page-level horizontal overflow and
   that every new control is reachable without horizontal scrolling. The creator
   part runs at 768 and 1280 (full authoring is desktop/tablet-oriented, GUI plan
   G6); at 360 it only opens the editor/preview switch and reads the values.
2. **Accessibility.** Add an axe scan (the helper used by
   `character-sheet.spec.ts`) on four states per stage: the creator tab with the
   new editor open, the player sheet before a roll, the roll or draw result, and
   the GM session board with the result.
3. **Keyboard.** One keyboard-only pass per stage on the player sheet: reach the
   control with Tab, activate with Enter or Space, and read the result from the
   live region. Covers the resource amount form, roll inputs, target and
   recorded-roll pickers, draw and shuffle.
4. **R1 journey.** New `resourceEditing.spec.ts`: apply 17 damage in one command,
   raise the maximum, see the computed-maximum case hide the maximum input
   (Roadwardens), and the GM board keeping one-tap steps. Add the queued-offline
   case to `web/tests/offline/character.spec.ts`: adjust and set while offline,
   reconnect, see one applied result each.
5. **Error and edge states**, added to the owning journey:

   | Stage | State to assert in the GUI |
   |-------|----------------------------|
   | R0/R2 | Publishing a document over the sheet budget shows a diagnostic that opens the right entity |
   | R2 | An invalid formula shows the diagnostic beside the editor; `adv(3d6)` is rejected with its message |
   | R3 | A lookup with no row shows the declared fallback and a validation, not a broken sheet |
   | R4 | A roll over the 100-dice limit is refused with a readable message; a pushed pool shows original and rerolled dice |
   | R5 | A roll with no matching band shows the total without an outcome; a pushed roll shows its new outcome |
   | R5 | A pushable roll whose output uses `{fields.<resource>.current}` can be reopened and pushed (regression for the 2026-11-12 fix) |
   | R6 | A die with a bad symbol entry shows the field error and cannot be published |
   | R7 | No eligible target shows an empty picker and a disabled button; a second response to the same roll shows the conflict |
   | R8 | Empty deck disables the draw button and names the deck; shuffle re-enables it; a deck with no cards shows the creator warning |

6. **Shared deck, two users.** Extend `cardDecks.spec.ts` with two player
   contexts in one campaign, as `opposedRolls.spec.ts` does: both draw, no card
   appears twice, and each sheet shows the right count after its own draw. Assert
   that a private (`owner_only`) draw is not shown to the other player while the
   count still drops.
7. **Visual baselines.** Add screenshots at 360 and 1280, light theme, to
   `visual.spec.ts`: resource row with amount controls, roll result with outcome
   and details, custom-dice faces, target picker, drawn cards with the count, and
   the Dice tab with the deck editor open. Six states × two widths. Baselines are
   reviewed by a person before they are committed.
8. **Theme and text size.** One dark-theme and one 200 % text pass over the six
   states above, asserting no clipped or overlapping control. No extra baselines.

**Exit:** all journey shards, `web-offline` and the visual job pass in CI on the
final head, three times in a row for the new and changed specs.

### T2 — Hosted run on the isolated preview

One ordered journey on a fresh deployment of the exact commit, following the
form of the [multi-user protocol](../../acceptance/multi-user-journey-protocol.md).
One GM and two players, each in a separate browser profile, GUI only.

1. GM publishes the eleven fixtures that carry the features: Roadwardens,
   Glass Observatory, Midnight Dispatch, Far Beacon, Lantern Court, Hearthbound,
   Brass Ledger, Winter Compass, Signal Forge, Bridge Contest and Ember Road.
2. For each fixture: GM creates a campaign, invites both players by link,
   players create and adopt a character, each player performs the fixture's
   action, the GM reads it on the session board.
3. Record for every roll and draw: the result shown to the roller, the same
   result in the other player's and the GM's view under its audience, and the
   entry in the campaign export.
4. Bridge Contest: one attack against the other player's defense, one contested
   roll, one refused second response.
5. Ember Road: alternate draws until the deck is empty, read the refusal,
   shuffle, draw again. Compare the cards across all three views.
6. Offline: one player goes offline, sees roll, draw and shuffle disabled with
   the reason, queues a resource adjustment, reconnects.
7. Reload and reopen each sheet, and check the last result and counts.
8. Scoped cleanup with independent readback.

**Exit:** a result table with one row per step, the deployment ID and the
observed application commit, stored as
`docs/acceptance/rules-coverage-gui-<date>.md`.

### T3 — Human checks

Not automatable, short, and recorded in the same acceptance file. These are
inputs to the open G9 gates and do not close them.

1. **Screen reader.** One pass with a desktop screen reader over a roll with an
   outcome, a custom-dice roll, a targeted roll and a card draw. The result,
   each die or card and the cards left must be announced as text.
2. **Visual review.** A person reviews the T1 screenshots and the creator
   editors for the pool builder, outcome bands, custom dice, target settings and
   decks at 768 and 1280.
3. **Creator walkthrough.** Someone who did not build the features authors one
   small system from a blank document using only the guided editors: a computed
   maximum from a table, a roll with two outcome bands, one custom die and one
   deck. Note every point where the free-form editor was needed.
4. **Emulated touch.** Tap targets of the new controls at 360 px with touch
   emulation. This is recorded as emulated and is not physical-device evidence.

## Order and dependencies

T1 → T2 → T3. T1 items 1–3 can be done stage by stage in parallel. T2 needs R8
and the 2026-11-12 fixes merged into the branch that is deployed. T3 item 2
needs the T1 baselines.

## Not included

Physical devices, real provider sign-in, table and remote playtests, load
testing, the hosted public-API journey (B6), scene and display testing, and
application-version transition tests (design Section 17.0).

## Decisions

Owner answers of 2026-11-12: D1 all stages, D2 yes, D3 no. D4 is not answered yet.

| # | Question | Recommendation |
|---|----------|----------------|
| D1 | Run every stage at three widths, or only stages with new sheet controls? | All stages for the player and GM parts. The cost is run time, about three times the eight journeys, which may need a fourth CI shard. |
| D2 | Add twelve visual baselines? | Yes, limited to the six states listed. More baselines raise maintenance on every style change. |
| D3 | Is the hosted run (T2) required before PR 75 merges? | No. Merge after T1 passes in CI; run T2 on the merged commit. |
| D4 | Who performs the screen-reader pass and the creator walkthrough? | The owner or a tester the owner names. They cannot be signed off from browser automation. |

## Risks

| Risk | Mitigation |
|------|------------|
| Longer CI from three viewports | Parameterise by viewport inside one test where the setup can be shared; add a shard only if a job passes eight minutes |
| Flaky multi-context journeys | Wait on committed state (the settled-save helper and server-rendered counts), never on timing |
| Visual baselines drift with the bundled Chromium | Update them only together with a Playwright upgrade, in a commit of their own |
| Card counts on another player's sheet update only on reload | Assert the documented behaviour (count refreshes on load and after the player's own draw or shuffle), not a live update |

## Implementation record

**T1 items 1–3 — 2026-11-12, implemented.**

- `web/tests/fixtures/guiChecks.ts` holds the shared checks: the three play
  sizes, no sideways page scroll, a control inside the viewport, an axe scan
  that fails on serious or critical violations, and activation by keyboard.
- The stage journeys `rulesGrammar`, `rulesData`, `dynamicPools`,
  `rulesOutcomes`, `customDice`, `opposedRolls` and `cardDecks` use them. On the
  player sheet and the GM board each action is used once per width in the same
  session, by keyboard at 360 px and by pointer at 768 and 1280 px, and each use
  waits for its own command response. The page is scanned before the first and
  after the last use.
- The creator page is scanned at 1280 px and checked for sideways scroll at 768
  and 360 px. The 360 px creator step does not yet open the editor/preview
  switch and read values, as item 1 asks.
- Roadwardens checks the computed maximum on the GM board at each width, since
  its roll is granted by an item and is not on the board. Bridge Contest plays
  the striker on a phone by keyboard, the defender on a tablet and the GM on a
  desktop, and checks both pickers at every width.
- Two defects found by the scans and fixed: the creator's "no issues" text and
  discarded dice in the creator's Try it result failed colour contrast
  (`ExpressionEditor.module.css`, `RollActionEditor.module.css`).
- Verified locally: all eleven tests of the seven specs pass against PostgreSQL
  16 with the container's Chromium. Not verified: CI on the pinned Chromium, and
  whether the two style fixes touch an existing visual baseline.

**T1 items 4, 6 and 8, and part of 5 — 2026-11-12, implemented.**

- Item 4: `e2e/resourceEditing.spec.ts` sets current and maximum by direct
  input, applies 17 damage as one command from the keyboard at phone width,
  checks that healing stops at the maximum, that out-of-range input is refused
  and that the GM board offers one-tap steps only.
  `offline/resourceEditing.spec.ts` queues an amount and a direct input offline
  against the production build and checks one applied command each. The
  computed-maximum case stays in `rulesData.spec.ts`.
- Item 6: a second test in `cardDecks.spec.ts` puts two players in separate
  browser profiles on one campaign deck, with alternating and simultaneous
  draws, the count after reload and a GM shuffle. The private-draw case is not
  in the GUI test: the sheet has no audience control, so it stays in the API
  scenario.
- Item 8: `expectReadableInDarkAndLargeText` checks the six states in the dark
  theme and with text at 200 %. It asserts that the theme really switched.
- Item 5, done: `adv(3d6)` rejected beside the editor (R2), an answered roll no
  longer offered for a second response (R7), the empty deck (R8), the bad symbol
  entry (R6, already present), and `e2e/pushResourcePlaceholder.spec.ts` for
  reloading and pushing a roll that prints a resource part (R5 regression).
- Verified locally with the container's Chromium: the nine journey specs
  (fourteen tests) and the offline resource test pass. Not verified: CI on the
  pinned Chromium.

Open in T1:

- Item 5, rest: the sheet-budget diagnostic at publish (R0), a lookup with no
  row (R3), the 100-dice refusal (R4), a roll with no matching band (R5), no
  eligible target (R7) and the deck-without-cards warning in a journey (R8; it
  has a unit test).
- Item 7: the twelve visual baselines. They must be generated with the pinned
  Chromium and reviewed by a person; this environment has a different build.
- Item 1, rest: the 360 px creator step that opens the editor/preview switch.

T2 and T3 are not started.
