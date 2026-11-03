# G9 hosted browser acceptance — 3 November 2026

This records automated hosted-browser evidence and fixes from PR #29. It does
not declare the entire G9 gate closed, approve a public release, or substitute
emulation for physical-device or human playtest evidence.

## Target and execution identity

| Field | Value |
| --- | --- |
| Repository baseline | `main` `414c4acf9e47731a64e2f26a25000ef29849d8b7` |
| Tested application after fixes | `ee88435116ed64bb5dd3aa1b2b6afd200a19b853` |
| Railway project / environment | `sweetroll-d2-acceptance` / `preview` |
| Service | `sweetroll-d2` |
| Deployment | `bcc9c614-d2ba-4390-8e2e-6b2e4e7967e0`, observed `SUCCESS` |
| URL | https://sweetroll-d2-preview.up.railway.app |
| Asset build | `build-mw10dugf` |
| Browser | Playwright 1.48 Chromium 130, Linux, headless |
| Widths / themes | 360, 768, 1280 CSS px / explicitly selected Light and Dark |
| Text enlargement | CSS emulation: snapshot computed font sizes/line heights, then double each; wait for routed controls before enlargement |
| Rules fixtures | Original license-neutral d20, 2d6 PbtA-style and counted-success d6 pool fixtures; no shipped licensed-system claim |
| Authentication | Existing deterministic test identities, separate browser contexts; no real OIDC-provider claim |

The main-linked `sweetroll-acceptance` service was first inspected at deployment
`26d3c427-84f7-4703-9d77-0cd905ce0efa`: correct main commit and health, but
runtime auth mode **locked**. `/dev/signin` returned SPA HTML rather than a test
session. Its variables/source were not changed. Testing moved to the existing
isolated preview, whose test adapter was already enabled. The ordinary
`sweetroll` production service and its pending changes were untouched.

## Reproducible protocol

From the repository root, install root and web lockfile dependencies and the
matching Chromium build. Trust the execution environment's managed proxy CA;
the G9 runner does not disable TLS validation. Set `G9_ACCEPTANCE_URL` explicitly
to one of the existing named test deployments; there is no production default.

```sh
G9_ACCEPTANCE_URL=https://sweetroll-d2-preview.up.railway.app \
  npx --prefix web playwright test --config web/playwright.g9-acceptance.config.ts
```

Before the artifact spec, fetch the deployed `/offline-manifest.json` build ID
and rebuild the same application source using `OFFLINE_BUILD_ID=<that ID>` and
`npm run web:build`. This accounts for the intentionally timestamped build ID;
JS/CSS must match as bytes, not just as filenames. Six served files (HTML,
JS, CSS, worker, offline manifest and PWA manifest) are compared byte for byte.

The ordered multi-user regression remains its existing runner:

```sh
cd web
MULTI_USER_ACCEPTANCE_URL=https://sweetroll-d2-preview.up.railway.app \
  npx playwright test --config playwright.multi-user-acceptance.config.ts
```

The MU runner uses one worker; the G9 runner uses two workers with independent
fixture IDs and browser contexts. Both have zero automatic retries. Setup and independent
server observations use real HTTP; no server responses are replaced. The MU
runner retains its GUI-only user operations. Additional G9 route/media fixtures
use HTTP setup, explicitly separate from the GUI-only MU protocol. Image upload
and scene creation still lack GUI entry points and are not represented here as
successful GUI authoring flows.

## Findings and red–green fixes

