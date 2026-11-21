# Shared physical dice for Sweetroll

Feature plan · 20 November 2026  
Based on Sweetroll `c10903f` and Vtrpg `0050784`. Appendix A contains newly measured normals for all 60 outcomes on the six numbered dice.

## Server feature toggle

The operator enables physical dice per server deployment with `SWEETROLL_PHYSICAL_DICE=true`. The default is `false`. Apply a change by restarting or redeploying the app service, using the same value on all its replicas. The existing roll engine handles every roll while the switch is off.

When enabled, authenticated browser sessions receive `physicalDiceEnabled: true` from `GET /api/me`. The browser only offers the physical-dice controls or loads the worker and numbered models when this capability is present. A player's **Show 3D dice** setting controls their own rendering within an enabled deployment. A thrower who hides animation still supplies the physical outcome.

As the remaining slices land, apply the server switch to preparation, completion, event publication and active-attempt recovery. When disabled, reject physical-only command requests before creating a roll or publishing an event. Keep existing committed results readable and let unfinished attempts expire. Acceptance must exercise both server settings, including a direct physical request with the switch off and a roller with 3D hidden when it is on.

## What players will see

A player taps the existing roll action. Dice in that player's chosen color roll across a transparent layer over the character sheet or campaign screen. Everyone currently allowed to see the roll sees the same throws, collisions and final faces. The camera fits the same tray on a phone and a desktop. The existing result card still shows the rules outcome, stacks with nearby events and fades as it does today. A kept pool die, a discarded die and a modifier can contribute differently to the result. The result card and breakdown continue to explain that distinction.

Give each account **Show 3D dice** and **My dice color** in preferences. The first is a viewing preference. A player with it switched off can make a physical roll that everyone else sees in that player's color. A player who switches off animation still gets the usual result card. Proposed default is on for a capable browser, with animation suppressed when the device requests reduced motion. Settings apply to the user's own devices after sign-in. Snapshot the thrower's color once per roll, tint the die body and keep the markings legible using contrasting ink.

## How every device reproduces the throw

Sweetroll sends two campaign events for a successful physical roll. The first carries enough information to simulate the throw immediately. The second confirms the initiating player's settled dice. Between them, the roller and each authorized viewer with 3D enabled run the same Rapier worker locally. Three.js draws the numbered Vtrpg models using the calibrated normals in Appendix A. Only the roller can submit the official result. A spectator's local face reading never changes campaign history.

| Campaign event | When | Contents |
| --- | --- | --- |
| `roll.started` | After the server authorizes and prepares the action, before the dice settle | Attempt ID, scheduled server start time, simulation version, thrower color, seed, ordered die IDs and shapes, and each body's exact initial position, orientation, linear velocity and angular velocity. |
| `roll.finished` | After the server accepts the roller's completion | Same attempt ID, committed roll ID, settled tick, ordered final positions, orientations and face values. The existing result card and history use the committed roll ID. |

These are the two notifications on the normal campaign path. The roller prepares and completes the action through the command API. Network traffic for the throw grows with the number of dice and authorized viewers. A longer throw adds local physics ticks and sends zero additional motion updates. For example, 20 dice require 20 initial body states and 20 final poses, regardless of whether they take two seconds or four to settle. Profile client CPU on a phone with that pool size.

### Deterministic physics and independent rendering

- Pin the exact deterministic Rapier 3D WebAssembly build (for example, `@dimforge/rapier3d-deterministic`). Version its bytes together with the tray, collider data, face table, gravity, solver settings, material properties, tick length and settle/rethrow rules. Every device loads the same physics inputs. Bake colliders once in model coordinates.
- Generate launch states once on the server. Encode their float32 components with a canonical round-trip representation. Even the roller initializes from the transmitted values. Insert tray bodies and dice in a specified order. Any later cocked-die rethrow uses a versioned integer PRNG keyed by seed, die ID and retry number, with deterministic arithmetic and stable processing order.
- Run a worker at a fixed simulation step of 1/60 second, independently of display refresh. Declare a die settled after the versioned linear/angular speed and face-alignment tests hold for a fixed number of consecutive ticks. Bound cocked-die recovery by tick and retry count. Vtrpg's render-frame stepping and elapsed-time cutoff must be replaced for this flow.
- Use the scheduled start time to target a display tick. A slow or late viewer can process several physics ticks together and skip drawings while catching up. It must still execute the ticks in order. Interpolate between adjacent local poses for Three.js. An orthographic camera uniformly fits the entire fixed tray to each viewport. Rotation or resize changes the camera only. Identical world positions at a given tick can appear at different pixel coordinates or slightly different wall-clock times.

