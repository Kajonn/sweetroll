# Rules coverage GUI testing, local run of 2026-11-12

Record for the [GUI test plan](../superpowers/plans/2026-11-12-rules-coverage-gui-testing.md),
layer T1. It covers what could be tested in a development container: the code,
a local PostgreSQL and a headless browser. It is not hosted, device, provider
sign-in, screen-reader or playtest evidence and closes no G9 gate.

## Tested build

| Item | Value |
|------|-------|
| Application commit | `e188590` on branch `ccr-1abb65de-3ox621` (main `9ff2c72` plus the test commits) |
| Database | PostgreSQL 16, local, disposable databases per suite |
| Browser | Chromium build 1243, headless. The project pins a Playwright that expects build 1248, so CI uses a different Chromium |
| Node.js | 22.23, with the engine check disabled. The project requires 24 |
| Sign-in | Development and test sign-in only |

## Results

| Suite | Result |
|-------|--------|
| Server typecheck and contract check | Pass |
| Server unit tests | 676 of 676 pass |
| PostgreSQL integration and API scenarios | 451 of 452 pass. One fails, see below |
| Web typecheck | Pass |
| Web unit tests | 1,317 of 1,317 pass |
| Browser journeys (dev server, all specs except visual) | 93 of 93 pass in 9.7 minutes |
| Offline suite (production build with service worker) | 32 of 32 pass in 3.5 minutes |
| Visual baseline suite | Not run. Screenshots from this Chromium build cannot be compared with the committed baselines |

The failing integration test is `character-http-acceptance.test.ts`, "serves
all three reference systems through the same HTTP surface". It exceeds its
5-second limit here (5.6 to 6.3 seconds) and did the same on the unmodified
PR 75 head in this container. It passed in CI on that head. It is treated as a
slow-environment timeout, not as a defect, and was not changed.

## What the browser runs cover for the rules features

Each row was run in the browser at 360×640, 768×1024 and 1280×800 on the player
sheet and the GM board, by keyboard at the phone width, with an automated
accessibility scan before and after.

| Stage | Feature | Spec | Also checked |
|-------|---------|------|--------------|
| R0 | Sheet evaluation budget | `rulesEdgeStates` | Publish is blocked in the creator and the diagnostics name the limit |
| R1 | Resource amount and direct input | `resourceEditing` (online), `offline/resourceEditing` | One command for 17 damage, healing stops at the maximum, out-of-range input refused, queued offline and applied once, GM board keeps one-tap steps |
| R2 | Conditionals and text comparison | `rulesGrammar` | `adv(3d6)` rejected beside the editor |
| R3 | Tables, aggregates, computed maximum | `rulesData`, `rulesEdgeStates` | A lookup with no row shows the fallback and a message |
| R4 | Dynamic pools | `dynamicPools` (four fixtures), `rulesEdgeStates` | A roll over 100 dice is refused with a readable message |
| R5 | Outcome bands and details | `rulesOutcomes`, `rulesEdgeStates`, `pushResourcePlaceholder` | No matching band shows the total alone; a pushable roll that prints a resource part reloads and pushes |
| R6 | Custom dice and symbols | `customDice` (two fixtures) | Bad symbol entry shows the field error |
| R7 | Targeted and opposed rolls | `opposedRolls` (three profiles), `rulesEdgeStates` | Answered roll no longer offered; no eligible target disables the action |
| R8 | Card decks | `cardDecks` (two tests) | Empty deck, shuffle, and two players in separate profiles on one campaign deck with simultaneous draws |

The creator page is scanned at 1280 px, checked for sideways scroll at 768 and
360 px, and its editor/preview switch is used at 360 px. Six states are checked
in the dark theme and with text at 200 %: resource direct input, roll result
with outcome and details, custom-dice faces, target picker, drawn cards with
the count, and the deck editor.

## Defects found and fixed during this testing

| Defect | Fix |
|--------|-----|
| A pushable roll whose output prints `{fields.<resource>.current}` or `.max` could not be reopened or pushed | Push snapshot key pattern widened (`runtime/push-context.ts`), unit and browser regression tests |
| `adv(3d6)` and `adv(4d6kh3)` silently rolled two dice | The parser rejects anything but one die |
| "No issues" text in the creator's expression editor failed colour contrast | Uses the text-safe success colour |
| Discarded dice in the creator's Try it result failed colour contrast | Struck through and dashed, not faded |

No other defect was found in the rules features by these runs.

## What is left to do

**Needs the project's pinned browser (CI or a developer machine)**

1. Run CI on this branch. It is the first run of the new and changed specs on
   the pinned Chromium and on Node.js 24.
2. Check whether the two contrast fixes change an existing visual baseline.
3. Generate the twelve new visual baselines (plan T1 item 7): six states at 360
   and 1280 px. A person reviews them before they are committed.
4. Meet the T1 exit: the new and changed specs pass three times in a row in CI.

**Needs the hosted preview (plan T2)**

5. One ordered GM and two-player journey through the eleven fixtures on a fresh
   deployment of the exact commit, GUI only, with a result table, the
   deployment ID and the observed commit. It needs the preview's address and a
   way for test users to sign in there.

**Needs a person (plan T3; owner decision D4 names who)**

6. A screen-reader pass over a roll with an outcome, a custom-dice roll, a
   targeted roll and a card draw. The automated scan checks rules, not what is
   announced.
7. Visual review of the new screenshots and of the pool builder, outcome bands,
   custom dice, target settings and deck editors at 768 and 1280 px.
8. A creator walkthrough from a blank document by someone who did not build the
   features, noting where the free-form editor was needed.
9. Tap targets at 360 px with touch emulation, recorded as emulated.

**Not covered by any automated GUI test**

10. A private (`owner_only`) draw as seen by another player. The sheet has no
    audience control, so only the API scenario covers it.
11. The creator's warning for a deck without cards in a journey. It has a unit
    test.
12. Live update of the card count when another player draws. The count is read
    again on load and after the player's own draw or shuffle, by design.

**Open questions from the code review of PR 75, still undecided**

13. A roll can raise the character revision when a computed resource maximum
    has drifted from the stored one.
14. Roll options list the name of every campaign character of the target
    entity to players, including characters they cannot otherwise open.

**Outside this plan and still open (design Section 18.2)**

Physical devices, real provider sign-in, human visual sign-off of the whole
application, and table and remote playtests.
