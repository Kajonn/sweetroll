# I6 Campaign Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the backend-only campaign workflow, including secure integration with existing character commands and return of adopted characters on departure.

**Architecture:** Campaigns owns membership, invitations, placement and audience policy; Characters retains sheet commands and authoritative rolls. Narrow internal policy/placement dependencies share PostgreSQL transactions without HTTP orchestration or a second rules engine. Every sensitive response, including replay, is authorized for its original placement scope.

**Tech Stack:** Node.js 24, TypeScript, Fastify/TypeBox, PostgreSQL 17, Vitest, generated OpenAPI and web client types; existing deterministic authentication and license-neutral fixtures.

**Spec:** [Campaign backend design](../specs/2026-09-09-i6-campaign-backend-design.md). Read the complete spec and `design_v2.md` Section 17.8 before executing any task.

## Global Constraints

- Owner-approved prerequisite exception: backend development and HTTP verification may precede full I5 acceptance. No production deployment, I5 closure or full I6 acceptance is authorized by this plan.
- OD-03 is deferred: campaign/co-GM roles grant no system-authoring permissions. Preserve current creator ownership and revision-safe saves.
- OD-08 launch selection/licensing is deferred: use existing license-neutral fixtures and accessible published versions, not claimed licensed launch templates.
- No Player campaign UI, GM app/session-board endpoint, outbox/email, media, display credentials or campaign upgrades.
- Active GMs see attached sheet state, not other actors' owner-only notes/private rolls. No visibility toggle.
- Adopt only an exact version match. Return the same character with current sheet values to the original owner on departure/removal; retain campaign history in its original scope.
- All mutation retries preserve execution identity; sensitive replay requires current authorization. Invitation issue/rotation replay contains metadata only, never stored plaintext.
- Keep ordinary character commands as the offline protocol. Preserve published packages, standalone IDs, existing character routes and reference systems.
- Use `apply_patch` for manual edits. Do not commit or push unless the owner requests it. Work in an isolated worktree at execution time; preserve existing local documentation changes.
- Integration execution must retain `--no-file-parallelism`; never count database-skipped tests as passing acceptance.

## File Map and Dependency Order

New production files:

| File | Responsibility |
| --- | --- |
| `src/campaigns/index.ts` | Public typed command/read interface and factory; coordinates workflows |
| `src/campaigns/policy.ts` | Internal current membership/audience/character capabilities and replay authorization |
| `src/campaigns/persistence.ts` | Scoped SQL and campaign aggregate transaction ownership |
| `src/campaigns/invitations.ts` | Token generation/hash, issue/rotation/consumption and secret-free receipts |
| `src/campaigns/content.ts` | Content/grants/activity projections and bounded export workflows |
| `src/characters/campaignPlacement.ts` | Internal character placement/return operations on an existing `PoolClient` |
| `src/transport/http/campaigns.ts` | TypeBox schemas, thin route handlers and exported route definitions |
| `migrations/0012_campaigns.sql` | Campaign policy/membership base tables |
| `migrations/0013_campaign_character_scope.sql` | Character ownership union, controllers, placement/history scope |
| `migrations/0014_campaign_invitations.sql` | Single-use invitations and recovery receipts |
| `migrations/0015_campaign_content_activity.sql` | Content/grants/source-scoped activity and export |
| `migrations/0016_campaign_roll_audiences.sql` | Campaign roll audiences and atomic activity references |

Existing integration points:

- `src/characters/index.ts`, `persistence.ts`, `idempotency.ts`, `export.ts`, `migration.ts`: current ownership, receipts, state/history and transaction paths.
- `src/systems/runtime.ts`: existing normalized roll audience is only `owner_only`; do not make Runtime a campaign policy engine.
- `src/transport/http/characters.ts`, `openapi.ts`, `src/bootstrap/http.ts`: character schema updates, explicit campaign route-definition registration and dependency wiring.
- `src/platform/config.ts`: typed configurable bounds, with validation in `src/platform/config.test.ts`.
- `tests/integration/i3-app.ts`: existing fixture embeds `I3_SCHEMA_DDL`; keep it consistent with additive migrations while retaining historical fixture behavior.
- `scripts/generate-system-contracts.ts`, `docs/contracts/openapi-v1.json`, `web/src/api/schema.d.ts`: contract generation/check. Never manually edit generated output.

