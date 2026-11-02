# Multi-user adventure journey — repeatable acceptance protocol

**Authority:** owner instruction, 2026-11-01: fix the discovered problems next,
then test with the same sequence as the completed journey. This protocol is the
required post-fix rerun, not evidence that the fixes have already passed.

- [Historical execution and findings](multi-user-journey-2026-11-01.md)
- [Machine-readable historical evidence](multi-user-journey-2026-11-01.json)
- [Required remediation plan](../superpowers/plans/2026-11-01-multi-user-journey-remediation.md)

## Preconditions and fixed fixtures

Use one GM/owner and three players with separate browser contexts/cookie jars.
The existing synthetic identities in `src/bootstrap/http.ts` are suitable in an
explicit test-auth environment: Journey GM and Journey Players One, Two, Three.
Fixture sign-in may use `/dev/signin`; this is not production/provider-auth acceptance.
Keep all four contexts isolated and alive during shared-session checks.

Before creating data, record the source branch and exact application commit,
terminal deployment SUCCESS, `/health/ready`, and served frontend/backend identity.
Verify all four test identities can sign in. Use an isolated intended test service;
do not change the production source or enable test authentication on production.
If preflight fails, mark **BLOCKED** and resolve the test environment before running.
An existing preview is usable only after verifying its exact application identity.

Use a unique run suffix on system/campaign/character names. Start with fresh data;
the historical resources are archived and must not be reused. Record every created
resource ID privately for scoped cleanup, but never publish cookies or invitation tokens.

| Actor | Viewport | Character | Might | Agility | Will | Character creation path |
| --- | --- | --- | ---: | ---: | ---: | --- |
| GM | 1280 × 900 | None | — | — | — | Authors system and adventure |
| Player 1 | 360 × 900 | Aldric the fighter | 2 | 3 | 4 | Personal character, then GUI adoption |
| Player 2 | 768 × 900 | Bryn the mage | 3 | 3 | 3 | Create directly in campaign |
| Player 3 | 1280 × 900 | Cora the scout | 4 | 3 | 2 | Create directly in campaign |

Author **Tower of Ash** from a blank system, default dice d20, entity Hero,
integer attributes Might/Agility/Will, and an Adventurer sheet section that binds
all three fields and two slots: Equipment accepts item; Spells accepts spell.
Publish rules version 1.0.0 and share through the existing link-sharing UI.
This is a rules-package version, not an application release or migration test.

| Template | Scope/kind | Actions or data |
| --- | --- | --- |
| Longsword | System/item | Sword attack: d20 + Might; Sword damage: d8 + Might |
| Firebolt | System/spell | Cast Firebolt: d20 + Will; Firebolt damage: d6 + Will |
| Rope | System/item | Data-only; create and publish, no placement assertion |
| Ashguard blade | Campaign/item | Based on Longsword; inherit its actions |
| Ember spell | Campaign/spell | Based on Firebolt; inherit its actions |
| Caravan supplies | Campaign/item | Blank/data-only, default quantity 3 |
| Secret vault key | Campaign/item | Blank/data-only; initially GM only |

## Ordered sequence and assertions

Run MU-00 through MU-12 **in order**. Perform user operations in the GUI; API reads
may independently verify authorization, counts, revisions, dice and stored data.
The only allowed non-GUI setup is synthetic fixture authentication. Scoped cleanup
may use existing archive APIs. Do not seed a finished system, campaign, membership,
character or item over HTTP to bypass a user journey step.

