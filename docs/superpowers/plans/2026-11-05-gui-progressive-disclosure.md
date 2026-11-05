# GUI progressive disclosure

Authorized by the owner's GUI verbosity review and implementation request on
2026-11-05. Baseline: main `513b888` (PR #30 merged).

## Behavior

- Normal mode shows names, values, primary actions, save/error/conflict state,
  roll outcomes, sharing audiences and permission/unavailability explanations.
- Account → Developer tools contains an off-by-default, device-local debug
  preference. It reveals identifiers, revisions, publish checksums, diagnostic
  paths/codes and expression ASTs. It changes presentation only and never fetches
  additional privileged data or changes authorization.
- Advanced identifier editing, field constraints, appearance and token precision
  controls remain available in native disclosures. Collapsing preserves values.
  Invalid identifier controls open automatically.
- Creator readiness has one save indicator, diagnostics action and version-history
  action. Blocked publication retains a visible explanation.
- Dice group outcomes, push attempts and face outcomes remain visible; per-die
  evidence and calculations are disclosed once through the shared roll renderer.
- Existing roster display names replace UUIDs in member/sharing/preview controls.
  Duplicate or absent names have an identifying suffix; short-ID collisions use
  full IDs. Requests continue to use exact user IDs and membership generations.
  Unavailable definition labels retain their identifier as a repair fallback.
- Appearance preferences live in Account; the shell continues applying stored
  device/account/OS preferences without an extra visible selector.

## Execution and verification

1. Red–green tests for device defaults/persistence, same-tab and cross-tab
   changes, storage failure, hidden metadata, stable reference selection,
   duplicate names, actionable diagnostics, advanced constraints and dice details.
2. Apply shared presentation controls to shell, Account, creator, publishing,
   characters and campaign controls. Preserve contracts and rules identifiers.
3. Update existing expectations for the new default presentation; retain technical
   diagnostics coverage in explicit debug mode. Run frontend tests/typecheck,
   browser journeys and offline regressions affected by shared shell changes.
4. Deploy this branch to the isolated preview, verify the exact deployment, then
   inspect ordinary/debug flows and responsive layouts. Record actual evidence
   in a dated acceptance record; do not close physical-device/provider/playtest
   release gates from browser automation.

No database, package, API, identity-provider, migration or version-upgrade changes
belong to this increment. Persistent account-profile improvements beyond existing
roster names remain outside this presentation change.

Implementation and observed validation are recorded in
[the dated acceptance record](../../acceptance/gui-disclosure-2026-11-05.md).
The isolated preview is deployed; human visual and broader G9 release gates
remain open. Final automated results are attached to PR #33.