Tasks execute in numeric order. Review each task's authorization and tests before starting the next. No route is registered in production until its policy/transaction path is implemented and tested. Migration numbers are reserved here against latest `0011_user_preferences.sql`; recheck at execution and renumber new files if another migration has landed, never edit an applied migration.

## Test Harness and Commands

All shell commands below run from the repository root unless marked `web/`. Set `TEST_DATABASE_URL` to the isolated test PostgreSQL database. Start the existing service with `docker compose up -d --wait postgres` if needed; do not use a production database. Integration files skip without this environment variable, so verify nonzero executed counts.

The new `tests/integration/i6-app.ts` fixture exports:

```ts
type TestActor = { actorId: string; cookie: string };
type I6Harness = {
  app: FastifyInstance;
  pool: Pool;
  users: { gm: TestActor; player: TestActor; other: TestActor; outsider: TestActor };
  versionId: string;
  otherVersionId: string;
  close(): Promise<void>;
};
export function buildI6Harness(): Promise<I6Harness>;
```

Build on existing `createI3Schema`, `createI3Pool`, `buildI3App` and `dropI3Schema`. Extend the fixture to inject Campaigns, authenticate four actors through the deterministic adapter, and publish fixture versions through SystemAuthoring rather than inserting fake version bytes. Reuse the publication steps from `character-http-acceptance.test.ts`; its helpers are local, not imports. `otherVersionId` is a genuinely different published version for mismatch tests. Add migration-backed coverage independently: embedded fixture DDL is not proof production migrations work.

For HTTP snippets, `h` is the awaited harness, `gm`/`player` are its user records, and resource IDs/revisions come from preceding successful HTTP responses in the same test, never guessed constant revisions. Each new test uses `beforeAll`/`afterAll` to create/drop its own schema and close app/pool. Routes in `app.inject` omit `/api`; that prefix belongs to the external proxy. Mutation inputs use the spec's camelCase preconditions and `idempotencyKey`. Preserve the existing transport result envelope when mapping Module results.

## Task 1: Reproduce Existing Replay Authorization and Protect Standalone Behavior

**Files:** Modify `src/characters/index.ts`, `src/characters/idempotency.ts`, `src/characters/persistence.ts`; test `tests/integration/character-replay-authorization.test.ts`, `tests/integration/characters.test.ts`.

**Interfaces:** Consume `Characters.apply(ctx, CharacterCommand)`, `manage`, `exportCharacter`, existing `RequestContext { actorId, requestId }`, and `claimExecution`. Produce current-authorization-before-disclosure behavior without changing deterministic execution/receipt retention.

- [ ] Add regression tests: execute an action as owner A, transfer to B using the existing management contract, replay as A, and verify no saved sheet/roll is returned. Repeat for recovery/export and migration-result paths. Verify B can read the transferred sheet and A's command is not executed again.

```ts
const command = {
  kind: 'executeAction' as const, characterId, actionId,
  inputs: {}, expectedRevision, idempotencyKey: randomUUID(),
};
const first = await handle.characters.apply(ctxA, command);
expect(first.ok).toBe(true);
// Complete the tested ownership-transfer operation before replaying.
const replay = await handle.characters.apply(ctxA, command);
expect(replay.ok).toBe(false);
```

