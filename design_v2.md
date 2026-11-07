# Generic TTRPG Platform (Revised)

**Product design specification — v0.4**

*Shared, mobile-first character sheets and campaign coordination for any TTRPG system.*

> **Product thesis.** A group plays a tabletop game together — at a physical table or remotely. This platform provides shared, mobile-first character sheets, rolls, and campaign coordination that work for *any* rules system. It is not a simulation and not a virtual tabletop: it captures the basics (stats, rolls, results) and gets out of the way, letting the GM and players update their own numbers.

| Document         | Product and technical design                         |
|------------------|------------------------------------------------------|
| Status           | Draft v0.4; GUI delivery added                       |
| Date             | 8 September 2026                                     |
| Primary audience | Product owner, UX designer, implementation team      |
| Planning horizon | MVP followed by collaboration and marketplace phases |

# 1. Executive summary

The product is a web platform with three role-oriented workspaces: **System Creator**, **Game Master**, and **Player**. A single account may use any combination of roles.

The core strength versus existing VTTs is:

- **Mobile-first for both GM and player.** Sheets and session surfaces are designed around a phone in one hand at a table.
- **Usable on a physical table and online.** Digital sheets accompany in-person play rather than replacing it; the same sheets work for remote groups.
- **System-agnostic.** Unlike D&D Beyond, it supports any rules system. Because copyrighted systems cannot be shipped, the MVP ships **pre-built open-license templates** plus a **minimal no-code creator**.
- **Not a simulation.** It captures the basics to make rolls and show results, then hands freedom back to the GM and players to update stats.

The MVP is a modular monolith backed by PostgreSQL and object storage. System definitions are declarative, versioned documents. Math and dice expressions are parsed into a lightweight AST and evaluated by the platform; creator-supplied executable code is never run. Published system versions are immutable; campaigns and characters pin to an immutable published version. A character or campaign may move forward to a later, non-breaking version of the same system after its state verifies against that version (Section 6.7); this is unrelated to application-version migration (Sections 12.4 and 17.0).

> **MVP scope.** Build a trustworthy shared-character-sheet and campaign platform — not a full virtual tabletop and not an auto-applying rules simulator. The first Player and GM applications are mobile-first web apps delivered as an installable PWA. Native binaries and app-store distribution are post-MVP. Simple background images, manually edited fog, GM-positioned tokens, and a restricted player display are included in I7b. Video, voice, tactical movement, dynamic lighting, marketplace payments, and arbitrary scripting are excluded from the first release tag.

# 2. Positioning and differentiation

The existing market forces a trade-off that no current tool fully resolves:

| Category | Examples | Problem |
|----------|----------|---------|
| Full VTT | Roll20, Foundry, D&D Beyond, Fantasy Grounds | Heavy setup, poor mobile, often system-locked, aimed at remote play (maps, tokens, fog) |
| Light VTT | Owlbear Rodeo | Map-only, no character-management depth |
| Character apps | D&D Beyond | System-locked (D&D only), no cross-system or campaign coordination |

**Nobody owns the "digital character sheets for a group that plays together" space** — whether that group sits at the same physical table or plays remotely without needing a battle map.

**Positioning statement:**
> Shared, mobile-first character sheets and rolls for any TTRPG system — at a physical table or remote. Your group plays the game; we handle the math, visibility, and the session bookkeeping.

**Deliberate non-identity (hard scope limit — do not creep toward these):**
- Not a full virtual tabletop: simple image presentation, manual fog, and GM-positioned tokens are allowed; tactical grids, movement rules, vision, dynamic lighting, and automated combat are excluded
- Not a physics/simulation layer that auto-applies rules to everything
- Not a system-locked builder
- Not a marketplace or content store

**What we ARE:**
- Mobile-first (GM **and** player) character sheets
- Usable at a physical table **and** online
- System-agnostic via pre-built open-license templates + a minimal creator
- Trustworthy: the right people see the right data, server-enforced
- Simple math + basic dice, not a programming language

# 3. Users, roles, and tenancy

Roles are contextual capabilities, not account types. The same user can create a system, run one campaign, and play in another. Authorization is evaluated against the current resource and campaign membership.

| **Role**            | **Primary jobs**                                                     | **Important constraints**                                                      |
|---------------------|----------------------------------------------------------------------|--------------------------------------------------------------------------------|
| System creator      | Model rules; design sheets; preview; validate; publish; maintain versions | Cannot inspect campaigns or characters merely because they authored the system |
| Game master         | Create campaign; invite members; manage content; view permitted characters; reveal information | Authority limited to campaigns they own or co-manage |
| Player              | Join campaign; create and play characters; view shared content; make rolls | Cannot read GM-only content or another player's private data |
| Independent player  | Create a character from a public or personally accessible system     | No campaign content or GM integration                                          |
| Platform admin      | Moderation, abuse response, support, operational recovery             | Privileged access is audited and not part of normal product flows              |

> **Tenancy rule.** A campaign is the principal collaboration scope. A system is a reusable definition, while characters, handouts, notes, and membership belong to a campaign or to an individual user. Visibility is **server-enforced**, never UI-only.

# 4. Product structure and navigation

| **Workspace**  | **Primary navigation**                                                      | **Responsive intent**                                                                             |
|----------------|-----------------------------------------------------------------------------|---------------------------------------------------------------------------------------------------|
| System Creator | Overview; Data Model; Sheet; Rules; Preview; Versions; Settings            | Desktop-first. Tablet supported. Mobile offers review and small edits, not full layout authoring. |
| Game Master    | Session; Content; Characters; Members; Campaign Settings                     | Mobile-first quick actions plus richer desktop organization.                                      |
| Player         | Characters; Activity; Account; Campaigns after I6                            | Mobile-first with platform-owned bottom navigation and thumb-reachable controls.                   |
| Account        | Home; Systems; Campaigns; Characters; Profile                               | Responsive launcher that reflects all roles.                                                      |

## 4.1 Shared interaction principles

- Autosave drafts, show the last saved state, and never make a user guess whether data persisted.
- Place in-session actions before administrative controls; destructive operations require confirmation and clear scope.
- Use progressive disclosure. Basic creation should not expose formulas, validation, or visibility logic until needed.
- Normal views show readable names and actionable state. Account → Developer tools offers an off-by-default device-local “Show debug information” preference for technical IDs, revisions, checksums, diagnostic paths/codes and expression ASTs. It changes presentation only, never authorization or data fetching. Identifier editing, field constraints, appearance and precise token positioning remain available through collapsed native disclosures that preserve values. Missing reference labels remain explicit repair fallbacks. See the [GUI disclosure plan](docs/superpowers/plans/2026-11-05-gui-progressive-disclosure.md).
- The creator has one save indicator, one diagnostics action and one version-history action; publication blocking reasons remain visible. Roll group totals, push availability and relevant face outcomes stay visible; per-die calculations are available through roll details. Appearance preferences are edited in Account while the shell continues applying the effective device/account/OS theme.
- Keep state and rules distinct: definitions describe what a field means; character and campaign records contain current values.
- Every visibility control states its audience in plain language and offers a preview-as-player check.
- Provide undo for builder operations and recoverable deletion for user content where practical.

In character sheet item slots, show the item name once and reveal rename editing on request. Keep Remove visually secondary in each row and require confirmation before deleting an item. After a granted nominal action is acknowledged by the server, show a clear action confirmation with its authored output when meaningful; do not display unresolved roll placeholders as a result.

Templated entries expose schema-driven field editing on the character sheet. Item entries can update their positive integer quantity under the character revision and offline idempotency flow. Item granted rolls can use attributes of the carrying character alongside item values. The builder offers character attributes reachable through the item's slots and validates that a referenced attribute is available for every entity that can use that slot. An item may expose separate hit and damage rolls, each with its own expression and result.

## 4.2 Multi-device GM play

A GM may use **multiple devices in the same session simultaneously**, with each device focused on a different task. Private control devices may share the GM account; a device handed to players uses restricted display access:

- e.g. an **iPad or second screen for showing images/handouts to players**, while a **phone shows monster/stat sheets** for the GM's own reference.
- Concurrency between the GM's devices is handled by the standard revision/`409` mechanism; single-writer per resource means the GM cannot corrupt their own data by editing from two screens, though they will see a conflict and refresh prompt if both attempt to mutate the same field at once.
- Each authenticated GM device runs the normal responsive surface, with no artificial single-session lock. A tablet handed to players instead uses the dedicated restricted Display surface introduced in I7b; it must not retain the GM session or private cached data.
- Updates are scoped to the campaign and actor, initially through authorized polling/revision refresh. In I7b, paired player displays receive only the permitted scene projection using revocable, display-scoped credentials; they never receive GM originals or secret payloads. Since 2026-11-07 the paired display receives committed scene snapshots over a credential-scoped server-sent-event stream instead of polling (Section 7.7); other campaign views keep their refresh behavior.

# 5. Core user journeys

## 5.1 Start a campaign from a template

1. Choose a pre-built open-license system template, or a blank/from-scratch template for the minimal creator.
2. Create a campaign from the template's pinned published version and set campaign metadata.
3. Choose defaults: character ownership, GM visibility, dice visibility, and whether multiple characters per player are allowed.
4. Invite players with expiring links or email invitations and optionally appoint co-GMs.
5. Add text content classified as GM only, all players, or selected players.
6. Review the campaign as a player before the first session.

## 5.2 Create and publish a custom system

1. Create a system draft from blank or by **cloning a template**; define name, description, language, and default dice notation.
2. Define fields, resources, and actions with guided controls for common dice plus an optional numeric attribute modifier; direct expression editing remains an advanced path.
3. Arrange a single-column sheet into sections. The builder lists definitions not yet present on the target sheet and places each with one action, creating the first section when necessary; creators do not copy stable IDs for the basic path.
4. Validate, preview with sample data (phone/desktop), and publish an immutable version. Share by direct link or invite.

## 5.3 Join and play

1. Open an invite, authenticate, review campaign identity, and join.
2. Create a character using the campaign's pinned system version, or claim a character assigned by the GM.
3. Complete required fields and resolve validation messages.
4. During play, update resources, trigger actions and rolls, and read shared content — at a physical table or online.
5. Review a clear activity history for meaningful changes and rolls.

## 5.4 Create adventure-specific items

**Implementation contract:** [Campaign inherited actions](docs/superpowers/specs/2026-10-31-campaign-inherited-actions.md).

