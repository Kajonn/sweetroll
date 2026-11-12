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

## Hosted T2 run of 2026-11-12

**Result: partial.** Eleven fixtures ran against the repaired acceptance deployment.
Ember Road reproduced a stale deck count after a successful shuffle. The GM session
board and player campaign Activity show audience-filtered roll entries, with no
result details for the cross-view comparison required by T2.

| Item | Observed |
|------|----------|
| Service | [sweetroll-acceptance](https://sweetroll-acceptance-production.up.railway.app/) |
| Source | `main`, [`7c4107cb7f135e6aa69be4cf4feb0aeff38c94f6`](https://github.com/Kajonn/sweetroll/commit/7c4107cb7f135e6aa69be4cf4feb0aeff38c94f6), PR #82 |
| Deployment | [`b7398529-c5fd-4266-9a3a-043e59d65b10`](https://railway.com/project/3574e37e-8ef6-4f2c-9f22-0faac46a1563/service/47ec825e-3855-452e-82e8-0f025967dae6?id=b7398529-c5fd-4266-9a3a-043e59d65b10), SUCCESS |
| Readiness | HTTP 200 and JSON status `ok`. Railway logs confirmed schema initialization and test auth |
| Frontend | `/assets/index-B3OyKm8y.js` matched a local build of the commit byte for byte. SHA-256 `7b84b981312ad57fc5e5e001f4a444521eb8f3b2087966ecb8f41fe36e2b94d7` |
| Browser | Playwright 1.64.1, Chromium headless shell 156.0.8078.4 (build 1248) |
| Profiles | One GM at 1280 × 800, player one at 360 × 640 and player two at 768 × 1024. Separate contexts and distinct test identities |
| Test data | Main run suffix `b6d5cebe`; focused Ember Road rerun suffix `14cdcfdd` |

The GM pasted packages compiled from the repository fixtures into the GUI import
dialog, published each system, shared its link, created a campaign and issued two
invitations. Each player accepted the invitation link and created and adopted a
personal character through the GUI. Rolls, draws, shuffles, the offline edit
and campaign export were triggered through the GUI. The runner also used HTTP
for fixture sign-in, independent readback and scoped archive commands.

### Results by plan step

| T2 step | Result | Evidence |
|---------|--------|----------|
| 1. Publish fixtures | Pass | All eleven imports published at rules version 1.0.0. |
| 2. Create campaigns, invite, adopt and play | Partial | Eleven campaigns, 22 accepted invitations and 22 adopted characters. Both players performed each fixture's actions. GM Session displayed a roll entry for every recorded result. The board exposes the actor and time without the detailed player result. |
| 3. Compare player, peer, GM and export views | Partial | All 28 results in the main run matched the roller's display and the GM export. The export matched actor, action, output, total, dice, breakdown and audience. Each peer saw the expected activity entries. Bridge Contest also showed the attack output to its responder in the recorded-roll picker. The GM board and peer Activity could only confirm event presence for the other fixtures. |
| 4. Bridge Contest | Pass | Two targeted attacks used the other character's Defense of 10. Both opponents countered using the recorded attack total. The original roll was removed from the responder's choices after use. |
| 5. Ember Road | Fail | Six alternating draws yielded 12 distinct cards. Both players saw the empty-deck message and disabled draw control. Shuffle restored the server count to 12 while the initiating sheet stayed at zero. On the focused rerun, refreshing the sheet showed 12 and a subsequent draw left 10. Detailed cards matched in the roller view and GM export. The other player's campaign feed and GM board showed draw events without card details. |
| 6. Offline and reconnect | Pass | The phone profile showed the offline explanation and disabled Check, Read the omens and Gather the omens. A subtraction of 3 Health was queued. The server revision stayed unchanged offline, then advanced once on reconnect and recorded exactly one adjustment to 7/10 Health. Repeated on the focused run. |
| 7. Reload and reopen | Pass with shuffle workaround | The last result was found in the Activity dialog for both players in each fixture, with exact output and total independently read back. Regular results cleared from the inline panel on reload. On the focused Ember Road run both sheets reopened at 10/12 after the post-shuffle draw. |
| 8. Scoped cleanup | Pass on the current database | Archived 22 characters, 11 campaigns and 11 private systems from the main run. Archived the focused run's two characters, campaign and private system. Read back each archived status from the service. |

### Main run results by fixture

The GM export and both player views showed the expected event counts for
each row. The outputs below are from the rolling player's sheet and export.

| Fixture | Player one | Player two | Matched export entries |
|---------|------------|------------|------------------------|
| Roadwardens | Armor check: 4 | Armor check: 4 | 2 |
| Glass Observatory | Result: 47 | Result: 155 | 2 |
| Midnight Dispatch | Result: 0 | Result: 2 | 2 |
| Far Beacon | Result: 6 | Result: 15 | 2 |
| Lantern Court | Result: 14 | Result: 7 | 2 |
| Hearthbound | Strong hit (10) | Weak hit (9) | 2 |
| Brass Ledger | 78 against 50: Failure, -2 success levels | 65 against 50: Failure, -1 success levels | 2 |
| Winter Compass | Result: 3 | Result: 0 | 2 |
| Signal Forge | Result: 2 | Result: 3 | 2 |
| Bridge Contest | Attack margin: -2 / Contest margin: 24 | Contest margin: 12 / Attack margin: -5 | 4 |
| Ember Road | Read the omens: Crown of Ember, First of Tide<br>Read the omens: Third of Gale, Second of Gale<br>Read the omens: Crown of Gale, Crown of Tide | Read the omens: First of Ember, Third of Ember<br>Read the omens: First of Gale, Third of Tide<br>Read the omens: Second of Tide, Second of Ember | 6 |

### Ember Road shuffle reproduction

The focused browser run observed a `GET /decks` response with zero cards
remaining before the shuffle POST returned HTTP 200. A subsequent independent
read returned 12. The initiating sheet stayed at zero for the rest of the
observation window. After reload the next draw returned **Read the omens: Crown of Gale, Crown of Tide**,
and both sheets later showed 10/12. All seven focused draw results matched
the GM export.

The sheet refreshes the count when the action promise resolves. That promise
resolves after the command is queued, and the shuffle acknowledgement
contains no roll to trigger the second refresh that a draw gets. The
observed request order reproduces this race.

### Acceptance database recovery

The first deployment of the commit reported SUCCESS and readiness HTTP 200
while serving the previous database schema. The first hosted run returned
HTTP 500 for rolls and draws. PostgreSQL reported missing
`character_rolls.target_character_id`, `responds_to_roll_id` and
`deck_states`.

There were no application release tags. Acceptance was pointed at a new
logical database on its existing PostgreSQL service. The usual
`npm run start:db:init` pre-deploy command installed the schema from the
tested commit. The first recovery deployment created the empty database
and failed startup before schema initialization. A fresh deployment using
the standard initializer succeeded, and the same application commit was
tested again. The previous database is retained. The earlier attempt's
Ember Road cleanup received HTTP 502 during the cutover, so its archive
status in the previous database is unverified.