- [ ] Run `npx vitest run tests/integration/character-replay-authorization.test.ts --no-file-parallelism`; confirm the test fails because replay currently precedes owner lookup, not because fixture setup failed.
- [ ] Separate completed-execution detection from sensitive response disclosure. Reauthorize before `replayStoredOutcome`; use existing generic inaccessible errors. Keep same-owner successful replay byte-stable. Do not re-run Runtime on denied replay.
- [ ] Run the new file plus `tests/integration/characters.test.ts` and `tests/integration/character-concurrency.test.ts`. Review command-status/expired-receipt paths, not only successful action replay.
- [ ] Review checkpoint: no standalone data loss, altered dice, or duplicate effects; enumerate every Characters public method in a test matrix for later campaign extension.

## Task 2: Campaign Aggregate, Policy Base and Production Migration

**Files:** Create `migrations/0012_campaigns.sql`, `src/campaigns/index.ts`, `policy.ts`, `persistence.ts`, `tests/integration/campaigns.test.ts`, `tests/integration/i6-app.ts`; modify `src/platform/config.ts`, its tests, `tests/integration/migrations.test.ts`, `tests/integration/i3-app.ts`.

**Interfaces:** `createCampaignsModule({ pool, limits, now?, newId? })` produces `Campaigns`. Establish public `create`, `open`, `list`, `update`, `archive`, `recover`, `listMembers`, `changeRole`, `removeMember` methods with `RequestContext` and typed command inputs matching Section 8 of the spec. Task 4 adds the required `charactersPlacement` dependency before any attachment is possible; do not add an optional dependency or a silent no-op implementation.

- [ ] Write tests creating a campaign from a real accessible fixture version; assert creator is immutable active owner, outsider gets `not_found`, draft/inaccessible version is rejected, list excludes other campaigns, and archive prevents joins/mutations while allowing reads/recovery/departure.
- [ ] Run `npx vitest run tests/integration/campaigns.test.ts tests/integration/migrations.test.ts --no-file-parallelism` and record expected missing-campaign behavior.
- [ ] Implement metadata, active/archived lifecycle, relational roles, membership generation, campaign revision and access revision. Check accessible known versions using the same owner/public/link predicate as Characters, without enumerating unlisted systems. Create metadata/membership/audit/receipt atomically.

```sql
CHECK (revision > 0),
CHECK (access_revision > 0),
CHECK (status IN ('active', 'archived'))
```

- [ ] Add validated limits to config: page default 25/max 100; campaign members max 100; attached characters max 200; title max 200 characters; description max 10000 characters. Reject oversize inputs before transaction work; use these supported limits in final load tests rather than quietly lowering them.
- [ ] Run migration coverage from pre-I6 schema and fresh schema. Verify rollback on invalid version/membership insert, CHECK/FK/index behavior, checksum-safe upgrade, and unchanged standalone data.
- [ ] Review checkpoint: creator/co-GM roles never authorize system draft read/write; no empty campaign scaffold is exposed publicly.

## Task 3: Membership Races, Owner Protection and Read Policy

**Files:** Modify `src/campaigns/index.ts`, `policy.ts`, `persistence.ts`; create `tests/integration/campaign-membership.test.ts`.

**Interfaces:** `changeRole` and `removeMember` require `expectedCampaignRevision` and `idempotencyKey`; `listMembers` takes bounded cursor/limit. Internal campaign policy resolves active membership and capabilities on the caller's transaction client, not an independently pooled connection.

- [ ] Test GM versus player/co-GM/outsider permissions; owner cannot leave/demote/remove self; only owner promotes co-GMs; co-GMs cannot modify peers/owner or escalate themselves. A player may self-leave. Rejoin uses a new membership generation and cannot reactivate old grants/controllers.

```ts
expect(await Promise.all([changeAtRevision, removeAtSameRevision]))
  .toEqual(expect.arrayContaining([expect.objectContaining({ ok: false })]));
```

