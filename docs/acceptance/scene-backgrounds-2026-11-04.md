# Scene backgrounds — implementation checkpoint

M3 is implemented; hosted acceptance, post-redeploy verification and branch CI
remain pending. The complete PR is not yet accepted.

Inventory confirmed the existing Campaigns uploader and create/update APIs were
not reachable from an upload/select UI. The GM campaign page now links to its
scene library, with bounded named thumbnails, upload, create/open, preview,
confirmed replacement and explicit deletion. No new tactical behavior is added.

Red/green cases reproduced retained fog/tokens on replacement, missing catalog
routes and a GM demotion during original file I/O. These pass after atomic scene
reset, bounded GM catalogs/thumbnails and post-I/O authority/checksum checks.
A UI regression also reproduced uncommitted fog coordinates surviving the swap;
background identity now remounts viewport and fog/token controls. The shared file
control and existing display credential/redaction workflow are retained.

Local validation:
- 382 database integration cases passed with unchanged budgets (creation p95
  214.3 ms, reads 19.3 ms, bumps 29.1 ms and rolls 38.7 ms).
- 488 root unit cases passed; root/web type checks, generated contracts and web
  production build passed.
- 1,214 web unit cases passed, including confirmed replacement, exact request
  recovery after response loss, explicit stale-conflict refresh, revocation
  blanking, old fog-draft cleanup and existing scene/display regressions.

The hosted runner tests GUI upload/select/create/replace/delete, a concurrent GM
edit, a committed replacement with dropped response and exact retry, server-redacted
pixel colors, token reset, private-route denials, offline/reconnect and revocation.
It leaves only its successful campaign for a second post-redeploy checksum/pixel
verification, which then archives it. Deployment and actual results are pending.
Physical device and human/table-play G9 gates remain separate.
