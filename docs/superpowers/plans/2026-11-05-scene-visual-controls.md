# Complete the I7b/G8 visual scene controls

Status: planned; V1–V4 are open. No implementation or acceptance is claimed.
Updated 2026-11-05 after the owner's review of campaign scenes.
Baseline inspected: `5e3d81f` on PR #33.

Authority: [design Sections 7.7 and 17.9a](../../../design_v2.md),
[GUI plan G8](2026-09-08-gui-integration.md#g8--i7b-media-simple-scenes-and-restricted-player-display)
and [approved scene spec, Section 3](../specs/2026-09-14-i7b-scenes-display-design.md#section-3--gm-scene-ui).
This completes already specified work; it does not introduce a full VTT.

## What is actually delivered

| Capability | Observed implementation | Remaining work |
| --- | --- | --- |
| Backgrounds | Upload, select, create/open and confirmed replacement; M3 accepted. | Reuse these controls and private campaign media. |
| Tokens | Label markers; place/move forms; normalized coordinates; numeric/nudge controls. Placement currently sends `imageFileId: null`. | Select/upload art, render images/size and provide direct placement/movement. |
| Fog | Reveal/conceal circular dabs entered numerically, undo local dabs and commit. | Paint on the scene with mouse/touch and preview the stroke. |
| Restricted display | Paired access, server-redacted background, permitted label markers and polling. | Render permitted token images/size without gaining GM/original access. |

Inspect the existing `SceneViewport.tsx`, `TokenTray.tsx`, `FogToolbar.tsx`,
`SceneLibrary.tsx`, `DisplayView.tsx`, campaign API/query seams and Campaigns
scene/media/display implementations before coding. Existing data records support
optional token images; verify each derived contract instead of inventing a new
scene model. The historical Task 6/7/8 checks do not prove the missing controls.

## Constraints and sequence

Implement V1 → V2 → V3 → V4. Each step starts with failing tests against the
current implementation, then the smallest implementation and relevant green
regressions. Keep established Module ownership and generated API types.

- Reuse bounded/scanned private campaign media, resource-scoped access, existing
  revisions, idempotency handling, actor/generation query scope and display polling.
- Scene edits stay online-only. Preserve pending/applied/error states, authorization
  loss cleanup, background-replacement resets and explicit conflict recovery.
  Do not add an offline gesture queue in this completion work.
- Keep numeric coordinates/nudges as precision and keyboard alternatives inside
  disclosures. Gesture controls become the ordinary visual workflow.
- Retain labelled 44px touch targets and keyboard focus; distinguish select/move,
  brush and pan so one gesture cannot accidentally perform multiple operations.
- Reuse existing contracts where sufficient. Any required contract change must be
  narrowly justified, generated and tested. No pre-release migrations, old-client
  compatibility paths, tactical grids, movement rules, vision, lighting or arbitrary
  drawing tools belong to this work.

## V1 — Image tokens in GM and restricted display

- [ ] Write failing component/authorization tests for selecting existing campaign
  art or uploading an image, optional labelled fallback, normalized image size,
  unavailable art and display-safe image loading.
- [ ] Reuse campaign upload/catalog controls in the token tray. Pass the selected
  `imageFileId` on placement; retain a readable label and optional label-only token.
  Do not add background replacement merely to select token art.
- [ ] Render token art and its stored scene-relative size in both scene views.
  Preserve the same position/anchor at different viewport widths. Use GM-authorized
  bytes on the GM view and the existing credential-scoped token-image path on the
  display; never give a display the campaign original route or GM credentials.
- [ ] Verify hidden/fog-covered tokens and their image bytes remain unavailable
  to the display; referenced image deletion remains protected. Reopen the scene
  and redeploy to prove the selected image is retained. Missing art shows a labelled
  fallback; sign-out/revocation clears protected presentation.

Primary files: `web/src/campaigns/TokenTray.tsx`, `SceneViewport.tsx`,
`SceneLibrary.tsx`, `web/src/display/DisplayView.tsx` and their tests. Reuse the
existing campaign media/scene/display APIs and authorized image loader patterns.

Exit: a GM uploads/selects art and places a labelled image token entirely through
UI; the permitted paired display shows the same image, position and relative size.

## V2 — Direct token placement and movement

- [ ] Start with failing browser/component tests for mouse dragging, touch dragging
  and tap-to-place/move, plus cancellation and normalized coordinates at zoom/pan.
- [ ] Provide explicit token selection/placement/move modes. Tap a scene position
  to place/move a selected token; use pointer events/capture for drag preview.
  Only a completed move commits; pointer cancellation or Escape discards the local
  preview. Panning and painting do not move tokens.
- [ ] Convert pointer/touch positions through the rendered scene transform to
  normalized scene coordinates. Bound positions consistently and keep overlays
  aligned under fit, zoom, pan, resize and phone/tablet orientation changes.
- [ ] Use the existing move/place commands, revision checks and mutation recovery.
  Do not send a request for every pointer move. A conflict re-reads the scene and
  requires explicit review/retry; no silent overwrite or guessed revision.
- [ ] Preserve the numeric/nudge + Move workflow. Verify keyboard operation,
  offline disabling, pending feedback and actor/scene/background changes during
  an unfinished gesture.

Primary files: `SceneViewport.tsx`, `TokenTray.tsx`, campaign query/API seams,
related tests and scene browser journeys. Keep one mutation owner for gestures
and numeric controls so the same operation cannot be submitted twice.

Exit: mouse and touch can place and move an image token while zoomed/panned;
reopening and the paired display show its committed position. Keyboard-only
users can perform the same operation with the existing alternatives.

## V3 — On-image reveal/conceal brush

- [ ] Write failing tests for pointer/touch strokes, radius preview, Reveal/Conceal,
  local undo, cancellation and coordinate conversion under zoom/pan.
- [ ] Connect FogToolbar mode/radius to an on-scene brush. Show committed fog and
  the uncommitted stroke clearly on the GM view while allowing the GM to inspect
  the original. Collect bounded normalized dabs using the existing fog operation;
  avoid unbounded pointer samples or one request per sample.
- [ ] Keep explicit **Commit fog edit** and local **Undo fog stroke**. Uncommitted
  preview never changes the player display. The numeric dab controls remain
  available as a keyboard/precision alternative.
- [ ] Send the existing revision-checked fog command. Preserve the local stroke on
  a conflict for explicit review/retry against the refreshed scene; do not merge
  strokes automatically. Cancel unsafe drafts on authorization loss, scene or
  background change. Keep offline mutation disabling and clear feedback.
- [ ] Verify the paired display receives only server-redacted pixels after commit.
  Concealed regions never arrive as original image bytes under a client overlay;
  zoom/pan and brush size remain aligned across both input types and viewport sizes.

Primary files: `FogToolbar.tsx`, `SceneViewport.tsx`, their tests and the existing
Campaigns fog/display contracts. Add shared transform helpers only where needed
by both token gestures and brush input; keep rendering outside the rules engine.

Exit: a GM paints a region, previews/undoes it, commits Reveal, then commits
Conceal. Only committed permitted pixels appear on the paired display.

## V4 — Hosted acceptance and completion gate

- [ ] Extend browser journeys using actual pointer gestures and touch input,
  instead of proving only coordinate-form API calls. Cover phone 360px, tablet
  768px and desktop 1280px, zoom/pan, cancellation and keyboard alternatives.
- [ ] Run component regressions/typecheck, affected scene/media/display integration
  and privacy tests, scene journeys, relevant offline regressions and normal CI.
  Record failures before implementation and passing checks after it.
- [ ] Deploy the branch to the isolated test service; check its source commit,
  successful deployment and served build identity before testing. Do not change
  production sources. Run the ordered journey below through the real GUI.
- [ ] Record commit/deployment, commands/results, input/viewport coverage, screenshots,
  limitations and retained/cleaned fixtures in
  `docs/acceptance/scene-visual-controls-YYYY-MM-DD.md`.
- [ ] Close the three visual-control items in G8 and update I7b/design status only
  after this evidence passes. Numeric-only tests, API support and M3 background
  acceptance cannot close them. Keep physical-device, real-login, human visual
  approval and table/remote G9 playtests open until separately performed.

Ordered hosted journey:

1. GM opens a campaign, uploads a background and creates a scene through the UI.
2. Upload/select token art, place one visible image token and one hidden token;
   pair a separate restricted display. The hidden token/image stays unavailable.
3. Tap/place and drag/move with pointer and touch, including zoom/pan, then reopen
   the scene. Verify exact saved positions and permitted image/size on the display.
4. Paint Reveal, undo the draft, repaint and commit; paint/commit Conceal.
   Check draft isolation and redacted display pixels/hidden-token image access.
5. Exercise a stale revision, cancelled gesture and offline/reconnect. Confirm
   explicit recovery and no duplicate move or fog command; use keyboard alternatives.
6. Replace the background and verify old fog/tokens/drafts reset. Revoke the
   display and confirm protected content blanks and image access is denied.

Human verification on an actual phone/tablet and a real table or remote session
remains part of G9; emulated touch alone must not be reported as physical-device
acceptance.
