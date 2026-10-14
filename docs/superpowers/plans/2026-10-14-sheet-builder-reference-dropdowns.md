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
- [ ] Verify typecheck, unit test and existing sheet-editor regression suite.
- [ ] Deploy branch to isolated Railway preview and exercise creator sheet journey.
- [ ] Record deployed acceptance evidence.

## Journey
Sign in -> create/clone a system -> define a field/resource/action/slot -> Sheets -> choose target entity -> add section -> insert bound elements using dropdowns -> save -> refresh -> preview; verify labels and IDs remain stable. Exercise missing references and alternate entity choices.

## Risks
Existing tests may depend on editable ID inputs. Verify every existing editor test and update assumptions only when behavior changed intentionally. Avoid broadening action/slot filtering beyond existing semantics.
