# AGENTS.md

The application design is described in **design_v2.md**

Follow design and DO NOT increase scope without asking.

Update design document if any changes is made to the design.

The GUI delivery checklist is [GUI integration plan](docs/superpowers/plans/2026-09-08-gui-integration.md), linked from design Sections 10 and 17. Follow its dependencies and acceptance gates for frontend work.

For scripted API sessions, start with the [scenario authoring guide](tests/integration/scenarios/README.md). It gives you a copyable test, the API contract lookup, and the command for running a single scenario. Add new scenarios as `tests/integration/scenarios/*.test.ts`.

Multi-user remediation F1-F3 and test-target preflight E1 passed on the isolated
preview on 2026-11-02. The full ordered
[one-GM/three-player protocol](docs/acceptance/multi-user-journey-protocol.md)
passed on application `a1fc299` with 24 verified rolls, GUI-only invitation/adoption
flows, privacy, offline recovery and scoped cleanup. See the
[post-fix acceptance record](docs/acceptance/multi-user-journey-2026-11-02.md)
and [remediation plan](docs/superpowers/plans/2026-11-01-multi-user-journey-remediation.md).
Changes are in PR #28. This closes that journey gate; the broader G9 device,
provider-login and table/remote-playtest gates remain open under design Section 18.2.
No new feature is selected or authorized by this acceptance record.

PR #29 adds the [2026-11-03 hosted G9 protocol and evidence](docs/acceptance/gui-2026-11-03-g9-hosted.md), including prefixed display authentication, redacted-image loading, private-device handoff and enlarged-text layout fixes. Consult its final result table and tested application/deployment before repeating work. Physical devices, real provider login, human visual sign-off, table/remote playtests remain separate open release gates. Do not mark the complete G9 checklist accepted from browser automation alone.

The app is unreleased and databases contain only disposable test data. Follow the
[development database policy](database/README.md): update the current schema
baseline instead of adding migrations or repair code for obsolete app versions.

**Owner clarification (2026-11-05):** Until the first application release tag,
all app/database state may be cleared completely. The owner explicitly permits
deleting and recreating the development app and its database when necessary;
retaining old test state is optional. Do not ask again solely because a
pre-release reset would discard test state. Check release-tag status first;
after the first release tag, follow the released-data migration/recovery policy.

System (rules) versions are not application versions. Owner decision 2026-11-07:
characters and campaigns may be upgraded forward to a later non-breaking version of
the same system after a per-character dry run (design Section 6.7, [plan](docs/superpowers/plans/2026-11-07-system-version-upgrades.md)).
Reverting to the version recorded before the most recent upgrade is in scope.
Breaking upgrades, field mapping, other downgrades and cross-system moves remain
out of scope. Keep published rules identifiers and immutable snapshots.
Application-version migrations and support for older app/API/package/cache/client
versions are required only after the first application release Git tag (`v*.*.*`) for supported released versions.
Follow [design Section 17.0](design_v2.md#170-release-status-and-application-version-policy);
older compatibility checklists must not introduce pre-release acceptance or merge gates.

Before that tag, no app/database migration tasks or
transition tests belong in implementation plans or suites. The strategy is agreed
now in [the post-tag migration plan](docs/superpowers/plans/2026-10-27-application-migration-policy.md); implement transition code/tests only for changes after the tag.

PR #30 delivers system color/component themes, durable scanned media, character
portraits, item art and safe scene background upload/replacement. All stages
T1/T2/M0–M3 passed their recorded hosted acceptance; M3 also passed byte/pixel
verification after redeploy and CI #219 on application `d62a9f8`. See the
[completed staged plan](docs/superpowers/plans/2026-11-03-system-themes-and-images.md)
and [scene evidence](docs/acceptance/scene-backgrounds-2026-11-04.md). Physical
devices, real provider login and human/playtest G9 gates remain open.

I7b/G8 visual scene controls passed combined V4 feature acceptance in PR #38 on
2026-11-06. PR #36 contains V2 direct gestures and merged V3 fog brushing from
#37; merge #36 before #38. V1 image-token rendering was delivered in #34.
[Combined evidence](docs/acceptance/scene-visual-controls-2026-11-06.md) records
one ordered local/hosted GUI journey at deployed `3a35a5f`, terminal SUCCESS
`f33cf328`, with mouse/native emulated touch/keyboard at 360/768/1280px, exact
redacted pixels/art, privacy, conflicts/idempotency recovery, reopen, offline,
background reset, revocation and independent cleanup readback. Follow the
[completed visual-controls plan](docs/superpowers/plans/2026-11-05-scene-visual-controls.md).
The G8 visual-control feature gate is complete; physical-device/provider-login,
human visual approval and actual table/remote G9 release gates remain open.
Emulated touch must not be reported as physical-device acceptance. This record
selects no new feature; final-head CI is tracked in PR #38.

The owner approved the [scene streaming plan](docs/superpowers/plans/2026-11-07-scene-streaming.md)
on 2026-11-07. Stages 1–3 are implemented: the paired display receives scene
snapshots over SSE (`GET /displays/:id/scenes/:sceneId/events`, PostgreSQL
`LISTEN`/`NOTIFY`), and the old polled projection route was removed with all its
client code. Do not reintroduce display polling. The hosted journey and the
200-table load comparison (stage 4) remain open.

The owner approved Part B of the [public API plan](docs/superpowers/plans/2026-11-07-public-api-v1.md)
on 2026-11-07. Stages B1–B5 and the local parts of B6 are implemented: six token
scopes including `campaigns:read`/`campaigns:write`, browser-policy character
access, rolls and pushes, and the full campaign, media, scene and display-pairing
surface under `/api/v1`. See the plan's implementation record before changing v1.
The hosted B6 journey depends on real provider sign-in and remains open.

The owner requested the [rules coverage plan](docs/superpowers/plans/2026-11-10-rules-coverage.md)
on 2026-11-10. Stage R0 fixes review defects inside the current design. Stages
R1–R8 widen the rules contract and each needs the owner to confirm its decisions
(C1–C14) before work starts. Nothing is implemented yet.
