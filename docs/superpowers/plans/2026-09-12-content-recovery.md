# Durable Content Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow a GM to recover a manageable hidden note after list-level Hide, navigation, reload, or a new browser session.

**Architecture:** Proposed: extend the existing paginated content list with a management-filtered deleted view. Restore through the existing revision-guarded recovery command using summary revisions; ordinary content reads remain active-only and deleted bodies are never exposed by this addition.

**Tech Stack:** Campaigns Module, PostgreSQL, Fastify/OpenAPI, generated API types, React/TanStack Query, existing Dialog/Button controls, Vitest, Playwright.

**Spec:** `design_v2.md` Sections 4.1, 7.3, 9, 12.3, 17.9; I6 backend content/recovery policy; [remediation index](2026-09-12-remediation-index.md), R7.

## Global Constraints

- **Approval required before implementation:** approve management-only deleted-summary discovery and the GM Hidden view; update `design_v2.md` and the I6 backend spec before implementation.
- Hide continues to mean soft-delete, not audience change to GM-only. Labels and confirmation must say what it does.
- Existing recovery authority is active creator OR an active GM who may read the content. Ordinary shared-note recipients cannot discover deleted notes just because they previously read them.
- A GM cannot discover another creator's owner-only note. Do not replace policy with a blanket GM bypass.
- Keep ordinary `GET /content/{id}` active-only. No deleted body/grant preview, permanent delete, retention-window change, or player-note authoring UI is added.
- Keep existing editor receipt-based recovery and fresh-key/revision behavior. A retained client object is not the durable recovery source.

---

## Decision and Alternatives

Recommended: a `status=deleted` mode on the existing list, returning only manageable summaries, with a GM Hidden view. This persists discovery across browsers without a new read endpoint.

An immediate Undo using the DELETE receipt is smaller but cannot close recovery after reload. Adding a deleted-body preview endpoint is unnecessary for restoration and exposes more data. Neither alternative is included in this proposal.

- [ ] Obtain approval for the proposed status filter and GM view. Keep player-creator recovery semantics on the server, but do not add player-note management UI in this slice.

## Task 1: Expose Only Recoverable Summaries

**Files:** Modify `src/campaigns/content.ts`, `src/campaigns/persistence.ts`, `src/campaigns/policy.ts` only if policy factoring is needed, `src/transport/http/campaigns.ts`, `src/transport/http/campaigns.test.ts`, `tests/integration/campaign-content.test.ts`; regenerate `docs/contracts/openapi-v1.json` and `web/src/api/schema.d.ts`.

**Interfaces:** Add optional `status?: 'active' | 'deleted'` to `ListContentInput`, normalized to `active`; add required `status` to `ContentSummary`. Keep `ListContentResult` and the existing operation ID. Use a content-specific HTTP query schema, not the shared `PageQuery` used by members/characters.

```ts
// Additions to existing Module types:
type ContentListStatus = "active" | "deleted";
// ListContentInput.status?: ContentListStatus
// ContentSummary.status: ContentListStatus
// ContentView continues to include body, deletedAt and authorized grants.
```

- [ ] Extend existing `campaign-content.test.ts` helpers `createCampaign`, `seedMember`, and `createNote`. Hide an all-player note; default list excludes it; deleted list returns a fresh revision only to its creator/readable GM. A selected/all-player recipient sees no deleted summary, and another creator's owner-only note stays absent for a GM.

```ts
const hidden = await h.campaigns.listContent(ctxFor(h.users.gm), {
  campaignId, status: "deleted", limit: 1,
});
expect(hidden.ok).toBe(true);
if (!hidden.ok) throw new Error("expected management list");
expect(hidden.value.content[0]).toMatchObject({ contentId, status: "deleted" });
expect(hidden.value.content[0]).not.toHaveProperty("body");
expect(hidden.value.content[0]).not.toHaveProperty("grantedUserIds");
```

- [ ] Run `npx vitest run tests/integration/campaign-content.test.ts --no-file-parallelism` with `TEST_DATABASE_URL` set. Confirm missing filter/authorization behavior is the red condition.
- [ ] Implement status-aware filtering before pagination. Active lists retain current readership. Deleted lists require active membership and the SQL equivalent of `canManageContent`, not merely `contentVisibilitySql`; include creator access and readable-GM branches exactly. Bind status, actor, campaign, and query family into cursors; default and explicit active share one normalized scope. Ordinary open still returns 404 for deleted rows.
- [ ] Test actor/query cursor misuse, multiple pages with unauthorized rows interleaved, removed membership, creator departure/rejoin under current policy, stale revision, concurrent recovery, and archived campaign recovery denial. Recover using the listed revision; verify it returns to active and disappears from deleted lists. If archived campaign summaries remain readable, the UI must not imply restore can succeed before campaign recovery.
- [ ] Add transport tests for default/explicit/invalid status, response status serialization, bounded pagination and 404/401 mapping. Generate contracts, run consistency/typechecks and the complete content/HTTP authorization suites. Preserve DELETE response status/revision and editor recovery contracts.

## Task 2: Add a Durable Hidden View

**Files:** Modify `web/src/campaigns/api.ts`, `api.test.ts`, `types.ts`, `CampaignContent.tsx`, `CampaignContent.test.tsx`, `ContentEditor.test.tsx`, `CampaignDetail.tsx`, `CampaignDetail.session.test.tsx`, `web/src/i18n/messages.ts`, `web/tests/e2e/gmSessionJourney.spec.ts`.

**Interfaces:** Extend `ContentListQuery` from the generated operation query type. Keep `CampaignsApi.listContent` and `recoverContent`. Separate list keys by status/cursor while preserving `['campaigns', 'content', campaignId]` as the purge prefix and actor/generation after it. Detail-body keys remain distinguishable from list keys.

- [ ] Replace the test that accepts no list recovery with a regression that renders a deleted summary after unmount/remount with a fresh QueryClient. Mock ordinary `openContent` as 404: restoration must not depend on opening deleted content. Keep the existing retained-editor receipt regression untouched.

```ts
await api.recoverContent(row.contentId, {
  expectedContentRevision: row.revision,
  idempotencyKey: crypto.randomUUID(),
});
// This uses the fresh server-listed revision; never the pre-delete object.
```

- [ ] Add Active/Hidden views for GMs using existing shared controls, with a readable explanation that Hidden notes are soft-deleted and absent from ordinary player reads. Hidden rows show title/audience/status and a Recover confirmation, not an Open/Edit button. Expose pagination so recovery is not limited to the first 25 notes. Disable mutations offline, during refresh, and while campaign lifecycle disallows them.
- [ ] On recovery success, refresh active/deleted lists and relevant activity/session reads. On 409, refresh the hidden summary before explicit retry with a fresh key; do not guess `revision + 1`. On 404, evict that row and show generic unavailability without returning a deleted body. Purge both status lists and late responses on sign-out, account switch, leave and membership revocation.
- [ ] Correct the existing comment claiming summaries lack revision: they already contain `revision` and `accessRevision`. Preserve the editor's current recovery path and use the same existing confirmation vocabulary; do not rebuild its transaction logic.
- [ ] Extend the real GM journey: create shared note, Hide from the list, reload, find it in Hidden, confirm recovery, and read it in Active. Repeat discovery after a new authenticated browser context, and prove an ordinary recipient cannot list/read/recover the deleted note. Cover stale recovery using two GM contexts and both light/dark phone layouts in acceptance.
- [ ] Run content/API component tests, campaign revocation tests, full typecheck/contracts, targeted browser journeys, and full production-offline tests because query/cache handling changed. Record the new durable path separately from the old retained-editor acceptance.