| Finding | Reproduction before fix | Change and regression |
| --- | --- | --- |
| Deployed display redemption rejected | Anonymous `POST /api/displays/redeem` returned 401 while the unprefixed dev route worked | Match the Fastify plugin prefix in the display-credential exemption. Paired tests cover both mounts, missing/wrong credentials and protected GM routes. Observed red: prefixed 401 versus expected 200; green: 32 focused HTTP tests. |
| Redacted derivative could not be written | Pairing succeeded after the first fix, but hosted projection returned 500 | Provision the non-root container's `/app/data/display` directory alongside `/app/data/media`; hosted pixel-level projection now succeeds. |
| Image request omitted display credential | An ordinary img URL could not carry `x-display-secret` | Fetch only the redacted image with the credential header, omit account cookies, render a blob URL, abort stale requests and revoke object URLs on disposal. Unit tests and hosted image decoding/pixel assertions cover this. |
| Former private device retained its session | After opening a cached private sheet and visiting `/display`, `/api/me` still reported authenticated | Complete ordinary session sign-out, durable account purge and query cancellation before allowing pairing. Failed preparation stays blank with Retry. Hosted checks verify anonymous state, private-route denial, no retained private payload and no resurrection with Back/reload. Generation tombstones may retain identifiers, but no sheet/roll/queue payload. |
| Display frame remained visible offline | A previously shown projection remained on screen after the browser went offline | Hide the frame immediately while offline and refetch on reconnect; prevent a former scene frame from showing under a new scene ID. Unit and hosted outage/reconnect tests cover this. |
| Enlarged phone content overflowed | 200% checks reported 448/516/430 px document widths at a 360 px viewport for sheet/campaign/creator routes; the broader matrix also found intrinsic settings inputs | Bound input and grid tracks, wrap long headings/labels, allow text-sized phone navigation to scroll without overlapping labels, and keep footer text in its column. Ordinary screenshot baselines are retained. |

## Results

| Protocol | Observed result |
| --- | --- |
| Combined deployed artifact | PASS, 9.7 s: readiness/API/SPA routing and six exact served files |
| Display privacy and live controls | PASS, 49.9 s: revealed/concealed pixel assertions, hidden/fogged token omission, credential image requests, private-route denial, safe cache contents, outage/reconnect, reload, token movement, scene change, conceal/reveal, revocation and direct revoked-credential denial |
| Former private-device handoff | PASS, 7.8 s: server sign-out, private-data purge, Back/reload denial |
| d20 offline conflict/export/account isolation | PASS, 12.7 s |
| PbtA offline conflict/export/account isolation | PASS, 16.0 s |
| d6-pool offline conflict/export/account isolation | PASS, 15.5 s |
| Ordered MU-00–MU-12 | PASS, 137.6 s runner total: all 13 steps and 24 actor-bound verified rolls, followed by scoped archive/readback |
| Full responsive/theme/text/keyboard/axe route matrix | PASS: 6 combinations × 46 cases = 276 checks; zero horizontal-overflow or WCAG A/AA axe findings; keyboard focus and callback/deep-link checks pass |

The [sanitized machine record](gui-2026-11-03-g9-hosted.json) preserves actual
fixture identifiers, per-test timings, routing/asset hashes, pixel observations,
roll results and cleanup evidence. Successful run-created fixture campaigns,
characters and systems were archived/private and independently read back;
display credentials were revoked and uploaded image fixtures deleted.

