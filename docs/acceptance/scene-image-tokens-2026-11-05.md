# Scene visual controls V1 — image tokens

Date: 2026-11-05. PR: [#34](https://github.com/Kajonn/sweetroll/pull/34).
Scope: V1 of the [visual-controls completion plan](../superpowers/plans/2026-11-05-scene-visual-controls.md).

Status: **V1 accepted on the isolated hosted preview, including redeploy persistence.** V2/V3/V4 and full G8/G9 remain open.

## Implementation and boundaries

The token tray reuses the campaign image library for upload and existing-art selection,
without calling background replacement. Placement sends the selected `imageFileId`,
or null for an explicitly label-only marker. New tokens default to 0.1 of scene width;
the stored size remains in the existing greater-than-zero/at-most-one contract.
GM and display art share a centered square whose width is relative to the scene.
Portrait/landscape art is contained without distortion. Labels remain readable when
art is unavailable. Text labels name the art, so adjacent images use empty alternative
text to avoid duplicate screen-reader announcements. GM buttons retain their token labels
and a 44px hit area independent of the image size.

GM image reads use the authorized campaign original route. Display art uses only its
credential-scoped token-image route with omitted account credentials, no-store reads,
abort on unmount and released object URLs. Hidden/fog-covered tokens stay server-filtered.
The image loader rejects paths outside the supported display image routes. Background
and actor/generation changes reset token authoring scope. No backend schema, generated
contract, migration, offline scene queue or new rules-engine behavior is introduced.

## Test-first evidence and regressions

- RED: all four initial added component cases failed against main (`28 passed, 4 failed`):
  image selection, selected image placement/default size, proportional GM rendering and
  restricted display image fetching. GREEN: focused scene/library/token/display suite
  passed 33 tests after implementation.
- Full web suite: **126 files / 1,235 tests passed**. Relevant rendering/display tests
  were rerun after the accessibility/layout fixes: **20 passed**.
- Native PostgreSQL 17.11 scene/media regressions: **31 passed**, using
  `npx vitest run tests/integration/campaign-scenes.test.ts tests/integration/scene-backgrounds.test.ts --no-file-parallelism`
  with an isolated `TEST_DATABASE_URL`.
- `npm --prefix web run typecheck`, `npm run web:build` and `git diff --check` passed.
- Local Chromium: historical `sceneDisplayJourney` passed; new `sceneImageTokens`
  passed, including 360/768/1280px geometry, zero horizontal overflow, zero axe
  violations, offline blank/reconnect and revocation.
- Initial browser attempts exposed test-launch restrictions (tsx IPC sockets and
  interface enumeration). Local-only launch configuration used `node --import tsx`,
  a loopback host, and the installed Chromium. No product configuration changed.
- The new journey initially had an incorrectly nested image-row selector; fixed.
  Hosted loading also exposed five-second image waits and geometry reads before image
  decode; the test now waits for authorized images and decodes the background before
  measuring it. Navigation is bounded separately from action waits. Proxy TLS handling
  is enabled only by the explicit hosted-test environment flag.
- Axe initially rejected repeated image alternatives beside token labels; the product
  fix keeps the text labels and treats the adjacent art as decorative. The next local
  browser run passed the complete journey.

## Hosted target and build identity

Only the isolated preview was changed. Production and main-linked acceptance sources
were not changed.

| Field | Value |
| --- | --- |
| Project / environment | `sweetroll-d2-acceptance` / `preview` |
| Service | `sweetroll-d2` |
| URL | https://sweetroll-d2-preview.up.railway.app |
| Branch / application | `feat/scene-image-tokens` / `34ed28306732254db650f5c1bd03df65566a9490` |
| Initial deployment | `90a83af7-b93a-4a33-a883-88bc6fbe998a`, SUCCESS |
| Readiness | `/health/ready` returned `{"status":"ok"}` |
| Served JS | `/assets/index-CdO598CI.js`, SHA-256 `9418f4451f80ff756e1f2f93903a4da9f18f1b1060555effd16447fed431913f` |
| Served CSS | `/assets/index-BxbiTdYG.css`, SHA-256 `5f0f38084ce92024ac259164127c503839be0e4322ab69598f06a3f39dac3837` |
| Served build | `build-mw43csp7`; JS and CSS bytes exactly matched the local build |

## Ordered hosted journey

`web/tests/e2e/sceneImageTokens.spec.ts` runs against both local HTTP and this hosted
build. Campaign creation uses the existing deterministic GM identity and license-neutral
published d20 fixture through the API. The feature steps below use the actual GUI;
privacy, persistence and cleanup also use direct read/denial assertions.

1. Upload a background and create a scene. Reveal an area with existing numeric fog controls.
2. Upload token art through the token tray. Place visible Wren, hidden Secret, a visible
   Fogged token outside the revealed area, and a label-only marker. Reopen the scene.
3. Select existing art; assert it does not replace the background or reset scene state.
   Referenced-art deletion returns 409.
4. Pair a fresh separate browser context through Settings. Only Wren and the label marker
   appear. Hidden/fogged token-image reads at the current revision return 404; campaign
   original reads with only the display credential return 401. Ordinary display loading
   makes no GM/campaign/character/system API reads.
5. At 360, 768 and 1280px, verify 0.12 relative image width and the stored 0.25/0.5 center,
   zero horizontal overflow and screenshots. GM axe reports zero violations.
6. Going offline removes every display image. Reconnection restores authorized art.
   Revoking the display removes every image on the next poll.
7. Retain only this run's fixture, redeploy the same application, and rerun against the
   saved scene. Compare exact token state and the SHA-256 of the GM-authorized art bytes.
   Revoke the newly paired display and archive the campaign independently.

Hosted normal run: **PASS (58.6s)**. Redeploy `e8098628-6dc7-4174-9415-0cb7e819d738`
reused application `34ed283`, reached **SUCCESS**, and the complete saved-scene run
passed again (**50.1s**). All four token records matched exactly; art bytes retained
SHA-256 `bb0179a9241bb9557a1fb431293cf2c26b7e0ff80d1d8e0f9e6b2e0786be43ec`.
The test revoked its new display and archived campaign `47591366-3733-4df0-bbc0-cfce64581949`.
Earlier failed-run campaigns were also archived by the independent cleanup path.

CI [#248](https://github.com/Kajonn/sweetroll/actions/runs/42117932562) completed
**SUCCESS** on application `34ed283`: verify, web, all three journey shards, visual
and offline jobs passed. The production deployment job was correctly skipped on the PR.
Later documentation/test-harness commits preserve that application tree; check PR
status for their additional CI run.

Screenshots from the passing hosted run:

- [GM at 360px](assets/scene-image-tokens-2026-11-05/gm-tokens-360.png)
- [Restricted display at 768px](assets/scene-image-tokens-2026-11-05/display-tokens-768.png)

## Open gates

V2 direct tap/drag movement and V3 on-image reveal/conceal painting are next. This V1
record does not close the combined V4 gesture journey or the aggregate G8 requirements.
Real phone/iPad testing, provider login, human visual approval and physical-table/remote
playtests remain separate G9 gates. Browser viewports are emulated devices.
