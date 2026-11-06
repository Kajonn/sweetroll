# V2 direct token placement and movement — 6 November 2026

PR: https://github.com/Kajonn/sweetroll/pull/36

Status: implemented; local browser acceptance passed. Hosted and final CI checks pending.
V3 fog brushing, V4 combined acceptance and aggregate G8/G9 remain open.

## Implementation

- The token tray arms a snapshot of a labelled uploaded-image or label-only token.
  Tap the scene to place it. Select/move mode supports dragging, or selecting a
  token then tapping its destination. Pan mode never changes token coordinates.
- Pointer capture tracks a local preview. A completed gesture saves once; Escape,
  touch cancellation, capture loss, page scroll, resize/blur, changed scene revision or scoped
  actor/scene/background/offline remount discards unfinished input. Grabbing a
  token off-center preserves that offset. Focus capture does not scroll the scene.
- Coordinates are bounded normalized positions computed from the actual transformed
  scene layer, including CSS scale/pan. Keyboard zoom/pan and numeric/nudge plus
  Move controls remain available. Saved coordinates refresh the precision fields.
- One token command owner serializes gestures and precision forms. Unknown outcomes
  retain the exact body/key; confirmed conflicts read the authoritative scene before
  an explicit fresh-key retry. Failed post-save reads recover the read without
  resending the already applied change. Denied commands remove protected content.
  Feedback and intended conflict/recovery coordinates appear beside the scene.
- No API/schema changes, migrations, new runtime dependencies or offline edit queue.

## Test-first evidence and local checks

The pre-implementation gesture suite had four failing tests (mouse/touch preview,
tap placement and pan); four cancellation checks initially passed vacuously because
no gestures existed. Later regression cases independently failed before fixes for
grab offset, protected-content removal after denied commands, scope-unmount read
cleanup and scrolling focus and scrolling during an active gesture. The completed suite exercises active gestures before
cancelling them.

| Check | Result |
| --- | --- |
| Frontend full suite before final feedback polish | 1,255 passed; the later focus test adds one case |
| Final affected viewport/gesture/command/tray tests | 36 passed |
| Backend unit suite | 489 passed, 10 database-dependent skipped |
| Actual PostgreSQL scene/media integration | 31 passed (PostgreSQL 18.6 local fixture) |
| Frontend typecheck and production build | Passed |
| Generated contracts | Passed using `node --import tsx scripts/generate-system-contracts.ts --check` |
| Final local Chromium V2 journey | Passed in 15.2s, no retries |
| Whitespace/diff checks | Passed |

Local browser journey uses real HTTP, PostgreSQL and the existing bounded clean-image
scanner fixture. Background/scene creation, token-art upload, placement/movement,
keyboard controls, pairing and revocation use the GUI; independent API reads prove
saved state and archive cleanup. At 360, 768 and 1280px it verifies touch tap movement,
mouse dragging, native CDP touch dragging, zoom/pan and zero horizontal overflow.
Preview-only movement sends no request; each release saves once. Escape and native
touchCancel send no command. A real competing PATCH produces 409 and requires
explicit retry. A real applied request with its response aborted retries with the
identical key/body. Reload preserves the saved token; the separate display shows
its committed position. Axe reports no violations, offline hides editing, reconnect
restores it, revocation blanks display images, and cleanup independently reads back
an archived campaign.

The sandbox blocks Unix sockets used by tsx's launcher and standard Chromium. The
local-only runner uses `node --import tsx`, loopback TCP for PostgreSQL and a separate
headless-shell binary with normal multiple-process context isolation. No repository
runtime/dependency/config changes were made for these launch constraints. An initial
single-process browser launch incorrectly shared session state across contexts; that
launch was discarded. Early test targets also overlapped the token's label hit area;
the final test taps an unoccupied destination. Cleanup preserves the original failure.

## Hosted target

Only `sweetroll-d2-acceptance` / `preview` / `sweetroll-d2` is changed:
https://sweetroll-d2-preview.up.railway.app

Final application commit, deployment, served-build identity and hosted results will
be recorded after verification. Production and main-linked acceptance sources are
unchanged. No physical phone/tablet, real provider login, human visual approval or
real playtest is claimed.