### Authority, privacy and recovery

1. **Prepare and announce.** Authorize the existing campaign action, including its resolved audience, bindings, ordered dice/groups and push eligibility. Bind a short-lived attempt to actor, character, campaign, pinned rules and state revision. Persist the attempt before publishing its start event. Retrying the same command returns the same start state. Preparation creates no factual roll or action effects.
2. **Simulate and submit.** The initiator runs the worker even with rendering disabled. It reads settled faces with Appendix A and submits the final poses, readings and tick under the attempt ID. Other authorized players can see the throw immediately. Their workers only observe.
3. **Commit once.** Recheck current actor authority, audience and revision. Validate the expected dice and order, bounded tick, finite poses, normalized rotations and agreement between the submitted faces and calibrated final orientations. Pass the validated draws through the existing server evaluator for modifiers, keep/drop, push and success counting. Commit the receipt, roll, activity and effects atomically, then announce completion. Validate the submitted result without running the physics on the server. This design trusts the initiating device for the physical throw.
4. **Reconcile.** If the local simulation agrees, let it land normally. If it differs, display the accepted roller's poses and result and record a diagnostic with the simulation version and first observed difference when available. An incompatible viewer or one too far behind can show the accepted result directly. An early finish notification can be held for the visual landing while the existing result card remains independent. A finish received without a start can still show the official result. Deduplicate commands and notifications by their IDs.
5. **Deliver only to the roll audience.** Use campaign-member SSE with Sweetroll's stream lifecycle and cross-instance notification pattern. Apply the live roll read policy before sending either event or serving a pending start to a reconnecting user. The existing three-second activity feed remains the recovery path for committed results. Clear pending visuals on access loss, campaign change or expiry. A lost completion response is recovered via the command receipt. If the roller leaves before submitting and the attempt expires, spectators clear the pending throw and no result enters history.

## Coverage and failure behavior

| Situation | Planned behavior |
| --- | --- |
| Ordinary d4, d6, d8, d10, d12 and d20 | Support all six. Include numeric pools, mixed dice and modifiers when the server can determine every draw before throwing. |
| Physical push | Reuse the parent breakdown and existing eligibility rules. Animate only the dice being rerolled. Preserve the identities and faces of the other dice. |
| Opposed or private roll | Respect each roll's existing audience and parent/child restrictions. Independent actors still own their respective throws. |
| Custom, weighted or symbolic dice, percentile dice, or an expression whose next draw depends on a previous result | For the first release, route the entire action through today's evaluator if it cannot be faithfully represented. Make that decision before physical preparation. Avoid splitting one outcome across two sources of randomness. |
| Programmatic client, existing solo workflow, offline mode | Keep the current API and offline policy. The first physical flow is for online campaign play. |
| Viewer disables rendering, lacks WebGL, or loses the graphics context | Continue delivering the result card. Text-only spectators skip physics, model downloads and animation. A roller with functioning physics can submit headlessly. |
| Initiator lacks the required physics version or their tab closes | Detect capability before preparing and offer the ordinary roll explicitly. An unfinished physical attempt expires. Recover an already committed attempt by ID. |
| Concurrent rolls or missed events | Track independent attempts, bound concurrent visual work and preserve the result stack. A reconnecting viewer can fetch an authorized active start and catch up within a bounded local work budget. |

Keep the canvas transparent and pointer-transparent under the result cards. Cap device pixel ratio, pause drawing when hidden, release scene resources, and persist the account settings through the existing partial `GET/PATCH /me/preferences` contract. Keep dice color independent of system theme. Profile mobile worker time, message sizes and concurrent rolls before setting pool and catch-up limits.

## Implementation order and acceptance

Each slice starts with an observed failing test, implements the smallest passing change, and reruns the affected existing checks. Update `design_v2.md`, the GUI integration plan and API contracts alongside the implementation.

