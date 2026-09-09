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

The MVP is a modular monolith backed by PostgreSQL and object storage. System definitions are declarative, versioned documents. Math and dice expressions are parsed into a lightweight AST and evaluated by the platform; creator-supplied executable code is never run. Published system versions are immutable; campaigns and characters pin to a version and upgrade explicitly.

> **MVP scope.** Build a trustworthy shared-character-sheet and campaign platform — not a full virtual tabletop and not an auto-applying rules simulator. The first Player and GM applications are mobile-first web apps delivered as an installable PWA. Native binaries and app-store distribution are post-MVP. Simple background images, manually edited fog, GM-positioned tokens, and a restricted player display are included in I7b. Video, voice, tactical movement, dynamic lighting, marketplace payments, and arbitrary scripting are excluded from the first release.

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
- Keep state and rules distinct: definitions describe what a field means; character and campaign records contain current values.
- Every visibility control states its audience in plain language and offers a preview-as-player check.
- Provide undo for builder operations and recoverable deletion for user content where practical.

## 4.2 Multi-device GM play

A GM may use **multiple devices in the same session simultaneously**, with each device focused on a different task. Private control devices may share the GM account; a device handed to players uses restricted display access:

- e.g. an **iPad or second screen for showing images/handouts to players**, while a **phone shows monster/stat sheets** for the GM's own reference.
- Concurrency between the GM's devices is handled by the standard revision/`409` mechanism; single-writer per resource means the GM cannot corrupt their own data by editing from two screens, though they will see a conflict and refresh prompt if both attempt to mutate the same field at once.
- Each authenticated GM device runs the normal responsive surface, with no artificial single-session lock. A tablet handed to players instead uses the dedicated restricted Display surface introduced in I7b; it must not retain the GM session or private cached data.
- Updates are scoped to the campaign and actor, initially through authorized polling/revision refresh. In I7b, paired player displays receive only the permitted scene projection using revocable, display-scoped credentials; they never receive GM originals or secret payloads.

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
2. Define fields, resources, and actions with simple math/dice expressions.
3. Arrange a single-column sheet into sections.
4. Validate, preview with sample data (phone/desktop), and publish an immutable version. Share by direct link or invite.

## 5.3 Join and play

1. Open an invite, authenticate, review campaign identity, and join.
2. Create a character using the campaign's pinned system version, or claim a character assigned by the GM.
3. Complete required fields and resolve validation messages.
4. During play, update resources, trigger actions and rolls, and read shared content — at a physical table or online.
5. Review a clear activity history for meaningful changes and rolls.

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
| Media        | image attachment reference                 | Avatar/portrait only in MVP                       |

**Removed from MVP:** rich text, temporal dates, single/multiple entity references, embedded collections. These are post-MVP.

## 6.3 The sheet

A sheet is a **single-column linear scroll** (predictable collapse to one column on phones) composed of:

- Headings and section dividers
- Labeled fields
- Resource bars (current/max) with step controls and direct input
- A flat list of **action buttons** (rolls and simple stat bumps)

**Removed from MVP:** tabs, multi-column grid layouts, drag-drop element palette, manual binding inspector, reusable fragments, conditional display, viewport authoring beyond preview. Keep only a simple section/order editor with move-up/down controls and keyboard authoring.

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

## 6.7 Version upgrades and migration

Campaigns and standalone characters pin to an exact system version. A creator can publish a newer version without changing existing play. A GM or independent character owner may preview an upgrade, review warnings, and commit it atomically.

- Compatible changes (labels, layout, new optional fields, new reference data) migrate automatically.
- Potentially breaking changes (type changes, removed definitions, changed required fields) require an explicit mapping or default.
- Every migration produces a before/after snapshot and audit event; rollback is available for a bounded retention period.
- MVP supports platform-generated field mappings and defaults. Creator-authored migration scripts are excluded.

# 7. Campaign and play specification

