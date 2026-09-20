# Railway acceptance remediation plan

**Status:** Proposed  
**Date:** 2026-09-20  
**Source:** Browser acceptance against the Railway `sweetroll-acceptance` service, deployed from `main` at merge commit `a5ab993`.  
**Design authority:** [`design_v2.md`](../../../design_v2.md), especially Sections 4.1, 5.2, 6.3–6.5, 7.5, 10, 14, and 17.4.

## Goal

Make the simple creator journey reliable for a non-programmer: clone a d20 template, add named fields and rolls, place them on a sheet, publish, create a character, and use every exposed control without opaque identifiers, stale status, or developer-oriented output.

This plan repairs the acceptance defects. It does not add a larger rules engine, automatic D&D 5.1 rules, a VTT, arbitrary scripting, or new migration semantics.

## Acceptance evidence

The live journey successfully cloned the d20 template, added ten D&D-style fields and ten labeled d20 actions, published version `0.1.0`, created `Acceptance Hero`, edited values, changed a resource, rolled, viewed activity, archived/recovered, and proved persistence after reload.

| ID | Severity | Observed behavior | Expected behavior |
| --- | --- | --- | --- |
| AR-01 | High | Renaming a new field ID appeared to work, then reverted to `field`, `field_1`, etc. | A valid rename persists or the UI clearly explains and confirms why it cannot be applied. |
| AR-02 | High | A new action using `fields.field_1` produced `missing_reference`, while the persisted field ID was `field_1`. | A guided action can bind to a field in its target entity without typing or debugging an opaque ID. |
| AR-03 | High UX | New fields and actions were saved but absent from the published character sheet because they were not placed in a section. | The simple flow makes placement explicit and prevents a creator from believing an unbound definition is playable. |
| AR-04 | Medium | Rapid adjacent edits could be overwritten by later autosaves while the status eventually read `Saved`. | Serialized autosave preserves every accepted edit and `Saved` describes the current visible document. |
| AR-05 | Medium | After publishing, the success dialog said the version was live while the editor behind it still said `Draft (unpublished)` / `Not published yet`. | Published-version status refreshes immediately and distinguishes the live version from the continuing draft. |
| AR-06 | Medium | `Basics`, `Abilities`, and `Combat` were duplicated as headings in the rendered accessibility tree. | Each section has one heading at the intended level. |
| AR-07 | Low | Activity displayed raw event keys such as `character_field_set` and repeated the same ISO timestamp. | Activity uses localized summaries and one human-readable time with machine-readable `dateTime`. |
| AR-08 | Verify | Export dialog opened and closed after `Download export`, but the managed browser did not observe a download event. | A routed browser test proves a named JSON download whose content matches the export contract. |
| AR-09 | Coverage | Migration opened, but preview/commit/rollback could not be exercised without a second version. | The release journey publishes a compatible second version and proves migration plus rollback. |

## Confirmed code-level risks

1. `EntityList.replaceField` currently finds the old array entry with `f.id === field.id`. Once the child editor changes `field.id`, that predicate no longer matches the original field, so the rename is dropped.
2. `DefinitionIdInput` uses the constant DOM ID `definition-id-input` for every rendered field. Repeated IDs make labels and automated targeting ambiguous.
3. The dice editor exposes one cross-document field map, while server compilation validates expressions in their owning entity/sheet context. An unplaced action has no clear guided owner, so a generic `missing_reference` is not actionable.
4. Field/action creation and sheet placement are separate tabs with no completion cue. The separation is valid in the package model, but the simple workflow does not communicate it.

These are starting hypotheses for red tests, not permission to bypass server validation or change package semantics.

## Product decisions to record before implementation

Update `design_v2.md` before changing behavior:

1. **Stable ID rename:** allow rename before publication. When there are references, require an explicit confirmation and atomically rewrite every supported structured reference. If expression-source rewriting cannot be proven safe, block the rename and list the referencing expressions instead of leaving a partially renamed package.
2. **Simple placement flow:** keep definitions and layouts separate in the package, but default the simple creator to `Add to character sheet` with a destination section selector. Advanced creators may opt out. Do not silently alter existing sheets.
3. **Action field binding:** provide a field selector scoped to the action's sheet/entity context. Keep the custom expression editor as progressive disclosure.
4. **Publish status language:** after publication, show both facts: `Version X is live` and `Draft has/has no unpublished changes`.

