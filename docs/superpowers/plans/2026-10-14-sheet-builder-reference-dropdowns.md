# Sheet builder reference dropdowns (2026-10-14)

## Goal
Rename the creator navigation label **Sections** to **Sheets**. Replace manually typed sheet target and element binding IDs with dropdowns displaying available definition names while persisting stable identifiers.

## Scope
- Keep existing `sections` tab key and legacy `sheets` alias for compatible deep links.
- Select sheet target entity from document entities.
- Select field/resource/action/slot bindings from relevant definitions; include already placed definitions.
- Preserve unresolved historic references visibly, without rewriting them.
- Keep technical sheet, section, element IDs generated and read-only.
- No database migration or schema changes.

## Test-driven execution
- [x] Add unit tests for entity selection, binding selection and missing-reference display.
- [x] Introduce select UI and parent-to-child definition plumbing.
- [x] Verify typecheck, unit test and existing sheet-editor regression suite.
- [x] Deploy branch to isolated Railway preview and exercise creator sheet journey.
- [x] Record deployed acceptance evidence.

## Journey
Sign in -> create/clone a system -> define a field/resource/action/slot -> Sheets -> choose target entity -> add section -> insert bound elements using dropdowns -> save -> refresh -> preview; verify labels and IDs remain stable. Exercise missing references and alternate entity choices.

## Risks
Existing tests may depend on editable ID inputs. Verify every existing editor test and update assumptions only when behavior changed intentionally. Avoid broadening action/slot filtering beyond existing semantics.

## Verification result

Exact application commit `59a6e15` was already deployed as Railway `07263619-c8e4-412e-918b-b4fb4829dc74` (SUCCESS). Readiness returned 200 and deployed JS/CSS matched the production build byte-for-byte. The live GUI journey verified all four reference types, stable generated IDs, missing references through entity changes/reload, legacy tab links and responsive preview. Local focused regression tests passed 74/74; application CI passed 1,143 frontend tests, 51 browser journeys, 24 offline tests and server verification.

The intentional navigation rename invalidated only the 1280 px document-editor visual baseline (344 pixels). The inspected baseline was updated and its fresh browser comparison passed; full follow-up CI is tracked in PR #20.

[Detailed deployed acceptance evidence](../../acceptance/sheet-builder-reference-dropdowns-2026-10-14.md) records the artifact identity and limitations. The existing creator preview does not render slots; slot binding selection/persistence was verified, and a visual slot renderer remains separate work. Physical-device and real-auth acceptance are not closed by this journey.
