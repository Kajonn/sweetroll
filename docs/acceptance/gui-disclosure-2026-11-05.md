# GUI progressive disclosure — 2026-11-05

Implementation: PR #33, `feat/gui-progressive-disclosure`.
Application under test: `45aea0b3c9f9f80e116273af4a91b150c3a1bc0d`.

## Delivered behavior

Normal mode hides internal identifiers, revisions, checksums, diagnostic codes
and expression ASTs. Account → Developer tools → Show debug information reveals
these on the current device. Debug changes presentation, not permissions.
Identifier editing, validation limits, appearance, token coordinates and roll
calculations remain available in disclosures. Names, values, roll outcomes,
errors, publication blockers, permissions and conflict actions remain visible.
Creator actions and save state are consolidated, and appearance settings live
in Account. Member selectors use names, with identity suffixes when needed.

## Verification

| Check | Observed result |
| --- | --- |
| Red–green component tests | New disclosure/debug/name/diagnostic assertions failed before implementation and passed after it. |
| Frontend unit suite | 1,227 passed in 125 files. |
| Backend unit suite | 488 passed, 10 skipped. |
| Type checking and frontend production build | Passed. |
| Existing local browser journeys | 61/62 passed together; remaining setup journey passed after adapting its member-row selector to readable names. |
| New normal/debug journeys | Both 360px and 1280px passed; defaults, navigation persistence, identifier editing and preserved field values verified. |
| CI integration, contracts and Docker | Recorded in the PR checks; final workflow is authoritative. |
| Offline production-worker regressions | Recorded in the PR checks; final workflow is authoritative. |
| Focused production-worker rerun | All three campaign template/derived-template journeys passed after selectors were updated for the normal-mode “Campaign item” label. |
| Visual snapshots | Nine changed screenshots from CI run 42039280192, artifact 13420491381, inspected by the agent and proposed as updated baselines. Unchanged 360px sheet-preview baseline retained. |

The nine CI screenshots cover creator, library, publish dialog, conflict banner
and desktop sheet preview. No overlaps or clipped primary actions were observed.
Local rendering has different font metrics, so local screenshots were not used
as baseline replacements. Human visual sign-off remains open.

## Hosted preview

Isolated preview: <https://sweetroll-d2-preview.up.railway.app>.
Source: `Kajonn/sweetroll`, branch `feat/gui-progressive-disclosure`.
Deployment `e8109f95-33f3-4878-a5e0-da820c464afc` successfully deployed application
`45aea0b`. Production sources were not changed.

An earlier deployment of the same increment (`e3d4bc5`) was exercised manually:
cloned the d20 fixture, checked normal Account and creator presentation, enabled
debug, checked user/revision/sheet/section/element identifiers, navigated back,
and disabled debug. Values and navigation were preserved. Debug was left off.
The final application additionally passed the automated debug journeys above.

![Normal Account view](assets/gui-account-normal-2026-11-05.png)

Local browser checks use real Chromium and PostgreSQL 17; temporary configs
outside the repository replace the restricted tsx CLI IPC launcher with
`node --import tsx` and bind to loopback. No application behavior was mocked.

Physical-device, real-provider-login, human visual approval and table/remote
playtest gates remain open. These checks do not close the complete G9 release gate.