## Workstream 1 — Stable field identity and autosave correctness (P0)

**Primary files:**

- `web/src/editor/EntityList.tsx`
- `web/src/editor/fields/DefinitionIdInput.tsx`
- `web/src/editor/fields/DefinitionIdInput.test.tsx`
- `web/src/editor/DocumentEditor.test.tsx`
- `web/src/state/draftSync.ts` and its tests

### Tasks

- Change field replacement to address the original field by stable location/original ID, not by the edited ID.
- Give every `DefinitionIdInput` a unique DOM ID (`useId` or an explicit owner-derived ID).
- Compute reference counts at the document level and pass them into field editors.
- Implement one document-level rename command. It must update the field and all allowed structured references in one reducer action so autosave sees one coherent revision.
- Fail closed for expression sources that cannot be safely rewritten; present the exact references and leave the document unchanged.
- Add a pending-save barrier so a later label/default edit cannot serialize an older field ID over a newer accepted edit.
- Ensure conflict/retry behavior preserves the same rename transaction.

### Acceptance criteria

- Rename `field_1` to `dexterity`, wait for `Saved`, reload, and still see `dexterity`.
- Two rapid edits (ID then label) survive reload in order.
- Duplicate IDs are rejected before save with field-specific feedback.
- A referenced rename is either atomically complete or explicitly blocked; no stale sheet/action reference is possible.
- Every rendered definition input has a unique label/control association.

## Workstream 2 — Guided action binding and diagnostics (P0)

**Primary files:**

- `web/src/editor/DocumentEditor.tsx` (`DiceTab`, `buildFieldTypeMap`)
- `web/src/editor/actions/RollActionEditor.tsx`
- `src/systems/implementation/rules/compile-document.ts`
- `src/systems/implementation/rules/typecheck.ts`
- related unit and integration tests

### Tasks

- Reproduce AR-02 with a package containing `field`, `field_1`, and an unplaced roll action before changing code.
- Separate field environments by entity; do not merge same-named fields from unrelated entities.
- Add a guided `Attribute` selector for simple rolls. It writes a valid field reference only after the action has a known target context.
- If an action is not placed on a sheet, show `Place this action on a sheet before using character fields` instead of an unknown-field error.
- Keep server compilation authoritative. Client preview may explain errors but may not weaken or replace server diagnostics.
- Add `Jump to` handling that opens the relevant action and, when applicable, the destination section.

### Acceptance criteria

- A roll bound to the second newly created field compiles, publishes, and executes on a character.
- Two entities with the same field ID do not leak types or values across action contexts.
- Unplaced field-dependent actions produce one actionable diagnostic.
- Plain dice rolls remain usable without a field binding.

## Workstream 3 — Definition-to-sheet completion flow (P0)

**Primary files:**

- `web/src/editor/EntityList.tsx`
- `web/src/editor/actions/RollActionEditor.tsx`
- `web/src/editor/sheet/SheetEditor.tsx`
- `web/src/editor/sheet/SectionEditor.tsx`
- `web/src/editor/publishReadiness.tsx` / diagnostics surfaces

### Tasks

- Add an `Add to character sheet` choice to field and action creation, enabled by default in the simple flow.
- Let the creator choose an existing section or create a named section without leaving the current task.
- Show an `Unplaced definitions` summary in Sections and publish readiness, with direct actions to place each item.
- Treat unplaced optional definitions as a warning, not a package-format error. Treat a required field or intended playable action omitted from every playable sheet as a blocking creator-readiness error unless the creator explicitly marks it advanced/internal.
- Preserve manual ordering and the existing package separation between definitions and sheet elements.

### Acceptance criteria

- Adding ten fields and ten actions through the simple flow places all selected items exactly once.
- Preview and the published character show the same ordered fields/actions.
- Opting out leaves an explicit unplaced warning and never silently alters a sheet.
- Existing templates retain their current layout byte-for-byte unless edited.

## Workstream 4 — Publish-state reconciliation (P1)

**Primary files:** `web/src/editor/DocumentEditor.tsx`, publish dialog/version-history components, draft query/cache code.

