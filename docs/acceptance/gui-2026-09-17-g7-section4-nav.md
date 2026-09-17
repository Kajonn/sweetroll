# Acceptance: G7 §4 navigation consistency (2026-09-17)

Explicit §4-consistency pass for GUI plan G7 box "Keep Session, Content,
Characters, Members, and Settings navigation consistent with Section 4"
(`docs/superpowers/plans/2026-09-08-gui-integration.md`). Closes that box;
preview-as-player stays open.

## Tested commit

`79e2e2f` (`main`, post-push; code-identical to the verified `276f5ce` —
the delta is the docs-only hardening-plan tracking commit).

## Findings

- All five §4 GM surfaces exist as campaign-detail tabs with §4
  vocabulary (tab labels "Session", "Content", "Characters", "Members",
  "Settings"): `web/src/campaigns/CampaignDetail.tsx:279-385`.
- `Session` and `Settings` are GM-gated (`owner`/`co_gm`; players get no
  tab): `CampaignDetail.tsx:346-383`, locked by
  `CampaignDetail.session.test.tsx` and `CampaignDetail.members.test.tsx`.
- `Activity` is an additional tab beyond the §4 list (player-row
  "Activity" surface, `CampaignActivityTab`). Documented here, not removed.
- Order deviation (accepted, owner decision 2026-09-17): tabs render
  Characters, Members, Content, Activity, Session, Settings — not the §4
  document order (Session; Content; Characters; Members; Campaign
  Settings). `Tabs` defaults to the first tab (`web/src/ui/Tabs.tsx:29`),
  so all roles land on Characters. Reordering to §4 order would move the
  GM landing tab to Session: a UX behavior change, deferred, not a defect.
- Responsive half of the box ("panels on larger screens and focused
  pages/sheets on phones") rides existing evidence: Phase 2 e2e at
  360×640 and 1280×800 plus the campaign axe spec (15/15, both widths,
  360px dark pass) — no overflow, zero serious/critical findings.

## Evidence (this session unless noted)

- New lock test `web/src/campaigns/CampaignDetail.navigation.test.tsx`
  (2 tests): GM sees all six tabs; player sees Characters/Content/
  Members/Activity with Session + Settings absent.
- Focused: `npx vitest run CampaignDetail.navigation/members/session`
  → 3 files, 11/11 passed.
- Fresh browser: `gmSetupJourney` (Members + Settings tabs through the
  real UI, incl. promote/remove) → 1 passed on scratch DB
  `sweetroll_verify_nav` (ports 3132/5192), Chromium-only.
- Prior session on code-identical tree: affected-specs matrix 19/19
  (`gmSetupJourney`, `campaignUpgradeJourney`, `sceneDisplayJourney`,
  `campaignAccessibility` 15/15, `npcListJourney`); web unit 1038/1038
  ×2 consecutive; root unit 323/323; integration 348/348.

## Limitations

- Chromium-only; no real devices (touch/keyboard stays G9).
- Tab-order acceptance is a recorded owner decision, not a §4 text match;
  if §4 order becomes required, the GM landing tab changes with it.
- Preview-as-player (real-policy preview) untouched — still open per GUI
  plan; this pass covers navigation presence/gating only.
