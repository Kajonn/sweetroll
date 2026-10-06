Commit: the `test: dynamic objects journey and acceptance` commit on branch
`feat/dynamic-objects` (parent `a6f0f3a`); it adds exactly two files —
`web/tests/e2e/dynamicObjects.spec.ts` and this record — no product-code changes.

# Dynamic sheet objects acceptance (2026-09-26)

One Playwright spec proves the plan's exit criteria end to end: a GM authors
two `item` templates (nominal `Raise Torch`, granted `Longsword Attack` roll)
plus an `Inventory` slot accepting `["item"]` through the Creator UI, places
the slot on the sheet, and publishes 1.0.0; a fresh player context creates a
character from the published version and drives the full entry loop
(templated add grants the attack, custom `Lucky Stone` stays data-only,
granted roll resolves, removal revokes the attack while roll history stays
append-only, offline `torch` add replays exactly once on reconnect); removing
the `longsword` template trips the breaking gate (`template_removed`, HTTP
422) until republished with `acknowledgeBreaking: true` as 2.0.0.

## What ran (exact commands, verbatim outcomes)

All from the worktree (`/home/jonas/dev/sweetroll/.worktrees/dynamic-objects`);
e2e from `web/` via the canonical isolated runner (ephemeral shard DB).
Ports 3000/5173 were occupied by the main-checkout dev servers, so dedicated
ports per precedent (`BACKEND_PORT=3126 WEB_PORT=5126
SWEETROLL_BACKEND_TARGET=http://localhost:3126`); `AUTHORITATIVE_ROLL_SECRET`
taken from the repo `.env` (never echoed).

`node scripts/run-e2e.mjs --suite journeys tests/e2e/dynamicObjects.spec.ts`

```
Running 1 test using 1 worker
·
  1 passed (14.7s)
```

Unit gates (this task, before commit):

- `npm test` (repo root): 35 files passed, 1 skipped; 374 tests passed, 8 skipped.
- `npm test` (`web/`): 109 files passed; 1105 tests passed.
- `npm run typecheck` (`web/`): clean, zero errors.

Scope: Chromium-only, dev-server E2E (`web/playwright.config.ts`: backend
`npm run migrate && npm run dev:http` + `web:dev`, serial `workers: 1`).
The journey spec is the e2e evidence; the whole e2e matrix was not re-run here.

## Spec layout (`web/tests/e2e/dynamicObjects.spec.ts`, 375 lines)

- Leg 1 — creator authoring, all UI (lines 107–230): dev sign-in,
  `library-new-system` → `Dynamic Objects <uid>`; attributes tab adds a
  `Hero` entity with integer `Might` + text `Name` (mirrors
  `creatorToCharacter.spec.ts`, needed for character creation); templates tab
  adds template 1 → label `Torch` → granted roll → label `Raise Torch` →
  nominal toggle checked, template 2 → label `Longsword` → granted roll →
  label `Longsword Attack` (guided dice left at `d20`); slots tab adds a slot
  → label `Inventory` (`accepts: ["item"]` is the `addSlot` default, untouched);
  draft read-back over `GET /api/systems/:id` proves torch is
  `{label: "Raise Torch", nominal: true}`, longsword is a live (non-nominal)
  roll, and the slot accepts `["item"]`; sections tab adds a sheet + `Gear`
  section + slot element bound to the slot id via `definition-id-input`;
  `Saved`, publish 1.0.0, version id captured from
  `publish-dialog-create-character`.
- Leg 2 — player loop in a fresh browser context, same owner (lines 232–308):
  clean-session sign-in, `/characters/new?systemVersionId=` → entity select →
  create; `slot-add` → picker `Longsword` → granted `Longsword Attack` button
  appears; `slot-add` → `Custom entry` fallback → `Lucky Stone` → entry row
  carries zero `slot-granted-*` forms and the attack count stays 1; roll
  `Longsword Attack` → `Roll result` + `Total` (mirrors
  `web/tests/offline/character.spec.ts`) → `Saved` →
  `character_action_executed == 1`; remove with destructive confirm → attack
  count 0, `Lucky Stone` intact, `character_action_executed` still 1 and
  `entry_removed == 1`; `setOffline(true)` → add `Torch` → `Changes pending`
  → reconnect → `Saved` → `entry_added == 3` (one per add, no duplicate).
- Leg 3 — breaking change over the API (lines 310–374): `POST /api/systems`
  clone (mirrors `publishOwnedClone` in `test-auth.ts`), publish the clone
  unchanged as 1.0.0 for a baseline, drop the `Longsword` template from the
  draft, `PUT` draft; publish 2.0.0 with `acknowledgeBreaking: false` →
  HTTP 422 with `template_removed` in the body; republish with
  `acknowledgeBreaking: true` → 200 with a new version id.

## UI vs API split (per plan, locked)

- UI drives every journey-critical interaction: system create, entity/field
  authoring, template + granted-action + nominal authoring, slot definition,
  sheet slot placement + binding, save/publish, character creation, entry
  add/remove, granted roll, offline add + reconnect.