- [ ] Run `npx vitest run tests/integration/campaign-membership.test.ts --no-file-parallelism`; verify actual stale-revision and authorization failures, using synchronized promises/barriers rather than sleeps.
- [ ] Implement campaign-first lock order, expected-revision checks after authorization, revision/access-revision increments and minimal self-leave replay acknowledgement. All source selection and permission reads share a consistent snapshot.
- [ ] Add role/membership/campaign cursor scoping tests, `no-store` response requirements for later adapter coverage, and list bounds with deterministic ties. Never paginate then filter unauthorized rows in memory.
- [ ] Re-run Task 2-3 suites. Review checkpoint: removal has a transaction hook for Task 4 return; no public route is registered until that hook is real.

## Task 4: Character Ownership Scope and Atomic Placement/Return

**Files:** Create `migrations/0013_campaign_character_scope.sql`, `src/characters/campaignPlacement.ts`, `tests/integration/campaign-placement.test.ts`; modify `src/characters/index.ts`, `persistence.ts`, `idempotency.ts`, `export.ts`, `migration.ts`, campaign factory/persistence, fixture DDL and migration tests.

**Interfaces:** Internal `createCampaignPlacement({ pool, runtime })` supplies typed `createInCampaign(client, input)`, `assign(client, input)`, `claim(client, input)`, `adopt(client, input)`, `returnForMember(client, input)` operations on a supplied `PoolClient`. `input` contains validated actor, campaign ID, membership generation and character/campaign revision preconditions; no method starts/commits its own transaction. Add required `charactersPlacement` to `createCampaignsModule` construction and update every caller. Campaigns alone orders membership/placement transactions. Characters authorization receives the same policy resolver and supports ownership union DTOs without removing existing standalone response fields. Campaign character initialization is prepared through Runtime before opening the final transaction; `createInCampaign` only rechecks and persists that prepared resolution while locked.

- [ ] Add migration tests backfilling standalone history/receipts and preserving original IDs/owner IDs, constraints rejecting neither/both ownership scopes, and controller membership in a different campaign. Test zero-controller campaign characters without dummy owners.
- [ ] Run `npx vitest run tests/integration/campaign-placement.test.ts tests/integration/migrations.test.ts --no-file-parallelism`; verify missing scope/placement causes failures.
- [ ] Add ownership union, placement generation/history, return-owner invariant and controllers/claim designations. Existing `ownerId` remains populated for standalone views; attached views explicitly represent campaign custody and controllers rather than inventing an owner user.

```sql
CHECK ((owner_id IS NOT NULL AND campaign_id IS NULL)
    OR (owner_id IS NULL AND campaign_id IS NOT NULL))
```

- [ ] Refactor only character transaction bodies needing participation to accept a caller-owned client. Keep standalone transaction wrappers. Lock campaign then sorted character IDs; if standalone placement changed after lookup, release/retry with correct order rather than locking campaign after character.
- [ ] Test personal adoption with exact pin, own consent/disclosure and preserved state; mismatched version, other user's character, removed owner and archived target fail. Test designated claim only, concurrent claim once, shared controllers and role promotion preserving return-owner controller.
- [ ] Implement removal's all-or-nothing return: membership removal, controller/grant/claim cleanup, current-state detachment, revision/generation increments, audit and receipt. Campaign-created sheets stay; adopted sheets return to original owner; former controllers/GM lose live access. Inject failure after first of multiple returns and assert total rollback.
- [ ] Verify archived departure, concurrent sheet write versus departure, pre-attachment migration preview invalidation and old queued commands after return. Attached migration/rollback/transfer/personal duplication must deny, not repin/copy.
- [ ] Re-run placement, migration, concurrency and duplicate suites. Review checkpoint: no owner-only helper authorizes attached data and no migration history leaks through exports.

## Task 5: Existing Character Endpoint and Replay Policy Matrix

**Files:** Modify all Task 4 character files and `src/transport/http/characters.ts`; create `tests/integration/campaign-character-authorization.test.ts`, extend `character-replay-authorization.test.ts`; update `src/transport/http/characters.test.ts`.