## 7.1 Campaign workspace

The campaign workspace combines member management, content, characters, and an in-session activity feed. The **Session view** is a curated mobile surface: pinned content, recent rolls, quick character access, and reveal/hide controls.

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

A separate tablet or remote player receives only an authorized display projection. Fog-covered pixels must be removed from server-generated display imagery (or safe tiles); sending the original image under a client-only overlay does not protect secrets. Filter hidden tokens and GM metadata before delivery. Pairing credentials are revocable and cannot read campaign administration, GM notes, or originals. Clear privileged browser state when entering display mode, and blank the display when authorization is uncertain or revoked. Previously revealed information cannot be retracted from screenshots. See the GUI plan G8 for acceptance cases.

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

- Sticky character identity and primary-resource summary without excessive vertical space.
- Platform-owned bottom navigation for Characters, Activity, and Account; Campaigns is added in I6. System creators cannot add navigation destinations or divide the linear sheet into tabs.
- Prominent action buttons and resource controls; numeric entry supports direct input and step controls.
- Optimistic updates with visible pending/error state and automatic retry only when idempotent (offline-safe).
- A roll result opens as a compact sheet showing dice, modifiers, total, and audience.

## 10.3 GM mobile session view

- Pinned handouts and notes, recent activity, member status, quick character access, and the **GM session board**.
- One-tap reveal/hide with audience confirmation; items remain visibly marked after sharing.
- Works simultaneously across multiple GM devices (Section 4.2).
- Conflicts between co-GMs and the GM's own devices resolve via revision/`409` and an immediate refresh prompt.

## 10.4 Accessibility and localization

Target WCAG 2.2 AA for the authored application. The builder must flag missing labels, low contrast, ambiguous names, and controls available only by drag. Store display strings separately from stable IDs and design all UI for localization, plural rules, time zones, and longer translated labels. Bidirectional layout is a post-MVP validation item unless required at launch.

## 10.5 Visual design, components, and flexible themes

