# AGENTS.md

The application design is described in **design_v2.md**

Follow design and DO NOT increase scope without asking.

Update design document if any changes is made to the design.

The GUI delivery checklist is [GUI integration plan](docs/superpowers/plans/2026-09-08-gui-integration.md), linked from design Sections 10 and 17. Follow its dependencies and acceptance gates for frontend work.

The app is unreleased and databases contain only disposable test data. Follow the
[development database policy](migrations/README.md): update the current schema
baseline instead of adding migrations or repair code for obsolete app versions.
Generic rules-system character/campaign upgrades remain product functionality.
