# System themes and image uploads — staged feature plan

**Date:** 2026-11-03
**Status (2026-11-04):** T1 and T2 implemented with passing hosted journeys and CI #205. M0 durable storage/scanning foundation passed hosted upload and post-redeploy verification plus a local metadata/bytes restoration drill. See [themes](../../acceptance/system-themes-2026-11-04.md) and [media](../../acceptance/image-foundation-2026-11-04.md). M1 hosted acceptance and CI #209 passed; M2 is implemented with local checks; hosted acceptance and CI remain pending, and M3 remains planned. The full requested implementation is incomplete.
**Baseline:** `main` `01c9fba` (merged PR #29).
**Scope authority:** Owner request for system color themes, then themed GUI elements; image uploads for characters, items, then adventure backgrounds.
**Design:** [Sections 10.5, 17.9c and 18.2](../../../design_v2.md). Reuse the [GUI foundation and G9 gates](2026-09-08-gui-integration.md) and [I7b scene/display contract](../specs/2026-09-14-i7b-scenes-display-design.md).

## Existing capability and intended outcome

Light/Dark/Follow device already work through semantic tokens and account/device preferences (`web/src/theme/`, `web/src/styles/global.css`). There is no system-specific theme selection. Character image fields were reserved but remain null-only. Campaign media upload and scene backgrounds already exist in `src/campaigns/media.ts` and the campaign scene UI; this plan extends them rather than restarting I7b. Hosted media durability remains open in the [G9 record](../../acceptance/gui-2026-11-03-g9-hosted.md).

A creator will choose a visual identity for a system. Players keep their own light/dark preference while using that system's colors and, later, styled controls. Players and GMs will attach pictures to characters and items. GMs will use uploaded adventure illustrations/maps through the existing scene and restricted-display workflow.

“Adventure backgrounds” means campaign scene backgrounds here. General page wallpaper, document/video uploads, image generation, image editing suites, tactical rules and arbitrary creator CSS/scripts are outside this plan.

## Delivery stages and dependencies

| Stage | Capability | Dependencies | Exit demonstration |
| --- | --- | --- | --- |
| T1 | Basic system color themes | Existing shared tokens, creator and immutable package workflow | Select a preset, preview, save, publish, and play that system in light and dark. |
| T2 | Themed GUI elements | T1 accepted | System-styled headings, panels, buttons and resource controls use the same accessible interactions. |
| M0 | Shared image foundation and durable hosting | Existing I7b media; resource attachment contract | A private image remains available after restart/redeploy; unauthorized readers cannot fetch it. |
| M1 | Character image uploads | M0 accepted | Owner uploads/replaces/removes a portrait; permitted GM sees it; unrelated users cannot. |
| M2 | Item image uploads | M1 accepted; immutable item/template semantics | System, campaign and personal items show their authorized art without changing existing placed copies. |
| M3 | Adventure background upload completion | M2 accepted; existing I7b scenes/display | GM uploads/selects/replaces a background and safely shows revealed pixels on a paired display. |

Themes and images are independent tracks. Preserve T1 → T2 and M0 → M1 → M2 → M3; M0 supports every upload stage. No whole-project completion or release readiness follows from adding this plan. Existing G9 human/device/provider/playtest gates remain open; actual implementation must meet the applicable definition of done and existing sequencing exceptions.

## T1 — Basic system color themes

- [x] Specify a bounded presentation selection on the system draft/package: a platform preset ID, initially Default (current Sweetroll), Blue and Ochre. Each provides accessible light/dark token sets. No color-code fields or arbitrary CSS in this step.
- [x] Treat the preset as system presentation, separate from Light/Dark/Follow device. Keep the existing device > account > OS mode resolution. Apply system styling to the creator preview and system-bound character/campaign content; global account/library/navigation retains platform styling.
- [x] Store the selection through normal revision-safe draft saves and immutable publication. Clone/export/import and runtime projections preserve the selection. New publications never restyle existing pinned characters/campaigns. Missing selection uses Default; invalid authored IDs produce diagnostics. Update the current package contract/fixtures without old-build conversion code.
- [x] Add a small visual preset picker to the creator with immediate phone/desktop preview, saved status and a reset-to-Default action. Read-only published views expose no misleading edit controls.
- [x] Scope tokens and portaled dialogs/popovers to their originating system surface. Navigating between two systems, account switching and returning to global pages cannot retain another system's styling.
- [x] Preserve unsaved inputs, queued character changes, scroll/focus and action results when changing theme or light/dark mode. Cache the validated selection with the existing authorized sheet/package for offline rendering.

**Red → green and acceptance:** First reproduce missing selection persistence/projection and cross-system/portal scoping in focused tests. Implement the smallest contract/token/UI change, then verify creator save/reload/preview/publish/clone/export and two differently themed systems. Run character edit/roll/offline/reconnect regressions where affected. Inspect actual routed screenshots in every preset and mode at 360/1280 px; check 200% text, keyboard focus, contrast and error/disabled states. Retain human and real-device sign-off as distinct G9 evidence.

## T2 — Themed GUI elements

- [x] Extend the platform preset definition with a bounded component style variant: headings/dividers, panels, action buttons, item cards and resource bars. Offer named, platform-authored styles with preview; final visual assets are selected during this stage.
- [x] Keep the T1 color choice and component style composable. Validate their supported combinations, provide a Default style, and persist style selection using the same draft/package/projection workflow.
- [x] Implement variants through existing shared components and CSS tokens/classes. Keep one renderer and the current linear sheet; preserve accessible names, DOM semantics, focus, validation, loading/conflict/offline states and 44px targets.
- [x] Keep decoration separate from meaning: damage/errors, disabled actions and resource values remain readable. Do not recolor uploaded artwork or alter fog, tokens, actions, permissions or dice behavior.

**Red → green and acceptance:** Write failing variant-selection/preservation and shared-control tests before implementation. Exercise the approved color/style combinations in creator preview, player sheets and GM character views, including portaled controls. Compare routed screenshots in light/dark, long labels and enlarged text; prove keyboard/touch alternatives and repeat an edit/roll flow. Theme artwork must be bundled/approved platform assets, not remote executable styling.

## M0 — Image foundation and persistence

The shared scanning/storage capability and durability gate are accepted. Parent-specific
controls and workflows below are completed with their consuming stages; this does
not claim character or item attachment APIs exist yet.

- [ ] Define attachment ownership/read/edit/delete rules for character, system-item, campaign-template, personal-item and scene resources before adding endpoints. Reuse validated image-processing/storage internals from I7b where useful; keep authorization in the owning Module. Do not grant players the existing GM-only campaign image API.
- [ ] Keep initial limits aligned with I7b: PNG/JPEG/WebP, 5 MiB decoded and 4096 px per dimension. Bound encoded request size and decoded pixel work, verify actual decode/type, reject malformed/unsupported images, strip metadata from safe display derivatives, and enforce per-owner/campaign quotas with clear messages. Meet the design's upload scanning requirement before serving accepted assets.
- [ ] Store private bytes outside the ephemeral container filesystem with metadata in PostgreSQL. Use the existing media directory/volume deployment approach first; an object-store adapter requires a concrete later need. Prove write permissions, restart/redeploy persistence, backup/restore of metadata plus bytes and a usable missing-file error.
- [ ] Expose opaque attachment references, not client-chosen filesystem paths or public originals. Reauthorize reads and retries against the parent resource; prevent guessed/cross-resource IDs, removed memberships and display credentials from accessing unrelated art.
- [ ] Specify upload → attach → replace/remove behavior with idempotency, expected parent revisions and failure cleanup. A failed upload/attachment preserves the prior image; orphan cleanup cannot delete referenced bytes. Release files only when no retained published snapshot, placed copy or retained character references them.
- [ ] Reuse shared upload controls with thumbnail preview, meaningful image description, progress/busy, retry/cancel, remove and understandable validation errors. Begin with online-only image mutations; ordinary sheet edits keep their existing offline queue.
- [ ] Define a scoped caching policy: character-scoped safe thumbnails may follow existing authorized character offline storage and purge boundaries; campaign catalogs, GM originals and restricted displays retain their online-only/no-service-worker persistence rules. Missing/offline images show a placeholder without blocking sheet play. Never persist bearer/signed URLs as durable attachment identity.
- [ ] Update current schema, Module/HTTP contracts, generated web types, operations documentation and focused storage tests together. Follow the [pre-release database policy](2026-10-27-application-migration-policy.md); add no obsolete-version migrations.

**Red → green and acceptance:** Begin with failing interface/HTTP cases for allowed users, unrelated users, cross-campaign attachment, spoofed MIME, corrupt/oversized images, stale revisions, duplicate retries and failed writes. Include metadata/derivative safety, referenced-file deletion and lost-response recovery. Then verify one real hosted upload survives an application redeploy and a backup/restore drill. Record actual service/source/deployment and byte-read results; health checks alone do not prove storage durability.

## M1 — Characters

- [x] Add one optional portrait per character, usable by standalone and campaign characters, including NPCs/monsters. Use a character attachment independent of a particular rules field so a portrait does not require editing the published system; explicitly define its relationship to the existing reserved image field before coding.
- [x] Character controllers may upload/replace/remove; GM/co-GM access follows existing character read/edit authority, not system authorship. Uploads grant no new sheet visibility. Retain existing controller/GM disclosure rules.
- [x] Render portrait thumbnails in the character library/authorized roster and character header, with an accessible larger view and a stable placeholder. Keep list payloads bounded and avoid eagerly downloading full images.
- [x] Handle ownership transfer, campaign adoption/return, archive/recovery and deletion consistently with character attachment ownership. Preserve authorized personal images on return without leaving a route into the old campaign.
- [x] Allow offline sheet play with an already authorized cached thumbnail or placeholder; image changes require connectivity and must not block unrelated queued resource/action changes.

**Red → green and acceptance:** Add failing portrait policy/persistence/concurrency tests, then implement module → HTTP/types → UI. Journey: player uploads, reloads, replaces and removes; GM sees only permitted characters; another player and unrelated creator fail direct fetches; transfer/return and account-switch/revocation cleanup behave correctly. Repeat offline sheet edit/roll/reconnect with no image network access.

## M2 — Items, spells, abilities and adventure equipment

- [ ] Support one optional image on system item templates, campaign templates and personal entries, using the existing item/spell/ability kinds without a new rules engine or implicit effects.
- [ ] System creators manage draft item art; publishing pins the exact safe asset reference/content identity and retains its bytes for immutable versions. Clone/import/export must document which assets are included, their bounded manifest/checksums and explicit missing/unauthorized-art behavior; never export credentials or private campaign asset references.
- [ ] GM/co-GM manages campaign template art under the catalog's actual audience. A character controller manages personal/placed-copy art as presentation only. Do not widen the editable base/actions contract or require a system republish for personal art.
- [ ] Placement pins the image with the selected template revision. Later replacement/archive/deletion of template art does not silently alter existing copies. Personal edits affect only that instance.
- [ ] Proposals and restricted drafts inherit their existing audiences; thumbnail lists, preview, direct image reads and export cannot reveal secret template names/art. Explicit reveal governs new placement; no unrestricted media URL bypasses D1/D2 policy.
- [ ] Define retained-copy ownership before implementation: when a disclosed copy must survive catalog archive or authorized character return, materialize/retain an authorized character-scoped safe asset. Do not depend on renewed access to the old campaign catalog or expose its GM originals.
- [ ] Display art on item cards/detail views without obscuring quantity, description or actions. No image is required; personal entries remain data-only even when illustrated.

**Red → green and acceptance:** First fail immutable-image pinning, proposal/audience and retained-copy tests. Journey with one GM and three players: publish a weapon, spell and equipment image, place copies, create personal art, narrow a template audience, preview as each player, attempt guessed direct reads, replace/archive source art, and verify placed copies and rolls remain correct. Include offline/return behavior and scoped cleanup.

## M3 — Adventure backgrounds

- [ ] Reuse the existing campaign image uploader, scene background reference and restricted display. Inventory the reachable upload/select flow first; only implement verified gaps in selection, thumbnails, naming, replacement/removal and error recovery.
- [ ] Let the GM/co-GM upload or choose an existing campaign image, preview its fit and use it as a scene background. Defaults stay GM-only until intentionally presented; this does not upload a site wallpaper.
- [ ] Replacing a background is a revision-safe, confirmed operation: reset to fully concealed fog and clear/review token positions before showing the new image. Retain the previous scene/image if the operation fails. Do not reuse a reveal mask that might expose new secret pixels.
- [ ] Protect in-use backgrounds from destructive deletion or offer explicit detach/replace first. Keep media retention and source-image access aligned with M0 and the existing scene contracts.
- [ ] Preserve server-rendered redaction, hidden-token filtering, credential-only display requests, safe blank/offline/revoked states and GM-device handoff purge. A client-side overlay over a full original is never sufficient.

**Red → green and acceptance:** Start with tests for any identified flow gaps and safe replacement atomicity. Run the existing scene/display journey plus upload/select/replace, restart/redeploy, concurrent GM edit, display reconnect/revoke and remote-display checks. Inspect actual image bytes and network/storage: no unrevealed pixels, hidden tokens, GM originals or character/item art may reach display credentials. Add real phone/iPad testing to the applicable G9 record without claiming automation completes it.

## Implementation handoff and completion records

Before each stage, read the current code, resolve its attachment/package contract details in a short spec, and write failing behavior tests. Record the failing command/result, implement the smallest change, rerun to green, and run affected integration/contract/web/browser checks. Keep the existing Module boundaries and shared components. Do not add generic media services, infrastructure or version-transition support without a demonstrated requirement.

For hosted acceptance, verify the test service's branch and latest successful deployment first. Use the acceptance service for main or a separate preview for a branch; never change the production source for a test. Record tested commit, deployed artifact, relevant journeys, screenshots, remaining manual checks and scoped cleanup in `docs/acceptance/`. Mark a stage complete only with its own evidence. This planning PR leaves every new stage unchecked and existing release gates unchanged.

## Implementation checkpoint (2026-11-04)

T1/T2 and M0 evidence remains recorded above. M1 module, HTTP/contracts and UI
are implemented and accepted by the hosted player/GM journey and CI #209. See [M1 evidence](../../acceptance/character-portraits-2026-11-04.md).
M2 is implemented under the [item image contract](../specs/2026-11-04-item-images.md), with [local validation and pending hosted acceptance](../../acceptance/item-images-2026-11-04.md); M3 remains unimplemented. Do not treat the checked implementation tasks as
completed acceptance of the remaining feature request.
