# Sweetroll scene streaming and batched edits

**Proposed implementation plan · 7 November 2026 · Baseline `6faccc9`**

## Goal

Replace the paired display’s five-second projection polling with server-sent events (SSE). Save a finished token move or committed fog stroke in one PostgreSQL transaction. Render a new player-safe map only when the background or fog changes.

This work covers the paired scene display and GM scene commands. The campaign session board and other feeds keep their current refresh behavior. Keep the existing scene visual-controls plan for V2 drag/tap placement and V3 brush input. Fog retains explicit **Commit fog edit** and local undo. Update `design_v2.md` §7.7 and the V2/V3 plan when implementation starts, and retain the separate G8 and G9 acceptance gates.

## 1. Separate image versions from scene revisions

- [ ] Add `imageRevision` to the scene schema baseline. Increment `sceneRevision` on every saved edit and `imageRevision` only on fog changes or a different background. A background replacement retains the existing behavior of clearing fog and tokens. Apply the project’s current-schema policy for disposable pre-release test databases and recheck release tags before implementation.
- [ ] Build the display projection from authorized scene and media metadata. Move PNG generation into the image-serving path. Key derivatives by scene ID and image revision, and reuse an authorized cached derivative before reading the original map. Use a single in-flight render per key per process, atomic writes, and bounded derivative retention. A different replica may render the same version if it uses a separate cache.
- [ ] Require a valid display credential and the current image revision for each image request, including cache hits. Recheck access and the image revision after a slow render before sending bytes. Keep token-art access tied to the current visibility check. Give token art a stable URL identity across moves while its image reference stays unchanged.
- [ ] Start with tests showing that a token move changes the projection but causes zero map downloads and zero PNG renders. Test concurrent image requests, stale revisions, background replacement, deleted media, and pixels on both sides of a fog boundary.

## 2. Stream committed scene snapshots

- [ ] Add `GET /api/displays/:id/scenes/:sceneId/events` beside the display routes. Authenticate with `X-Display-Secret` using the existing campaign scope checks. Send `text/event-stream` with `Cache-Control: no-store`. Use Fastify’s streamed response and the browser’s `fetch()` response reader with `credentials: "omit"`. Document the stream and regenerate affected contracts.
- [ ] Use one dedicated PostgreSQL `LISTEN` connection per Fastify process, separate from its request pool. Issue `NOTIFY` inside successful scene-write transactions. Include only internal IDs and the revision, with separate invalidation for credential revocation and relevant media deletion. Attach the in-process subscription before loading the first authorized snapshot and catch up if an update arrives during setup. PostgreSQL remains the authoritative state.
- [ ] Send a complete `scene` snapshot with `sceneRevision`, `imageRevision`, the credential-scoped map URL, and the filtered token list. Share the projection calculation per scene per process while enforcing each connection’s credential scope. Keep the latest pending snapshot per slow client and disconnect it if writes remain stalled. Drop older revisions and discard in-flight results after a connection is revoked or replaced.
- [ ] Replace the browser polling timer. If the image revision changes, clear the displayed frame immediately and show the new one only after its image arrives. Cancel superseded image loads. Keep token moves on the current map. Use lightweight heartbeats, a client timeout, and jittered reconnect backoff. Blank on disconnect or lost authorization. Start each new connection with a fresh snapshot and stop retrying a revoked credential until the display is paired again.
- [ ] Close affected streams on committed revocation or invalidated scene access. On listener failure, close all local display streams, reject new streams until listening is restored, then let clients reconnect and reload. Keep cleanup tied to the HTTP connection lifecycle. Heartbeats do not query PostgreSQL.
- [ ] Write failing tests first for wrong-campaign and revoked credentials, hidden tokens and image bytes, aborted transactions, the first-snapshot race, two-replica delivery, a slow client, and listener loss. Include a conceal-during-image-load regression that proves an old frame cannot return.

## 3. Save one batch per completed gesture

- [ ] V2 uses local preview throughout a drag and sends only the final coordinates on release. V3 collects bounded, normalized dabs and reuses the existing fog command on explicit commit. Undo and cancelled gestures produce zero writes. Use the successful command response to update the GM view, then refetch on conflict or when reconciling an uncertain result.
- [ ] At the backend, authorize and check `expectedSceneRevision` once per command. Apply the batch in one transaction, increment the revision once, and record the idempotency receipt with the mutation. A retry of the same command retains its original key and payload. A stale revision returns a conflict, preserves the local draft where safe, and requires explicit retry against refreshed state. Independent edits from two GMs remain separate transactions.
- [ ] Write failing tests for many pointer samples producing one committed move or stroke, lost-response retry, concurrent co-GM edits, oversized fog payloads, and rollback without an SSE update. Preserve the existing keyboard and numeric controls.

## 4. Verify and release the change

| Gate | Evidence to capture |
|---|---|
| Two-process integration | Run two backend processes on one test PostgreSQL and shared test media. Connect the display to A and write through B. Verify move, reveal, conceal, background replacement, revocation, listener failure, and reconnect. |
| Isolated hosted journey | Verify source commit and readiness, then test SSE through the real ingress with the current single-replica, volume-backed deployment. Check first-frame latency, heartbeat delivery, idle connections, reconnect after restart, and the GM/display journey. The two-process test covers notification fan-out separately. |
| 200-table load comparison | Run the same 200-display workload with idle scenes and edit bursts. Record projection requests and SQL per second, pool wait, active streams, image bytes and renders, scene transactions, reconnects, and p95 commit-to-visible latency. |
| Proposed pass criteria | Zero periodic display projection requests and zero heartbeat SQL during a stable idle run. Zero map fetches or renders on token-only edits. One scene transaction per completed gesture. Target p95 below 500 ms for a token move to appear in the hosted baseline. Report fog render time and conceal-to-blank latency separately. |

Run each stage red–green. Before rollout, run the affected backend integration tests, browser journeys, generated-contract checks, and normal CI. Record the baseline and comparison results with the tested commit and deployment. The latency threshold is a proposed target, with no benchmark results yet.

## References

- [Sweetroll scene design](https://github.com/Kajonn/sweetroll/blob/6faccc9/design_v2.md#77-simple-scenes-and-player-display)
- [Visual-controls plan](https://github.com/Kajonn/sweetroll/blob/6faccc9/docs/superpowers/plans/2026-11-05-scene-visual-controls.md)
- [Current display backend](https://github.com/Kajonn/sweetroll/blob/6faccc9/src/campaigns/display.ts) and [hosting setup](https://github.com/Kajonn/sweetroll/blob/6faccc9/docs/operations/railway.md)
- [PostgreSQL LISTEN](https://www.postgresql.org/docs/current/sql-listen.html) and [NOTIFY](https://www.postgresql.org/docs/current/sql-notify.html)
- [Fetch response streaming](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch#streaming_the_response_body) and [Fastify streams](https://fastify.dev/docs/latest/Reference/Reply/#streams)
