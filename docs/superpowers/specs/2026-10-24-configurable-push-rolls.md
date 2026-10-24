# Configurable pushes — slice C contract

Status: design contract for implementation after merged B, reviewed against main `759323a529a50569a22b5d3db9172bb81a153d29` (PR #22). This document specifies the next delivery; it does not enable pushes or claim implementation/acceptance. Follow the [C execution plan](../plans/2026-10-24-configurable-push-rolls.md) and parent [dice-pool plan, Task 7](../plans/2026-10-21-dice-pool-reliability.md#task-7--design-and-deliver-configurable-pushes-slice-c-tdd).

## 1. Version and supported policy

Document/package **1.2** adds optional `pushPolicy` to entity and non-nominal template-granted roll actions. Grammar remains **0.2**; a push is a command over saved dice, never a formula function. Packages 1.0 and 1.1 retain their existing decoding, checksums, RNG order, results and receipts. No backfill of push capability onto old rolls, including grouped 1.1 rolls. Old engines reject 1.2 explicitly. Clone/import/export preserve 1.2. Enabling a policy promotes a draft to 1.2; editing groups or removing a policy never silently downgrades it.

Example action member (the other action fields are unchanged):

```json
{
  "pushPolicy": {
    "version": "1.0",
    "maxAttempts": 2,
    "successThreshold": 1,
    "allowOnSuccess": true,
    "groups": [
      { "groupId": "attribute", "lockedFaces": [1, 6], "reportedFaces": [] },
      { "groupId": "skill", "lockedFaces": [6], "reportedFaces": [] },
      { "groupId": "gear", "lockedFaces": [1, 6], "reportedFaces": [1] }
    ]
  }
}
```

Policy version is mandatory. `maxAttempts` is an integer 1–10 and counts accepted child rolls after the root, not HTTP attempts. `successThreshold` is an explicitly authored finite number between -1e9 and 1e9; a roll is successful for push eligibility iff its factual scalar total is at least that threshold. `allowOnSuccess` is required; no implicit global success mode is inferred from grouped operations. Authors of sum rolls choose a meaningful threshold too.

There are 1–32 unique policy groups. Each references an existing, explicitly named dice group in the action's compiled expression. `lockedFaces` and `reportedFaces` are unique integer arrays, each bounded by the platform's 1,000-side ceiling, and every face must lie within the referenced group's sides. An empty array is legal. Unknown/duplicate groups, duplicate/out-of-range faces, unknown policy versions and policies on resource/nominal actions fail assessment with a bounded path diagnostic. No arbitrary predicates or user code.

For this first C delivery, push-enabled expressions are additive numeric combinations of direct sum/count dice groups, scalar-only terms, and finite literal scaling (absolute effective coefficient at most 1e6). Only explicitly named groups can be targeted by the policy. Success thresholds on counted groups remain the group's own thresholds. Push-targeted groups cannot use keep-high/low. Scalar-only count/binding arithmetic is frozen from the original successful roll. Dice-dependent divisors, count/side/threshold expressions, conditionals and unsupported nonlinear forms are rejected when a policy is enabled. Existing custom formulas stay editable and valid without a policy; the editor explains why a particular formula cannot enable pushing and never rewrites it automatically. This bounded policy avoids outcome-dependent arithmetic failures becoming opportunities to sample new randomness with fresh keys.

Unlisted groups, including anonymous groups, are retained unchanged. Pushable dice are the kept dice in a listed group whose current face is not locked. Newly rolled locked faces stay locked on the next push. Empty pools, all-locked pools and pools with no eligible listed dice cannot be pushed; an empty push does not consume an attempt. No alternate empty-push policy is introduced.

Existing package/expression/dice ceilings still apply to every combined result (100 dice, 1,000 sides, 256 AST nodes, depth 32, 1,024 source bytes, or lower effective package limits). A push never adds dice. At most ten accepted pushes per chain bounds cumulative work.

## 2. Authoritative source and immutable evaluation

A successful 1.2 action with a policy creates the root roll, attempt 0, with an internal immutable push snapshot. The snapshot records version/checksum, entity/action/expression IDs, normalized field/input bindings actually used, output template, policy, source kind and entry provenance, and placement scope. Original evaluated counts/sides and stable dice IDs come from the stored structured result. The initial inputs and computed values are frozen; later field, input, item-value or quantity edits do not rebuild the pool.

Clients submit a saved parent roll reference only. Systems resolves the immutable pinned package and evaluates a child from the original normalized bindings plus the parent's factual dice. Evaluation consumes deterministic randomness derived from the **new server-owned command execution ID**, in original AST/group/die order, only for eligible dice. Locked and unlisted dice consume no RNG draws and preserve ID/value/sides/kept state. Eligible dice keep their IDs and sides; only value/success/reduction metadata may change. The original expression, scalar bindings and output template are reused to recompute group totals, calculation terms, final scalar and output. Parent/root rows and their receipts are never edited.

The pure evaluator receives a validated authoritative snapshot; it performs no database, campaign or browser work. It checks dice/group identity, ordering, budgets, policy applicability and parent attempt bounds. A corrupt/inconsistent stored snapshot fails closed without a partial result. It must not reroll the entire pool then overwrite locked values, use current bindings or invoke preview randomness.

Accepted children record versioned public lineage: `rollId`, `rootRollId`, `parentRollId`, `attempt`, `maxAttempts`, `rerolledDiceIds`, and face outcomes per configured reported group/face. A face outcome gives both its count in the combined pool and its count among dice rerolled in this child. This distinction supports manual bookkeeping without silently applying damage, counters or resource effects. Root outcomes have an empty rerolled-ID list; reports are factual and do not instruct automatic effects. No secret, seed, internal package snapshot, idempotency key or execution lease is exposed.

## 3. Availability and changes since the original roll

A fresh availability response is advisory; POST rechecks it under transaction locks. It returns `canPush`, the latest character revision, next/max attempt, eligible dice IDs and one bounded reason when unavailable. Cached availability is marked stale and cannot authorize a mutation.

| Current condition | Decision |
|---|---|
| Active standalone current owner, same original owner/placement scope | Eligible subject to source, policy and dice checks |
| Attached active GM/co-GM or active controller, with parent-roll read permission | Eligible subject to the same checks; sheet write alone is insufficient |
| Changed character/item values or inputs, same action source and pinned rules | May push the saved pool using original values; show that they are original values |
| Source entry/action absent, custom/campaign data-only entry, or nominal action | Unavailable; data-only entries never gain mechanics |
| Entry restored with the same entry ID, system template and source provenance | May resume if all other current checks pass; no new pool is inferred |
| Current version/checksum differs from the root | Unavailable; no reinterpretation against upgraded rules |
| Rollback restores the exact root version/checksum and applicable source | May resume if current placement, audience and attempt checks pass; rollback neither deletes history nor restores consumed attempts |
| Archived character/campaign | Read/history remain subject to current authorization; pushing unavailable |
| Adoption, return or re-placement changes placement generation; ownership differs | Old chain unavailable in the new scope, even if an old roll UUID is known |
| Parent already has an accepted child | Unavailable; only that child can be the next parent |
| Attempt exhausted, disallowed success, no eligible dice | Unavailable with an explanatory reason |
| Outsider, revoked membership/controller, hidden parent, cross-character UUID | Non-disclosing not-found response |

Validate action ownership through the existing entity sheet placement or `findGrantedAction` and current entry/slot validation. Matching an `actionId` string alone is insufficient. Check the original granted source provenance as well as the entry ID; personal/campaign data-only entries cannot substitute for a removed system entry.

## 4. Command, receipt and concurrency contract

Proposed routes use the existing Characters module and command result envelope:

- `GET /characters/{characterId}/rolls/{rollId}/push-options`: current authorized availability; no mutation or receipt. Does not disclose a hidden/foreign roll.
- `GET /characters/{characterId}/rolls/{rollId}`: current authorized public saved result for parent/root navigation; never returns the private execution context.
- `POST /characters/{characterId}/rolls/{rollId}/push`: body exactly `{expectedRevision, idempotencyKey}`. Positive integer revision; existing key bounds. Parent ID is part of the hashed request identity together with character ID and expected revision.

Strict schemas reject supplied seed/dice/total/bindings/inputs/action/policy/attempt/eligible IDs/lineage/audience/output metadata with HTTP 400, rather than silently dropping it. The command kind is distinct from execute-action and still uses the existing actor-scoped claim/replay/lease protocol. Root/child IDs are allocated once for the claimed execution and reused on lease reclaim; a lease retry cannot mint a different child or seed.

| Outcome | HTTP / behavior |
|---|---|
| Accepted | 200, existing character-command result with authoritative child roll and lineage |
| Same key/body after commit | 200, same child/dice/IDs/attempt with replay flag, after current reauthorization |
| Key/body mismatch | Existing 409 idempotency mismatch |
| Pending live lease | Existing 409 command-in-progress; retry identical request |
| Stale revision or parent already consumed | 409 conflict; no child/attempt consumed; fresh explicit review required |
| Exhausted/success-blocked/empty/source-or-version-ineligible | 422 invalid-value with bounded push reason; no child/attempt consumed |
| Hidden/foreign/revoked parent or wrong scope | 404, without parent metadata |
| Committed outcome no longer disclosable | Existing 409 result-unavailable or non-disclosing denial, never re-execution |
| Transient server/transport failure | Retain exact uncertain request; resolve through the existing replay protocol |

Ordinary rolls can leave character revision unchanged in current code. Therefore `expectedRevision` **cannot** be the only protection against two different keys consuming one parent.

Commit in the existing lock order: execution claim/row, then campaign when attached, character, root and parent roll. Root/parent locks follow character locking consistently; lock an identical root/parent only once. Recheck current membership, controller/GM capability, lifecycle, revision, placement/version/source, parent read audience, policy, leaf status and remaining attempts under these locks. The root pins policy and lineage; `attempt = parent.attempt + 1` cannot exceed its maximum.

Add database uniqueness on non-null parent roll IDs (one accepted child per parent) and on `(rootRollId, attempt)` for push-capable rows. Scope composite parent/root foreign keys to the same character. These are required even when the application has already checked for an existing child. Distinct-key and distinct-actor races must produce one accepted child, with the loser receiving a definite conflict. Do not return an unrelated winner's receipt under a different key. Map unique-conflict errors deliberately; do not expose them as an indefinite 500 retry loop.

Roll row, immutable lineage/snapshot, character/campaign activity references, audit and completed receipt commit atomically. Failure rolls back all effects, leaving a safely reclaimable pending execution or a finalized definite rejection as appropriate. No resource mutation or ordinary character revision increment is introduced solely to simulate push serialization. Existing unrelated edit/migration concurrency remains intact.

## 5. Audience inheritance and replay

Preserve `actor_id` as the actor who executed each roll for audit. Add a nullable **audience principal** for push-capable rows: root principal is the original root actor; children inherit it. Legacy rows resolve principal as `actor_id`, so existing audience behavior remains unchanged. The principal is server-owned and never a request field.

Evaluate `owner_only`/`gm_only` against this inherited principal, not the latest child executor. With that fixed principal, the existing audiences form a safe order: `owner_only` is narrower than `gm_only`, which is narrower than `campaign`. Each child's effective audience is the narrower of its parent's audience and the current locked campaign default. Standalone stays owner-only. No per-push audience override is accepted. Later default widening cannot widen a chain; later narrowing is applied to the next child. Historical recorded audiences remain historical; current membership, role and placement are still rechecked on reads/replays.

Example: a co-GM pushes a player's GM-only roll and later becomes an ordinary player. That child must not become visible to them merely because they executed it. Keep command actor and audience principal separate throughout history/activity/export and receipts. A GM cannot push another actor's owner-only roll without parent read permission.

If the current default would narrow a readable parent to a child hidden from the executor, availability reports `audience_restricted`; POST rejects without creating a child or consuming an attempt. Parent read permission alone cannot authorize disclosure of the proposed child in a receipt. This check uses the inherited principal and the locked current default inside the commit transaction.

All full-result disclosure paths use the inherited principal: push-options, POST precondition, same-key replay, character activity/cache, campaign roll/activity/export, player and GM results. Existing receipt scope checks cover placement/membership generations but do not by themselves establish this new parent/child audience rule. Explicitly reauthorize roll/principal access before replaying child bytes. A stale or revoked reader gets no dice, bindings, parent/root correlation IDs, eligibility or lineage. Minimized sheet events continue to null hidden roll references. Personal state exports still exclude history.

## 6. Storage and compatibility

Add a new immutable migration after 0023; never edit an applied migration. Planned nullable `character_rolls` members are `parent_roll_id`, `root_roll_id`, `push_attempt`, `push_context_json`, `push_result_json`, and `audience_actor_id`. JSON members distinguish SQL NULL from JSON null and admit objects only. Root rows have self root ID, NULL parent and attempt 0; child rows have same-character root/parent, positive bounded attempt and matching snapshot lineage. Non-push rows leave every new member NULL. Enforce all-or-none/coherent lineage, audience-principal and JSON constraints, same-character foreign keys, and the uniqueness above. Validate the bounded snapshot/result schema on internal decode as well as output serialization.

Separate private execution context from public result metadata. Current grouped breakdown storage remains the source of factual per-die identities. Generate HTTP/OpenAPI/client types from the canonical schemas. Expose public lineage beside optional breakdown only for push-capable rolls; ordinary 1.0/1.1 result and receipt JSON must remain byte-identical. Updating read SQL to project the audience principal must cover campaign paths too, not just the new endpoint.

New clients read old results without fabricating lineage or Push buttons. Old package engines reject 1.2. For a previous browser build using additive response fields, retain its old display and action behavior; absence of a Push control never means permission to create a local reroll. Current service-worker updates must preserve account-scoped cached history and frozen uncertain attempts. A queued push may not be silently downgraded to execute-action by an old client. Unknown attempt kinds fail closed and remain recoverable by a capable build; bump/store a capability discriminator if required by the existing durable-store reader.

## 7. Creator, play and durable uncertainty

Creator controls reuse RollActionEditor/GroupedPoolEditor and template action editing. A disabled-by-default Push section lists named group labels, editable locked/reported face choices, maximum attempts, success threshold and allow-on-success. Show unsupported-expression diagnostics without deleting the custom formula. Use accessible labels, bounded numeric input and existing editor undo/autosave/conflict behavior; no unrelated redesign.

Player and GM result/history surfaces reuse RollBreakdown and add parent/root navigation, attempt/max text, rerolled versus retained dice, manual face reports and an explained Push control. Link navigation reauthorizes destinations and handles inaccessible parents without leaking their metadata. Server options supply current eligibility; controls disable for offline, stale options, pending edits/commands, uncertain outcome, exhausted/locked/source-ineligible/archived states and failed ownership. The server remains authoritative after a stale tab or double click. Retain initial/final result after reload through authorized history, not a new local random simulation.

Pushes are online-only, using the existing per-character durable **OnlineAttempt** machinery shared with lifecycle/migration operations. Persist the complete frozen POST, parent reference, actor/character/account generation and original key before sending. Do not add push to offline-capable EditIntent or automatically create one on reconnect. An already-sent uncertain push is replayed verbatim after reconnect/reload/takeover before any newer write. A timeout, malformed 2xx or failed IndexedDB acknowledgement must retain the original attempt. A conclusive rejection may retire it through existing guarded rules; no fresh-key substitute is automatic.

Acknowledging a child must preserve recoverable authoritative lineage/result before retiring its attempt; confirmed character state alone is insufficient because pushes may leave revision/state unchanged. Use the existing durable history/cache store or a guarded result record in the same acknowledgement transaction. Reload must recover the accepted child even when the UI has not yet fetched Activity.

GM SessionBoard currently calls direct online wrappers; it must participate in equivalent durable uncertain-attempt handling rather than bypass it. Reuse/extract the existing session/attempt coordinator for this path, with the same ownership and account guards. It must not gain a separate weaker retry queue. An expired replay window requires explicit unknown-outcome review, never a silent fresh push; fetching current sheet revision alone cannot prove a push did not commit. Availability/history may locate the child for review but cannot authorize a replacement automatically.

## 8. Deterministic acceptance fixture and gates

Use one bounded, explicitly described mixed pool fixture, not a claim of support for every Year Zero edition:

| Group | Parent faces | Operation | Locked faces | Child with injected eligible draws |
|---|---|---|---|---|
| Attribute d6 | 1, 2, 6 | Count >= 6 | 1, 6 | 1, 6, 6 |
| Skill d8 | 1, 4, 8 | Count >= 7 | 8 | 7, 2, 8 |
| Gear d6 | 1, 3, 6 | Sum | 1, 6 | 1, 5, 6 |

Include scalar modifier -1. Parent total is 11; child total is 15. Exactly four RNG draws occur (attribute second, skill first/second, gear second). Every die ID is retained and locked values do not consume RNG. For this fixture set success threshold 10, allow-on-success true, maximum two attempts, and report gear face 1 (combined count 1, rerolled count 0). A separate allow-on-success false case blocks the parent. Empty/all-locked fixtures make zero child RNG calls. Include a newly rerolled reported face and next-step locks as separate controls.

Required red → green suites cover schema/versions/clone/import/export, evaluator identity/recalculation, both action sources, PostgreSQL atomic commit/replay/distinct-key and actor races, all disclosure paths and role-change principal regression, source/version/placement/lifecycle transitions, forbidden outcome injection, client uncertainty/ack failure/reload/takeover/expiry, previous/current worker/package compatibility, and creator/player/GM keyboard/responsive flows. Compare legacy fixtures/checksums/RNG/results before and after.

Require the full canonical CI matrix and a separate isolated deployed multi-account journey on the exact tested code, with migrations/readiness and served frontend/worker identity verified. Record actual terminal deployment, IDs, cleanup and limitations. Do not mark C accepted from this contract, unit tests, skipped DB tests or a staged deployment. Wider B compatibility and G9/device/provider-authentication gates retain their own evidence requirements.