| Slice | First failing check | Acceptance evidence |
| --- | --- | --- |
| 1. Models and face reader | The actual d6 model with local +Z uppermost must read 3. The old table returns 1. A d4 resting with its local −Y face down must read 1. | Import the numbered assets. Build shared, renderer-independent face and collider metadata. Verify all 60 numbered resting poses against independent mesh/label fixtures, including tilted placements, ambiguous rests, printed d10 zero and rotated import axes. |
| 2. Physical resolution | A prepared mixed roll supplied with known orientations must give the same total, groups and breakdown as a controlled draw through the existing rules. | Cover ordinary rolls, keep/drop, success counts and pushes. Deny a different actor's completion. Reject missing/extra dice, conflicting retries and stale state. Concurrent completion creates exactly one receipt, result and set of effects. |
| 3. Deterministic shared throw | The same start fixture must produce identical state at intermediate ticks and at rest across Android Chrome, iOS Safari and a desktop browser. | Run seeded single dice, mixed shapes and a colliding 20-die pool. Hash canonical physics snapshots at named ticks before and after collisions. Compare hashes, settle ticks, poses and face values. Repeat under different display rates, frame throttling, and resize. Report the first divergent tick. Synthetic viewport tests supplement the device runs. |
| 4. Event delivery and overlay | A roller with visuals off can roll for a viewer with visuals on. The viewer sees the thrower's color and both receive exactly one result. | Assert one start and one finish for a successful roll and zero per-tick messages. Exercise duplicate, missed and late events, a deliberately mismatched final pose, incompatible client versions, reconnect across server instances, roller disconnect and audience revocation. Test preference persistence, reduced motion, keyboard focus, touch-through and renderer cleanup. |
| 5. Hosted campaign journey | GM and two players in independent browser contexts exercise the feature through normal campaign controls. | Check acceptance source branch, deployed commit and readiness. Roll each shape, a mixed pool and a push. At 360 px verify the full 20-die tray fits after rotating the screen. Compare settled faces against history and the rules total. Repeat with a private roll, a roller with 3D off, two simultaneous rolls and a disconnected observer. Record device/browser, build and observed results. |

### Slice 1 implementation record

The six numbered OBJ/MTL pairs from Vtrpg commit `0050784` are available under `/dice/v1/`. The `White` material is the body and `Black` is the engraving. Each `dN.hull.json` contains convex-hull points in the OBJ coordinate frame. Apply the same uniform scale and origin to the model and collider. To regenerate the points, run `python scripts/bake-dice-hulls.py` with SciPy installed.

The renderer-independent `readPhysicalFace` function takes the model-to-world quaternion for a Z-up tray. It returns a game value when the reading direction is within 10° of vertical. Invalid rotations and cocked poses return `null`. The simulation worker will decide when the body has stopped moving. For the d4 the reading direction points away from the support face, and for the d10 the engraving 0 means 10.

The first two tests failed on the +Z d6 and the −Y support face of the d4 before implementing the reader. The collider tests then failed for all six missing hulls. The passing suite checks each numbered resting pose at eight headings with a 5° tilt, using OBJ support triangles as a fixture independent of the runtime normal table. Run `npm test -- tests/physical-dice src/systems/physical-dice/faces.test.ts`.

### Slice 2 implementation record

With the server flag enabled, an authenticated browser can post an `executeAction` or `pushRoll` to `/characters/:characterId/physical-rolls`. The response contains an attempt ID, expiry, audience and ordered die IDs, groups and sides. An `attempt` of `null` directs the client to the ordinary command for unsupported throws. Preparation never records a roll. The initial limits are 60 seconds to submit, 100 dice and a final tick from 1 through 3600.

Only the initiating actor can post `{tick, dice}` to `/characters/:characterId/physical-rolls/:attemptId/complete`. Each die supplies its prepared ID, numeric value, position and Z-up orientation. The existing evaluator consumes the validated faces, including only eligible redraws on a push. The character command atomically saves the accepted poses, receipt, roll and activity. An identical completion can recover the authorized receipt after the animation deadline.

The mixed-pose regression uses a d6 showing 3 and a d8 showing 7 for a total of 12 with a +2 modifier. Integration tests exercise actor binding, idempotency, concurrent completion, group success counts, a push, expiry, stale revisions and membership changes. Slice 3 supplies the versioned launch state and deterministic physics worker. Slice 4 connects it to event delivery, preferences and rendering.

### Slice 3 implementation record

Preparation stores a server-generated 32-bit seed, scheduled start time and ordered float32 body states in the same row as the attempt. A retry returns the saved launch. Each body corresponds by index to one prepared die. The server runs no physics ticks.

The gated module worker at `/dice/v1/worker.js` pins `@dimforge/rapier3d-deterministic-compat@0.21.0`, the v1 assets and the `rapier-v1` simulation settings. Its Z-up tray spans 24 by 18 world units. Apply a uniform 0.6 scale to the original models to match the colliders. Any change affecting the replay must update the simulation version and checkpoint fixtures together.