**Interfaces:** Extend existing `CharacterView`/summary/reconciliation with placement identity as needed; `Characters.apply/manage/open/list/listActivity/exportCharacter/previewMigration/commitMigration/rollbackMigration/duplicate` retain owning entry points. Saved results include original placement and policy generation. Add documented non-sensitive `result_unavailable` for committed results whose original scope cannot safely be replayed.

- [ ] Table-test every public Characters method from Task 1 against owner/co-GM/controller/unassigned player/removed/outsider, both personal and attached. Test direct URLs, library searches, command recovery, archive/recover, transfer, duplicate, exports and migrations, not just campaign-prefixed routes.
- [ ] Run `npx vitest run tests/integration/campaign-character-authorization.test.ts tests/integration/character-replay-authorization.test.ts --no-file-parallelism` and confirm prior owner-only paths fail matrix cases.
- [ ] Compose campaign capabilities into current entry points and transaction rechecks. History and saved responses use original scope, never current attachment alone. Reauthorize before conflict details, cached validators, replay and download output.

```ts
// A return does not convert campaign-era receipts into personal receipts.
expect(returnedSheet.ownerId).toBe(originalOwner.actorId);
expect(campaignReceiptReplay.ok).toBe(false);
expect(returnedExport.migrationLineage).not.toContainEqual(campaignMigration);
```

- [ ] Ensure pre-adoption history is hidden while attached and available after return; campaign history remains inaccessible to departed actors. Mutation replay after rejoin cannot reuse old membership generation or execute a second time.
- [ ] Run root/web typechecks after DTO changes; update consumers only for explicit union handling, no campaign UI. Review checkpoint: same-owner standalone receipts stay deterministic and the current sheet renderer/session still works.

## Task 6: Single-Use Invitations and Lost-Response Recovery

**Files:** Create `src/campaigns/invitations.ts`, `tests/integration/campaign-invitations.test.ts`; modify campaign factory/persistence and configuration tests.

**Interfaces:** `issueInvitation`, `listInvitations`, `reviewInvitation`, `acceptInvitation`, `declineInvitation`, `rotateInvitation`, `revokeInvitation` consume Section 5/8 spec input shapes. Review returns invitation revision and access revision; accept/decline requires both plus campaign ID/token/key. Administrative mutations use campaign/invitation revisions. Secret-bearing success DTO is distinct from metadata-only replay DTO with `tokenUnavailable: true`.

- [ ] Test initial issue, same-key lost-response replay, rotation invalidating old token, lost rotation response, and scanning receipt/log payloads for token absence. Test owner versus co-GM role restrictions and bounded expiry (default 7 days, maximum 30 days, strictly future expiry).

```ts
expect(replayedIssue).toMatchObject({ invitationId, tokenUnavailable: true });
expect(JSON.stringify(storedReceipt)).not.toContain(initialToken);
expect(replayedIssue).not.toHaveProperty('token');
```

- [ ] Run `npx vitest run tests/integration/campaign-invitations.test.ts --no-file-parallelism`; confirm failures distinguish incomplete invitation behavior from authentication setup.
- [ ] Generate random 32-byte tokens and store hashes only. Redact token-bearing bodies and hashes, including error logs. Implement non-secret receipt replay and explicit revisioned rotation; no recoverable token encryption or deterministic regeneration.
- [ ] Lock campaign then invitation for globally single-use consumption. Review is read-only; changed access/invitation revision requires re-review. Two different actors racing accept/decline produce one consumer. Already-active members cannot elevate with an invite. Old accepted token cannot recreate removed membership.
- [ ] Verify expiration, revoke, rotation, membership rejoin, receipt expiry and administrative revoke of consumed invite. Rate-limit issue/review/consume using existing HTTP mechanism if available, otherwise a bounded adapter-level limiter; test rejection without logging tokens.
- [ ] Review checkpoint: one-time response exception is documented in generated contracts at Task 9, and no secret is serialized into generic receipt helpers.