### Tasks

- On publish success, update/invalidate the workspace and version-history queries from the returned version.
- Replace the single `Draft (unpublished)` concept with independent live-version and draft-dirty indicators.
- Keep the newly published version ID available to `Create test character` without requiring a reload.

### Acceptance criteria

- Immediately after confirmation, the editor shows `0.1.0 live` and `Draft matches live version`.
- A subsequent edit changes only the draft indicator.
- Reload produces the same status.

## Workstream 5 — Character UI polish and accessibility (P1)

**Primary files:** character projection/sheet components, `CharacterTools.tsx`, `messages.ts`, and their tests.

### Tasks

- Remove duplicate visual/accessibility headings while preserving section hierarchy.
- Map activity event kinds to localized, player-facing summaries.
- Render one localized time; retain the exact timestamp only in the `<time dateTime>` attribute and optional details.
- Preserve archive/read-only/recover behavior and the existing activity payload privacy boundary.

### Acceptance criteria

- Axe and heading-outline tests find one heading per sheet section with no skipped levels.
- Activity says, for example, `Ability Score changed` and `Strength Check rolled`, not raw event keys.
- No timestamp is visually duplicated.

## Workstream 6 — Export and migration release coverage (P1)

**Primary files:** `web/src/characters/CharacterTools.tsx`, `CharacterRoute.test.tsx`, browser acceptance specs, export/migration HTTP integration tests.

### Tasks

- Assert the export response, generated filename, MIME type, browser download event, and parsed JSON contract.
- Surface an inline success/error state before closing the export dialog; do not silently close on failure.
- Extend the creator journey to publish a compatible `0.1.1`, preview character migration, commit it, verify the new pin, and roll back.
- Keep migration IDs behind the existing user-facing controls; do not require copying internal IDs when the last migration is known.

### Acceptance criteria

- A real browser captures one JSON download and its contents match the current character revision.
- Network/download failure leaves the dialog open with a retryable error.
- Migration preview, commit, reload, and rollback pass against PostgreSQL.

## Workstream 7 — End-to-end regression and release gate (P0 exit)

Add a dedicated Playwright journey that uses only visible GUI controls:

1. Sign in through deterministic test auth in the isolated E2E environment.
2. Clone d20.
3. Add and rename ten fields, including a `field_1` rename regression.
4. Create guided rolls bound to at least the first, second, and tenth fields.
5. Place fields/actions across at least two sections.
6. Preview at 360 px and 1280 px.
7. Publish `0.1.0`.
8. Create a character and verify every placed field/action is present.
9. Edit values, bump a resource, roll each action, inspect activity, export, archive, recover, and reload.
10. Publish `0.1.1`, migrate, verify, and roll back.

Run against a fresh PostgreSQL database and the built frontend/static server configuration used by deployment. Keep `workers: 1`, `retries: 0`, deterministic secrets, and per-run data names. Do not point the journey at production data.

### Required gates

- Root unit, integration, typecheck, contracts, and build.
- Web unit, typecheck, and production build.
- Targeted Playwright journey at phone and desktop widths.
- Existing offline suite.
- Axe scan for creator and character routes.
- `docker build` and combined static/API smoke test.
- `git diff --check`.

## Delivery order and PR slicing

| PR | Scope | Depends on |
| --- | --- | --- |
| A | AR-01/AR-04 stable rename, unique IDs, autosave regressions | Design decision 1 |
| B | AR-02/AR-03 guided binding, placement workflow, actionable diagnostics | A; design decisions 2–3 |
| C | AR-05/AR-06/AR-07 publish state and UI/accessibility polish | A |
| D | AR-08/AR-09 export/migration coverage and full Railway-equivalent acceptance journey | A–C |

Do not merge PR D until the entire visible journey passes from a fresh database. Earlier PRs must include their focused red/green tests and may merge independently when their own gates are green.

## Completion definition

This remediation is complete only when a non-programmer can add named fields and field-bound rolls, deliberately place them on a sheet, publish, create a character, see every selected item, and exercise the character lifecycle without typing generated IDs or interpreting raw diagnostics. A green unit suite alone is not closure; the routed browser journey and built deployment artifact are mandatory evidence.