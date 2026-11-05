# AGENTS.md

The application design is described in **design_v2.md**

Follow design and DO NOT increase scope without asking.

Update design document if any changes is made to the design.

The GUI delivery checklist is [GUI integration plan](docs/superpowers/plans/2026-09-08-gui-integration.md), linked from design Sections 10 and 17. Follow its dependencies and acceptance gates for frontend work.

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

Character/campaign version upgrades, mapping previews and rollback are also out of scope.
Keep published rules identifiers and immutable snapshots; do not add conversion paths.
Application-version migrations and support for older app/API/package/cache/client
versions are required only after the first application release Git tag (`v*.*.*`) for supported released versions.
Follow [design Section 17.0](design_v2.md#170-release-status-and-application-version-policy);
older compatibility checklists must not introduce pre-release acceptance or merge gates.

Before that tag, no app/database or character/campaign migration tasks or
transition tests belong in implementation plans or suites. The strategy is agreed
now in [the post-tag migration plan](docs/superpowers/plans/2026-10-27-application-migration-policy.md); implement transition code/tests only for changes after the tag.

PR #30 delivers system color/component themes, durable scanned media, character
portraits, item art and safe scene background upload/replacement. All stages
T1/T2/M0–M3 passed their recorded hosted acceptance; M3 also passed byte/pixel
verification after redeploy and CI #219 on application `d62a9f8`. See the
[completed staged plan](docs/superpowers/plans/2026-11-03-system-themes-and-images.md)
and [scene evidence](docs/acceptance/scene-backgrounds-2026-11-04.md). Physical
devices, real provider login and human/playtest G9 gates remain open.

I7b/G8 visual scene controls are **not complete**. The 2026-11-05 review reopened
image-token selection/rendering, direct drag/tap token controls and on-image fog
brushing. Follow the [visual-controls completion plan](docs/superpowers/plans/2026-11-05-scene-visual-controls.md).
The numeric-control and M3 background acceptance records prove their stated
foundation only; do not use them to close these visual-control requirements.