## Task 7: Content, Grants and Source-Scoped History

**Files:** Create `migrations/0015_campaign_content_activity.sql`, `src/campaigns/content.ts`, `tests/integration/campaign-content.test.ts`, `tests/integration/campaign-export.test.ts`; modify campaign factory/policy/persistence, fixture DDL and migration tests.

**Interfaces:** `createContent`, `openContent`, `listContent`, `updateContent`, `deleteContent`, `recoverContent`, `replaceGrants`, `listActivity` use current membership and source visibility. Grant replacement takes `expectedContentRevision`; transaction increments content/access revisions together. Only minimal source references belong in campaign activity payloads.

- [ ] Test `gm_only`, `all_players`, `selected_players`, `owner_only` across all roles, including owner-only creator removal and GM inability to export/read another actor's private note. Test default audiences, bounded tags/body, soft-delete/recover and atomic grant/audience changes.
- [ ] Run `npx vitest run tests/integration/campaign-content.test.ts tests/integration/migrations.test.ts --no-file-parallelism` and confirm missing-policy failures.
- [ ] Implement relational content visibility and same-campaign membership grants. Body limit 100000 characters; max 20 tags of 50 characters; max 100 grants per content item. Validate before writes; plain text only. Players author/edit/delete their own owner-only notes; inaccessible notes cannot be administratively shared by guessing ID.
- [ ] Store activity references and apply current source policy before pagination. Request IDs correlate multiple events; do not make request ID globally unique per activity event.

```ts
expect(eventsAfterGrantRemoval.map(event => event.sourceId))
  .not.toContain(selectedNoteId);
expect(outsiderRead.statusCode).toBe(404);
```

- [ ] Test grant removal versus content patch/reads, cross-campaign grants, membership rejoin and cursor reuse after narrowing. Review checkpoint: no broad event contains private note body, sheet state or roll bindings.
- [ ] Before HTTP registration, implement and test `exportCampaign(ctx, { campaignId, idempotencyKey })` as a versioned, deterministic authorized snapshot. Bound export to configurable 10 MiB UTF-8 and 10000 projected records; reject excess without partial success. Exclude inaccessible notes, personal pre-adoption history, token/hash/credentials and receipts. Task 8 extends this projection's tests to campaign rolls; Task 10 verifies it through HTTP. No pending export stub may be wired in Task 9.

## Task 8: Campaign Roll Audiences and Atomic Activity

**Files:** Modify `src/characters/index.ts`, `persistence.ts`, `idempotency.ts`, `src/systems/runtime.ts`, `src/transport/http/characters.ts`, campaign policy/content; create `tests/integration/campaign-rolls.test.ts`; extend runtime/HTTP tests only where contracts change.

**Interfaces:** `CharacterActionCommand.audience?: 'owner_only' | 'gm_only' | 'campaign'`; standalone accepts only `owner_only`. Characters composes normalized runtime output with authorized audience; Runtime never queries membership. Execution metadata fixes effective default audience and original placement at first claim.

- [ ] Test actor-private, GM-only and campaign rolls with two controllers and multiple GMs; sheet readability must not reveal private inputs/bindings. Standalone rejects campaign audience. Missing audience resolves once from campaign default; later default changes do not change retry dice or audience.

```ts
const result = await characters.apply(
  { actorId: player.actorId, requestId: randomUUID() },
  { kind: 'executeAction', characterId, actionId, inputs: {},
    audience: 'owner_only', expectedRevision, idempotencyKey: randomUUID() },
);
expect(result.ok).toBe(true);
```