Start one worker per attempt with `{type:"start", dice:attempt.dice, launch:attempt.launch}`. On its initial frame, advance it with `{type:"advance", tick}`. A viewer can derive its target tick from elapsed time since `launch.startsAt` at 60 Hz. Each response advances up to 120 ticks toward that target. The `frame` contains the actual tick and ordered poses. The `settled` frame contains all readings for completion. An `unsettled` frame or a worker error ends the attempt without supplying a result. Terminate the worker on cancellation or after the final frame. Screen size and inter-frame time never enter the physics calculation.

A body must stay slow and aligned for 18 consecutive ticks. A slow, unreadable die gets a deterministic rethrow after 30 ticks, up to three retries. The hard limit is 1,200 ticks. Only the roller submits; camera fitting, visual interpolation and audience delivery belong to slice 4.

The regression suite covers each of the six shapes, a mixed pool and a 20-die throw. Its checkpoints hash Rapier's serialized world and the settling counters at the start, ticks 12, 30 and 72, and the final tick. The production worker is exercised through desktop Chromium, mobile-emulated Chromium and mobile-emulated WebKit with different frame schedules and a resize. Run `npm run web:build` and `npm --prefix web run test:physics` after installing the Playwright Chromium and WebKit browsers. Physical Android Chrome and iOS Safari measurements remain an open acceptance gate.

## Appendix A · Measured normals for the numbered models

These vectors are in the **unmodified OBJ local frame** and point outward from the physical face. They were calculated from the six numbered Vtrpg OBJ meshes at `0050784`. For each model, group near-coplanar convex-hull facets by outward direction, select the large physical faces, and refine their directions with area-weighted coplanar white body triangles. Project the black numeral geometry onto each face to associate that plane with its actual engraving. Vertex shading normals, engravings and bevels do not define separate die faces. Pin the model revision with the table. If the build converts, scales non-uniformly or rotates a model, bake the matching normal transform and collider alignment during import.

For d6 through d20, rotate each local normal by the die's world orientation and select the largest dot product with world up. Use the direction opposite gravity as world up. The d4 has three numbers per face and a single value at its upper vertex. Its four table rows map the **downward support face** to the visible upper number. Select the most negative dot product for this model. Equivalently, negate its four stored vectors before using the common maximum-dot reader. The d10's printed 0 corresponds to the row for value 10.

The calculation produced 60 distinct labeled directions across the six models. I checked the projected markings, separately rendered the four d4 resting orientations to read their raised corners, and checked all 60 against independently selected hull support triangles under eight rotations with a small tilt. All 480 geometric readouts matched. These checks cover model coordinates and value mapping. Runtime collider alignment, settling and on-screen appearance still need the tests in slices 1 and 5.

