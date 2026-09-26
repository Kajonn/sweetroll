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