- [ ] Run `npx vitest run tests/integration/campaign-rolls.test.ts --no-file-parallelism`; verify current owner-only DB/runtime/DTO assumptions are exposed.
- [ ] Use Task 7 audience constraints and original-scope columns; commit authoritative roll, character result, campaign activity reference and receipt in one transaction. Keep runtime calculation outside campaign lock, recheck placement/membership before commit. Roll generation failure or revoked permission produces no partial event.
- [ ] Test changed explicit audience with same key yields mismatch; omitted-default replay uses recorded effective audience; return hides campaign history while current sheet remains available. Re-run original roll/idempotency/load suites across d20, PbtA and d6-pool fixtures.
- [ ] Extend Task 7 export tests to exclude other actors' private rolls/bindings while retaining permitted campaign/GM-only rolls. Use the same source policy as activity; no unrestricted export query.
- [ ] Review checkpoint: no second rules engine, changed authoritative entropy scheme or auto-applied roll outcomes.

## Task 9: Complete HTTP Contracts, Bootstrap and Generated Types

**Files:** Create `src/transport/http/campaigns.ts`, `src/transport/http/campaigns.test.ts`; modify `src/transport/http/openapi.ts`, `openapi.test.ts`, `src/bootstrap/http.ts`, `tests/integration/i6-app.ts`; regenerate `docs/contracts/openapi-v1.json`, `web/src/api/schema.d.ts` through existing script.

**Interfaces:** `buildCampaignsRoutes({ campaigns })` plus `campaignsRouteDefinitions` follows the Characters adapter. Register definitions explicitly in OpenAPI; app registration alone does not populate the document. Bootstrap injects one shared campaign policy/placement implementation into Campaigns and Characters, never two independent authorization copies.

- [ ] Add thin authentication/wire-decoding/error-mapping tests for every Section 8 spec operation. Include required preconditions, unknown enum rejection, size limits, cursor bounds, 404 collapse, `result_unavailable`, no-store and token-safe POST bodies. Verify review's revisions are sufficient to construct accept/decline as a nonmember.
- [ ] Run `npx vitest run src/transport/http/campaigns.test.ts src/transport/http/openapi.test.ts`; expect missing route/schema failures before wiring.
- [ ] Implement the complete inventory: campaign create/list/read/update/archive/recover; members list/role/remove; invitation issue/list/rotate/revoke/review/accept/decline; character create/list/assign/claim/adopt; content create/list/read/update/delete/grants/recover; activity and export. Mutations with DELETE follow the established transport convention for explicit revision/key input, documented in TypeBox/OpenAPI.

```ts
app.register(buildCampaignsRoutes({ campaigns }));
// openapi.ts must consume campaignsRouteDefinitions alongside existing arrays.
```

- [ ] Add `Cache-Control: no-store` for campaign and attached/history responses and authorize before conditional responses. No token URL parameters, private payload caches, or session-board endpoint. Preserve test/prod auth separation.
- [ ] Run `npm run contracts:generate`, `npm run contracts:check`, `npm run typecheck`, `npm run web:typecheck`. Fix generated DTO consumers without changing the Player navigation or exposing half-built campaign screens.
- [ ] Review checkpoint: every spec route has a handler, operation ID, concrete request/result schema and direct-object-reference test; no placeholder production handler is registered.

## Task 10: Filtered Export and HTTP Exit Demonstration

**Files:** Extend `tests/integration/campaign-export.test.ts`; create `tests/integration/campaign-http-acceptance.test.ts`. Modify `src/campaigns/content.ts`, `index.ts`, `persistence.ts` only for defects reproduced through these tests.

**Interfaces:** `exportCampaign(ctx, { campaignId, idempotencyKey })` returns versioned bounded JSON from a consistent authorized snapshot. Current audience policy applies to every source; receipt replay additionally checks original policy generation. Export bound: maximum 10 MiB UTF-8 serialized payload and 10000 projected records; configurable, reject without partial success.

