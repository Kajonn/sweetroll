# AGENTS.md

The application design is described in **design_v2.md**

Follow design and DO NOT increase scope without asking.

Update design document if any changes is made to the design.

The GUI delivery checklist is [GUI integration plan](docs/superpowers/plans/2026-09-08-gui-integration.md), linked from design Sections 10 and 17. Follow its dependencies and acceptance gates for frontend work.

The app is unreleased and databases contain only disposable test data. Follow the
[development database policy](database/README.md): update the current schema
baseline instead of adding migrations or repair code for obsolete app versions.
Character/campaign version upgrades, mapping previews and rollback are also out of scope.
Keep published rules identifiers and immutable snapshots; do not add conversion paths.
Application-version migrations and support for older app/API/package/cache/client
versions are required only after the first release for supported released versions.
Follow [design Section 17.0](design_v2.md#170-release-status-and-application-version-policy);
older compatibility checklists must not introduce pre-release acceptance or merge gates.