- API covers proof reads and the breaking leg: draft read-back (nominal flag,
  accepts kinds), activity reads (`character_action_executed`, `entry_removed`,
  `entry_added` counts), system clone/draft-save/publish with and without the
  acknowledge flag. Payload shapes mirror `publishOwnedClone`
  (`web/tests/offline/test-auth.ts`); every UI testid cites its source spec
  in the file header.

## Findings (all resolved inline)

- `getByText("Lucky Stone")` is strict-mode ambiguous (label span, `name:`
  summary meta, `Remove …` button): scoped to `li[data-testid^="slot-entry-"]`
  instead; same fix pre-applied to the `Torch` visibility check.
- A fresh clone carries no version history, so removing the template and
  publishing without ack succeeded (no baseline to break against). The spec
  now publishes the clone unchanged as 1.0.0 first, then the unacknowledged
  2.0.0 is correctly denied with `template_removed`. No product-code issue.

## Known limitations

- KNOWN LIMITATION (per brief): templated entry values have no UI edit
  surface in step 1 — `updateEntryValues` is wired (custom-entry rename form
  exercises it) but templated value editing is unreachable from the sheet UI.
- Template/slot definition ids are creator-opaque auto ids (`template_1`,
  `slot_1`, …); the journey names live in labels (`Torch`, `Longsword`,
  `Inventory`). The breaking leg locates the template by label.
- Player leg reuses the owning dev user in a fresh browser context (clean
  cookies/storage) rather than a second human; cross-user visibility
  (sharing/access levels) is not exercised.
- No real devices — desktop Chromium viewport only; no axe pass in this spec.
- Out-of-scope items from the design (new field kinds, lookups, effects
  engine, trading) appear nowhere in the journey, and OD-04 stays deferred
  except the granted roll/nominal actions proven here.

## Follow-up delivery and verification (2026-10-04)

This section supplements the original 2026-09-26 run above; its counts and
commands remain historical results from the initial feature commit.

- The creator offers `item`, `spell`, `effect`, and a user-facing **ability**
  label for the stored `talent` kind. Slot acceptance can include the relevant
  kinds. The later isolated Railway GUI journey added Dagger, Firebolt, and
  Athletic Push to a Hero and used their granted actions; Firebolt showed
  `d10 + Arcana` and `Arcana: 4`, and the creator displayed Athletic Push as
  `ability` (PR #16 verification notes). This is GUI evidence for item, spell,
  and ability use, separate from the original Playwright journey above.
- Longsword can use a carrying character attribute for its hit expression and
  has a separate damage expression/action. Compiler and runtime tests cover
  both rolls (`src/systems/implementation/rules/compile-document.test.ts`,
  `src/systems/implementation/runtime/resolve-entries.test.ts`). The original
  browser journey exercised only `Longsword Attack`, so it is not evidence
  that a player clicked both hit and damage in the GUI.
- The UI follow-ups make item names appear once, place rename behind a control,
  keep Remove secondary with a confirmation, and show nominal-action
  confirmation after server acknowledgement. Roll results show readable
  attribute labels. See `design_v2.md` sections 4.1 and 10.2 for the design
  decisions and the focused UI tests in PR #16 for regression coverage.
- PR #16 at commit `5a838c33cc63c0a0b2e8196795de6a5e82f933ff` passed
  [CI run #75](https://github.com/Kajonn/sweetroll/actions/runs/37234535137):
  `verify`, `web`, `web-offline`, three journey shards, and `web-e2e (visual)`.
  The router test response fixture was completed with `nominal: null`, and the
  document editor's 360/1280 px snapshots were updated for the Templates tab.
  Repeated CI runs exposed a one-pixel height variation in the 360 px sheet
  preview. The visual test now captures a fixed 276×610 px region with a
  limited text-edge pixel tolerance while retaining the explicit geometry
  checks. Production deployment was skipped on this PR run.

The 2026-10-05 follow-up adds typed editing for templated entry fields and an
item quantity input. Its update command accepts an optional positive integer
quantity, projects it back to the sheet, and queues it with the existing
offline revision/idempotency flow. `dynamicObjects.spec.ts` now authors
Longsword Attack and Longsword Damage with Hero's Might, edits a Weapon bonus
and quantity on the character, clicks both rolls, and checks retained history.
The first CI run found a creator-generated template field ID colliding with
an entity field; document-wide ID allocation and a component regression test
were added. Local unit suites passed (server: 375 passed, 9 skipped; web:
1,109 passed), and both type checks passed. The expanded Chromium journey
passed in [CI run #82](https://github.com/Kajonn/sweetroll/actions/runs/37414970764)
on commit `2b1c8b74d41abe75602491380aeb9c87b8f7a160`. That run also passed
`verify`, `web`, `web-offline`, the other two journey shards, and the visual
suite. Earlier reruns exposed date-sensitive replay-window test fixtures and
an orphaned expression in the breaking-change test; these test fixtures were
corrected before the successful run. Production deployment was skipped because
this is a pull request.

The original limitations on real devices, human playtests, and cross-user
sharing still apply. The full ongoing-effects engine remains outside this plan.