Use the [Tablefolk GUI mockup](https://tablefolk-ttrpg-mockups.humdrumrat.chatgpt.site) as the visual reference for hierarchy, restrained green accents, readable typography, rounded panels, and touch-friendly controls. Keep Sweetroll branding and the navigation/linear sheet constraints in this specification. Capture selected reference views in the repository during G0; prototype data and simulated services are not production implementations.

Adopt the design incrementally in the existing React application. Keep CSS modules, accessible primitives, generated API contracts, and the character projection/session model. AppShell owns navigation and one flexible content region; individual views own their internal columns. Do not replace the backend or create a second character renderer.

Use semantic CSS tokens for color roles, typography, spacing, borders, radii, shadows, and focus. Shared controls and feature components consume those tokens. Ship light/dark presets and Follow device, with portal inheritance and accessible states. I4a stores device preferences; I5 adds an account default with per-device override. Restricted display preferences remain device-local. Prove extensibility through a third internal preset; arbitrary CSS, a theme editor, and theme marketplace remain excluded.

Implement loading, empty, validation, saving, offline, conflict, and permission states as part of every view. Theme changes must preserve editor/character state and must not recolor uploaded art or change fog/token visibility. Preserve 44px touch targets, visible keyboard focus, and readable text in every theme.

The execution checklist is [GUI integration implementation plan](docs/superpowers/plans/2026-09-08-gui-integration.md). Its G0-G9 tasks supplement the delivery increments below; they do not retroactively change historical acceptance evidence.

# 11. Technical architecture

> **Architecture.** Begin with one modular TypeScript application, one PostgreSQL database, and one deployable artifact. I1 has `http` and `migrate` process modes. Add a worker mode only when a concrete asynchronous consumer exists. Preserve deep Module Interfaces so extraction remains possible if measured load or team scale later justifies it.

| **Area**       | **Recommended responsibility**                                                       | **MVP technology direction**                             |
|----------------|--------------------------------------------------------------------------------------|----------------------------------------------------------|
| Web client     | Role-oriented responsive PWA, local draft/offline buffer, accessibility, polling     | React + TypeScript; accessible UI primitives             |
| HTTP Adapter   | Wire decoding, authentication context, HTTP status mapping, OpenAPI description       | Fastify on Node.js LTS; stateless replicas               |
| Modules        | Authorization, lifecycle rules, policy, idempotency, transactions, returned outcomes | TypeScript; workflow-level Interfaces                    |
| Package logic  | Decode, validate, compile, canonicalize, compare, and evaluate packages               | Private in-process implementation with strict budgets    |
| Database       | Identity, relational selectors, JSONB package/state documents, audit records          | PostgreSQL with constraints and explicit SQL migrations  |
| External tools | OIDC and, when introduced, transactional email                                        | Narrow ports with production and deterministic adapters  |

The Player and GM applications are role-oriented surfaces within the responsive web client, not separate native applications. The PWA must remain directly usable in supported mobile browsers and installable to a device home screen. A later release may package the web client for app stores, but the MVP does not select a native wrapper, depend on native-only platform interfaces, or include app-store submission work.

Redis, object storage for package exports, a message broker, microservices, and a separately deployed rules runtime are excluded from I1. Package export is a bounded synchronous response. Portrait object storage is introduced with the character increment that first uses it.

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

**Real-time read:** use poll-on-view plus server revision. Clients refresh permitted data when a view becomes active. Add authorized asynchronous notifications only when user research or measured polling load justifies them; secret payloads are never sent to a mixed-audience channel.

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
  bootstrap/                 # http and migrate process composition
```

Use Node.js LTS, TypeScript, Fastify, a thin PostgreSQL driver, explicit SQL migrations, and runtime schema decoding. Generate transport types for the web client, but keep published-package semantics owned by the systems implementation. Internal directories organize implementation knowledge; they do not imply additional public seams.

# 12. Data design

| **Aggregate/table** | **Key relationships**                        | **Important fields**                                                |
|---------------------|----------------------------------------------|---------------------------------------------------------------------|
| users               | external_identities, owned resources         | id, display_name, locale, status, created_at                        |
| systems             | creator; drafts; versions; collaborators     | id, owner_id, name, access, lifecycle                               |
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
| outbox_events       | First concrete asynchronous consumer         | topic, payload, attempt_count, available_at, published_at           |
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

# 13. HTTP interface and real-time contract

Expose a versioned REST HTTP interface described by OpenAPI. Use resource-oriented reads and command endpoints for behavior that must enforce rules atomically. Each endpoint maps to one deep Module call rather than reproducing authorization, validation, or transaction ordering in the HTTP Adapter. Cursor pagination is required for potentially unbounded lists. Every error has a stable code, human message, request ID, and optional field paths.

| **Area**   | **Representative endpoints**                                                                                                            |
|------------|-----------------------------------------------------------------------------------------------------------------------------------------|
| Systems    | POST/GET /systems; GET /systems/{id}; GET /systems/{id}/versions; PUT /systems/{id}/draft; POST /systems/{id}/preview; POST /systems/{id}/publish; PATCH /systems/{id}; DELETE /systems/{id} |
| Versions   | GET/PATCH /system-versions/{id}; GET /system-versions/{id}/export                                                                        |
| Templates  | GET /templates; create a system with a version source to clone a template                                                               |
| Campaigns  | POST /campaigns; GET/PATCH /campaigns/{id}; POST /campaigns/{id}/invitations; DELETE /campaigns/{id}/members/{memberId}                 |
| Characters | POST /characters; GET /characters/creation-options; GET /characters/creation-versions; POST /campaigns/{id}/characters; GET/PATCH /characters/{id}; POST /characters/{id}/actions/{actionId}; POST /characters/{id}/migrations |
| Content    | POST /campaigns/{id}/content; PATCH /content/{id}; POST /content/{id}/grants                                                            |
| Session    | GET /campaigns/{id}/session (GM session board); POST /characters/{id}/resources/{resourceId}/bump                                        |
| Activity   | GET /campaigns/{id}/activity; GET /characters/{id}/activity                                                                             |
| Exports    | POST /characters/{id}/exports; POST /campaigns/{id}/exports; GET /exports/{id}                                                          |

`GET /characters/creation-versions` enumerates only systems owned by the actor plus explicitly discoverable (`public`) systems (OD-01 option A, unlisted/link-only). Character creation and metadata lookup from a KNOWN version ID keep their existing authorization unchanged: permission to use a version (owner or `public`/`link` access, published version, active system) never implies permission to discover it, and link-access systems remain usable when the exact version ID is known. The `/characters/new` page opened without a version shows a "Choose a system version" picker from this endpoint; the manual system-version-ID box remains as fallback, and picking a version loads its creation metadata through the unchanged lookup path.

At the reconciled baseline `d6bfd32`, the picker uses the inline `CharactersApi.listCreationVersions()` query in `CreateCharacter.tsx`. GUI work must reuse this path, preserve exact-version links, and add account-scoped cache handling before G4 acceptance. OD-01 discovery is resolved as unlisted/link-only: the endpoint no longer enumerates other owners' `link` systems. G6 must bound/paginate this list before expanding it into a library/catalog. See the GUI plan reconciliation for current implementation versus remaining work.

## 13.1 Idempotency

Create, roll, action, invitation, migration, and export commands accept an idempotency key scoped to user and endpoint. The server stores the completed result for a bounded interval. This prevents duplicated damage, resource spending, rolls, and invitations after mobile or offline retries.

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
- Load and soak tests shaped like session bursts: many resource updates, rolls, and views in a short window.

## 16.2 Reference systems

Maintain three internal reference systems as acceptance fixtures: a minimal rules-light system, a class-and-level fantasy system with derived statistics and inventory, and a dice-pool system with resources. They must exercise every supported field, sheet element, formula feature, action, visibility path, migration category, and mobile breakpoint. Where an open license permits, the shipped templates correspond to these fixtures.

# 17. Delivery plan

Delivery retains I1-I7 and adds I4a for GUI integration and I7b for simple scenes and restricted display. Each increment produces a complete, deployable capability rather than infrastructure that cannot be exercised. Backend increments are functional through the documented HTTP interface; frontend increments provide the normal user interface over capabilities completed by earlier increments.

Foundational work belongs to the first increment that needs it. For example, repository setup, CI/CD, identity seams, database conventions, and baseline observability are tasks in I1 rather than a separate non-functional milestone.

## 17.1 Increment definition of done

Every increment must meet all applicable criteria before work begins on the next increment:

- Its primary workflow runs end to end without direct database changes or unpublished internal procedures.
- Public interfaces are documented and versioned. Backend-only workflows are usable through the OpenAPI contract.
- Authentication, authorization, validation, concurrency, idempotency, and audit requirements are implemented where the increment introduces them.
- Database migrations, deployment configuration, structured logs, health checks, and relevant operational metrics are included.
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

1. Establish the TypeScript workspace, single deployable artifact with `http` and `migrate` modes, PostgreSQL migration conventions, local environment, CI/CD, health checks, structured logging, request IDs, and baseline metrics. Do not add a worker until a concrete asynchronous consumer exists.
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
4. Build the single-column sheet section/order editor with move controls and complete keyboard operation; do not add grid layout or drag-only behavior.
5. Build simple math, dice action, validation-rule, and reference-data editors that expose only the grammar supported by I1.
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
7. Implement compatible and mapped character migration previews, atomic commits, before/after snapshots, and bounded rollback while leaving the standalone character unchanged until commit.
8. Define offline synchronization responses for cached reads and queued writes, including idempotent replay, stale revisions, revoked access, and reconciliation metadata.
9. Add state-schema, derived-value, command atomicity, idempotency, concurrency, ownership, migration, export, and session-burst load tests against all reference systems.

**Acceptance demonstration:** Through the documented HTTP interface, create a standalone character from a published reference system, edit fields, bump a resource, execute a roll, replay the command safely, observe a concurrent-write conflict, export the character, and migrate it explicitly to a newer version.

> **I3 closed 2026-09-05; merged to main at `62a482f`.** Production `SystemRuntime` and the standalone Characters backend are implemented, with HTTP acceptance, offline replay, concurrency, migration, and load verification recorded in `docs/acceptance/i3-2026-09-05.md`. Standalone characters have one transferable owner and fixed owner-only visibility; campaign assignment and multiple-owner rules remain in I6. Offline synchronization replays ordinary idempotent commands rather than introducing a second mutation protocol. Image fields remain null-only until a later increment introduces object storage. See `docs/superpowers/specs/2026-09-05-i3-character-backend-design.md`. This status note was reconciled on 2026-09-06; I4 scope is unchanged.

## 17.6 I4 - Character Sheet frontend

**Tasks:**

1. Build the reusable schema-driven, single-column sheet renderer for every MVP field, resource, section, and action element using the versioned projection returned by Characters rather than interpreting packages independently.
2. Build standalone character creation and required-field completion from a selected published system version.
3. Add accessible field editing, direct numeric entry, resource step controls, optimistic pending/error states, and explicit recovery from revision conflicts.
4. Add action input, roll execution, and compact roll-result presentation with expression, dice, modifiers, total, and audience.
5. Add derived values, validation messages, character activity, archive/recovery, export, and migration preview/confirmation surfaces.
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

**Status:** Planned, added 2026-09-08; reconciled against `d6bfd32`. I1-I4 historical closure records remain unchanged. The basic creation picker is implemented and reused by G4/G6; this does not close I4a or I5.

Resolve OD-01 discovery semantics for the new picker before G4 acceptance, and include picker cache lifetime in G1. Complete G0-G5 in the [GUI integration plan](docs/superpowers/plans/2026-09-08-gui-integration.md): establish reference/route inventory and frontend CI; repair creator save/conflict and application-wide account cleanup; add theme tokens/shared controls; fix the responsive shell; polish the real character journey; and simplify/restyle the creator. G1 lifecycle repairs and G2 controls both precede protected-route migration.

**Acceptance demonstration:** At phone/tablet/desktop widths and in light/dark, create and publish a simple system without writing expressions, create and use a character, roll, recover from offline/conflict states, and sign out without leaving private data visible. Preserve generated contracts, stable IDs, published versions, and the existing character session/renderer. Review real screenshots and targeted regression evidence before I5 begins.

## 17.7 I5 - Standalone Player app

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

Apply GUI plan G7 to the player campaign routes using I4a components and the owning Module authorization contracts.

**Backend tasks:**

1. Persist campaigns pinned to immutable system versions, campaign settings, memberships, roles, invitations, campaign-owned characters, text content, grants, and campaign activity using explicit relational authorization columns.
2. Implement the documented HTTP interface for campaign create/read/update/archive, membership and co-GM management, expiring invitation issue/accept/revoke, and campaign policy configuration. Introduce the transactional outbox with invitation email delivery as its first concrete asynchronous consumer.
3. Implement character creation, assignment, claiming, multiple-owner rules, and standalone-to-campaign adoption without changing a character's pinned version implicitly.
4. Implement GM-only, all-player, selected-player, and owner-only text content with deny-by-default scoped queries, audited visibility changes, and no UI-only enforcement.
5. Implement campaign and character policy decisions for read, edit, roll audience, and GM visibility; generate direct-object-reference and role/membership/ownership matrix tests.
6. Implement campaign activity reads, poll-on-view revision behavior, authorized notifications without secret payload broadcast, membership revocation, and cache-invalidation signals.
7. Add invitation idempotency, concurrent membership and content tests, expired/replayed token tests, revocation tests, campaign export, and four-player session-burst load tests.

**Player integration tasks:**

1. Extend the Player app with invitation review, authentication return, accept/decline, campaign identity confirmation, and expired/revoked invitation handling.
2. Add campaign list and navigation, leave flow, campaign character creation/claiming, and clear ownership/editability indicators.
3. Add permitted text content, selected-player content, campaign activity, and per-roll audience selection using the same owning-Module policy implementation as all other callers.
4. Remove inaccessible campaign data from active views and caches promptly after membership or visibility revocation, including when reconnecting after offline use.
5. Add end-to-end player tests for invitation through play, cross-campaign isolation, content audiences, revocation, accessibility, and offline reconnect.

**Acceptance demonstration:** Provision a campaign and invitation through the documented HTTP interface; on a phone, a player accepts the invitation, creates or claims a campaign character, uses the sheet, reads only permitted content, makes a campaign-visible roll, and loses HTTP and cached access after membership revocation.

## 17.9 I7 - GM app

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
9. Expose one deep Campaigns Module command for system-version upgrade preview and commit. Its implementation coordinates field mappings/defaults, warnings, character migrations, the campaign pin, before/after audit, rollback, and proof that publishing alone never upgrades a campaign; the GM caller never loops through characters.
10. Complete WCAG 2.2 AA review, responsive testing, cross-campaign authorization tests, session load/soak tests, SLO dashboards, alerting, backup restoration drill, and incident runbook exercise.

**Acceptance demonstration:** A GM creates a campaign without direct HTTP tools, invites four players, manages visibility, previews each player's view, runs the session board from a phone while showing content on a second device, resolves a concurrent edit, and explicitly upgrades the campaign without changing another pinned campaign.

## 17.9a I7b - Simple scenes and restricted player display

**Status:** Planned. Restores the owner-requested image, manual fog, token, and phone/tablet display scope; it does not introduce full VTT behavior.

Complete GUI plan G8: define media/scene/display contracts and persistence; add safe authorized image storage and rendering; implement revision-controlled manual fog and token operations; implement revocable display pairing and server-filtered scene projections; then build touch/keyboard scene controls and the minimal display shell. Keep this within the modular application. Do not add a second rules engine or expose GM credentials on a shared tablet.

**Acceptance demonstration:** From a phone, use a monster sheet while an iPad shows a scene; manually reveal/conceal fog, place/move a token, change scene, reconnect, and revoke the display. Verify response bodies, media URLs, browser storage, deep links, and direct requests cannot expose originals, hidden tokens, GM notes, or administrative actions. Run the same permitted scene with a remote player. Concealing cannot undo information already seen.

## 17.10 MVP acceptance criteria

- **I1:** A complete reference system can be validated, published immutably, cloned, exported, and evaluated through the documented HTTP interface; hostile or over-budget packages are rejected safely.
- **I2:** A non-programmer can reproduce or modify a reference system using only the GUI and publish it without database or code changes.
- **I3:** A client can create, operate, export, and explicitly migrate a character through HTTP; retries do not duplicate effects and concurrent edits do not silently overwrite state.
- **I4:** The player sheet works at 360 and 1280 px, renders without connectivity, and synchronizes queued writes idempotently on reconnect.
- **I4a:** Existing creator/character routes meet the GUI plan G0-G5 gates with safe save/account lifecycles, flexible themes, responsive layouts, and frontend CI.
- **I5:** A player can manage and play personal characters in a mobile browser or installed PWA with no campaign dependency.
- **I6:** A player can join an HTTP-provisioned campaign, create or claim a character, and access only authorized content; guessed identifiers, revoked memberships, and replayed invitations disclose nothing.
- **I7:** A GM can use the mobile-first web app to create a campaign from a shipped open-license template, invite four players, manage content visibility, verify each player's view, and run a session across two devices.
- **I7b:** A GM phone and restricted tablet/remote display support simple images, manual fog, and tokens, with no GM secrets in display responses or caches.
- **GUI release:** Apply G9 to each migrated view and final release: actual routed visual review, real phone/iPad checks, built frontend/API deployment, and physical-table/remote playtests.
- Publishing a new system version never changes an existing character or campaign until its authorized owner completes an explicit upgrade.
- Users can export system, character, and campaign data in documented formats.
- Backup restoration, monitoring, alerting, load testing, and an incident runbook have been exercised before public beta.

# 18. Open decisions and next actions

## 18.1 Open decisions

| **ID** | **Decision**   | **Question**                                                                      | **Working recommendation**                                        |
|--------|----------------|-----------------------------------------------------------------------------------|-------------------------------------------------------------------|
| OD-01  | Sharing model  | Which systems may be enumerated by the creation picker versus used from a known link?         | Private plus unlisted links; resolve picker enumeration before G4 acceptance.                    |
| OD-02  | GM visibility  | Do campaign GMs always see full character state?                                  | Disclosed campaign policy; default yes.                           |
| OD-03  | Collaboration  | Can several creators edit one system draft concurrently?                          | Named collaborators; serialize draft edits in MVP.                |
| OD-04  | Rules ceiling (resolved) | Grammar v0.1 covers d20, 2d6, keep-high/low, advantage helpers, and threshold-counted dynamic d6 pools. | Defer reroll, explode, push, custom faces, lookups, and effects. |
| OD-05  | Authentication | Passwordless email, social sign-in, or both?                                      | OIDC social plus email magic link.                                |
| OD-06  | Business model | Free, subscription, paid storage, or marketplace?                                 | Do not couple MVP data ownership to an unvalidated payment model. |
| OD-07  | Public content | What moderation/takedown is required before public discovery?                     | Keep discovery out of MVP unless staffing and process exist.      |
| OD-08  | Templates      | Which open-license systems to ship as launch templates (license review pending)?  | Start with OGL/CC systems listed in 6.6; verify each license.     |

> **Note.** Offline support is now a requirement (Section 8), not an open decision.

## 18.2 Immediate next actions

**Current next work (reconciled against `d6bfd32`):** execute I4a / GUI plan G0-G5 before I5 feature expansion. Reuse the completed picker, fix its account-cache lifetime under G1, and resolve OD-01 discovery before G4 acceptance. Preserve I1-I4 records as history, carry G6-G7 into I5-I7, and implement the explicit I7b scene/display scope afterward. The numbered foundation actions below retain their original increment context; they are not instructions to redo completed work.

1. The I1 capability matrix selects license-neutral d20, 2d6 PbtA-style, and d6 counted-success families; its detailed matrix is in the system-package contract design.
2. OD-04 is resolved by grammar v0.1 in the system-package contract design; implement that grammar after the package structural contracts.
3. Resolve OD-05 and establish the identity, repository, database, CI/CD, OpenAPI, and observability foundations inside I1.
4. Run license review on candidate templates before any package is described as a shipped open-license template.
5. Build and acceptance-test I1 before starting the System Builder; treat its package and evaluation contracts as versioned interfaces.
6. Prototype the I2 System Builder workflow and the future I4 phone sheet as validation artifacts, but do not implement character state before I2 proves the package model usable.
7. Run five moderated creator tests during I2 and measure time to first published playable system.
8. Create the ownership authorization table in I3, then extend it with campaign membership, audience, and GM-policy cases before I6 implementation.
9. Keep the I5 Player app campaign-free; add all player campaign workflows together with their backend support in I6.
10. Resolve OD-01 discovery before G4 picker acceptance; resolve OD-02, OD-03, and OD-08 before I6; settle the GM visibility policy before I7. Keep commercial features and a public catalog outside the critical path.

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
