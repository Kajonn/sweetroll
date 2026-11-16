# Sweetroll event overlay

**Feature plan · 14 November 2026 · Reviewed against `main` at `7c4107c`**

## Player experience

Show new play events in a non-modal overlay on character sheets and campaign pages, including the GM Session board. A roll card shows who rolled, the total, and the audience when relevant. A card draw shows the drawn card names. A campaign handout event shows the type of change and the title when the current reader can see it. Use existing actor labels and localized text. Detailed dice, push controls, and past events are available in the character sheet and the appropriate Activity view.

| Behavior | Proposed first version |
| --- | --- |
| Placement | Upper right on desktop. Below the compact header on phones, within safe-area insets and clear of the bottom navigation. Bound the width and height and allow long text to wrap. |
| Timing | Show the card immediately on receipt. Hold it for **6 seconds**, fade its opacity for **240 ms**, then remove it. Use the same hold time with immediate removal when reduced motion is requested. |
| Stacking | Append each distinct event as its own card, with the newest at the top. Every card owns its deadline. Three events a second apart yield three simultaneous cards that then fade a second apart. |
| Bursts | Show up to **three cards**. Keep the visible cards in place when full and show a count of additional recent events. As space opens, surface still-fresh overflow cards with their original deadlines. Every event remains available in its authorized history. Retain only fresh overflow entries up to a bounded limit and size the stack for small screens. |
| Interaction | Keep the overlay passive, with click-through and no change to keyboard focus. Announce arrivals through one polite live region. Group announcements during a burst and avoid announcing the same successful roll in both the inline result and the overlay. |

Use app defaults for the duration and stack size. Apply the existing light, dark, and system theme tokens. The first event types are rolls, pushed rolls, card draws, and visible campaign content creation, updates, and grant changes. Use factual text such as “Campaign note updated” for generic updates since the activity kind also covers ordinary edits. Keep field changes, sync messages, and administrative activity in their existing surfaces. Mount the overlay in the signed-in app shell. The restricted `/display` route continues to use its own scene viewer.

## Implementation

### 1. Show confirmed results for the acting player or GM

- Add a shared overlay component and a small in-memory state model backed by a testable clock. Define one deduplication key and deadline per event. Keep the host within the authenticated shell and key its state to account generation and the active campaign or standalone character. Use scoped publishers so a response from a previous screen cannot add a popup to the current one.
- Publish from the character session’s acknowledged-result paths and the GM Session board’s successful command-response path. Include the GM board’s push session. Use the result returned by the server for ordinary, granted, opposed, and pushed rolls and for card draws. Capture the current action label when already available. The overlay displays a summary, and the existing result surface provides details and push controls.
- Expose the persisted `rollId` in the browser command result and save it in the same idempotency receipt as the roll. Campaign activity already has `sourceRollId`, so both sources use the same key. Each pushed attempt uses its own saved roll ID. Requests that happened to have the same result stay distinct. A recovered command response can surface once when it belongs to a recent, still-active action. Reopening a cached `lastRoll`, replaying a stale queued attempt, and receiving a failed or uncertain response produce no card.

### 2. Show new campaign events to authorized participants