- [ ] Test deterministic ordering and exclusion of other actors' owner-only notes/private rolls, token/hash/credentials, personal pre-adoption history and private receipts. Compare equivalent authorized snapshots, not randomly different export timestamps/IDs.
- [ ] Run `npx vitest run tests/integration/campaign-export.test.ts --no-file-parallelism`; verify deliberate inserted private data is absent by content assertion, not merely a snapshot shape test.
- [ ] Verify the Task 7-8 projection through HTTP, including byte/record budget errors and authorization on completed replay. Fix any reproduced mismatch without adding an archive job/outbox or treating GM export as an unrestricted database dump.
- [ ] Write the full HTTP demo: provision/review/join; create/claim/share controllers; adopt with disclosure; content/audience rolls; concurrent departure/write; return current state and exact pin; denied prior campaign URLs/history/receipts; safe standalone export afterward.

```ts
expect(returned.ownerId).toBe(player.actorId);
expect(returned.systemVersionId).toBe(adopted.systemVersionId);
expect(returned.state).toEqual(lastCommittedState);
expect(removedCampaignRead.statusCode).toBe(404);
```

- [ ] Run `npx vitest run tests/integration/campaign-export.test.ts tests/integration/campaign-http-acceptance.test.ts --no-file-parallelism`. Use no direct SQL for ordinary workflows; SQL inspection is allowed only to prove persistence invariants/secrecy.
- [ ] Review checkpoint: campaign-created characters stay attached, adopted characters return, campaign history never becomes personal, and no second invocation restores membership.

## Task 11: Load, Regression and Backend Acceptance Record

**Files:** Create `tests/integration/campaign-load.test.ts`, `docs/acceptance/i6-backend-2026-09-09.md`; update spec/GUI plan status only with actual evidence.

**Interfaces:** Ordinary HTTP commands from Task 9, existing integration isolation/load budgets and current production-offline suite. No new testing-only auth path or custom mutation endpoint.

- [ ] Add four-player session bursts with concurrent reads/bumps/rolls, verify exactly-once effects, p95 ordinary requests below 300 ms and bounded rule actions below 500 ms under existing test conditions. Test removal/return at supported member/character limits; report latency rather than weakening assertions to force green.
- [ ] Run `npx vitest run tests/integration/campaign-load.test.ts --no-file-parallelism`; resolve correctness failures before performance tuning. Verify query counts/response bounds and absence of unbounded list/export reads.
- [ ] Run the complete required gates, capturing command, environment, commit/tree and executed/skipped counts:

```bash
npm test
npm run test:integration
npm run contracts:check
npm run typecheck
npm run build
npm run web:test
npm run web:typecheck
npm run web:build
npm run web:test:e2e
npm run web:test:offline
```

- [ ] Provision browser prerequisites using the existing Playwright configs and test databases; `TEST_DATABASE_URL` is for integration, `DATABASE_URL` for bootstrap. Built offline suite uses its configured isolated database/ports. Do not call a skipped suite acceptance evidence.
- [ ] Audit log/receipt secret absence, all existing Characters bypass paths and no system-authoring authority from campaign roles. Record migration upgrade results, rollback injection evidence, HTTP workflow and load distributions.
- [ ] Write backend-only acceptance with production sign-in, Player campaign UX/cache purge, licensed launch templates and physical devices explicitly unaccepted. Do not mark G7/I6 complete or imply deployment permission.
- [ ] Final review of diff and tests before handoff. Commit/push only on a new explicit owner request.

## Plan Self-Review and Handoff

Coverage: spec ownership/departure/pins -> Tasks 4-5; current replay -> Tasks 1/5/6; invitations -> Task 6; relational policy/concurrency -> Tasks 2-4/7; roll pipeline -> Task 8; complete routes/generated types -> Task 9; source-filtered export -> Task 10; acceptance/security/performance -> Task 11. Task 9 wiring waits for real policy implementations. All new tests use real PostgreSQL for invariants, not only mocked repositories.

This plan records required work, not executed evidence. At execution start, verify migration numbers, exact existing DTOs and test fixture schemas against the actual tree. If a proposed signature cannot preserve a published contract, stop and resolve that conflict before implementing; do not invent compatibility shims or change owner decisions silently.
