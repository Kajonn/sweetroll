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

The app is unreleased and databases contain only disposable test data. Follow the
[development database policy](database/README.md): update the current schema
baseline instead of adding migrations or repair code for obsolete app versions.
Character/campaign version upgrades, mapping previews and rollback are also out of scope.
Keep published rules identifiers and immutable snapshots; do not add conversion paths.
Application-version migrations and support for older app/API/package/cache/client
versions are required only after the first application release Git tag (`v*.*.*`) for supported released versions.
Follow [design Section 17.0](design_v2.md#170-release-status-and-application-version-policy);
older compatibility checklists must not introduce pre-release acceptance or merge gates.

Before that tag, no app/database or character/campaign migration tasks or
transition tests belong in implementation plans or suites. The strategy is agreed
now in [the post-tag migration plan](docs/superpowers/plans/2026-10-27-application-migration-policy.md); implement transition code/tests only for changes after the tag.