[CI #198](https://github.com/Kajonn/sweetroll/actions/runs/41692007857) passes all seven verification jobs on the exact deployed application: **477 root tests, 354 real PostgreSQL integration tests, 1,195 frontend tests, 62 browser journeys, 31 production-worker offline checks and ten unchanged visual baselines**, plus types/contracts/builds/Docker. Production deployment is skipped. Local 32-test HTTP regression, root/frontend typechecks and generated contract identity also pass. The `tsx` CLI cannot open its
IPC socket in this runner, so contracts were checked with
`node --import tsx scripts/generate-system-contracts.ts --check` instead.

## Retained routed screenshots

These are actual application screenshots from the final hosted run; they are
not replacement baselines or a source-mockup capture. Agent visual inspection
found no blocking layout defect in these retained views; human sign-off remains
open.

- [Phone character, light](images/g9-2026-11-03/character-360-light.png)
- [Phone character, dark](images/g9-2026-11-03/character-360-dark.png)
- [Tablet campaign content](images/g9-2026-11-03/campaign-Content-768-light.png)
- [Desktop sheet builder, dark](images/g9-2026-11-03/creator-sections-1280-dark.png)
- [GM scene controls on phone](images/g9-2026-11-03/gm-scene-phone.png)
- [Restricted redacted tablet display](images/g9-2026-11-03/restricted-display-tablet.png)
- [Recovered pool character](images/g9-2026-11-03/recovered-pool-phone.png)

## Runner corrections and earlier attempts

- The initial main-linked-service attempt stopped at authentication and created
  no journey resources. Correct source/health alone was not accepted as GUI
  readiness.
- G9 browser startup initially lacked the managed proxy CA; adding the existing
  CA to Chromium's trust store resolved that runner issue.
- The first display cleanup omitted its required image revision and masked the
  primary pairing failure; subsequent runs report the primary failure and use
  revision-guarded cleanup.
- The display route intentionally has a restricted section rather than the app
  main shell; its ready condition is the real pairing heading.
- Public asset-worker caches are permitted; the privacy check enumerates cache
  requests and rejects API/media/projection entries. Requiring an entirely empty
  CacheStorage incorrectly rejected a safe public app-shell cache.
- Independent-account generation tombstones are not private sheet payloads.
  Handoff inspection accepts only cleared character sentinels and rejects
  confirmed sheets, rolls, pending requests and other retained character data.
- Stop collecting projection response bodies before deliberate page/offline
  transitions. Otherwise CDP may reject a stale body read after navigation,
  producing an unhandled runner error despite completed application assertions.
- The pool fixture's condition is an enum: the independent writer uses its
  supported `focused` value. An arbitrary note was correctly rejected with 422.
- The export review is left through navigation to the sheet, consistent with
  that surface's controls, rather than waiting for a nonexistent Close button.
- Early long runners were interrupted while correcting these new protocol
  assumptions. Interrupted/incomplete runs are not accepted evidence. A scoped
  follow-up identified three remaining campaigns and their three systems by
  this protocol's exact titles/version links, test actors and creation/update
  window before the final run. It revoked their display credentials, archived
  their characters/campaigns and made systems private/archived, with independent
  readback. The final run's active fixtures were outside that cleanup window.
- CI #196 exposed the older I5 journey taking the page offline after URL
  navigation but before confirmed edit ownership. The runner now waits for
  the target heading, Editing-in-this-tab and Saved before its single offline
  bump. Pending-state and exactly-two-bump assertions, retries and timeouts
  are unchanged.
- Initial CI screenshot differences exposed unintended bottom-nav/footer height
  changes; layout was corrected without regenerating or relaxing any baseline.

## Explicit remaining boundaries

- Real Android Chrome and iPad Safari, physical touch/software keyboards,
  orientation changes and actual PWA installation/reopening remain unperformed.
- CSS text enlargement is browser emulation, not OS accessibility-text or
  hardware proof. Automated axe checks do not replace human visual, contrast,
  focus visibility or screen-reader review.
- Long Swedish/German authored labels were tested. The app's translation
  catalog was not rewritten or represented as a full translated-UI test.
- Physical-table and real remote-group playtests remain open. Concurrent browser
  contexts are useful regression evidence, not those human sessions.
- Real-provider login, callback/logout acceptance and the OD-05 provider decision
  remain open; test-auth `/cb` return does not close them.
- Source-mockup archiving and launch-template licensing (OD-08) remain open.
- Test services have no persistent app media volume. Upload/compositing/readback
  in one deployment are verified; persistence across redeployment is not claimed.
  The existing Railway operations guide requires a volume for durable images.
- No historical app/database/client transition, version upgrade, migration or
  public release was introduced. Disposable current-schema test data remains
  governed by the existing pre-release policy.