| Step | GUI operations | Required result after fixes |
| --- | --- | --- |
| MU-00 | Complete deployment/identity preflight above. | Exact target recorded; four distinct actors ready. |
| MU-01 | GM creates the blank system, attributes, three system templates/actions, slots and sheet; saves and publishes. | Saved state reopens; valid 1.0.0 version and all definitions persisted. |
| MU-02 | GM creates **The Missing Caravan** from that version; adds public **Village briefing** (find the caravan near the ruined tower) and **GM secret: ambush** (caravan master betrayed the party), GM only. | Correct campaign pin and both audience policies persisted. Wait for each save response and cleared form before creating the next note. |
| MU-03 | For players 1, 2, 3 in turn, GM issues a fresh invitation. Player opens token-entry GUI without a URL token, pastes token, reviews and accepts. | All three join through this manual path; submitted token remains the entered token; no empty-token 400. Each sees the public briefing/body but no secret or Settings tab. |
| MU-04 | Player 1 creates a personal character from the shared version and adopts it using the repaired GUI and disclosure confirmation. Players 2 and 3 create their characters directly in the campaign. | Three independently controlled attached sheets. Player 1 uses no direct adoption request from test code. Set attributes to the actor table before rolls. |
| MU-05 | GM creates Ashguard blade, Ember spell, Caravan supplies and Secret vault key through Items & powers. First three are all-player templates; key is GM only. | Two inherited-action templates and two blank templates persisted with correct kinds/audiences. |
| MU-06 | For players 1, 2, 3 in turn, add Longsword, Firebolt, Ashguard blade, Ember spell and Caravan supplies; create personal **Lucky token N**, description “Personal adventure equipment”, actor-specific notes, quantity 2. Execute the six actions listed below. | Six entries per sheet, 18 entries total at this checkpoint; proper kinds in each slot. No secret key in any picker. System/derived actions work; ordinary personal equipment has no invented executable actions. |
| MU-07 | Reload each sheet and inspect retained entries/actions and horizontal overflow. Each player attempts another player's sheet and secret-template ID and attempts catalog management; GM opens Characters. | Data/actions retained at 360/768/1280 px without horizontal overflow. Unauthorized reads/writes denied (404 or specified management denial), no leaked view. GM can open all three sheets. |
| MU-08 | All three players execute Sword attack, then Cast Firebolt in their separate sessions, concurrently across actors. | Six additional successful rolls. Inspect raw dice, field bindings and totals: the actor's Might/Will is used, and total equals the actual die + that value. |
| MU-09 | GM shares the key with player 1 only. Inspect each actual player's catalog and direct ID; preview players 1 and 2 as GM. Player 1 attempts sheet placement. GM explicitly reveals to all players; player 2 places a copy. GM narrows back to GM only; player 2 reloads and attempts new placement. | Recognizable player labels target the correct stable IDs. Only player 1 initially sees the restricted draft; others receive 404. Preview equals actual policy; restricted placement blocked. Reveal permits placement; narrowing preserves that existing copy while blocking new placement. |
| MU-10 | On player 1's sheet, wait for Available offline; disconnect that context, add personal **Offline trail ration**, reload offline, reconnect. | Changes pending survives reload; sync settles; exactly one new stored ration. Do not weaken the production-worker offline check. |
| MU-11 | Player 1 edits its Caravan supplies quantity from 3 to 2; save and reload. Independently read player 2's copy and catalog. | Player 1 retains 2; player 2 and catalog retain 3. |
| MU-12 | Archive only this run's three characters, four campaign templates and campaign. Make its system private and archive it. Read all statuses independently. | All tracked resources archived; system private; unrelated data and deployment sources preserved. No deletion needed. |

MU-06 action order per player: **Longsword / Sword attack**, **Longsword / Sword
damage**, **Firebolt / Cast Firebolt**, **Firebolt / Firebolt damage**, **Ashguard
blade / Sword attack**, **Ember spell / Cast Firebolt**. Check the correct dice
and attribute binding; totals depend on the actual server roll, never a fixed
“lucky” result. Preserve 18 initial + 6 concurrent = **24** successful rolls.

After MU-06 there are six entries per character. MU-09 adds a seventh to player 2;
MU-10 adds a seventh to player 1. Later counts must account for these intentional additions.

## Historical failures versus the required rerun

The 2026-11-01 run reproduced F1 for all three players, then accepted each pending
invitation through its URL to continue. It used the existing adoption API once for
F2 and ID labels to target F3 recipients. Those exceptions are historical evidence,
**not passing post-fix results**. Any such fallback in MU-03/MU-04 makes the rerun
FAIL or BLOCKED. Retain invitation-link acceptance as an additional focused regression
using a fresh invitation/fixture campaign; do not silently replace the manual step.

The exploratory harness resumed after selector/save-wait adjustments and incorrectly
tried ordinary dice history through a push-roll-only read path. Those harness errors
are not product defects. Do not promote that scratch script or its old state as a
passing canonical runner. Implement a maintainable spec in the existing fixture/E2E
structure without weakening these steps, assertions, retries or workload.

## Result record and completion gate

For every step, record PASS/FAIL/BLOCKED, actual actor/viewport, evidence and any
deviation. Record commit/deployment/assets, CI results, exact commands, response
statuses, total/binding checks, inspected screenshots and cleanup readback. Redact
invitation tokens/session credentials. Keep the historical report immutable and
write a new dated post-fix acceptance record linked from the remediation plan.

**Completion requires:** F1–F3 fixed with observed red → green tests, required CI
green, and MU-00–MU-12 passing on the deployed fixed commit without the historical
GUI bypasses. A count of successful rolls alone is insufficient. Provider login,
physical Android/iPad and real table/remote playtests remain separate open G9 gates.
