# System extensions E8: local ordered journey

**Record · 21 November 2026 · local, PostgreSQL 16, Node 24, Chromium (Playwright)**

The [system extensions plan](../superpowers/plans/2026-11-07-system-extensions.md)
stage E8 asks for one ordered local journey. It is
[`web/tests/e2e/extensionsAcceptance.spec.ts`](../../web/tests/e2e/extensionsAcceptance.spec.ts),
run in the journeys suite. It passed three times on the working tree based on
`7a17c61` (about 20 s each); CI runs it with the other journeys.

| Step | How | Result |
|---|---|---|
| 1. The creator publishes a system and extensions X and Y | API (GUI authoring is covered by `extensionAuthoring.spec.ts`) | Pass |
| 2. Player A creates a character with X ticked, Y unticked | GUI: character creation | Pass; the character's composition is X 1.0.0 |
| 3. The GM adds Y to the campaign | GUI: campaign Settings, Rules and extensions, "Add extension" | Pass; the campaign has Y |
| 4. A's character is adopted | API | Pass; the campaign and the character have X and Y |
| 5. Player B places an X item | GUI: item picker grouped by extension name | Pass; the entry names X, edge 1 |
| 6. The GM upgrades X campaign-wide, then reverts | GUI: Settings, "Upgrade", then "Revert" | Pass; both characters move to X 1.1.0, B's item follows the unchanged default (edge 2), and the revert restores X 1.0.0 and edge 1 |
| 7. Removing X is blocked by B's item, then allowed | GUI: Settings, "Remove extension" disabled with the blocked message; after B's item is removed (API), the removal succeeds | Pass; the campaign and A's character keep only Y |
| Activity | API read-back | `extension_added`, `extension_upgraded`, `system_version_reverted` and `extension_removed` in the campaign feed |

Change made for this journey: the confirm button of the Rules and extensions
panels names the checked change ("Add extension", "Remove extension",
"Upgrade", "Revert"), and the campaign messages say "rules" instead of "rules
version".

**Not covered here:** the hosted journey (plan E8, second item), which needs an
isolated deployment and independent cleanup; adoption and B's item removal
through the GUI; keyboard-only and light/dark checks. No G9 release gate is
closed by this record.
