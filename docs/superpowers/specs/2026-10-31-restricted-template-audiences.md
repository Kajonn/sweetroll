# Restricted campaign-template audiences — adventure slice D2

**Status:** implemented in PR #27; CI #174 and isolated hosted acceptance pass. [Evidence and remaining G9 gates](../../acceptance/restricted-template-audiences-2026-11-01.md).
**Baseline:** main `90b053d069a58a63a53724f068585da28c50ae8e`, merged D1 PR #26.
**Authority:** design §§4.1, 5.4, 17.0, 17.9b; adventure-items roadmap slice D2.
**Execution:** [D2 plan](../plans/2026-10-31-restricted-template-audiences.md).

## User-visible boundary

A GM/co-GM prepares a campaign template visible to **GM only**, **Selected players**,
or **All players**. The audience controls catalog discovery/read, including exact
IDs and derived action/default summaries. Selected players can review a shared draft;
restricted drafts cannot be copied to character sheets. A GM must explicitly **Reveal
to all players** before ordinary placement. This is the first D2 placement contract:
there is no per-entry secrecy, selected-player sheet grant, automatic reveal or new
sheet visibility mode. The confirmation explains that revealed copies remain usable
and cannot be recalled by subsequently narrowing the catalog audience.

Existing B/C all-player creation/placement and D1 approval remain unchanged. D1
approval always publishes an all-player data-only template; private proposals and
review reasons never inherit catalog sharing.

## Authorization and persistence

| Operation | Required authority and result |
| --- | --- |
| Create/edit/content/lifecycle/sharing | Active GM/co-GM; active campaign for writes; expected resource revision and exact-request idempotency |
| List/read active catalog | Active membership; GM sees all, player sees all-player plus selected grants for their current membership generation |
| Read/list archived catalog | Active GM/co-GM only, irrespective of former grants |
| Preview as player | Active GM/co-GM targeting an active player; same catalog read policy and SQL filtering as the target's real request; read-only |
| Character selector and placement | Existing character authority plus active all-player template; restricted drafts omitted for GMs too |
| Export | Existing GM-only campaign export; include current audience/grants within existing consistent snapshot and budget |
| Restricted display | No catalog authority or response; unchanged |

Use the existing `campaign_item_templates.audience` relational column with the three
explicit values. Store selected grants in a campaign-owned relation keyed by template,
user and membership generation. Validate distinct active player recipients in this
campaign; reject empty selected sets, duplicates, outsiders, inactive members, GMs and
unknown keys. Bound grants by the existing campaign membership limit; inspect that
limit before fixing the transport maximum. Audience other than selected accepts no
grants. Membership removal/rejoin cannot revive an old grant; promotion gives normal
GM access, subsequent demotion requires a still-valid grant. Sharing does not alter
immutable content revisions or placed snapshots; it increments resource revision.

Keep the current 500-template quota, text/default budgets, immutable system pins and
content revision behavior. Change only the fresh database baseline before the first
release tag. Add no migrations, old-client/cache adapters or character conversion.

## Reads, pagination and observable metadata

Introduce one template read policy owned by Campaigns. Repository calls must make
privileged versus actor-scoped reads explicit; no implicit unfiltered page default
may remain reachable from public member/character paths. Apply audience and current
grant filtering before SQL ordering, LIMIT and nextCursor. Bind cursors to campaign,
actor, membership generation, role/read mode and existing filters. A cursor grants no
authority; every page rechecks current membership and sharing. Reject another scope's
cursor without returning hidden metadata.

Direct inaccessible IDs return the same not-found shape as absent IDs. Hidden names,
notes, defaults, bases/actions, counts, grant identities and content revisions must
not appear in selectors, errors, activity, roll history or player exports. Emit no
public activity for restricted create/edit/archive/recover or sharing changes; use a
private GM audit with no content text. All-player publication events can retain the
existing minimal event shape. Shared event existence/timestamps must not reveal
secret preparation. Recheck authorization for receipt replay: a demoted manager
cannot recover a prior secret response from a saved mutation receipt.

## Sharing and explicit reveal

Use a dedicated GM-only sharing command, exposed as
`POST /campaigns/:id/item-templates/:templateId/sharing`. Its strict body contains
`expectedTemplateRevision`, `idempotencyKey`, `audience`, and generation-bound
recipient selections for selected visibility. Content edits cannot silently change
sharing. Creation may explicitly choose an audience; omitted audience retains the
existing all-player default. Restricted creation and all-player reveal require clear
GUI audience labels/confirmation. Changing a restricted draft to all-player is the
explicit reveal operation; the server performs it atomically, never as a side effect
of placement.

Serialize sharing, placement, archive and membership changes with the campaign lock
using the established lock order. At initial resolution AND locked character commit,
require active all-player state and exact template/content revisions. A stale
restricted/revealed reference requires explicit review; no automatic new key or
silent visibility expansion. Failed or denied commands leave no character write,
receipt, partial grants or public activity. Inject failures to prove rollback.

A previously committed placement is an independent, disclosed sheet copy. Exact
committed retries may return that result under current character authority after
catalog narrowing; they never fetch or disclose newer secret content. An uncommitted
queued placement fails current visibility/revision validation. Catalog sharing never
removes existing entries, changes their actions, erases roll history or changes
returned-sheet access. Test this distinction at the durable execution/receipt seam.

## Client and offline boundary

Campaign catalog browsing of restricted drafts is online-only and memory-only. Scope
queries to account, campaign, membership generation, role and real-versus-preview
target. Cancel and remove data on authority changes, exit, unmount and offline entry;
late completions cannot repopulate an obsolete scope. Preview uses the real server
policy with a persistent read-only banner, no mutation controls and no durable cache.

Character selector caches continue to contain only all-player choices. Never persist
restricted draft labels/defaults/actions in the character store or service worker.
Existing disclosed all-player selector data and materialized sheet snapshots retain
their current offline behavior. Narrowing cannot erase information already delivered
to an offline device; UI wording must not promise recall. Online refresh removes
ineligible choices; new/queued writes always validate current authority on reconnect.
Do not broaden this work into disabling accepted character offline functionality.

Sharing/reveal are online-only. Uncertain network results retain the exact open-dialog
request/key; reload reads authoritative sharing without resubmission. Conflict requires
refresh and explicit review. Preserve draft fields and focus on recoverable errors.

## Required proof

Use GM, co-GM, selected player, unselected player, removed/rejoined player and outsider.
Cover data-only and inherited-action templates of all four kinds. Prove list/direct-ID,
paging, preview parity, selector, character projection/export, campaign export,
activity/audit, delayed response, service-worker/IndexedDB and guessed requests.
Race sharing/placement, sharing/archive and sharing/removal; verify old committed
placement retry versus never-committed queued placement. No restricted draft reaches
any sheet, including a GM-owned NPC. Run canonical CI and both hosted browser/offline
journeys on the same pinned isolated preview build, with scoped cleanup. Physical
Android/iPad, production provider login and playtests remain independent G9 gates.
