# T1 system color themes — 2026-11-04

Application under hosted test: `0c30b2c03d2d1d8efa1521f26699b8af69aa07fe`.
Isolated Railway project `sweetroll-d2-acceptance`, environment `preview`, service
`sweetroll-d2`, source `docs/system-themes-and-images` pinned to that commit.
Deployment `ee0d79be-5ca6-4167-8def-5f8369a092f1` reached **SUCCESS**.
URL: https://sweetroll-d2-preview.up.railway.app.

## Red → green

- `npm test -- src/systems/implementation/package/presentation.test.ts` first
  failed all three preset preservation cases because documents rejected
  `metadata.presentation`. The five focused tests passed after implementation.
- The new web tests first failed because the presentation capability was absent;
  the subsequent interaction run caught a broken select/label association.
  The fixed tests prove portal inheritance, isolated scopes, preserved unflushed
  text, reset and preview propagation. Focused run: 41/41 passed.
- Full web suite: 118 files, 1,197 tests passed. Backend's initial parallel run
  hit four existing HTTP timing limits under concurrent local checks. The
  separate HTTP rerun passed all 67 cases. Root and web type checks, generated
  contract checks and production builds passed.

## Hosted journey

`web/tests/hosted/systemThemes.spec.ts` passed in 1.5 minutes. It uses a real
deployed frontend/API and PostgreSQL, one test author and scoped test fixtures.

| Check | Result |
| --- | --- |
| GUI preset change, automatic save, reload | PASS |
| GUI publication and originating dialog colors | PASS |
| Export and clone preserve the published Blue choice | PASS |
| Later Ochre draft cannot recolor the pinned character or campaign | PASS |
| Default, Blue, Ochre × light/dark × 360/1280 px, routed screenshots and axe | PASS, 12 combinations, no axe violations |
| Character edit and authoritative roll | PASS |
| Global account page has no system scope; second system restores its own choice | PASS |
| Authorized cached sheet reopens offline with its pinned Blue choice | PASS |
| Created characters/campaigns/systems archived and systems made private | PASS |

Runner corrections: the first poll dereferenced a selection before automatic
save finished; it now polls absence safely. Offline proof waits for the existing
“Available offline” acknowledgement. The local browser runner trusts the
workspace TLS interception for service-worker installation; this changes no
application authentication or TLS setting. No bearer credentials are recorded.

## CI follow-up

CI #202 passed web unit/build, all three journey shards and the complete
production-worker offline suite. It caught two issues:

1. The new campaign theme read initially checked out another connection after
   the read transaction. The single-transaction regression caught the pooled
   read and hung its callback spy. Resolve the immutable package on the existing
   authorized read client instead; retain the original regression unchanged.
2. Creator screenshots changed because Basics now contains the preset picker.
   Both CI-produced images (360/1280 px) were inspected before replacing their
   baselines. All other visual baselines passed unchanged.

Follow-up `047b0a7` passed CI #203 after the unchanged load check was retried:
its initial p95 creation result was 302.3 ms against the 300 ms budget. No budget
was relaxed. The transaction regression and both reviewed visual baselines pass.
The hosted build `build-mw1ul18f` was separately compared byte-for-byte against
its rebuilt HTML, CSS, JavaScript, worker and manifests; the artifact check passed.
T1 automated feature acceptance is complete.
T2 and M0 acceptance follow below and in the separate image-foundation record.
M1–M3 remain incomplete. Human visual approval, physical devices and the remaining
G9 release gates are not closed by this automation.

## T2 component styles

Application `0d51195d6e8a1bb2d3b800e7d688fe0e36791acc`, isolated preview deployment
`1cb4b860-cd1c-4150-9d16-ca2724212089`, reached SUCCESS. CI
[#205](https://github.com/Kajonn/sweetroll/actions/runs/41805791817) passed all jobs.

Default and Classic component styles compose with Default, Blue and Ochre
colors. Classic uses platform typography and scoped CSS for headings, dividers,
panels, actions, item cards and resource controls. Selection travels through the
same draft, immutable package, clone/export and runtime projection as T1.
Portaled dialogs inherit both color and style.

The focused red–green selection/preservation tests passed: 8 backend cases and
53 web cases. The extended deployed `systemThemes.spec.ts` journey passed in
2.3 minutes on this application:

| Check | Result |
| --- | --- |
| GUI save/reload, publication, clone and export retain color and style | PASS |
| Later draft changes preserve pinned character/campaign presentation | PASS |
| 3 colors × 2 styles × 2 modes × 2 widths (360/1280 px) | PASS, 24 screenshot combinations, no axe violations |
| Originating dialogs inherit Classic typography | PASS |
| 200% text expansion, keyboard focus and phone page overflow | PASS |
| Character edit/roll and authorized offline reopening | PASS |
| Global navigation/account isolation and switching systems | PASS |
| Scoped journey fixture cleanup | PASS |

The Classic Blue dark phone, Classic Ochre light desktop and enlarged-text
phone screenshots were inspected. Browser automation and these inspections
complete T2 automated feature acceptance; they do not supply human sign-off or
physical-device evidence.