- Use the campaign activity records as the source. Extend the browser activity DTO with an optional, display-safe summary derived from the same authorized query. A shared roll summary can use the stored total, effective audience, and drawn card labels. The acting player’s command response may also supply its outcome label. Campaign content contributes a label and an authorized title. Keep raw bindings, target values, rendered templates, deck order, sheet data, and content bodies out of this projection. Keep the public v1 activity contract independent of browser presentation data. Regenerate the affected web contracts.
- Subscribe to the same first-page activity query across the active campaign’s tabs and connected, attached character sheets. Key it by campaign, actor, and account generation. Use one request per foreground campaign tab per **3 seconds**, with the Session board and Activity tab sharing that query where mounted. Keep the board’s other query intervals separate. Avoid polling from standalone sheets, background tabs, and offline views.
- Seed seen IDs from the first successful read on entry or after reconnecting or returning from the background. Compare subsequent fresh responses by stable ID and process unseen rows from oldest to newest using the server’s timestamp and ID ordering. If a full first page contains only fresh, unseen events, follow the existing cursor within a bounded page budget for that poll. Bound freshness to the last **15 seconds** using server time so resurfaced history does not become a burst. Use roll ID across both sources and event ID for content. The stack timer starts on receipt, so every eligible event gets the same reading time regardless of polling latency. Measure shared delivery on Railway against a proposed **4-second p95** target for foreground sessions. Monitor request volume with no duplicate per-view polls.
- Enforce current campaign membership, original roll scope, and effective audience on the server. Campaign rolls reach active members, GM-only rolls reach the permitted roller and GMs, and private rolls reach only the permitted roller, including when the actor is a GM. Content uses its current visibility and grants. Recheck authorization for visible scopes on refresh, including content when grants change. Clear affected cards and pending announcements after a denial. Treat pagination and age cutoffs independently of authorization so that a card leaving the first page during a burst still gets its reading time. Clear scoped state and ignore late responses on sign-out, account or scope change, leave, or a denied read. Store popup state in memory for the tab.

### 3. Verify and document

Implement each stage red–green. Update `design_v2.md` §§7.5, 10.2–10.4 and 11.5 and link this follow-up from the GUI integration plan.

| Layer | Required checks |
| --- | --- |
| Web unit and component | Immediate first render. Independent deadlines with fake timers and an arrival at the fade boundary. Stable order and overflow behavior. Duplicate response, idempotency replay, identical totals with different IDs, and normal push with a distinct ID. Reduced motion, long translations, single live announcement, and no focus change. |
| API and access | Ordinary roll, pushed roll, card draw, and visible content summaries. Verify private, GM-only, campaign, and selected-content cases as different users, including a denied reader who receives neither an event row nor a result. Cover concurrent rolls, rollback, replay, revoked membership or grants, and no raw data in the browser summary. |
| Playwright | Use independently signed-in GM and player contexts at **360, 768, and 1280 px**. Make three rolls from different actors within six seconds and verify both the initiating and receiving screens, ordered cards, independent expiry, and no duplicates after a refresh. Include a draw, a handout update, an invisible roll or handout, a background/reconnect baseline, navigation during an in-flight fetch, and continued access to roll details and Activity after the cards fade. Check 320 px and enlarged text for overflow, and verify that phone navigation and active sheet controls stay reachable. |
| Railway acceptance | Deploy the branch to the intended acceptance service. Verify its source branch, deployed commit and `/health/ready`. Repeat the multi-user browser journey and capture observed local and remote latency, the stack before expiry, and audience isolation. Record the commit, deployment and outcomes after CI and the hosted journey reach terminal results. |

## Repository references

- [Sweetroll design, Dice and activity](https://github.com/Kajonn/sweetroll/blob/7c4107cb7f135e6aa69be4cf4feb0aeff38c94f6/design_v2.md#75-dice-and-activity) and [GUI integration plan](https://github.com/Kajonn/sweetroll/blob/7c4107cb7f135e6aa69be4cf4feb0aeff38c94f6/docs/superpowers/plans/2026-09-08-gui-integration.md)
- [Character session](https://github.com/Kajonn/sweetroll/blob/7c4107cb7f135e6aa69be4cf4feb0aeff38c94f6/web/src/characters/session.ts), [GM Session board](https://github.com/Kajonn/sweetroll/blob/7c4107cb7f135e6aa69be4cf4feb0aeff38c94f6/web/src/campaigns/SessionBoard.tsx), and [campaign activity persistence](https://github.com/Kajonn/sweetroll/blob/7c4107cb7f135e6aa69be4cf4feb0aeff38c94f6/src/campaigns/persistence.ts)
- [Multi-user journey protocol](https://github.com/Kajonn/sweetroll/blob/7c4107cb7f135e6aa69be4cf4feb0aeff38c94f6/docs/acceptance/multi-user-journey-protocol.md) and [Railway operations](https://github.com/Kajonn/sweetroll/blob/7c4107cb7f135e6aa69be4cf4feb0aeff38c94f6/docs/operations/railway.md)