**D1 implementation (PR #26; hosted acceptance passed):** [Player proposal contract](docs/superpowers/specs/2026-10-31-player-template-proposals.md) and [execution plan](docs/superpowers/plans/2026-10-31-player-template-proposals.md) specify private player submissions and one atomic GM approval that publishes a data-only catalog template. The source personal entry remains unchanged. C is merged as `455f967`. Proposal routes, private generation-bound reads, atomic approval/rejection and online-only scoped GUI are implemented; Passing hosted journeys, exact served-asset verification, private recovery and independent cleanup are tracked in [D1 acceptance](docs/acceptance/player-template-proposals-2026-10-31.md). Restricted catalog audiences are implemented separately in D2 ([PR #27 acceptance](docs/acceptance/restricted-template-audiences-2026-11-01.md)).

**Implemented and accepted on the isolated preview (2026-10-31):** [Campaign templates with inherited actions — adventure slice C](docs/superpowers/plans/2026-10-31-campaign-inherited-actions.md), planned against `main` `ba8200b`. A derived template uses a server-validated base from the campaign's pinned published package; only presentation, typed field defaults and item quantity are editable. Placed copies keep their exact catalog revision, reuse existing roll/nominal/entry-resource actions and push policies, and remain usable after catalog archive or authorized character return without a live catalog lookup. Personal/blank campaign entries remain data-only. Base changes and instance conversion are excluded; non-breaking rules-version upgrades follow Section 6.7. The implementation is published in PR #25. Application `58c71a1` passes all CI #158 verification jobs and both isolated hosted journeys, including offline/returned-sheet recovery. Deployment `5a090554-1e7d-4a06-98e2-3a6e1f0a886d`, served asset identity and independent cleanup are verified. C7 is complete; unperformed G9 release gates remain open.

1. A player or authorized GM adds a personal custom entry to a character's compatible sheet slot and records its name, description, quantity and notes without changing the published system.
2. A GM or co-GM may create a reusable campaign template for an item, spell, ability or effect. Data-only templates can start blank; a template based on the campaign's pinned system version may inherit that system item's validated actions.
3. Publish the campaign template to its authorized members, then add it to a campaign character. Character-specific values stay with the instance. A later template edit creates a revision and does not silently alter existing entries.
4. Remove an entry to remove its actions from the sheet while retaining prior rolls and activity. Player proposals and restricted-audience drafts are implemented in D1/D2. Existing entries remain pinned; explicit instance upgrades are outside this increment.

See the [adventure-specific custom items plan](docs/superpowers/plans/2026-10-07-adventure-custom-items.md) for permission, visibility, offline and acceptance gates. The existing dynamic-object design's data-only rule continues to apply to personal entries.

**Implemented in PR #19 (slice B, 2026-10-10):** [Campaign data-only templates execution plan](docs/superpowers/plans/2026-10-09-campaign-data-templates.md). An active GM/co-GM creates and publishes a blank template to all active campaign members in one operation, with fixed bounded name/description/notes and an item default quantity. Resource concurrency revision is separate from immutable content revision; edit appends content, while archive/recover changes lifecycle only. Placement validates the selected revisions and materializes a server-owned data-only snapshot; character-specific edits never update the catalog. Archive blocks new placement and preserves old copies. Returned sheets keep those copies under the existing return-owner exception, without campaign catalog/history access. Offline placement freezes the fetched reference and requires explicit review if it changes before first commit; an authorized committed retry preserves its original result. The implemented contract passed required CI #91; [acceptance evidence](docs/acceptance/campaign-data-templates-2026-10-10.md) records server/browser/offline coverage and passed isolated deployed multi-account/offline acceptance. Inherited actions, proposals, restricted drafts and explicit instance upgrades remain later slices.

# 6. System Creator specification

## 6.1 System definition model

A system version is a validated declarative package with stable identifiers for every definition. Display names may change; identifiers must not. Runtime records store definition identifiers rather than labels.

| **Definition**   | **Purpose**                                   | **Representative configuration**                             |
|------------------|-----------------------------------------------|--------------------------------------------------------------|
| Field            | Atomic value stored on an entity              | id, label, type, default, required, constraints              |
| Derived field    | Calculated value not directly edited          | math-only expression, rounding, fallback                     |
| Sheet view       | Responsive presentation of bound data         | sections, elements, bindings                                 |
| Action           | User-triggered roll or simple stat change     | inputs, roll notation, output message                        |
| Rule             | Validation or simple conditional behavior     | condition, severity, message, targetId                       |
| Reference data   | Reusable system content                       | skills, items, conditions, lookup tables                     |

## 6.2 Supported field types

| **Category** | **MVP types**                              | **Notes**                                         |
|--------------|--------------------------------------------|---------------------------------------------------|
| Scalar       | text, integer, decimal, boolean            | movable; numeric constraints and step supported   |
| Choice       | single choice, multi-choice                | Static options only; reference-data source        |
| Resource     | current/max pair                           | Optional min/max and reset action                 |
| Computed     | number, text, boolean                      | Read-only result of a math-only expression        |
| Media        | image attachment reference                 | Reserved image field; character portraits and item art delivered in M1/M2 (Section 7.8) |

**Removed from MVP:** rich text, temporal dates, single/multiple entity references, embedded collections. These are post-MVP.

## 6.3 The sheet

A sheet is a **single-column linear scroll** (predictable collapse to one column on phones) composed of:

- Headings and section dividers
- Labeled fields
- Resource bars (current/max) with step controls and direct input
- A flat list of **action buttons** (rolls and simple stat bumps)

**Removed from MVP:** tabs, multi-column grid layouts, drag-drop element palette, manual binding inspector, reusable fragments, conditional display, viewport authoring beyond preview. Keep only a simple section/order editor with move-up/down controls and keyboard authoring.

The basic builder exposes an explicit “not on this character sheet” list for the sheet's target entity and global actions. The creator selects a target section for one-action placement (initially the first section); when none exists, placement creates the first section. Each placed item receives a generated document-wide element ID. Manual target-ID editing remains an advanced repair path, not the expected creation flow. The creator Sheets tab presents entity and element-binding reference IDs as labeled dropdowns sourced from compatible document definitions; sheet, section, and element identity IDs remain automatically assigned and read-only in the basic builder. Unresolved legacy bindings are shown explicitly without silent replacement.

## 6.4 Rules and expression engine

> **Security invariant.** System packages contain data and simple expressions only. They cannot execute JavaScript, make network requests, access files, or run server commands.

Expressions are **math plus basic dice** only, parsed into a lightweight typed AST and evaluated by the platform with hard budgets:

- Arithmetic, comparison, and boolean composition: `+ - * /`, `== != < <= > >=`, `&& ||`, `min`, `max`, and `round`; division-by-zero fallback
- Field access: stable identifiers of sibling fields and current action inputs only
- Dice: standard notation (`2d6`, `d20 + 2`), keep-high/low (`4d6kh3`), advantage-style helpers, field-derived pools, and counted successes at a threshold; server-side deterministic dice
- **No** chained derived-field dependency graphs
- **No** lookup/aggregation over collections (`equipped.armor.bonus` is out)
- **No** effect engine (set/increment/append) — resource changes are simple built-in "bump" actions
- **No** `against target.defense` action chains

Grammar v0.1 is fixed by `docs/superpowers/specs/2026-09-04-system-package-contract-design.md`. It excludes rerolls, exploding dice, push mechanics, custom faces, arbitrary property traversal, and executable extension points. The platform ceilings are 1,024 expression bytes, 256 AST nodes, depth 32, 100 dice per roll, and 1,000 sides per die.

**Rolls** are a button press → server evaluates → result shows normalized expression, individual dice, modifiers, total, and audience. Rolls are factual; the platform does **not** auto-apply outcomes to state.

**Dice-pool reliability, slice A (2026-10-23 CI and isolated deployed acceptance):** success counts require direct dice operands; valid zero pools remain legal. Entity and item-granted roll actions reject arithmetic failures with a reviewable HTTP 422 error, without recording a fallback or partial roll. Error receipts preserve retry identity. Computed/validation scalar fallbacks remain unchanged. Custom pool formulas retain their expression editor; previews show their sample bindings and omit modifiers where the AST cannot prove an additive interpretation. See [slice A acceptance](docs/acceptance/dice-pool-reliability-2026-10-22.md) for verification and remaining release gates.


**Named dice groups, slice B (2026-10-23 implementation):** document/package 1.1 and grammar 0.2 add declarative `group("attribute", "Attribute", dice(fields.attribute, 6))` operands. `countSuccesses` may count a named group; bare groups sum dice. A versioned calculation graph records group subtotals, thresholds, individual stable dice identities and nested operations. Entity/granted actions, receipts, persistent rolls, audience-filtered grouped history and campaign export preserve the structure. The same text-based group breakdown is used in creator preview, play, GM session results and cached activity. Legacy 1.0 packages/results/checksums/RNG order remain unchanged; character state exports continue to exclude history. See the [B contract](docs/superpowers/specs/2026-10-23-named-dice-groups.md) and [delivery plan](docs/superpowers/plans/2026-10-21-dice-pool-reliability.md) for compatibility and acceptance status. Grouped history details are returned only to readers permitted to see the originating roll, independently of sheet-read permission.

Slice A was merged as PR #21; B was merged as PR #22 (`759323a`). B passed all seven CI verification jobs on final branch head `4cfc04a` (run 121). On 2026-10-24 isolated deployment `87604ee3-6f89-48b3-a86f-585b118fdd0d`, observed commit `ae7d1e8`, passed named-group, legacy and production-offline live journeys; that deployment predates the later parser control-character fix. Mixed-client/worker compatibility is deferred until after the first release tag under Section 17.0; wider device/provider-authentication gates remain open. See the [B acceptance record](docs/acceptance/named-dice-groups-2026-10-23.md). No public-release claim. B does not reroll dice or change resources automatically.

**Configurable pushes, slice C (2026-10-24, implementation in PR #23; scoped acceptance recorded):** the [C contract](docs/superpowers/specs/2026-10-24-configurable-push-rolls.md) specifies package 1.2 action/group policy while retaining grammar 0.2. An online command references an authoritative saved parent and rerolls only eligible dice from its immutable original pool. One-child database uniqueness and atomic lineage/receipt writes enforce bounded attempts independently of character revisions. Child disclosure inherits the root audience principal and can only narrow; the command executor remains separate for audit. Player and GM reuse durable uncertain-command recovery, with no offline creation of pushes or automatic resource effects. The [C execution plan](docs/superpowers/plans/2026-10-24-configurable-push-rolls.md) owns red → green implementation and separate CI/deployed acceptance. The PR implements these capabilities. Source validation is bound to the revision read by Systems and checked under the character lock, even when a caller predicts a future revision. A child must remain readable by its executor after narrowing. The browser validates the complete child and its requested parent before acknowledging; rejected roll access clears the chain from durable results/history and stays hidden offline. Sign-out, character purge and scope changes erase private saved results. The core creator/player/GM and uncertain-recovery journeys passed on isolated deployment `0d776788-110d-403a-8350-3e7dc0e6a4a9`, actual application commit `f75cb02`; see the [C live record](docs/acceptance/configurable-push-rolls-2026-10-24.md). The [2026-10-25 acceptance follow-up](docs/acceptance/configurable-push-rolls-2026-10-25.md) adds passed bounded transition, concurrency, worker-replacement and adapter-compatibility evidence. Early Activity reads await initial reconciliation; later stale cache writes remain rejected with readable refresh guidance. See the [repair evidence](docs/acceptance/character-tools-fixes-2026-10-25.md). Unperformed wider release gates remain open in the C plan.

The [2026-10-27 scoped acceptance](docs/acceptance/configurable-push-rolls-2026-10-27.md) passed nine fresh-system journeys on isolated deployment `90462834-5fbd-4aea-865c-2f9cdc9680b5`, exact application `dfae37f`, including two independent authors, current permission/scope changes, early Activity and durable offline recovery. All five served artifacts matched the source rebuild; CI 135 passed. The report distinguishes PostgreSQL default-policy evidence from the unperformed live internal setting change.

**Pre-release scope decision (2026-10-27):** The owner confirms there has been no release and there are no existing users. Character/campaign version upgrades were removed on that date and reinstated for non-breaking system versions on 2026-11-07 (Section 6.7). Application/database migration and historical-client compatibility are deferred until after the first release tag under Section 17.0. Fresh system authoring/publishing, play, permissions, saved-pool pushes and offline recovery remain in scope. Existing version checks remain defensive constraints; no upgrade workflow is added by this decision.

## 6.5 Draft, validation, and publishing

| **State**          | **Mutable?**  | **Use**                                                                 |
|--------------------|---------------|-------------------------------------------------------------------------|
| Draft              | Yes           | Autosaved authoring state. Not selectable for new campaigns.            |
| Test snapshot      | No            | Temporary preview snapshot with deterministic sample data; expires.     |
| Published version  | No            | Stable package addressable by system ID and semantic version.           |
| Deprecated version | No            | Still usable by pinned campaigns; hidden by default from new selection. |
| Archived system    | Metadata only | No new campaigns; existing access remains according to policy.          |

Publishing performs schema validation, expression/type checking, reference validation, accessibility warnings, responsive checks, and a breaking-change comparison against the previous version. A published version is a content-addressed snapshot with release notes and a checksum.

## 6.6 Templates

The MVP ships pre-built **starter templates from open-licensed systems** so a GM can start a campaign without opening the creator:

- `Basic Fantasy RPG` (OGL)
- A retroclone / rules-light system
- `Cairn` / Into-the-Odd style
- A PbtA-style minimal system
- A Year Zero / dice-pool system
- A **Blank / from-scratch** template

Templates are exported declarative packages that users can clone and customize with the minimal creator. They double as the platform's acceptance fixtures (see Testing).

I1 contract validation uses three original, license-neutral reference fixtures: a d20 ability/check family, a 2d6 PbtA-style move family, and a d6 counted-success pool family. These fixtures define the capability ceiling without being represented as reviewed launch templates. Shipping any named open-license template still requires the separate license review.

## 6.7 Pinned rules and non-breaking version upgrades (owner decision 2026-11-07)

This section is about **system (rules) versions**. It is independent of
application/database versions, which follow Sections 12.4 and 17.0.

Campaigns and characters store the exact published system version they use.
Publishing a new version never changes existing play by itself. Systems are
expected to grow: new items, spells, talents and other templates are common, and
so are stat changes on existing templates. An owner can therefore move a
character or campaign **forward** to a later published version of the **same
system** when the change is non-breaking for that character:

1. **Package check.** The publish-time comparison (Section 6.5) runs between the
   current pin and the target. Adding entities, fields with defaults, templates,
   slots, actions or granted actions and changing template stats, labels,
   expressions with the same context and result type, or presentation are
   non-breaking. A breaking finding blocks only when it touches this character
   (owner decision 2026-11-07): its own character type, an action on its sheet, a
   template or slot used by one of its entries, or an expression behind its
   computed fields or those actions. Breaking changes elsewhere, such as a removed
   item nobody on this sheet has, are listed in the preview but do not block.
2. **Character check (dry run).** The server decodes the character's stored state
   and every entry against the target package, using the existing write-time
   validators. Field values, entry values, slot acceptance and limits, system-base
   references of campaign-derived entries and validations must all pass. New
   non-computed fields receive their declared defaults. The result is a preview
   listing the fields added or dropped, stats updated or kept on this character's
   entries, the target's validation messages and any blocking problems.
3. **Commit.** The upgrade stores the target version ID, the defaulted state and a
   revision bump in one revision-checked, idempotent transaction, and records an
   activity/audit event with the source and target versions. Rolls, activity and
   history are retained unchanged. Nothing is converted or remapped: stable
   definition identifiers carry the values across.

Stored values are kept by identifier. Granted actions and expressions come from
the pinned package. Placing an item copies its template field defaults (its
stats) into the entry, so a version change moves each entry value that still
equals the old template default to the new default, and keeps values the player
or campaign changed; the preview lists both. New template fields receive their
default, and the item's art follows the template unless it was changed.
Campaign-derived entries re-pin their system base to the target version.

**Campaigns.** A campaign and its attached characters share one pin. An active GM
or co-GM upgrades the campaign; the dry run covers every attached character and
every campaign template with a system base, and the commit moves all of them
together or none. Campaign template bases are re-pinned to the target version and
checksum. Any character that fails the dry run blocks the whole campaign upgrade; derived entries already placed on sheets keep their copied defaults.
A standalone or returned character is upgraded by its owner. A standalone
character can be adopted only at the campaign's exact version, so its owner may
first upgrade it to that version.

**Revert (owner decision 2026-11-07).** A character or campaign can return to
the version it used before its most recent upgrade. The upgrade stores that
version as `previous_system_version_id`; a revert clears it, so a second revert is
not possible until the next upgrade. Revert uses the same dry run and commit as an
upgrade, but against the previous version and without the package-level check,
because undoing additions always reads as removals. Current values are kept by
identifier, so play since the upgrade (damage, resources, notes) is not lost.
Values of fields that do not exist in the previous version are dropped and listed
in the preview. An entry whose template or slot does not exist in the previous
version, or whose values no longer verify, blocks the revert; the owner removes or
edits it first. A campaign reverts with all attached characters and template bases
or not at all, and any blocker blocks the campaign.

**Excluded.** Breaking upgrades, field mapping or renaming, reverting to any
version other than the recorded previous one, moving between different systems,
automatic upgrades on publish and lineage tables. A blocked character stays on its
version; create a new character to use a breaking version. Version selection lists
later authorized versions and the revert target; choosing one runs the check for
this character before anything is saved. Standalone characters use
`GET /characters/:id/version-options`, `GET /characters/:id/version-check?targetVersionId=`
and `POST /characters/:id/version` (`{ targetVersionId, expectedRevision, idempotencyKey }`);
attached characters move only with their campaign, through the GM/co-GM routes
`GET /campaigns/:id/version-options`, `GET /campaigns/:id/version-check?targetVersionId=`
and `POST /campaigns/:id/version` (`{ targetVersionId, expectedCampaignRevision, idempotencyKey }`).
The campaign check lists every attached character and every system-based campaign
template with its blockers; the commit locks the campaign, then its characters and
templates, re-verifies them and writes the campaign pin, each character and a new
template content revision with the re-pinned base in one transaction. A campaign
records `previous_system_version_id` like a character. A blocked change returns 409,
and activity records `system_version_upgraded` or `system_version_reverted` with
version and definition identifiers only; the campaign feed shows the same kinds to
all members. In the GUI, **Rules version** sits in the character tools (standalone
characters) and in campaign Settings (GM/co-GM). Both run the check before offering
**Upgrade** or **Revert**, and the character change uses the session's durable
online-attempt ordering like archive/recover. The [system version upgrade plan](docs/superpowers/plans/2026-11-07-system-version-upgrades.md)
defines the delivery stages.

Character activity uses readable action names and local date/time formatting.
A published system version updates the open editor's status immediately.

## 6.8 System extensions (owner-approved 2026-11-07)

Systems can be extended with new items and abilities through separately published
**extensions**: immutable packages of templates (item, spell, talent, effect) with
their granted actions and expressions, owned and shared like systems. A character
or campaign is built on a system version plus a set of extension versions (its
composition). A campaign's composition is the union of the extensions it chose and
those used by its attached characters. Scope, access, ID scoping, campaign-union,
removal and upgrade rules are decisions X1–X13 in the
[system extensions plan](docs/superpowers/plans/2026-11-07-system-extensions.md),
which also tracks implementation stages E1–E8. E1 (package contract) and E2
(authoring and publishing under `/systems/:systemId/extensions` and
`/extensions/:extensionId`) are implemented; an extension is a `systems` row of
kind `extension` whose versions record the base version they were built against.

**Future feature (recorded 2026-11-07, not authorized):** an extension catalog for
discovering and previewing published extensions. It depends on OD-07 and needs its
own plan and approval.

# 7. Campaign and play specification

## 7.1 Campaign workspace

The campaign workspace combines member management, content, characters, and an in-session activity feed. The **Session view** is a curated mobile surface: pinned content, recent rolls, quick character access, and reveal/hide controls.

Campaign creation distinguishes versions with the same display name and semantic version by showing their publication date and a short version identifier. The campaign's pinned version supplies character creation choices automatically; players and GMs should not need to enter an internal version ID. A GM's roster access is labelled as GM access when they do not control a character. Member, sharing and content-preview controls use existing roster display names. Duplicate or absent names have an identifying suffix; short-ID collisions use full IDs, and debug mode shows full IDs. Requests retain exact user IDs and membership generations. Campaign and Session activity show local dates and readable actor labels; the exact actor identifier remains available for identification. Sheet previews show a section title once when its first heading repeats that title.

## 7.2 GM session board

A dedicated **GM Session board** lists all characters with their key resources at a glance (health, stress, ammo, etc.). The GM can one-tap a bump control on any resource without opening each sheet. Designed for the GM at a physical table, and works across the GM's multiple devices (Section 4.2).

## 7.3 Content model and visibility

| **Audience**     | **Who can access**                                  | **Typical use**                                       |
|------------------|-----------------------------------------------------|-------------------------------------------------------|
| GM only          | Campaign owners and co-GMs                          | Plans, secrets, unrevealed locations, private notes   |
| All players      | All active campaign members                         | Handouts, maps, recaps, rules references              |
| Selected players | Explicit member allow-list plus GMs                 | Dreams, secret clues, private correspondence          |
| Owner only       | Creating player plus GMs if campaign policy permits | Personal notes or hidden character information        |
| Public link      | Anyone with link, only if explicitly enabled        | Post-session handouts; excluded from default behavior |

Visibility is enforced in server queries and storage access, never only by hiding UI. Changing visibility writes an audit event.

## 7.4 Characters

- A character references one immutable system version and stores values keyed by stable definition ID.
- Ownership can be one player, multiple players, or the GM. Edit permissions are separate from view permissions.
- Campaign policy decides whether GMs see all character data, only shared fields, or explicitly granted data. Default recommendation is full GM visibility with clear disclosure to players.
- Derived fields are computed from stored state and package rules.
- Meaningful changes create append-only activity events; high-frequency cosmetic edits may be coalesced.

## 7.5 Dice and activity

Actions may produce private, GM-only, or campaign-visible rolls according to campaign policy and per-roll choice. Authoritative rolls are evaluated by the server and include normalized expression, individual dice, modifiers, result, actor, character, visibility, timestamp, and a request id for idempotency. Manual or physical-dice results can be logged distinctly rather than presented as verified platform rolls.

## 7.6 Content types (narrowed)

I6/I7 deliver **text notes** with visibility levels and basic tags. I7b adds authorized images and safe rendering derivatives for simple scene presentation, manual fog, and tokens. General document uploads, document previews, and external-link ingestion remain deferred. Media validation, access checks, and safe storage are prerequisites for I7b, not optional follow-up work.

## 7.7 Simple scenes and player display

A scene consists of a background image, a manually edited fog mask, and GM-positioned tokens with simple labels/images and visibility. Provide fit/pan/zoom, reveal/conceal, local undo, and drag or tap-to-place/move controls, with keyboard alternatives. Use normalized scene coordinates and revision-checked edits. There are no tactical grids, movement rules, initiative, automatic vision, or combat automation.

**Delivery status (2026-11-06):** Background upload/create/replace, numeric fog/token operations and restricted display are delivered. V1 uploaded token-image selection/rendering is implemented in PR #34 and accepted through hosted/redeploy verification ([evidence](docs/acceptance/scene-image-tokens-2026-11-05.md)). PR #36 implements V2 direct drag/tap token placement/movement with explicit pan/placement modes, cancellable local previews and shared revision/idempotency recovery; numeric controls remain available. Local and hosted mouse/touch browser acceptance passed on `84c23fd`; see [V2 evidence](docs/acceptance/scene-token-gestures-2026-11-06.md). V3 on-image Reveal/Conceal brushing is implemented with bounded local drafts, stroke undo, explicit commit and revision/idempotency recovery; local and hosted mouse/touch acceptance passed on `637a60f` ([V3 evidence](docs/acceptance/scene-fog-brush-2026-11-06.md)). These are existing I7b/G8 requirements; follow the [scene visual-controls completion plan](docs/superpowers/plans/2026-11-05-scene-visual-controls.md). Numeric controls remain accessible precision alternatives and do not satisfy the direct visual controls gate. M3 background acceptance alone does not close these gaps. V4 combined acceptance now passes in PR #38 on deployed `3a35a5f` ([combined evidence](docs/acceptance/scene-visual-controls-2026-11-06.md)); the I7b/G8 visual-controls feature gate is complete. G9 physical-device, provider-login, human and table/remote gates remain open.

**Scene streaming (2026-11-07, implemented):** the paired display no longer polls. It opens `GET /api/displays/:id/scenes/:sceneId/events` (`text/event-stream`, `Cache-Control: no-store`) with the `X-Display-Secret` header through `fetch()` with `credentials: "omit"`. Each `event: scene` message is a complete, credential-scoped projection (`sceneRevision`, `imageRevision`, map URL and the filtered token list); `event: revoked` ends the stream; `: hb` heartbeats never query PostgreSQL. Scene-write transactions issue `pg_notify` with internal IDs and the revision only, so rolled-back writes produce no event; each process holds one dedicated `LISTEN` connection separate from its request pool, subscribes before loading a stream's first snapshot, coalesces reloads, keeps only the latest pending snapshot for a slow client and disconnects a stalled one. Credential revocation and campaign media deletion also notify. On listener loss every local stream closes and new streams answer `503` until listening resumes; displays reconnect with jittered backoff and start from a fresh snapshot, and stop retrying a revoked credential until paired again. The former polled `GET /displays/:id/scenes/:sceneId/projection` route was removed. `scenes.image_revision` (schema baseline) changes only with fog edits or a different background; token-only edits keep it, so they neither download nor render a map. PNG generation happens on the image route, keyed by `(sceneId, imageRevision)`, with one in-flight render per key per process, atomic writes, removal of older image revisions and a credential/image-revision recheck after a render before bytes are sent. Token art URLs are keyed by the token's image file (`?file=`) so they stay stable across moves; display image bytes are `private, no-store`. The display clears its frame immediately on an image-revision change and shows the new map (and its tokens) only once the new bytes arrive; superseded image loads are cancelled. A disconnect or lost authorization blanks the frame. GM gestures already send one command per completed drag or committed brush (at most 512 dabs, enforced server-side), each applied in one transaction with one revision bump; the GM view adopts the command response and reads again only on conflict or uncertain outcomes. See the [scene streaming plan](docs/superpowers/plans/2026-11-07-scene-streaming.md) for remaining hosted and load gates.

A separate tablet or remote player receives only an authorized display projection. Fog-covered pixels must be removed from server-generated display imagery (or safe tiles); sending the original image under a client-only overlay does not protect secrets. Filter hidden tokens and GM metadata before delivery. Pairing credentials are revocable and cannot read campaign administration, GM notes, or originals. Clear privileged browser state when entering display mode, and blank the display when authorization is uncertain or revoked. Previously revealed information cannot be retracted from screenshots. See the GUI plan G8 for acceptance cases.

## 7.8 Image attachments (2026-11-03)

The [system themes and image uploads plan](docs/superpowers/plans/2026-11-03-system-themes-and-images.md) adds images in the requested order: **M1 character portraits**, **M2 item images** (including spells, abilities and adventure equipment), then **M3 adventure backgrounds**. M0 first establishes shared validation, resource-scoped access and durable media hosting. Campaign scene uploads/backgrounds already exist under I7b; M3 completes and verifies that flow rather than introducing a second scene system. Adventure backgrounds mean campaign scene images, not application page wallpaper.

Characters get one optional portrait independent of system-specific rules fields. The M1 implementation uses an independently revisioned attachment, authorized private byte routes and online upload/replace/remove controls; rules revisions and the sheet offline queue remain independent. Images remain outside service-worker persistence and offline sheets show a placeholder. Duplication retains an immutable asset under the new character authority; ownership transfer and campaign adoption/return preserve that link. See the [M1 specification](docs/superpowers/specs/2026-11-04-character-portraits.md) and [acceptance record](docs/acceptance/character-portraits-2026-11-04.md). Items get one optional image on system templates, campaign templates and personal/placed entries. Read/edit rights follow their parent resource; system authorship alone gives no access to character/campaign images. Published and placed copies pin and retain their exact safe art; template edits cannot silently alter existing copies. Returned characters retain disclosed character-scoped copies without access to the former campaign catalog. General document/video uploads remain deferred.

Reuse the existing bounded PNG/JPEG/WebP validation and image processing where useful, keeping policy inside the owning Module. Private durable storage, safe derivatives, quotas/scanning, revision/idempotency recovery, referenced-asset retention and metadata-plus-byte restoration are prerequisites. A volume must be provisioned and tested; a writable container directory alone does not establish durability. Image mutations begin online-only; authorized character thumbnails may follow existing offline cache/purge boundaries while GM originals, campaign catalogs and restricted displays remain online-only. A missing/offline image never blocks sheet play. Preserve server-redacted scene projections and reset fog safely on background replacement.

# 8. Offline (MVP-critical)

Because play happens at physical tables with unreliable venue connectivity, **offline read/cache is MVP-critical**, not optional:

- The phone sheet and last-known values must render without connectivity.
- Reads are cached at request time; the sheet renders from cache when offline.
- Writes queue locally and sync when reconnected, using an **idempotency key** (already required) to avoid double-spend on retry.
- Conflicts surface through the existing **revision + 409** mechanism rather than silently overwriting.

# 9. Authorization model

Use role-based permissions for coarse capabilities and resource-level policy checks for ownership, membership, visibility, and campaign settings. Every HTTP operation resolves the resource first, then evaluates the actor against that resource. Never accept a client-provided role as authority.

| **Capability**                         | **Creator** | **GM**        | **Player**    | **Independent** |
|----------------------------------------|-------------|---------------|---------------|-----------------|
| Edit own system draft                  | Yes         | No            | No            | No              |
| Publish own system                     | Yes         | No            | No            | No              |
| Create campaign from accessible system | Yes         | Yes           | Yes\*         | Yes\*           |
| Manage campaign members/settings       | If GM       | Yes           | No            | N/A             |
| Read GM-only content                   | No          | Yes           | No            | N/A             |
| Edit owned character                   | If owner    | By policy     | Yes           | Yes             |
| Read another character                 | No          | Yes/by policy | By visibility | No              |
| Reveal or reclassify content           | If GM       | Yes           | No            | N/A             |

*\* A player can create a campaign only by becoming its GM; the action is not available inside the Player workspace.*

## 9.1 Required authorization tests

- Direct-object-reference tests for every campaign, character, content, and invitation endpoint.
- Matrix tests for role, membership status, resource visibility, campaign policy, and ownership combinations.
- Revocation tests proving removed members lose HTTP and cached-content access promptly.
- Preview-as-player uses the same policy engine as real requests and never a UI-only approximation.

# 10. UX and responsive design

## 10.1 Breakpoints and layout behavior

| **Viewport**        | **Layout behavior**                                                | **Critical design checks**                                     |
|---------------------|--------------------------------------------------------------------|----------------------------------------------------------------|
| Phone: 320-599 px   | Single column; bottom navigation; full-width sheets               | No horizontal scroll; 44x44 px targets; virtualized long lists |
| Tablet: 600-1023 px | One or two columns; split content where useful                     | Portrait and landscape; keyboard; touch and pointer            |
| Desktop: >=1024 px  | Persistent navigation; multi-panel creator; content organization   | Resizable panels; keyboard workflows; readable max widths      |

## 10.2 Player mobile sheet

The app's `/` landing view is Systems, and its primary navigation label is
“Systems”. The shared header uses a single compact row: primary links are inline
on desktop and available through a keyboard-accessible navigation disclosure
below 1024px, with its trigger immediately after the Sweetroll logo on the left.
Phone bottom navigation remains available. Creator and campaign
tabs use one horizontally scrollable row with 44px targets instead of wrapping
into several rows. Navigation and viewport changes preserve the active view's
state; Escape closes the disclosure and restores focus to its trigger.

- Character identity, save/offline status and resource sections scroll with the rest of the sheet; the character header must not stick over fields or actions on small screens.
- Platform-owned bottom navigation for Characters, Activity, and Account; Campaigns is added in I6. System creators cannot add navigation destinations or divide the linear sheet into tabs.
- Prominent action buttons and resource controls; numeric entry supports direct input and step controls.
- Optimistic updates with visible pending/error state and automatic retry only when idempotent (offline-safe).
- A roll result opens as a compact sheet showing dice, modifiers, total, and audience.
- Roll expressions and field bindings use character attribute labels when available, retaining the field identifier for unresolved references. The creator presents the `talent` template kind as “ability” while preserving its stored kind value.

## 10.3 GM mobile session view

- Pinned handouts and notes, recent activity, member status, quick character access, and the **GM session board**.
- One-tap reveal/hide with audience confirmation; items remain visibly marked after sharing.
- Works simultaneously across multiple GM devices (Section 4.2).
- Conflicts between co-GMs and the GM's own devices resolve via revision/`409` and an immediate refresh prompt.

## 10.4 Accessibility and localization

Target WCAG 2.2 AA for the authored application. The builder must flag missing labels, low contrast, ambiguous names, and controls available only by drag. Store display strings separately from stable IDs and design all UI for localization, plural rules, time zones, and longer translated labels. Bidirectional layout is a post-MVP validation item unless required at launch.

## 10.5 Visual design, components, and flexible themes

Use the [Tablefolk GUI mockup](https://tablefolk-ttrpg-mockups.humdrumrat.chatgpt.site) as the visual reference for hierarchy, restrained green accents, readable typography, rounded panels, and touch-friendly controls. Keep Sweetroll branding and the navigation/linear sheet constraints in this specification. Capture selected reference views in the repository during G0; prototype data and simulated services are not production implementations.

The current Sweetroll visual refresh adopts the mockup's sage page, white cards, deep green text and actions, softer corners, and comfortable spacing across the shared shell, creator, and character views. Light, dark, and Follow device remain display preferences for the same app-wide design. **System-selectable themes are delivered in two stages**: T1 platform color presets and T2 Default/Classic component styles are implemented in PR #30, with CI #205 and [hosted acceptance](docs/acceptance/system-themes-2026-11-04.md). The existing app-wide refresh did not implement a system theme picker. Follow the [system themes and image uploads plan](docs/superpowers/plans/2026-11-03-system-themes-and-images.md), rather than treating those stages as completed I4a work.

Adopt the design incrementally in the existing React application. Keep CSS modules, accessible primitives, generated API contracts, and the character projection/session model. AppShell owns navigation and one flexible content region; individual views own their internal columns. Do not replace the backend or create a second character renderer.

Use semantic CSS tokens for color roles, typography, spacing, borders, radii, shadows, and focus. Shared controls and feature components consume those tokens. Ship light/dark presets and Follow device, with portal inheritance and accessible states. I4a stores device preferences; I5 adds an account default with per-device override. Restricted display preferences remain device-local. Prove extensibility through a third internal preset; arbitrary CSS, a theme editor, and theme marketplace remain excluded.

Implement loading, empty, validation, saving, offline, conflict, and permission states as part of every view. Theme changes must preserve editor/character state and must not recolor uploaded art or change fog/token visibility. Preserve 44px touch targets, visible keyboard focus, and readable text in every theme.

System presentation is distinct from the user's light/dark mode. T1 retains device > account > OS mode resolution, scopes a preset to system-bound content and its portals, and preserves the platform shell. Save presentation through draft revision checks and immutable publication; existing characters/campaigns keep their pinned selection. T2 extends the same shared controls with bounded platform-authored component styles. Neither stage permits arbitrary CSS/scripts or changes rules, permissions, navigation or uploaded artwork. Theme changes preserve unsaved and offline state; offline sheets use their authorized cached selection.

The execution checklist is [GUI integration implementation plan](docs/superpowers/plans/2026-09-08-gui-integration.md). Its G0-G9 tasks supplement the delivery increments below; they do not retroactively change historical acceptance evidence.

# 11. Technical architecture

> **Architecture.** Begin with one modular TypeScript application, one PostgreSQL database, and one deployable artifact. I1 has `http` and `db:init` process modes. Add a worker mode only when a concrete asynchronous consumer exists. Preserve deep Module Interfaces so extraction remains possible if measured load or team scale later justifies it.

| **Area**       | **Recommended responsibility**                                                       | **MVP technology direction**                             |
|----------------|--------------------------------------------------------------------------------------|----------------------------------------------------------|
| Web client     | Role-oriented responsive PWA, local draft/offline buffer, accessibility, polling     | React + TypeScript; accessible UI primitives             |
| HTTP Adapter   | Wire decoding, authentication context, HTTP status mapping, OpenAPI description       | Fastify on Node.js LTS; stateless replicas               |
| Modules        | Authorization, lifecycle rules, policy, idempotency, transactions, returned outcomes | TypeScript; workflow-level Interfaces                    |
| Package logic  | Decode, validate, compile, canonicalize, compare, and evaluate packages               | Private in-process implementation with strict budgets    |
| Database       | Identity, relational selectors, JSONB package/state documents, audit records          | PostgreSQL with constraints and explicit current-schema initialization  |
| External tools | OIDC and, when introduced, transactional email                                        | Narrow ports with production and deterministic adapters  |

The Player and GM applications are role-oriented surfaces within the responsive web client, not separate native applications. The PWA must remain directly usable in supported mobile browsers and installable to a device home screen. A later release may package the web client for app stores, but the MVP does not select a native wrapper, depend on native-only platform interfaces, or include app-store submission work.

Redis, object storage for package exports, a message broker, microservices, and a separately deployed rules runtime are excluded from I1. Package export is a bounded synchronous response. Character/item image persistence is delivered in M0–M2 (Section 7.8). Reuse the existing private media directory on a provisioned persistent volume first; a separate object-store adapter requires a concrete need. Verify metadata and byte restoration together.

## 11.1 Deep-module rules

- A Module exposes one Interface that callers and tests both use.
- Interfaces express complete workflows, not parser stages, tables, or transport details.
- Dependencies are accepted during process composition rather than created inside an implementation.
- In-process package and expression logic remains private; do not expose `Parser`, `Validator`, `Rules`, or repository Interfaces.
- PostgreSQL behavior is tested with real PostgreSQL. Do not add a generic persistence seam for hypothetical database portability.
- A port is introduced only when at least two adapters are justified. OIDC has production and deterministic test adapters and therefore earns a seam.
- Cross-Module callers use Interfaces rather than reading another Module's tables.
- Add an outbox only with the first concrete asynchronous consumer. Do not establish an event bus or persist unused events in I1.

## 11.2 I1 Modules and seams

| **Module or Adapter** | **Interface and ownership** |
|-----------------------|-----------------------------|
| Identity Module | Resolves external identities into local users and sessions. Owns users, external identities, sessions, and account lifecycle. Its implementation uses the OIDC port. |
| SystemAuthoring Module | Creates, opens, lists, saves, previews, publishes, exports, changes lifecycle, and deletes. Owns systems, drafts, versions, preview snapshots, authoring idempotency receipts, and system audit records. |
| SystemRuntime Module | Resolves an immutable version, state, and intent into a complete validated next state and render projection. Owns no mutable data and produces no persistence side effects. |
| HTTP Adapter | Maps versioned REST routes to one Module call each. Owns wire formats, request-size checks, authentication context creation, and stable HTTP error mapping, but no business ordering. |
| OIDC Adapter | Satisfies the Identity Module's external port. Provider tokens and claims never enter Systems Interfaces. |

`SystemAuthoring` and `SystemRuntime` share private package and expression functions and types in one code package. `SystemRuntime` receives a private published-package loader during process composition; production loads immutable versions from PostgreSQL and tests supply published fixtures directly. This internal seam is not exposed to callers.

Later increments add deep `Characters` and `Campaigns` Modules when their workflows exist. Content visibility belongs inside Campaigns until its behavior and callers justify a separate Module. Activity records are written by the Module performing the behavior; a separate Activity Module is introduced only if feed construction develops independent complexity and more than one caller.

## 11.3 Module Interfaces

The representative TypeScript below defines Interface shape rather than transport types:

```typescript
type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: AppError };

type RequestContext = {
  actorId: UserId;
  requestId: string;
};

interface SystemAuthoring {
  createDraft(ctx: RequestContext, input: CreateDraft): Promise<Result<AuthoringWorkspace>>;
  open(ctx: RequestContext, systemId: SystemId): Promise<Result<AuthoringWorkspace>>;
  list(ctx: RequestContext, input: PageRequest): Promise<Result<Page<SystemSummary>>>;
  saveDraft(ctx: RequestContext, input: SaveDraft): Promise<Result<AuthoringWorkspace>>;
  previewDraft(ctx: RequestContext, input: PreviewDraft): Promise<Result<PreviewSnapshot>>;
  publish(ctx: RequestContext, input: PublishDraft): Promise<Result<PublishedVersion>>;
  exportVersion(ctx: RequestContext, versionId: VersionId): Promise<Result<ExportedPackage>>;
  changeLifecycle(ctx: RequestContext, input: LifecycleChange): Promise<Result<LifecycleResult>>;
  deleteSystem(ctx: RequestContext, systemId: SystemId): Promise<Result<{ systemId: SystemId }>>;
}

interface SystemRuntime {
  resolve(input: RuntimeRequest): Promise<Result<RuntimeResolution>>;
}
```

`CreateDraft` uses a source union for blank creation, cloning a version, or importing bounded bytes. `AuthoringWorkspace` returns metadata, current draft and revision, version summaries, and one package assessment. Saving a draft therefore returns validation and compatibility information without requiring callers to coordinate separate operations. A semantically invalid but structurally safe draft may be saved; preview and publication require a valid assessment.

`RuntimeRequest` contains an immutable `versionId`, optional current state, and exactly one intent: `observe`, `initialize`, `set`, `bump`, or `action`. `RuntimeResolution` contains the complete validated next state, derived values, validation messages, normalized roll details when relevant, changed definition IDs, and a versioned render projection. Callers never receive AST nodes, apply runtime-generated patches, or order derived calculations themselves.

## 11.4 Interface invariants and errors

- Authentication occurs before a Module call; authorization occurs inside the Module that owns the resource.
- Every persistent mutation with retry risk requires an idempotency key. Reuse with identical input returns the stored result; reuse with different input returns `idempotency_mismatch`.
- Existing mutable records require an expected revision. A mismatch returns `conflict` with the latest revision and a non-sensitive summary.
- Inaccessible resources collapse to `not_found` unless revealing existence is intentional.
- Invalid packages return ordered diagnostics with stable codes and document paths.
- Budget exhaustion returns `budget_exceeded` without partial evaluation output or persistence.
- Published versions, preview snapshots, checksums, and runtime semantics are immutable.
- Publication performs a complete assessment of the exact source revision; a prior assessment is never proof of publishability.
- `SystemRuntime.resolve` is side-effect free from its caller's perspective.
- Programmer errors and infrastructure failures are logged with the request ID and become sanitized `internal` or `temporarily_unavailable` HTTP results.
- Ordinary operations target p95 below 300 ms. Bounded validation and runtime resolution target p95 below 500 ms.

## 11.5 Request and transaction paths

**Draft save:** authorize actor; reject a stale revision; decode the bounded document; assess structure, references, expressions, and compatibility; start a transaction; lock and recheck the revision; replace the draft; increment its revision; append an audit record; commit; return the complete authoring workspace.

**Publication:** authorize actor; check the idempotency receipt; read the exact draft revision; compile, assess, canonicalize, and checksum outside a transaction; start a transaction; lock the draft; recheck its revision and source checksum; enforce semantic-version and lifecycle rules; insert the immutable version, audit record, and idempotency result; commit. Database permissions and an immutability trigger reject updates to published package bytes.

**Runtime resolution:** load an immutable package; decode state and intent; enforce field, action, and resource constraints; resolve defaults and derived values; evaluate validations and optional dice; build the complete next state and render projection; return without persistence.

Authoritative dice derive from a server-secret HMAC of a server-generated command execution ID. The owning Module allocates and records that ID before runtime resolution; clients cannot supply it. Retries reuse the recorded ID and reproduce the result. Preview uses an explicit deterministic seed and is clearly non-authoritative.

**Future character command:** the Characters Module reads a character revision, calls `SystemRuntime.resolve`, then locks and rechecks the character revision in a short transaction before storing state, roll, activity, and idempotency result. Publishing a system version can never start this flow or mutate a character or campaign.

**Real-time read:** use poll-on-view plus server revision. Clients refresh permitted data when a view becomes active. Add authorized asynchronous notifications only when user research or measured polling load justifies them; secret payloads are never sent to a mixed-audience channel. The owner-approved exception (2026-11-07) is the paired scene display, which receives complete credential-scoped snapshots over server-sent events driven by PostgreSQL `LISTEN`/`NOTIFY` change signals (Section 7.7); notifications carry only internal IDs and revisions.

## 11.6 I1 source layout

```text
src/
  identity/                  # Identity Module
  systems/
    authoring.ts             # SystemAuthoring Interface
    runtime.ts               # SystemRuntime Interface
    implementation/
      package/               # decode, assess, compile, canonicalize
      rules/                 # parse, type-check, evaluate, dice
      persistence/           # SQL and transactions
  transport/http/            # HTTP Adapter and OpenAPI mapping
  platform/                  # config, PostgreSQL pool, logging, metrics
  bootstrap/                 # HTTP and database initialization
```

Use Node.js LTS, TypeScript, Fastify, a thin PostgreSQL driver, explicit current-schema SQL, and runtime schema decoding. Generate transport types for the web client, but keep published-package semantics owned by the systems implementation. Internal directories organize implementation knowledge; they do not imply additional public seams.

# 12. Data design

| **Aggregate/table** | **Key relationships**                        | **Important fields**                                                |
|---------------------|----------------------------------------------|---------------------------------------------------------------------|
| users               | external_identities, owned resources         | id, display_name, locale, status, created_at                        |
| systems             | creator; drafts; versions; collaborators     | id, owner_id, name, access, lifecycle, kind, base_system_id (6.8)   |
| system_drafts       | one current draft per system                 | system_id, revision, document_json, source_checksum, updated_by     |
| system_versions     | immutable child of system                    | version_id, semantic_version, checksum, package_json, release_notes |
| preview_snapshots   | immutable expiring draft preview             | snapshot_id, system_id, source_revision, package_json, expires_at   |
| idempotency_receipts| user and command scope                       | actor_id, command_kind, key, input_hash, result_json, expires_at    |
| system_audit_records| system authoring changes                      | system_id, actor_id, kind, summary, occurred_at, request_id         |
| campaigns           | pinned version; members; characters; content | id, system_version_id, owner_id, settings_json, status              |
| campaign_members    | user in campaign                             | role, membership_status, joined_at, permissions_override            |
| characters          | owner(s); optional campaign; pinned version  | id, revision, state_json, visibility, archived_at                   |
| content_items       | campaign; creator; optional file             | kind, title, body, audience, revision                               |
| content_grants      | content to selected member                   | content_id, member_id                                               |
| file_objects        | content/avatar/system asset                  | storage_key, media_type, size, scan_status, checksum                |
| activity_events     | actor and campaign/resource                  | type, audience, payload, occurred_at, request_id                    |
| outbox_events       | Deferred with invitation email to I6 follow-up; absent from token-only backend slice | topic, payload, attempt_count, available_at, published_at |
| invitations         | campaign and inviter                         | token_hash, intended_role, expires_at, accepted_by                  |

## 12.1 JSON document placement

Use relational columns for identifiers, ownership, membership, lifecycle, authorization selectors, versions, timestamps, and frequently queried metadata. Use JSONB only for the system package and character state because their shapes are creator-defined. Validate JSONB against the pinned package at every write. Keep visibility and ownership outside JSON so authorization queries remain explicit and indexable.

## 12.2 Concurrency and revisions

Mutable aggregates carry an integer revision. Update requests include the expected revision; mismatch returns 409 Conflict with the latest revision and a machine-readable conflict summary. Resource adjustments and rule actions are server-side atomic commands, not read-modify-write patches from the client. Draft builder operations may use an operation log for undo, but periodic compact snapshots remain canonical. This model also governs the **GM's multiple simultaneous devices** (Section 4.2).

## 12.3 Retention and recovery

- Daily encrypted backups with point-in-time database recovery; restoration drills at least quarterly.
- Soft deletion for systems, campaigns, characters, and content during a configurable recovery window.
- Immutable published packages retained while referenced by active or retained campaign data.
- Audit/activity payloads minimize sensitive content and have an explicit retention policy.

## 12.4 Development database policy (2026-10-27)

The app is unreleased, runs only in test environments and has no users. Initialize
an empty PostgreSQL database from `database/schema.sql` with `npm run db:init`.
Initialization is transactional and serialized; repeated startup preserves data.
There is no migration history/checksum ledger, incremental migration runner,
backfill, repair, old-client conversion or automatic reset. Edit the current schema
and recreate disposable test databases when it changes. Seed missing reference
templates without rewriting existing immutable versions. Character/campaign
rules-version upgrades are a separate, supported feature (Section 6.7) and need no
database migration. See [database policy](database/README.md).

Application-version migrations and compatibility with older app builds become
requirements only after the first application release tag. Before then, update the
current database, package/API and browser-storage contracts directly and rebuild
disposable fixtures as needed. No historical-build migration, backfill, legacy
decoder, previous-client bundle or mixed-version service-worker matrix is required
for an increment's acceptance or merge. The release-phase policy in Section 17.0
supersedes older implementation checklists that prescribe such work.

# 13. HTTP interface and real-time contract

Expose a versioned REST HTTP interface described by OpenAPI. Use resource-oriented reads and command endpoints for behavior that must enforce rules atomically. Each endpoint maps to one deep Module call rather than reproducing authorization, validation, or transaction ordering in the HTTP Adapter. Cursor pagination is required for potentially unbounded lists. Every error has a stable code, human message, request ID, and optional field paths.

| **Area**   | **Representative endpoints**                                                                                                            |
|------------|-----------------------------------------------------------------------------------------------------------------------------------------|
| Systems    | POST/GET /systems; GET /systems/{id}; GET /systems/{id}/versions; PUT /systems/{id}/draft; POST /systems/{id}/preview; POST /systems/{id}/publish; PATCH /systems/{id}; DELETE /systems/{id} |
| Versions   | GET/PATCH /system-versions/{id}; GET /system-versions/{id}/export                                                                        |
| Templates  | GET /templates; create a system with a version source to clone a template                                                               |
| Campaigns  | POST /campaigns; GET/PATCH /campaigns/{id}; POST /campaigns/{id}/invitations; DELETE /campaigns/{id}/members/{memberId}                 |
| Characters | POST /characters; GET /characters/creation-options; GET /characters/creation-versions; POST /campaigns/{id}/characters; GET/PATCH /characters/{id}; POST /characters/{id}/actions/{actionId} |
| Content    | POST /campaigns/{id}/content; PATCH /content/{id}; POST /content/{id}/grants                                                            |
| Session    | GET /campaigns/{id}/session (GM session board); POST /characters/{id}/resources/{resourceId}/bump                                        |
| Activity   | GET /campaigns/{id}/activity; GET /characters/{id}/activity                                                                             |
| Exports    | POST /characters/{id}/exports; POST /campaigns/{id}/exports; GET /exports/{id}                                                          |

`GET /characters/creation-versions` enumerates only systems owned by the actor plus explicitly discoverable (`public`) systems (OD-01 option A, unlisted/link-only). Character creation and metadata lookup from a KNOWN version ID keep their existing authorization unchanged: permission to use a version (owner or `public`/`link` access, published version, active system) never implies permission to discover it, and link-access systems remain usable when the exact version ID is known. The `/characters/new` page opened without a version shows a "Choose a system version" picker from this endpoint; the manual system-version-ID box remains as fallback, and picking a version loads its creation metadata through the unchanged lookup path.

The picker retains the inline `CharactersApi.listCreationVersions()` query in `CreateCharacter.tsx` and exact-version links. Reconciled 2026-09-12 from the GUI plan: G1 records account/generation-scoped cache handling and cleanup; G4 records OD-01 option A and generated picker types (`8d5f22a`, `8785c3b`); G6 Task 1 records bounded pagination/filtering, generated contracts and ordering/revocation tests (`557de16`). These are existing implementation records, not work to restart or fresh verification in this documentation handoff. Production-authentication and G9 gates remain open.

System sharing (owner-approved 2026-09-14): a system owner may set system access to `private`, `link`, or `public` through `PATCH /systems/{id}` (`SystemAuthoring.changeSharing`, owner-only, audited as `system_sharing_changed`), controlled in the system library row with confirmation on widening. Sharing is per-system and covers all its published versions. `link` systems stay unlisted but usable for standalone character creation from the exact version ID; `public` systems are additionally enumerated by `GET /characters/creation-versions`. Revoking sharing to `private` blocks only new creation/lookup; already-created characters keep their immutable pinned version and keep working. No campaign membership is required to create a character from a shared system.

## 13.1 Idempotency

Create, roll, action, invitation, and export commands accept an idempotency key scoped to user and endpoint. The server stores the completed result for a bounded interval. This prevents duplicated damage, resource spending, rolls, and invitations after mobile or offline retries.

## 13.2 Approved pre-upgrade remediation contracts (2026-09-12)

The owner approved the recommended [pre-upgrade remediation](docs/superpowers/plans/2026-09-12-remediation-index.md), including the two narrow discovery contracts below. Approval is not implementation or acceptance evidence. Campaigns owns authorization and pagination; existing Characters sheet authorization, placement commands, content recovery, revision/idempotency rules and standalone offline behavior remain intact. Production authentication remains owner-deferred. Campaign upgrades and scenes/display are excluded from this remediation.

- **Claim discovery:** `GET /campaigns/{id}/claimable-characters` maps to `Campaigns.listClaimableCharacters(ctx, { campaignId, limit?, cursor? })`, operation ID `get_campaigns_id_claimable_characters`. It returns `{ characters, nextCursor }` plus HTTP `requestId`; each row contains exactly `characterId`, `name`, `revision`, and `lifecycle: 'active' | 'archived'`. Require active membership and an outstanding designation for the current actor, excluding sheets that actor already controls. Match campaign/character scope on every predicate, filter before bounded pagination, use stable timestamp/ID ordering, bind cursors to actor/campaign/query family, and reauthorize each page and claim. No controller IDs, other designees, sheet state/projection, inventory, rolls, audit, placement metadata or system/version details are disclosed. Discovery grants no sheet read/export/activity/mutation access; the existing roster endpoint and GM/controller sheet permissions are unchanged. Claim consumes only the caller's designation and preserves other designations/controllers. Archived rows remain explanatory with no UI Claim action; the existing command's missing character-lifecycle check is a known discrepancy, not silently changed here.
- **Deleted-summary recovery:** `GET /campaigns/{id}/content` gains optional `status=active|deleted`, normalized to `active`; `ContentSummary` gains required `status`, while the result envelope and operation ID remain unchanged. Active lists retain existing readership. Deleted lists require active membership and existing management authority: creator OR a GM who may read the note, not any former recipient. Another creator's owner-only note remains inaccessible to GMs. Return existing summaries with current `revision`/`accessRevision` and status, never deleted bodies or grant lists. Filter before bounded pagination and bind normalized status, actor, campaign and query family into cursors. Ordinary `GET /content/{id}` remains active-only and returns generic 404 for deleted content. The GM Active/Hidden view supports paginated recovery after reload/new browser sessions using the listed revision and existing `POST /content/{id}/recover`; Hide means soft-delete, not GM-only audience. No deleted preview, permanent delete, retention change or player-note management UI is added. Preserve player-creator server authority and retained-editor receipt recovery. Archived campaigns still deny recovery mutations even if summaries are readable.
- **Privacy and lifecycle:** inaccessible resources retain generic 404 collapse and protected responses remain `Cache-Control: no-store`; no campaign payload service-worker persistence is added. Scope browser queries and in-flight results by actor/generation, distinguish claim and active/deleted list families, and purge them on sign-out, account switch, leave, revocation or visibility loss. Cancel/reject late responses so private data cannot repopulate a later lifetime. Revalidate authorization on reconnect; do not claim offline erasure of information already received. Successful mutations refresh relevant summaries/roster/campaign revisions before further commands; a definite 409 requires fresh reads and explicit fresh-key retry, never guessed revisions or automatic replay of a known success.

Detailed contracts and required regression matrices are in the [I6 backend spec](docs/superpowers/specs/2026-09-09-i6-campaign-backend-design.md) Sections 3.5 and 4.1.1 and the claim/recovery plans. Their implementation, ordinary-player journey, durable recovery, cache/privacy and release gates remain unverified by this docs-only change.

## 13.3 Public API v1 (2026-11-07)

The separate `/api/v1` contract covers everything the signed-in web app can do
outside browser sessions and token management. Users can create, clone or import
a draft, validate and preview it, attach template artwork, publish, deprecate,
export and share versions, and archive or delete systems. Characters can be
created, duplicated, edited, equipped, renamed, archived, exported and
transferred; they roll and push with the same server-side dice and audiences as
the browser. Campaign scripts manage campaigns, members, invitations, attached
characters, content, item templates and proposals, media, scenes with fog and
tokens, and display pairing and revocation.
Both local and combined HTTP serving expose the same prefix and public OpenAPI
document.
Browser routes keep cookie authentication. The API uses scoped personal
access tokens and checks current resource permissions for every request,
including receipt replay. Each operation calls the same module command as the
browser route, so attached characters follow the browser Characters policy
(controllers, GM visibility, roll audiences) and campaign data follows the
Campaigns policy. Inaccessible IDs read as `404`; a member whose role does not
permit a command receives `403 forbidden`, distinct from `403 insufficient_scope`.
Character and campaign pins are immutable.

Identity stores token digests and handles issuance, expiration and revocation
through the signed-in Account surface. Hosted issuance depends on a real
provider. Local development can opt in with `SWEETROLL_LOCAL_API_TOKENS=1`.
Authenticated request quotas use PostgreSQL counters shared across replicas.
The [API plan](docs/superpowers/plans/2026-11-07-public-api-v1.md) defines the
scope and hosted acceptance. The [quickstart](docs/api/v1.md) documents the
wire contract and retry windows.

**Completion implemented (owner-approved 2026-11-07):** Part B of the API plan
is implemented for local testing. Scopes are `systems:*`, `characters:*` and
`campaigns:read`/`campaigns:write`; commands that change both a character and
its campaign (campaign character creation, assign, claim and adopt) need both
write scopes. A write scope includes read for the same area (owner decision
2026-11-07); read never implies write. Tokens hold up to six scopes, and earlier four-scope tokens keep
their scopes. Uploads share an `upload` quota of 30 per minute. Binary art and
media reads accept Bearer tokens and are `private, no-store`. Each successful
v1 command writes an audit log line with operation, account and request ID,
never request bodies. Browser session routes, token management,
display-credential routes (including the scene event stream), webhooks and SDKs
stay outside v1. Responses are never wider than the browser shows the same
caller. Hosted acceptance still depends on real provider sign-in.

# 14. Security, privacy, and abuse prevention

| **Risk**                     | **Required control**                                                                                |
|------------------------------|-----------------------------------------------------------------------------------------------------|
| Cross-campaign data exposure | Policy logic in the owning Module; deny by default; scoped queries; object-level authorization tests |
| Malicious system expression  | No executable code; typed AST; depth/time/node budgets; restricted context; fuzz testing            |
| Malicious upload             | Allow-list types; magic-byte validation; size quotas; malware scan; private storage; safe previews  |
| Invitation theft             | Random high-entropy token; store hash; expiry; single-use option; campaign confirmation before join |
| Credential/session theft     | OIDC/OAuth with PKCE; secure HttpOnly same-site cookies; rotation; CSRF protection                  |
| Enumeration and scraping     | Opaque IDs; rate limits; generic unauthorized/not-found responses where appropriate                 |
| Privilege abuse              | Audited admin tooling; least privilege; support access requires reason and time-bounded grant       |
| Sensitive logs               | Structured allow-list logging; redact tokens, content bodies, character state, and signed URLs      |

Browser sessions use one fixed expiry in PostgreSQL and the session cookie.
Re-authentication atomically replaces the previous session, and only active
users resolve to a browser identity. Cookie-authenticated writes require an
exact allowed origin or browser same-origin Fetch Metadata when Origin is
absent. Bearer-token operations authenticate independently.

API and web responses deny framing and referrer disclosure. The content
security policy limits resources to the app origin, allows local image
previews and authorizes the pre-paint theme script by hash. HTTPS deployments
send HSTS. Metrics require a separate scraper token and are off by default.

The browser and public API share account request and image-upload budgets
in PostgreSQL. The general budget allows up to 120 writes or public API
requests, or 600 browser reads per minute. Browser reads spend one fifth of
the budget used by a write. Display redemption has per-IP and process limits. Each
campaign can have five live pairing codes, and each display credential can
open two scene streams per process.

## 14.1 Privacy defaults

- Systems are private until explicitly shared; campaigns are never discoverable by default.
- Campaign content uploads default to GM only; player notes default to owner only.
- Do not use private campaign or character content for model training or recommendation features without explicit consent and a separate design review.
- Provide account, character, system, and campaign export in documented formats.
- Publish a clear ownership model for system definitions, user uploads, and copies derived from shared systems.

# 15. Non-functional requirements

| **Quality**    | **MVP requirement**                                                                                                                                |
|----------------|----------------------------------------------------------------------------------------------------------------------------------------------------|
| Availability   | 99.9% monthly target for authenticated HTTP and character reads/writes                                                                             |
| Latency        | p95 < 300 ms for ordinary HTTP reads/writes; p95 < 500 ms for bounded rule actions, excluding client network                                      |
| Scale baseline | Design/test for 10k concurrent connected users, 1k active campaigns, and bursty session traffic; validate with load tests before committing infrastructure |
| Consistency    | Strong consistency for character changes, membership, visibility, actions, and published versions                                                   |
| Durability     | Acknowledged writes survive a single application instance failure; object availability follows scan workflow                                        |
| Accessibility  | WCAG 2.2 AA for critical flows and provided platform UI primitives                                                                                  |
| Compatibility  | Current and previous major versions of Chrome, Safari, Firefox, and Edge; responsive iOS/Android web                                                |
| Observability  | Request traces, structured logs, domain metrics, audit records, and correlation IDs                                                                 |
| Recovery       | Initial RPO <= 15 minutes and RTO <= 4 hours; refine from business impact analysis                                                                  |
| Offline        | Phone sheets render from cache without connectivity; queued writes sync idempotently on reconnect                                                    |
| Package limits | Configurable caps on fields, expression nodes/depth, sheet elements, package bytes, and collection sizes                                            |

# 16. Testing and quality strategy

## 16.1 Automated tests

- Treat each Module Interface as its primary test surface. Tests assert returned outcomes and persisted effects rather than private parser stages or repository state.
- Run `SystemAuthoring` workflow, policy-matrix, direct-object-reference, revision-race, idempotency, rollback, canonical-export, and immutable-publication tests against real PostgreSQL.
- Run `SystemRuntime` initialization, edit, bump, action, projection, deterministic-dice, invalid-state, and budget tests with published reference packages supplied through its private loader seam.
- Drive property and fuzz inputs through draft save/import or runtime resolution. Keep focused parser tests only where they materially improve failure localization.
- Run one contract suite against the production OIDC Adapter and deterministic mock Adapter.
- Keep HTTP Adapter tests thin: authentication, wire decoding, status mapping, required headers, request-size limits, request IDs, and OpenAPI conformance.
- Add outbox atomicity and delivery tests when the first asynchronous consumer introduces that implementation.
- Offline-cache tests: sheet renders without network; queued writes sync without double-spend.
- Accessibility tests in UI stories and end-to-end critical journeys, supplemented by manual screen-reader testing.
- Responsive visual regression at 360 and 1280 px for platform UI primitives and reference systems.
- Browser journeys run in isolated, ephemeral databases and may be sharded across CI jobs; the visual suite remains isolated from journeys. Ordinary UI waits fail within 15 seconds, complete journeys within two minutes, and the browser job within ten minutes so broken selectors cannot serialize into long CI stalls.
- Load and soak tests shaped like session bursts: many resource updates, rolls, and views in a short window.
- Replay scripted, multi-account API sessions with the [scenario runner](tests/integration/scenarios/README.md). Each run gets a fresh PostgreSQL schema, scoped credentials, and a request timeline for diagnosing failures.

## 16.2 Reference systems

Maintain three internal reference systems as acceptance fixtures: a minimal rules-light system, a class-and-level fantasy system with derived statistics and inventory, and a dice-pool system with resources. They must exercise every supported field, sheet element, formula feature, action, visibility path and mobile breakpoint. Where an open license permits, the shipped templates correspond to these fixtures.

> **Current scope (2026-11-07):** non-breaking character/campaign system-version upgrades and revert to the previous version, each with a dry-run preview, are in scope (Section 6.7). Breaking upgrades and field mapping remain excluded. Application/database migration is separate (Sections 12.4 and 17.0).

# 17. Delivery plan

**First-release-tag boundary (owner decision, 2026-10-27):** The application and
database remain under development until the first application release Git tag
(`v*.*.*`). Before that tag, use the current schema and disposable test data; do
not add or retain app/database upgrade tasks or old-build conversion tests. The
[post-tag migration strategy in PR #24](https://github.com/Kajonn/sweetroll/blob/refactor/pre-release-database-baseline/docs/superpowers/plans/2026-10-27-application-migration-policy.md)
is planned now and implemented only for changes after that tag. Fresh initialization,
current-format validation, authorization and exact-request recovery remain required.


Delivery retains I1-I7 and adds I4a for GUI integration and I7b for simple scenes and restricted display. Each increment produces a complete, deployable capability rather than infrastructure that cannot be exercised. Backend increments are functional through the documented HTTP interface; frontend increments provide the normal user interface over capabilities completed by earlier increments.

Foundational work belongs to the first increment that needs it. For example, repository setup, CI/CD, identity seams, database conventions, and baseline observability are tasks in I1 rather than a separate non-functional milestone.

## 17.0 Release status and application-version policy

**Owner decision (2026-10-27):** Sweetroll has no released app version or users;
deployments are test environments until the first application release Git tag
(`v*.*.*`, used by the release workflow). App/database migration and support for
multiple app versions are required only for changes after that tag. This policy takes
precedence over historical plans, specifications and unchecked compatibility gates.

**Owner clarification (2026-11-05):** Until the first application release tag,
all app/database state may be cleared completely. The owner explicitly permits
deleting and recreating the development app and its database when necessary;
retaining old test state is optional. Do not ask again solely because a
pre-release reset would discard test state. Check release-tag status first;
after the first release tag, follow the released-data migration/recovery policy.

| Phase | Required behavior |
|---|---|
| Before the first release tag (current) | Implement and verify the current app and schema. Edit the schema baseline and recreate test databases/profiles when needed. Do not add or maintain upgrade chains, one-off data repairs, old-build payload/cache adapters or mixed old/new app-client support. No implementation-plan tasks or transition tests may require this work before the tag. |
| First application release tag | Freeze and record the initial supported database, API/package and browser-storage baseline. No conversion from never-released development builds is required. |
| After the first release tag | Add migrations and compatibility handling when a subsequent change affects data or clients from an actually supported released version. Define the supported versions and retirement policy, and test those real transitions. |

Current-version schema validation, unsupported-input rejection, authorization,
transactional integrity, exact-request retry/reload recovery and offline behavior
remain required. Supported browser vendors/versions are a separate platform
requirement. Creator-published rules snapshots and pinning remain supported.
System (rules) version upgrades of characters and campaigns are a product feature,
not application migration, and are allowed before the tag (Section 6.7).
The [post-tag migration plan](docs/superpowers/plans/2026-10-27-application-migration-policy.md) defines the strategy now: a frozen tagged baseline, ordered migrations for later changes, released-data/client compatibility, validation and recovery. Implement no transition code or tests before the first release tag. Dated verification records are evidence, not tasks to repeat.

## 17.1 Increment definition of done

Every increment must meet all applicable criteria before work begins on the next increment:

**Owner-approved exception (2026-09-09):** The I6 backend-only slice may proceed before full I5 acceptance, using the existing deterministic authentication adapter and license-neutral reference fixtures. This permits backend development and HTTP verification only: it does not close I5, authorize production deployment, or satisfy full I6 acceptance. Real production sign-in and its return journey remain required for production readiness and full I6 acceptance. OD-03 and OD-08 dispositions for this slice are recorded in Section 18.1; all other applicable criteria below remain in force.

- Its primary workflow runs end to end without direct database changes or unpublished internal procedures.
- Public interfaces are documented and versioned. Backend-only workflows are usable through the OpenAPI contract.
- Authentication, authorization, validation, concurrency, idempotency, and audit requirements are implemented where the increment introduces them.
- Current-schema initialization, deployment configuration, structured logs, health checks, and relevant operational metrics are included. Application-version migrations and backward compatibility are required only after the first release tag, as defined in Section 17.0.
- Unit, integration, contract, security, accessibility, responsive, offline, and end-to-end tests required by the delivered capability pass in CI.
- Failure and recovery behavior is visible to users or HTTP callers; no operation silently loses or overwrites acknowledged state.
- The capability is exercised by the applicable reference systems and has an explicit acceptance demonstration.

## 17.2 Increment sequence

| **Increment** | **Capability delivered** | **Depends on** | **Exit result** |
|---------------|--------------------------|----------------|-----------------|
| I1 - System backend and rules runtime | System definition, validation, evaluation, publishing, and version HTTP interface **(completed 2026-09-04)** | None | A complete system can be created, validated, published, cloned, retrieved, exported, and evaluated through the documented HTTP interface. |
| I2 - System Builder frontend | No-code system authoring and publishing **(completed 2026-09-04)** | I1 | A non-programmer can create and publish a playable system entirely through the web interface. |
| I3 - Character backend | Runtime character state and commands | I1; I2 validates the package model | A client can create and fully operate a standalone character through the documented HTTP interface. |
| I4 - Character Sheet frontend | Reusable schema-driven character experience | I3 | A standalone character can be created and played through a responsive web sheet online or offline. |
| I4a - GUI integration | Lifecycle repairs, flexible themes, responsive shell, polished sheet and simple creator | I4 | G0-G5 pass through real routes, with frontend CI and visual acceptance. |
| I5 - Standalone Player app | Mobile-first Player PWA around the sheet | I4; I4a | A player can manage and play personal characters in a mobile browser or installed PWA without joining a campaign. |
| I6 - Campaign backend and Player integration | Campaign collaboration HTTP interface plus player-facing campaign flows | I3; I5 | Campaigns can be provisioned through HTTP, and invited players can join and participate through the Player app. |
| I7 - GM app | Mobile-first GM PWA for campaign administration and session operation | I6 | A GM can create and run a secure campaign with four players from a mobile browser, installed PWA, or desktop browser. |
| I7b - Simple scenes and player display | Authorized images, manual fog, simple tokens, restricted multi-device display | I7 | A GM phone controls a safe tablet/remote scene without disclosing GM-only data. |

## 17.3 I1 - System backend and rules runtime

**Tasks:**

1. Establish the TypeScript workspace, single deployable artifact with `http` and `db:init` modes, PostgreSQL initialization conventions, local environment, CI/CD, health checks, structured logging, request IDs, and baseline metrics. Do not add a worker until a concrete asynchronous consumer exists.
2. Implement the Identity Module and replaceable OIDC Adapter needed to own systems and authorize draft and publication operations; defer role-specific application shells.
3. Specify and version the system-package schema, stable definition IDs, limits, canonical serialization, checksum rules, and documented import/export format.
4. Persist system metadata, revision-controlled drafts, immutable published versions, lifecycle state, idempotency receipts, and audit records with relational ownership and access columns. Add an outbox only with the first concrete asynchronous consumer.
5. Implement the math and dice tokenizer, parser, typed AST, type checker, dependency validation, deterministic evaluator, normalized roll output, and hard depth/node/time budgets.
6. Implement field, resource, computed-value, sheet-section, action, validation, and reference-data package validation without accepting executable code.
7. Implement the `SystemAuthoring` Interface and map it to revision-safe HTTP routes for create, open, list, save, preview, publish, export, and lifecycle changes. Creation handles blank, clone, and import sources; save returns the current package assessment.
8. Implement semantic-version checks and breaking-change comparison while guaranteeing that publishing never mutates an existing version.
9. Encode the three reference systems as test fixtures and prepare license-reviewed launch template candidates without shipping unverified copyrighted material.
10. Test `SystemAuthoring` through its Interface against real PostgreSQL and test `SystemRuntime` through its Interface with published fixtures. Add property tests, package fuzz tests, HTTP contract tests, OIDC Adapter contract tests, authorization matrices, concurrency tests, and budget-exhaustion tests.

**Acceptance demonstration:** Using only the documented HTTP interface, create a rules-light system draft, evaluate representative math and dice expressions, publish an immutable version, clone it, export it, and prove that malformed or over-budget packages are rejected without changing the published version.

> **I1 closed 2026-09-04.** All ten tasks implemented. Breaking-change comparison now blocks publish on type changes, removed definitions, removed actions/validations, and changed required/resultType/context. Three reference system fixtures (d20, PbtA 2d6, d6 counted-success) ship under `docs/contracts/examples/`. Acceptance demonstration recorded at `docs/acceptance/i1-2026-09-04.md`. See `docs/superpowers/plans/2026-09-04-i1-closure.md` for the closure plan and its commits.

## 17.4 I2 - System Builder frontend

**Tasks:**

1. Establish the responsive React application shell, generated HTTP client, authenticated system library, accessible UI foundations, fault-containment view, and request/error correlation display.
2. Build draft creation, metadata editing, autosave status, revision-conflict recovery, archive controls, and recoverable navigation between systems.
3. Build editors for scalar, choice, resource, and computed fields with constraints, stable-ID handling, and immediate server-backed validation.
4. Build the single-column sheet section/order editor with move controls, complete keyboard operation, and one-action placement of definitions that are not yet on the sheet; do not add grid layout or drag-only behavior.
5. Build simple math, dice action, validation-rule, and reference-data editors that expose only the grammar supported by I1. Common rolls use guided dice and numeric-attribute selectors so the basic journey does not require expression syntax.
6. Build deterministic sample-data preview at phone and desktop widths using an immutable test snapshot rather than the mutable draft.
7. Build validation reporting that links errors and accessibility warnings to the responsible editor and prevents invalid publication.
8. Build publish confirmation, semantic version selection, release notes, version history, deprecation, package export, and clone-from-template workflows.
9. Add browser tests for authoring and publication, accessibility tests, responsive visual regression at 360 and 1280 px, and conflict/recovery tests.

**Acceptance demonstration:** A non-programmer clones a reference template, adds and arranges a field, defines a simple roll, previews both target widths, resolves validation feedback, and publishes a version without direct HTTP or database tools.

> **I2 closed 2026-09-04 (wire-up pass).** All 35 per-task components are now wired into the application: `DevSignInPanel` mounts in `AppShell` when `import.meta.env.MODE === "development"`; `SystemLibrary`, `CreateDraftDialog`, and `CloneFromTemplate` render at `/`; the `DocumentEditor` tabs (`metadata`, `sheets`, `actions`, `validations`, `referenceData`) each route to their dedicated editor (`MetadataEditor`, `SheetEditor`, `RollActionEditor` / `ResourceBumpEditor`, `ValidationEditor`, `ReferenceDataEditor`); `useDraftSync` owns autosave and surfaces the `ConflictBanner` on 409; `PreviewFrame` + `PreviewSheet` + `DiagnosticsDrawer` open behind header toggles; `PublishDialog` opens from the publish button and `VersionHistory` opens from the versions button; the `focus-editor:{path}` event from `DiagnosticsDrawer` resolves to the matching `[data-path]` element inside the editor body. Acceptance demonstration recorded at `docs/acceptance/i2-2026-09-04.md`.

## 17.5 I3 - Character backend

**Tasks:**

1. Persist standalone characters pinned to exact system versions, with relational ownership and visibility, revision-controlled JSONB state, lifecycle state, and audit records.
2. Implement character creation as one deep Characters Module command that delegates package interpretation to `SystemRuntime.resolve` with an `initialize` intent.
3. Implement authorized character reads that delegate derived values and validation to `SystemRuntime.resolve` with an `observe` intent and return its versioned render projection without mutating stored state.
4. Implement atomic field updates and built-in resource bump commands with expected revisions, idempotency keys, bounded values, machine-readable `409` conflicts, and `set` or `bump` runtime intents.
5. Implement server-authoritative character actions and rolls with an `action` runtime intent, deterministic command execution ID, normalized expression, individual dice, modifiers, total, audience, actor, timestamp, and request ID; do not auto-apply roll outcomes.
6. Implement character ownership changes, archive/recovery, activity history, and documented JSON export without leaking account data.
7. Version migration is excluded by the current owner decision in Section 6.7.
8. Define offline synchronization responses for cached reads and queued writes, including idempotent replay, stale revisions, revoked access, and reconciliation metadata.
9. Add state-schema, derived-value, command atomicity, idempotency, concurrency, ownership, export, and session-burst load tests against all reference systems.

**Acceptance demonstration:** Through the documented HTTP interface, create a standalone character from a published reference system, edit fields, bump a resource, execute a roll, replay the command safely, observe a concurrent-write conflict, export the character, and verify that publishing preserves its original rules snapshot.

> **I3 closed 2026-09-05; merged to main at `62a482f`.** Production `SystemRuntime` and the standalone Characters backend are implemented, with HTTP acceptance, offline replay, concurrency, migration, and load verification recorded in `docs/acceptance/i3-2026-09-05.md`. Standalone characters have one transferable owner and fixed owner-only visibility; campaign assignment and multiple-owner rules remain in I6. Offline synchronization replays ordinary idempotent commands rather than introducing a second mutation protocol. Image fields remain null-only until a later increment introduces object storage. See `docs/superpowers/specs/2026-09-05-i3-character-backend-design.md`. This status note was reconciled on 2026-09-06; I4 scope is unchanged.

## 17.6 I4 - Character Sheet frontend

**Tasks:**

1. Build the reusable schema-driven, single-column sheet renderer for every MVP field, resource, section, and action element using the versioned projection returned by Characters rather than interpreting packages independently.
2. Build standalone character creation and required-field completion from a selected published system version.
3. Add accessible field editing, direct numeric entry, resource step controls, optimistic pending/error states, and explicit recovery from revision conflicts.
4. Add action input, roll execution, and compact roll-result presentation with expression, dice, modifiers, total, and audience.
5. Add derived values, validation messages, character activity, archive/recovery and export.
6. Implement cached package and character reads, offline sheet rendering, queued idempotent writes, reconnect synchronization, and user-visible conflict resolution.
7. Define a stable routing seam so the sheet can be embedded unchanged in the Player and GM applications.
8. Add UI, accessibility, offline, browser, and responsive visual tests at 360 and 1280 px for all reference systems.

**Acceptance demonstration:** From a 360 px viewport, create and use a standalone character, go offline, read and update the sheet, reconnect without duplicate resource changes, resolve a simulated conflict, and export the final state.

> **I4 closed 2026-09-07 at `be69809` (closure commit `docs: close I4 character sheet frontend`).** The reusable projection-driven character sheet is implemented with durable offline edits, safe replay and fully offline reopening; verification recorded in `docs/acceptance/i4-2026-09-06.md` (backend unit 269, integration 122, web unit 484, E2E 19, production-offline 13, all green). Historical 30-day receipts replay unchanged. I5 remains untouched; installation and the Player PWA shell are still out of scope. See `docs/superpowers/specs/2026-09-06-i4-character-sheet-design.md`.
>
> **I4 reopened: completion/remediation in progress (2026-09-07).** The closure counts above are preserved as historical results; a follow-up audit found they did not prove the full routed workflow (unreachable action/tools/recovery controls, unsafe recovery/creation/estimate paths — see the remediation plan). Remediation proceeds under `docs/superpowers/plans/2026-09-07-i4-completion-remediation.md` with no scope changes: I5 remains untouched.
>
> **I4 reclosed 2026-09-07 (Task 9) at `8b9f40d`.** All audit findings were
> repaired and proven through the production UI: reachable action/tools/review/
> takeover controls on `/characters/$characterId`, atomic selection-safe
> recovery, retained uncertain attempts with explicit expired-outcome review,
> identity-bound creation, ordered resource estimates, and the complete
> create/complete/roll/offline/conflict/export journey for all three reference
> systems at 360/1280 px. Fresh verification on `8b9f40d`: backend unit 269,
> integration 123, web unit 621, E2E 19 (incl. visual 10/10), production-offline
> 21 — all green; typechecks, builds, contracts check, `git diff --check` clean.
> Evidence recorded in `docs/acceptance/i4-2026-09-06.md` (Reclosure section).
> I5 remains untouched; installation and the Player PWA shell are still out of
> scope.

## 17.6a I4a - GUI integration

**Status (reconciled 2026-09-12):** I4a implementation landed per the [GUI integration plan](docs/superpowers/plans/2026-09-08-gui-integration.md) G0-G5 records: frontend CI and routed checks, G1 lifecycle repairs, G2 shared controls/themes, G3 responsive shell, G4 character journey (`8d5f22a`, `8785c3b`) and G5 creator journey. I1-I4 historical closure records remain unchanged. The G0 reference capture remains blocked by the recorded HTTP 401; provisional-theme contrast, real-device and other G9 acceptance requirements are not closed by this reconciliation.

**Visual update (2026-09-24, merged PR #12):** The Tablefolk-inspired Sweetroll palette, shared surfaces and controls, starter-system cards, editor and character styling, mobile navigation correction, dark-mode focus ring, and ten inspected routed screenshot baselines (360/1280 px) are implemented. Light/Dark/Follow device still control one app-wide style; system-specific themes remain deferred. [CI on `a2510fb`](https://github.com/Kajonn/sweetroll/actions/runs/36055269301) passed the web, offline, visual, three journey, and verification jobs; its production deployment job was skipped. The source mockup has not been captured in `docs/ui/reference/`; screenshots in `web/tests/visual/__screenshots__/` show the **app**, not the source mockup. G0 reference archiving and G9 physical-device, playtest, production-auth, and deployed-artifact gates remain open. See the [GUI integration plan](docs/superpowers/plans/2026-09-08-gui-integration.md) and [visual reference inventory](docs/ui/visual-reference.md) for the current distinction.

OD-01 was resolved on 2026-09-09 as option A (unlisted/link-only), with the two-account owned/private/link/public matrix recorded under G4. G1 records picker cache-lifetime repairs. Preserve these implementations and their dependency/evidence history rather than restarting them; retain every unchecked GUI gate. G6 subsequently landed the I5 feature slice, but production sign-in and full I5 acceptance remain open.

**Acceptance demonstration:** At phone/tablet/desktop widths and in light/dark, create and publish a simple system without writing expressions, create and use a character, roll, recover from offline/conflict states, and sign out without leaving private data visible. Preserve generated contracts, stable IDs, published versions, and the existing character session/renderer. Review real screenshots and targeted regression evidence before I5 begins.

## 17.7 I5 - Standalone Player app

**Status (reconciled 2026-09-12):** G6 records the landed library, onboarding/activity/account/PWA shell, shared-control follow-up, account theme defaults and paginated catalog (`557de16`, `b1acf8a`, `a5b4f72`, `ceda932`, `112cb16`). The deterministic auth/return and concurrency checks (`ddc0929`) do not validate a real provider. Production sign-in remains owner-deferred, and full I5/device/release acceptance stays open.

This increment intentionally contains no campaign, invitation, membership, shared-content, other-player, or GM concepts. It composes the completed Character Sheet rather than rebuilding it. Apply GUI plan G6 using I4a shared components, including account theme defaults, device overrides, and real production sign-in.

**Tasks:**

1. Build player onboarding, profile, locale, session management, and an installable mobile-first PWA shell with fixed Characters, Activity, and Account navigation.
2. Build the personal character library with search, recent characters, system/template selection, create, duplicate, archive, recover, and soft-delete workflows.
3. Integrate the I4 sheet as the character play surface without creating a second renderer or character-state implementation.
4. Build personal activity, import/export access, synchronization status, storage warnings, and recovery guidance for failed queued writes.
5. Implement secure sign-out and local-cache removal, including clear handling of offline devices and expired sessions.
6. Add end-to-end tests for onboarding through character play, mobile accessibility tests, PWA installation checks, and offline restart/recovery tests.

**Acceptance demonstration:** A new player signs in on a phone, selects a system, creates and plays multiple personal characters, finds a recent character, works through a connection loss, exports data, and securely clears local data on sign-out.

## 17.8 I6 - Campaign backend and Player integration

**Status (reconciled 2026-09-12):** GUI plan G7 records the player slice landed on 2026-09-11 (`a33947f` through `4c3d09b`), not full I6 acceptance. Ordinary-player claim discovery remains R6, now contract-approved under Section 13.2 but not implemented/verified by this handoff. Historical co-GM journey evidence does not close that player workflow or the current R8 visibility/revocation proof.

Apply GUI plan G7 to the player campaign routes using I4a components and the owning Module authorization contracts.

**Backend tasks:**

1. Persist campaigns pinned to immutable system versions, campaign settings, memberships, roles, invitations, campaign-owned characters, text content, grants, and campaign activity using explicit relational authorization columns.
2. Implement the documented HTTP interface for campaign create/read/update/archive, membership and co-GM management, expiring invitation issue/review/accept/decline/rotate/revoke, and campaign policy configuration. Owner decision 2026-09-09: the first I6 backend slice uses out-of-band token-only invitations, with no outbox or email delivery. Issue/rotation receipts contain only non-secret metadata; a lost token response requires explicit rotation. Introduce the transactional outbox with invitation email delivery in a separately planned I6 follow-up, not as unused infrastructure in this slice.
3. Implement character creation, assignment, claiming, multiple-owner rules, and standalone-to-campaign adoption without changing a character's pinned version implicitly.
4. Implement GM-only, all-player, selected-player, and owner-only text content with deny-by-default scoped queries, audited visibility changes, and no UI-only enforcement.
5. Implement campaign and character policy decisions for read, edit, roll audience, and GM visibility; generate direct-object-reference and role/membership/ownership matrix tests.
6. Implement campaign activity reads, poll-on-view revision behavior, authorized notifications without secret payload broadcast, membership revocation, and cache-invalidation signals.
7. Add invitation idempotency, concurrent membership and content tests, expired/replayed token tests, revocation tests, campaign export, and four-player session-burst load tests.

**Backend slice policy (2026-09-09):** [Campaign backend spec](docs/superpowers/specs/2026-09-09-i6-campaign-backend-design.md) defines the backend-only contracts; it does not close I6 or its Player acceptance gates. Active GMs/co-GMs see full attached sheet state, disclosed before join/claim/adoption, with no I6 visibility toggle. This does not grant access to owner-only notes or actor-private rolls. Campaign-created characters have campaign custody and zero or more active member controllers; they stay in the campaign when controllers leave. Controller records survive role promotion, and a GM adopting their own character retains the return-owner controller invariant. Adoption requires the exact pinned version and explicit current-owner consent. On the original owner's departure/removal, the adopted character returns to that owner with its current sheet values and unchanged pin; all other campaign controllers lose live access. This return right cannot be reassigned. Adoption discloses that GM edits to sheet values return too: secrets belong in separately authorized content, not that sheet. Historical campaign rolls, activity and receipts remain campaign-scoped and do not return as personal history. Full membership revocation therefore removes campaign data access, with this explicit returned-sheet exception. Existing Characters routes, exports and idempotency/recovery responses must enforce current policy and original placement scope, not just standalone ownership. Membership removal and character return are one revision-safe transaction.

**Player integration tasks:**

1. Extend the Player app with invitation review, authentication return, accept/decline, campaign identity confirmation, and expired/revoked invitation handling.
2. Add campaign list and navigation, leave flow, campaign character creation/claiming, and clear ownership/editability indicators.
3. Add permitted text content, selected-player content, campaign activity, and per-roll audience selection using the same owning-Module policy implementation as all other callers.
4. Remove inaccessible campaign data from active views and caches promptly after membership or visibility revocation, including when reconnecting after offline use.
5. Add end-to-end player tests for invitation through play, cross-campaign isolation, content audiences, revocation, accessibility, and offline reconnect.

**Acceptance demonstration:** Provision a campaign and invitation through the documented HTTP interface; on a phone, a player accepts the invitation, creates or claims a campaign character, uses the sheet, reads only permitted content, makes a campaign-visible roll, and loses HTTP and cached access after membership revocation.

## 17.9 I7 - GM app

**Status (reconciled 2026-09-12):** The GUI plan's remediation cross-reference and index record GM Phase 1/2 and subsequent review fixes present at `11aea84`. Full I7 and unchecked G7/G9 gates remain open: pre-upgrade runtime/test, ordinary-player discovery, durable recovery and acceptance remediation comes next. Preview-as-player, true pinning, broader multi-device/acceptance work and the later upgrade/scenes increments are not closed by Phase 2 or by contract approval.

**Hardening outcome (2026-09-15, task 10):** WCAG/keyboard axe spec (15/15), co-GM two-user conflict + independent-operation proof, session-burst p95 evidence within budget, SLO-aligned buckets + definitions, backup/restore drill (incl. media tarball), and an exercised incident runbook (incl. pool error-listener fix) are done with evidence in `docs/acceptance/i7-2026-09-15-hardening.md` (commits `4548793`–`d6f7255`). Full I7 stays open per that record's open-gaps list (preview-as-player, launch-template licensing, production auth, mockup capture, G9 device/playtest/deployment gates, RPO-scheduling/PITR gaps, example-only PromQL).

**Hardening remainder outcome (2026-09-17):** RPO scheduling + retention with a 1000-character / 20-campaign volume re-drill (pg_dump 0.42s, restore 0.85s), opt-in WAL-archiving override with the PITR drill recorded NOT-EXERCISED (config-only validation), a file-only (not deployed) SLO scrape + alert bundle locked by test, and single-artifact serving (SPA 200 text/html on unrouted paths, API 404 JSON, env-gated) are done with evidence in `docs/acceptance/i7-2026-09-17-hardening-remainder.md` (commits `3949820`–`484e282`; G9 protocol in `docs/acceptance/g9-2026-09-17-device-playtest.md`). Full I7 and GUI release stay open per that record's open-gaps list (production auth, mockup 401, G9 devices/playtests/built-artifact remainder, NOT-EXERCISED PITR half, no production host, file-only PromQL).

The first GM app is a responsive web surface within the shared PWA. Native packaging and app-store distribution are not part of this increment. Apply GUI plan G7, including mobile NPC/monster list-to-sheet navigation. Image presentation and the restricted player display are delivered in I7b; I7 second-device acceptance uses permitted text content and authenticated GM views.

**Tasks:**

1. Add the mobile-first GM application shell and navigation to the shared responsive PWA without introducing a separate native client.
2. Build GM campaign creation from an accessible published system, campaign library, metadata/settings, archive/export, and clear pinned-version display.
3. Build invitation, member, role, co-GM, character assignment, ownership, and campaign-policy management with confirmation for security-sensitive changes.
4. Build text-content authoring, audience grants, reveal/hide controls, persistent audience markings, and preview-as-player using the production Campaigns Module policy implementation.
5. Build the mobile Session view with pinned content, recent rolls and activity, quick character access, and the GM session board.
6. Build one-tap authorized resource bumps across characters with optimistic status, idempotent retry, and immediate revision-conflict recovery.
7. Implement disclosed GM character visibility, character oversight, roll-audience controls, and audit views without granting system creators campaign access.
8. Support simultaneous GM devices and co-GMs through polling/revision refresh, authorized activity updates, and clear conflict handling without a single-session lock.
9. Non-breaking campaign version upgrades follow Section 6.7.
10. Complete WCAG 2.2 AA review, responsive testing, cross-campaign authorization tests, session load/soak tests, SLO dashboards, alerting, backup restoration drill, and incident runbook exercise.

**Acceptance demonstration:** A GM creates a campaign without direct HTTP tools, invites four players, manages visibility, previews each player's view, runs the session board from a phone while showing content on a second device, resolves a concurrent edit, and verifies that publishing preserves every campaign pin.

## 17.9a I7b - Simple scenes and restricted player display

**Status: visual-controls feature gate accepted 2026-11-06 in PR #38.** The
foundation delivery established authorized media, revision-controlled numeric
fog/token operations, revocable pairing and server-filtered display projections.
V1–V3 supply uploaded image tokens, direct mouse/touch placement/movement and an
on-image brush. The [combined V4 evidence](docs/acceptance/scene-visual-controls-2026-11-06.md)
now closes the reopened I7b/G8 visual-controls gate: ordered hosted GUI acceptance
passes on deployed `3a35a5f`, terminal SUCCESS `f33cf328`, with exact pixel/art,
privacy, recovery and cleanup proof. The historical numeric-only journey remains
foundation evidence. This is feature acceptance; physical devices, real provider
login, human visual approval and actual table/remote G9 release gates remain open.

**V1 update (PR #34):** Uploaded image tokens and their scene-relative rendering now pass component, privacy, responsive hosted and redeploy acceptance ([evidence](docs/acceptance/scene-image-tokens-2026-11-05.md)). V2 direct placement/movement is implemented in PR #36 with local and hosted mouse/touch acceptance passed on `84c23fd` ([V2 evidence](docs/acceptance/scene-token-gestures-2026-11-06.md)). V3 brushing is implemented in PR #37 with local and hosted mouse/touch acceptance passed on `637a60f` ([V3 evidence](docs/acceptance/scene-fog-brush-2026-11-06.md)). V4 combined local/hosted acceptance now passes in PR #38 ([evidence](docs/acceptance/scene-visual-controls-2026-11-06.md)); I7b/G8 visual-controls feature acceptance is complete. Separate G9 release gates remain open.

Complete GUI plan G8: define media/scene/display contracts and persistence; add safe authorized image storage and rendering; implement revision-controlled manual fog and token operations; implement revocable display pairing and server-filtered scene projections; then build touch/keyboard scene controls and the minimal display shell. Keep this within the modular application. Do not add a second rules engine or expose GM credentials on a shared tablet.

**Acceptance demonstration:** From a phone, use a monster sheet while an iPad shows a scene; manually reveal/conceal fog, place/move a token, change scene, reconnect, and revoke the display. Verify response bodies, media URLs, browser storage, deep links, and direct requests cannot expose originals, hidden tokens, GM notes, or administrative actions. Run the same permitted scene with a remote player. Concealing cannot undo information already seen.

## 17.9b Adventure-specific custom entries (follow-up plan)

**D2 (implemented and verified):** [Restricted template audiences](docs/superpowers/specs/2026-10-31-restricted-template-audiences.md) and [execution plan](docs/superpowers/plans/2026-10-31-restricted-template-audiences.md), based on merged D1 `90b053d`. Restricted catalog drafts remain off every character sheet; a GM explicitly reveals to all players before ordinary placement. Selected grants bind to current membership generations. Player preview uses the real catalog policy; restricted reads stay transient and online-only, while existing disclosed copies retain offline behavior. D2 is implemented in PR #27: CI #174 passes all seven verification jobs; hosted normal/offline journeys, byte-verified assets and independent cleanup pass on `5f445aa`. See [D2 acceptance](docs/acceptance/restricted-template-audiences-2026-11-01.md). Wider G9 release gates remain open.

Personal custom entries now support bounded name (200 characters), description and notes (2,000 each), plus positive integer quantity through the existing character revision and offline queue. The sheet provides create/edit controls and identifies their Personal origin; these entries remain data-only. All-player data-only campaign catalogs are implemented in PR #19. The implementation in PR #25 adds [adventure slice C: inherited campaign actions](docs/superpowers/plans/2026-10-31-campaign-inherited-actions.md), followed by implemented D1 player proposals in PR #26 ([acceptance](docs/acceptance/player-template-proposals-2026-10-31.md)) and implemented D2 restricted audiences in PR #27 ([acceptance](docs/acceptance/restricted-template-audiences-2026-11-01.md)). CI #158 and isolated deployed acceptance passed on `58c71a1`; broader G9 release gates remain open.

PR #19 implements the [slice B execution plan](docs/superpowers/plans/2026-10-09-campaign-data-templates.md): reusable all-player data-only campaign templates with server snapshots, offline/concurrency protection, archive/recover. Required CI #91 passed; [the acceptance record](docs/acceptance/campaign-data-templates-2026-10-10.md) distinguishes automated evidence, passed isolated deployed multi-account/offline acceptance and remaining manual/device gates. This does not close I7 or wider G9 acceptance.

The completed dynamic-object work added system templates and data-only character entries. [The adventure-specific custom items plan](docs/superpowers/plans/2026-10-07-adventure-custom-items.md) tracks delivered personal entries (A), implemented data-only campaign catalogs (B), accepted inherited campaign actions (C), and implemented private proposals/restricted audiences (D1/D2). These slices are separate from the historical I1–I7b completion claims and require their own character, campaign, offline, authorization and GUI acceptance evidence.

## 17.9c Planned system themes and image uploads (2026-11-03)

**Status (2026-11-04):** T1 color presets and T2 Default/Classic component styles passed hosted feature acceptance and CI #205. M0 scanning/storage passed real hosted clean/infected uploads and byte verification after redeployment, with a separate local metadata/bytes restoration drill ([evidence](docs/acceptance/image-foundation-2026-11-04.md)). M1 portraits passed the hosted player/GM journey and CI #209; M2 passed the hosted one-GM/three-player item-art journey and CI #210; M3 passed the hosted scene journey, post-redeploy byte/pixel verification and CI #219 on application `d62a9f8` ([evidence](docs/acceptance/scene-backgrounds-2026-11-04.md)). All requested stages in the [staged feature plan](docs/superpowers/plans/2026-11-03-system-themes-and-images.md) are implemented and accepted. This records the owner's requested additions without closing or reprioritizing unperformed G9 release gates.

| Track | Ordered stages | Required result |
| --- | --- | --- |
| System themes | T1 basic color presets → T2 themed GUI elements | Creator chooses and previews a system identity; immutable publications preserve it; player light/dark preferences and accessible shared controls still work. |
| Image uploads | M0 shared durable storage/access → M1 characters → M2 items → M3 adventure backgrounds | Authorized portraits and item art persist safely; existing scene backgrounds work through the restricted display without exposing originals or hidden pixels. |

The two tracks are independent; preserve their internal stage order. T1 builds on the delivered GUI token foundation and M0 reuses I7b media internals. Each stage follows red → green development, existing Module boundaries, current-schema policy and its own hosted/user-journey acceptance. M2 includes immutable art retention, catalog audiences, proposals and returned-character copies. M3 extends the existing scene workflow with safe background replacement. Arbitrary styling/code, image-editing suites and new tactical/VTT features are outside this addition. Implementation details and evidence checklists live in the staged plan.

## 17.10 MVP acceptance criteria

- **I1:** A complete reference system can be validated, published immutably, cloned, exported, and evaluated through the documented HTTP interface; hostile or over-budget packages are rejected safely.
- **I2:** A non-programmer can reproduce or modify a reference system using only the GUI and publish it without database or code changes.
- **I3:** A client can create, operate and export a character through HTTP; retries do not duplicate effects and concurrent edits do not silently overwrite state.
- **I4:** The player sheet works at 360 and 1280 px, renders without connectivity, and synchronizes queued writes idempotently on reconnect.
- **I4a:** Existing creator/character routes meet the GUI plan G0-G5 gates with safe save/account lifecycles, flexible themes, responsive layouts, and frontend CI.
- **I5:** A player can manage and play personal characters in a mobile browser or installed PWA with no campaign dependency.
- **I6:** A player can join an HTTP-provisioned campaign, create or claim a character, and access only authorized content; guessed identifiers, revoked memberships, and replayed invitations disclose nothing.
- **I7:** A GM can use the mobile-first web app to create a campaign from a shipped open-license template, invite four players, manage content visibility, verify each player's view, and run a session across two devices.
- **I7b (visual-controls feature gate accepted):** A GM phone supports uploaded image tokens, direct drag/tap placement/movement and on-image reveal/conceal brushing, with numeric/keyboard alternatives; a restricted tablet/remote display receives only revealed pixels and permitted tokens. The V4 combined hosted journey passes ([evidence](docs/acceptance/scene-visual-controls-2026-11-06.md)); G9 physical-device/provider/human/playtest gates remain separate.
- **GUI release:** Apply G9 to each migrated view and final release: actual routed visual review, real phone/iPad checks, built frontend/API deployment, and physical-table/remote playtests.
- Publishing a new system version never changes an existing character or campaign by itself; an owner may upgrade to a later non-breaking version after a passing dry run (Section 6.7).
- Users can export system, character, and campaign data in documented formats.
- Backup restoration, monitoring, alerting, load testing, and an incident runbook have been exercised before public beta.

# 18. Open decisions and next actions

## 18.1 Open decisions

| **ID** | **Decision**   | **Question**                                                                      | **Working recommendation**                                        |
|--------|----------------|-----------------------------------------------------------------------------------|-------------------------------------------------------------------|
| OD-01 (resolved 2026-09-09) | Sharing model | Which systems may be enumerated by the creation picker versus used from a known link? | Option A: enumerate owned plus explicitly discoverable (`public`) systems; other owners' `link` systems remain unlisted. Known-version owner/public/link use is unchanged. GUI plan G4 records the two-account matrix; see Section 13. Extended 2026-09-14: owners can set `private`/`link`/`public` per system (`changeSharing`); standalone creation from a shared system needs no campaign membership. |
| OD-02 (resolved 2026-09-09) | GM visibility | Do campaign GMs always see full character state? | Yes for attached sheet state, disclosed; no I6 toggle. Owner-only notes and actor-private rolls have separate policies. See Section 17.8. |
| OD-03 (deferred 2026-09-09) | Collaboration | Can several creators edit one system draft concurrently? | Named collaborators and multi-creator editing are deferred. Retain current creator ownership and revision-safe saves; campaign membership/co-GM roles confer no system-authoring permissions. Not a blocker for the I6 backend-only slice. |
| OD-04  | Rules ceiling (resolved) | Grammar v0.1 covers d20, 2d6, keep-high/low, advantage helpers, and threshold-counted dynamic d6 pools. | Defer reroll, explode, push, custom faces, lookups, and effects. |
| OD-05  | Authentication | Passwordless email, social sign-in, or both?                                      | OIDC social plus email magic link.                                |
| OD-06  | Business model | Free, subscription, paid storage, or marketplace?                                 | Do not couple MVP data ownership to an unvalidated payment model. |
| OD-07  | Public content | What moderation/takedown is required before public discovery?                     | Keep discovery out of MVP unless staffing and process exist.      |
| OD-08 (launch decision deferred 2026-09-09) | Templates | Which open-license systems to ship as launch templates? | Use existing license-neutral reference fixtures for I6 backend development/tests and accessible published versions for campaigns; no launch catalog is required for this slice. Template selection/license review remains open before shipped-template claims or acceptance requiring licensed launch templates. |

> **Note.** Offline support is now a requirement (Section 8), not an open decision.

## 18.2 Immediate next actions

**Public API completion implemented locally (2026-11-07):** Part B stages B1–B5
of the [API plan](docs/superpowers/plans/2026-11-07-public-api-v1.md) and the
local parts of B6 (campaign quickstart, documented limits and audit lines) are
implemented. Unit, contract and PostgreSQL integration suites pass, including
two-token campaign journeys and an API-edited scene reaching a paired display
stream. The hosted B6 journey still depends on real provider sign-in and has
not run.

**Scene streaming implemented (2026-11-07; owner-approved):** stages 1–3 of the [scene streaming plan](docs/superpowers/plans/2026-11-07-scene-streaming.md) are implemented on branch `claude/repo-next-steps-pzi9kv`: image revisions, SSE display stream with `LISTEN`/`NOTIFY`, removal of the polled projection route, and response-adopting single-command gestures (Section 7.7). Unit, integration (including two application instances on one database and listener loss) and local browser scene journeys pass. The isolated hosted journey and the 200-table load comparison in plan stage 4 have not been run; this does not close any G9 gate.

**Visual scene controls complete (2026-11-06; PR #38):** V4 combines image-token
authoring, direct mouse/touch movement and on-image fog in one hosted ordered
journey, closing the I7b/G8 visual-controls feature gate. See the
[acceptance record](docs/acceptance/scene-visual-controls-2026-11-06.md).
PR #36 includes #37; merge #36 before #38. The existing G9 release-readiness
gates and proposed real-login plan remain separate; this completion selects no
new feature or authentication provider.

**New planned feature tracks (2026-11-03):** [System themes and image uploads](docs/superpowers/plans/2026-11-03-system-themes-and-images.md) records the owner's additions: T1 system color presets followed by T2 themed GUI elements; M0 durable, authorized media followed by M1 character portraits, M2 item images and M3 adventure backgrounds. T1/T2 and the M0 foundation are implemented and verified; M1 portraits and M2 item art are accepted; M3 scene upload/select and safe replacement passed hosted, redeploy and CI acceptance. Reuse existing theme tokens and campaign scenes, and keep unfinished G9 release evidence separate from feature delivery.

**Hosted G9 automation and remediation (2026-11-03; PR #29):** The [dated protocol and acceptance record](docs/acceptance/gui-2026-11-03-g9-hosted.md) records source/deployment identity, routed theme/text/keyboard/axe checks, combined serving, the repeated ordered multi-user journey, offline conflict/export/account isolation and restricted-display privacy. Fixes preserve credential-only display access under `/api`, provide writable derivative storage for the non-root image, send display credentials with redacted-image requests, purge the former private-device session/cache before pairing, blank offline frames and constrain enlarged phone layouts. Human visual approval, physical Android/iPad/PWA checks, real OIDC, table/remote sessions, mockup/license decisions remain open. Durable hosted media was subsequently verified in PR #30 (Section 17.9c). Use the record's actual result table; no full-G9 or release acceptance follows from automation alone.

**Multi-user remediation accepted on isolated preview (2026-11-02; PR #28):** F1 manual invitation acceptance, F2 existing-personal-character GUI adoption and F3 recognizable recipient/preview labels are fixed. E1 is resolved for testing by the verified isolated preview. The same ordered [MU-00–MU-12 protocol](docs/acceptance/multi-user-journey-protocol.md) passed on application `a1fc299`, deployment `affa05b3-c796-42b0-8e63-7df0faf21771`: one GM, three players, 24 actor-bound rolls, manual token acceptance for all players, GUI adoption with disclosure, privacy/preview/reveal, production-worker offline reload/replay, independent quantities and scoped archive/readback. [Post-fix evidence](docs/acceptance/multi-user-journey-2026-11-02.md) records all 13 PASS steps, exact served build identity, focused regressions, CI #187 and both earlier runner failures. This closes the [remediation journey gate](docs/superpowers/plans/2026-11-01-multi-user-journey-remediation.md); it selects no new feature. Historical C/D1/D2 delivery and the wider open G9 gates below remain separate.

**Current feature track (2026-11-01):** [Campaign templates with inherited actions (adventure slice C)](docs/superpowers/plans/2026-10-31-campaign-inherited-actions.md) passed CI #158 and isolated deployed acceptance on `58c71a1`. C is merged, and PR #26 implements D1 data-only player proposals with passing isolated hosted acceptance ([evidence](docs/acceptance/player-template-proposals-2026-10-31.md)). D1 is merged as `90b053d`; PR #27 implements D2 restricted drafts, actual-player preview and explicit reveal, with CI #174 and both hosted journeys passing ([evidence](docs/acceptance/restricted-template-audiences-2026-11-01.md)). The release-readiness work below remains open in parallel; deployment or core browser verification does not close every G9 gate. No version migration or upgrade work precedes the first release tag.

**Release-readiness track (recorded 2026-09-24):** Continue the open [G9 release and acceptance gates](docs/superpowers/plans/2026-09-08-gui-integration.md#g9--release-and-acceptance-gates): archive the source mockup reference, validate real Android/iPad interactions and light/dark accessibility across the migrated routes, test a deployed frontend/API including direct links, authentication return and offline reopening, then conduct physical-table and remote playtests. Production authentication (OD-05) and launch-template licensing (OD-08) still need owner decisions and evidence before a public-release claim. Retain the recorded hardening/scenes limitations rather than rerunning completed increments; character/campaign upgrades were subsequently removed under Section 17.0. T1 system color presets, T2 component styles and the M0 storage foundation have passed their recorded automated acceptance. M1–M3 also passed their recorded feature acceptance (Section 17.9c and the linked plan).

**Historical 2026-09-12 handoff (superseded for sequencing):** The owner-approved [pre-upgrade remediation](docs/superpowers/plans/2026-09-12-remediation-index.md) then called for runtime/readiness and browser isolation fixes, narrow claim discovery, deleted-summary recovery, real-player visibility evidence and automated acceptance coverage. This paragraph preserves the original handoff context; its remediation and later feature sequence have since progressed. Preserve I1-I4 historical records and every unchecked G7/G9 gate. The numbered foundation actions below retain their original increment context; they are not instructions to redo completed work.

1. The I1 capability matrix selects license-neutral d20, 2d6 PbtA-style, and d6 counted-success families; its detailed matrix is in the system-package contract design.
2. OD-04 is resolved by grammar v0.1 in the system-package contract design; implement that grammar after the package structural contracts.
3. Resolve OD-05 and establish the identity, repository, database, CI/CD, OpenAPI, and observability foundations inside I1.
4. Run license review on candidate templates before any package is described as a shipped open-license template.
5. Build and acceptance-test I1 before starting the System Builder; treat its package and evaluation contracts as versioned interfaces.
6. Prototype the I2 System Builder workflow and the future I4 phone sheet as validation artifacts, but do not implement character state before I2 proves the package model usable.
7. Run five moderated creator tests during I2 and measure time to first published playable system.
8. Create the ownership authorization table in I3, then extend it with campaign membership, audience, and GM-policy cases before I6 implementation.
9. Keep the I5 Player app campaign-free; add all player campaign workflows together with their backend support in I6.
10. Preserve the resolved OD-01 discovery/use distinction and its G4 matrix evidence. OD-02 is resolved; the owner-approved OD-03/OD-08 deferrals and I5 prerequisite exception permit the I6 backend-only slice (Sections 17.1 and 18.1), not full I6 acceptance or production deployment. Settle launch-template licensing before demonstrations requiring shipped licensed templates. Keep commercial features and a public catalog outside the critical path.

## Appendix A. System package outline

```yaml
systemPackage:
  metadata: { systemId, versionId, semanticVersion, name, language }
  entities: [ { id, label, fields } ]
  referenceData: [ { typeId, records } ]
  sheets: [ { id, targetEntityType, sections, elements, bindings } ]
  expressions: [ { id, context, resultType, ast, dependencies } ]
  actions: [ { id, inputs, rollNotation, output } ]
  validations: [ { id, condition, severity, messageKey, targetId } ]
  limits: { maxExpressionCost }
  integrity: { schemaVersion, checksum }
```

The package format must be documented and versioned independently from individual game systems. Imports are validated and never trusted merely because a checksum is present. Export omits account identifiers and campaign/user data.

## Appendix B. Terminology

| **Term**         | **Meaning**                                                                                     |
|------------------|-------------------------------------------------------------------------------------------------|
| System           | The evolving creator-owned container and identity for a tabletop rules design.                  |
| System version   | An immutable, validated package used by campaigns and characters.                               |
| Definition ID    | A stable machine identifier for a field, action, entity type, or sheet-element binding.         |
| Entity           | A structured runtime record such as a character, item, spell, or condition.                     |
| Character state  | Stored values belonging to one character and keyed by definition IDs.                           |
| Derived field    | A value calculated from state and reference data rather than directly stored.                   |
| Action           | A user-triggered, validated roll and/or simple bounded state transition.                        |
| Campaign         | The collaboration scope containing members, characters, settings, and shared/secret content.    |
| Audience         | The set of principals permitted to read an activity or content item.                            |
| Reference system | An internal fixture used to verify that the generic platform supports real mechanics.           |


## Railway deployment configuration (2026-09-19)

The single-container hosting option uses the existing Dockerfile to serve the
built frontend and HTTP backend together. With `SWEETROLL_SERVE_STATIC=1`,
application API routes are mounted at `/api`, leaving browser deep links for the
SPA. Backend-only development retains its unprefixed API and Vite proxy.
Health, metrics, and explicitly enabled dev routes keep their existing paths.
Railway service settings initialize empty databases before deployment, check PostgreSQL
readiness, and start one app instance with a separately provisioned media
volume and PostgreSQL service. See [setup instructions](docs/operations/railway.md).
This configuration does not close the production-authentication, deployed
acceptance, backup/restore, or physical-device gates.

For acceptance environments only, `SWEETROLL_TEST_AUTH=1` enables the existing
deterministic test identity and exposes one production-build sign-in button.
The frontend detects the server-owned test-auth route instead of baking the
mode into the bundle. The button is absent when the route is disabled. This is
an acceptance shortcut and does not satisfy the real production-authentication
gate.
