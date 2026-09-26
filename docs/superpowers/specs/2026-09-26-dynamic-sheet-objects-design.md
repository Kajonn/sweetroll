# Dynamic sheet objects (inventory, talents, spells, effects) — design

Date: 2026-09-26. Status: owner-approved design (chat), pre-implementation.
Authority: `design_v2.md` (system packages §11–13, character state, grammar v0.1, `OD-04`).

## Problem

System packages define a fixed entity: every field, resource, and action is
creator-authored and every character shows all of its actions. A longsword
attack therefore appears on every sheet — including characters that own no
longsword. Item-like objects (inventory, talents, spells, effects) are dynamic
sheet content: players add and remove them during play, and item actions must
not live in the static system definition.

## Locked decisions (owner, 2026-09-26)

1. Generic mechanism for items, spells, talents, and effects — not
   inventory-only. The sheet defines typed slots where these objects go.
2. Both creator-defined templates and player-created custom entries.
3. Templates may grant actions; some granted actions are nominal (display /
   activity only, no mechanical resolution).
4. Custom (player-created) entries are data-only. Only creator templates
   grant actions.
5. Removal: granted actions vanish; roll/activity history stays (append-only).

## Approach

Template instantiation (option A). Rejected: entries-as-sub-entities (per-entry
revisions/conflicts too heavy for phone play) and static actions with
`requires` conditions (keeps item actions in the static definition and needs
the deferred lookups engine).

## Package format

- `templates`: map alongside `entities`. Each template: `id`, `kind` (`item` |
  `spell` | `talent` | `effect`), a small field schema reusing existing field
  kinds only (integer, text, boolean, singleChoice, resource — no new field
  types in step 1), and `grantedActions` shaped exactly like entity actions.
  Granted-action expressions resolve against a merged scope (entry values +
  owning character values, entry wins on collision).
- `slots`: sheet elements `{id, label, accepts: [kinds], maxEntries?}` placed
  like any other sheet element.
- Additive only: systems without templates/slots validate and behave exactly
  as today.

## Character state and resolution

- State gains `entries`: `{entryId, slotId, templateId | null, values,
  quantity?}`. `templateId: null` = player custom entry; the runtime refuses
  granted actions on custom entries.
- Granted-action rolls resolve merged scope (character fields + entry values).
  Nominal actions record an activity event and return display text.
- Removal deletes the entry; its actions leave the projection; history is
  untouched.
- Entries live under the character revision: add/edit/remove flow through the
  existing optimistic-concurrency + idempotency path, so offline replay and
  conflict behavior are inherited, not reimplemented.

## Creator UI

Template authoring behind the existing advanced disclosure (same pattern as
expression editing): Templates tab by kind, fields + granted actions composed
with entity-action controls. Slot placement in the sheet editor as ordinary
section elements. No new interaction vocabulary, no freeform canvas.

## Sheet UI (player)

Slots render as compact lists: templated entries show name + key stats +
inline granted-action buttons; custom entries show name + values with edit
affordances. Add flow: template picker first, "custom entry" as labeled
fallback (mirrors the G4 version-picker pattern). Quantity stepper where the
template allows. Remove uses the standard destructive-confirm. Granted actions
reuse existing roll/bump controls and sync text.

## Validation, budgets, migration

- Budgets: per-slot max entries (creator-set, platform default otherwise), max
  granted actions per template; node/depth budgets apply to granted-action
  expressions unchanged.
- Server validates: slot accepts the entry kind; custom entries carry no
  actions; scope collisions resolve entry-first deterministically.
- Migration: no templates/slots = old behavior. Adding templates is
  non-breaking. Removing a template with live entries is breaking and takes
  the acknowledge-breaking path.
- Offline: entries are plain values — snapshots, replay, and worker cache
  need no changes.

## Testing

Unit: merged-scope resolution (collision order), custom-entry action refusal,
slot-kind validation, budget enforcement, nominal-action activity logging.
Integration: add/remove/grant lifecycles under revision conflicts and replay.
E2E: creator template authoring + slot placement; player add (template +
custom), granted roll, remove-vanishes-actions, history intact; offline
add-then-reconnect.

## Out of scope (explicit)

New field kinds, lookups engine, full effects engine (stat modification,
ongoing effects), entry-to-entry references, trading/gifting between
characters, merchant/economy flows. `OD-04` stays deferred except granted
roll/bump actions as specified here.