| Model | Game value | Local outward unit normal (x, y, z) |
| --- | ---: | --- |
| d4 | 1 | 0.000019, -1.000000, 0.000269 |
| d4 | 2 | 0.816441, 0.333221, -0.471579 |
| d4 | 3 | -0.816552, 0.333191, -0.471409 |
| d4 | 4 | 0.000093, 0.333588, 0.942719 |
| d6 | 1 | 0.000000, 1.000000, 0.000000 |
| d6 | 2 | -1.000000, 0.000000, 0.000000 |
| d6 | 3 | 0.000000, 0.000000, 1.000000 |
| d6 | 4 | 0.000000, 0.000000, -1.000000 |
| d6 | 5 | 1.000000, 0.000000, 0.000000 |
| d6 | 6 | 0.000000, -1.000000, 0.000000 |
| d8 | 1 | 0.000000, 1.000000, 0.000011 |
| d8 | 2 | 0.816496, -0.333339, 0.471401 |
| d8 | 3 | 0.000000, -0.333323, -0.942813 |
| d8 | 4 | -0.816497, -0.333339, 0.471400 |
| d8 | 5 | 0.816497, 0.333338, -0.471401 |
| d8 | 6 | 0.000000, 0.333323, 0.942813 |
| d8 | 7 | -0.816496, 0.333338, -0.471401 |
| d8 | 8 | 0.000000, -1.000000, -0.000011 |
| d10 | 1 | 0.000000, 1.000000, -0.000366 |
| d10 | 2 | 0.772135, -0.544430, 0.327725 |
| d10 | 3 | 0.477206, -0.192697, -0.857404 |
| d10 | 4 | -0.772135, -0.544430, 0.327725 |
| d10 | 5 | 0.772135, 0.544431, -0.327725 |
| d10 | 6 | -0.477206, 0.192697, 0.857404 |
| d10 | 7 | -0.772135, 0.544430, -0.327725 |
| d10 | 8 | 0.000000, -1.000000, 0.000365 |
| d10 | 9 | -0.477206, -0.192697, -0.857404 |
| d10 | 10 | 0.477206, 0.192697, 0.857404 |
| d12 | 1 | 0.000000, 1.000000, -0.000043 |
| d12 | 2 | -0.850651, -0.447225, -0.276374 |
| d12 | 3 | 0.525731, 0.447183, -0.723626 |
| d12 | 4 | 0.000001, -0.447252, -0.894408 |
| d12 | 5 | -0.525731, 0.447182, -0.723626 |
| d12 | 6 | 0.850651, -0.447225, -0.276374 |
| d12 | 7 | -0.850651, 0.447225, 0.276373 |
| d12 | 8 | 0.525731, -0.447183, 0.723626 |
| d12 | 9 | -0.000001, 0.447252, 0.894408 |
| d12 | 10 | -0.525731, -0.447183, 0.723626 |
| d12 | 11 | 0.850651, 0.447225, 0.276374 |
| d12 | 12 | 0.000000, -1.000000, 0.000044 |
| d20 | 1 | 0.000025, 1.000000, -0.000022 |
| d20 | 2 | -0.577361, -0.745334, 0.333362 |
| d20 | 3 | 0.356812, 0.333306, -0.872693 |
| d20 | 4 | 0.356834, -0.333323, 0.872677 |
| d20 | 5 | -0.577325, 0.333364, 0.745362 |
| d20 | 6 | 0.934161, -0.333361, -0.127336 |
| d20 | 7 | -0.577339, 0.745364, -0.333336 |
| d20 | 8 | -0.000034, -0.745371, -0.666650 |
| d20 | 9 | 0.934184, 0.333312, 0.127292 |
| d20 | 10 | -0.577375, -0.333336, -0.745336 |
| d20 | 11 | 0.577376, 0.333335, 0.745335 |
| d20 | 12 | -0.934184, -0.333312, -0.127292 |
| d20 | 13 | 0.000034, 0.745370, 0.666651 |
| d20 | 14 | 0.577339, -0.745363, 0.333336 |
| d20 | 15 | -0.934161, 0.333360, 0.127335 |
| d20 | 16 | 0.577325, -0.333364, -0.745362 |
| d20 | 17 | -0.356834, 0.333323, -0.872677 |
| d20 | 18 | -0.356812, -0.333306, 0.872693 |
| d20 | 19 | 0.577361, 0.745335, -0.333362 |
| d20 | 20 | -0.000025, -1.000000, 0.000022 |

## Source references

- [Numbered Vtrpg assets](https://github.com/Kajonn/Vtrpg/tree/0050784411a4b88673fcf5c48d15b69fcfef8cd5/src/assets/dice), [Three.js model loading and former normal table](https://github.com/Kajonn/Vtrpg/blob/0050784411a4b88673fcf5c48d15b69fcfef8cd5/src/components/DiceRenderer.jsx), [Rapier throw and readout](https://github.com/Kajonn/Vtrpg/blob/0050784411a4b88673fcf5c48d15b69fcfef8cd5/src/components/DiceOverlay.jsx)
- [Sweetroll rules evaluator](https://github.com/Kajonn/sweetroll/blob/c10903f1965bd5dd88f20ea9394e41bbe4551ed9/src/systems/implementation/rules/evaluate.ts), [push evaluation](https://github.com/Kajonn/sweetroll/blob/c10903f1965bd5dd88f20ea9394e41bbe4551ed9/src/systems/implementation/rules/push.ts), [character commands](https://github.com/Kajonn/sweetroll/blob/c10903f1965bd5dd88f20ea9394e41bbe4551ed9/src/characters/index.ts)
- [Current campaign feed](https://github.com/Kajonn/sweetroll/blob/c10903f1965bd5dd88f20ea9394e41bbe4551ed9/web/src/playEvents/CampaignPlayFeed.tsx), [result overlay](https://github.com/Kajonn/sweetroll/blob/c10903f1965bd5dd88f20ea9394e41bbe4551ed9/web/src/playEvents/PlayEvents.tsx), [account preferences tests](https://github.com/Kajonn/sweetroll/blob/c10903f1965bd5dd88f20ea9394e41bbe4551ed9/tests/integration/identity-preferences.test.ts)
- [Rapier JavaScript determinism requirements](https://rapier.rs/docs/user_guides/javascript/determinism/), [deterministic 3D package](https://www.npmjs.com/package/@dimforge/rapier3d-deterministic)
