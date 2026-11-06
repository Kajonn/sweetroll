# Campaign background/token upload limit — 2026-11-06

PR [#35](https://github.com/Kajonn/sweetroll/pull/35) fixes valid campaign artwork
rejected with HTTP 413 before image validation. The unchanged Library archive
`Sweetroll_upload_test_images.zip` originally passed five uploads but failed both
backgrounds and the ranger token. All three affected uploads now pass the hosted
GUI journey.

## Cause and correction

Campaign scene backgrounds and token artwork share `POST /campaigns/:id/images`.
That route inherited Fastify's 1 MiB JSON limit, while the UI and image-processing
contract permit image files up to 5 MiB. Base64 adds further request overhead.
The route now uses the existing 8 MiB image-request allowance. This changes only
that upload route; decoded file/pixel limits, normalization, ClamAV scanning,
quotas, authorization and other campaign request limits remain in force.
No schema, migration, frontend or product-design change is included.

## Test-first evidence

A real 1280×1024 uncompressed PNG below 5 MiB produces a JSON request over 1 MiB.
Before the correction, the new regression failed `expected 413 to be 200`.
Afterward it passes and proves exact upload field mapping, anonymous 401 and an
unchanged 413 for an oversized unrelated campaign command. The existing oversized
JSON assertion now exceeds the new 8 MiB route allowance and still checks the
sanitized `too_large` error envelope. Module-level oversized-image rejection and
scanner behavior remain covered by their unchanged tests.

- Campaign HTTP suite: **30 passed**.
- Image processing/scanning: **13 passed**.
- Complete local backend unit run: **489 passed, 10 database-dependent skipped**.
- Root typecheck and `git diff --check`: **passed**.
- Full GitHub [CI #251](https://github.com/Kajonn/sweetroll/actions/runs/42266026210): **SUCCESS** on application `c842a84`, including database integration, contracts/types, Docker, web, all browser journey shards, visual and offline checks. Production deploy was skipped.

## Hosted identity and GUI sequence

Only the isolated `sweetroll-d2` preview source was changed. The main-linked
acceptance and production services, their auth configuration and their source
branches were left unchanged. The preview was pinned to the exact application
commit before entering the journey.

| Field | Value |
| --- | --- |
| Project / environment | `sweetroll-d2-acceptance` / `preview` |
| URL | https://sweetroll-d2-preview.up.railway.app |
| Branch | `fix/campaign-image-upload-limit` |
| Application | `c842a84670c67b6b4b3772acc7c4936d4067b1b6` |
| Deployment | `d6cac25b-73c6-4dce-8051-24d46dda659d`, **SUCCESS** |
| Campaign | `d7bf30aa-51d6-4a02-8f5d-7be2dde6cdbd` |
| Scene | `4c263722-e7b1-489d-a28f-2c6a4badfdc5` |

Setup used normal application APIs to create this campaign from the seeded d20
snapshot. These feature steps used the routed GUI and real browser file chooser:

1. Upload the unchanged 2,478,871-byte `background_tavern.png`; create a scene.
2. Upload the unchanged 1,040,794-byte `token_ranger.png` through Token artwork;
   place the ranger, reveal a central fog dab and reload. Both art assets render;
   the transparent token retains its placement.
3. Upload the unchanged 3,328,776-byte `background_ruins.png`; choose Use as
   background and confirm Replace and conceal. Reload shows the ruins and no
   tokens. All image files are 1672×941 or 1254×1254, below the 4096px limit.

No resizing, recompression or alternative images were used. The previous five
successful portrait/item/wolf uploads are recorded in the original Library test
report; this fix journey repeats the three affected assets and dependent scene
behavior rather than claiming a new eight-image run.

Independent authorized reads confirm exact source pixel equality for all three
originals, including ranger alpha extrema 0–255. Scene revision 4 contains the
ruins background with empty fog and tokens. A fresh display credential received
an entirely black image immediately after replacement; a subsequent central
reveal produced source-matching center `[181,158,119,255]` and concealed corner
`[0,0,0,255]`. The credential was revoked.

Scoped cleanup completed: only the created test campaign was archived through its normal recoverable archive command. Browser automation does not close
physical-device, provider, playtest, direct-gesture or aggregate G8/G9 gates.
