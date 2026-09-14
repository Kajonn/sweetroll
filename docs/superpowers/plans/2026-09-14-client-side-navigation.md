# Client-side navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In-app links navigate client-side through the TanStack Router instead of full page reloads, eliminating the boot flicker on every mode switch and preserving client state.

**Architecture:** Add a shared `AppLink` anchor component backed by a tiny router registry. `router.tsx` registers the app router at creation; `AppLink` intercepts plain left-clicks into `router.history.push(href)` and lets everything else (modifier/new-tab clicks, external URLs, hash links, unregistered standalone renders) fall through to normal anchor behavior. Migrate every full-load in-app anchor to `AppLink`, keeping all `href`s byte-identical. Leave the existing `navigation`-prop interceptions (CharacterLibrary rows, RecoveryNav, CampaignLibrary header actions, DocumentEditor tabs) untouched.

**Tech Stack:** React 18, TanStack Router v1 (existing), Vitest + Testing Library, Playwright Chromium, TypeScript `exactOptionalPropertyTypes` (spread-conditional optional props, never pass explicit `undefined`).

**Spec:** `design_v2.md` §4 (product structure and navigation) and GUI plan G3 (AppShell owns navigation; views own content). No HTTP or contract changes.

## Global Constraints

- TDD red-green per task; `npm run contracts:check` stays green (no HTTP changes in this plan).
- No new dependencies.
- Every migrated link keeps its exact `href` (deep links, no-JS, standalone/test renders, and existing href assertions keep working).
- Modifier/middle-click (new-tab) semantics preserved: only unmodified left-clicks on same-origin `/` paths are intercepted.
- Do not touch working `navigation`-prop interceptions (`CharacterLibrary`, `CharacterRoute` RecoveryNav, `CampaignLibrary` header actions, `DocumentEditor` tabs).
- New i18n keys ship in the same task as the component that uses them (none expected).
- Web `npm test`, `npm run typecheck`, `npm run build` green per task.

---

## File map

| File | Responsibility |
| --- | --- |
| `web/src/shell/appNavigation.ts` (create) | Router registry: `registerAppRouter`, `getAppRouter`, `resetAppRouter` |
| `web/src/ui/AppLink.tsx` (create) | Anchor that client-navigates when a router is registered |
| `web/src/ui/AppLink.test.tsx` (create) | Registry + interception unit tests |
| `web/src/router.tsx` (modify) | Register the router in `createAppRouter` |
| `web/src/shell/AppShell.tsx` (modify) | Header + bottom nav anchors become `AppLink` |
| `web/src/shell/AppShell.test.tsx` (modify) | Registered-router push test; reset registry in `afterEach` |
| `web/src/library/SystemLibrary.tsx` (modify) | Row link becomes `AppLink` |
| `web/src/campaigns/CampaignLibrary.tsx` (modify) | Row + empty-state join links become `AppLink` |
| `web/src/campaigns/CampaignDetail.tsx` (modify) | Back-to-list links (2×) become `AppLink` |
| `web/src/campaigns/InvitationReview.tsx` (modify) | Accepted-open link becomes `AppLink` |
| `web/src/player/Onboarding.tsx` (modify) | Entry links (2×) become `AppLink` |
| `web/src/player/PersonalActivity.tsx` (modify) | Row links become `AppLink` |
| `web/src/publish/VersionHistory.tsx` (modify) | Create-character CTA becomes `AppLink` (drop stale comment) |
| `web/src/publish/PublishDialog.tsx` (modify) | Create-character CTA becomes `AppLink` (drop stale comment) |
| `web/src/characters/CreateCharacter.tsx` (modify) | Empty-state + recovery links become `AppLink` |
| `web/tests/e2e/clientNavigation.spec.ts` (create) | No-reload proof across header hops + covered content links |

---

### Task 1: Router registry + AppLink component

**Files:**
- Create: `web/src/shell/appNavigation.ts`
- Create: `web/src/ui/AppLink.tsx`
- Create: `web/src/ui/AppLink.test.tsx`

**Interfaces:**
- Consumes: nothing (new seam).
- Produces (used by Tasks 2–3):
```ts
// web/src/shell/appNavigation.ts
export type AppRouterLike = { history: { push(path: string): void } };
export function registerAppRouter(router: AppRouterLike): void;
export function getAppRouter(): AppRouterLike | null;
export function resetAppRouter(): void;
```
```tsx
// web/src/ui/AppLink.tsx
import type { AnchorHTMLAttributes, ReactNode } from "react";
export type AppLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
  href: string;
  children: ReactNode;
};
export function AppLink(props: AppLinkProps): React.JSX.Element;
```

- [ ] **Step 1: Write the failing tests.** Create `web/src/ui/AppLink.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getAppRouter, registerAppRouter, resetAppRouter } from "../shell/appNavigation.js";
import { AppLink } from "./AppLink.js";

describe("AppLink", () => {
  afterEach(() => resetAppRouter());

  it("client-navigates unmodified left clicks when a router is registered", async () => {
    const user = userEvent.setup();
    const push = vi.fn();
    registerAppRouter({ history: { push } });
    render(<AppLink href="/campaigns" data-testid="nav">Campaigns</AppLink>);
    const link = screen.getByTestId("nav");
    expect(link).toHaveAttribute("href", "/campaigns");
    await user.click(link);
    expect(push).toHaveBeenCalledWith("/campaigns");
  });

  it("lets modifier clicks fall through to the browser", async () => {
    const user = userEvent.setup();
    const push = vi.fn();
    registerAppRouter({ history: { push } });
    render(<AppLink href="/campaigns" data-testid="nav">Campaigns</AppLink>);
    await user.keyboard("{Control>}");
    await user.click(screen.getByTestId("nav"));
    await user.keyboard("{/Control}");
    expect(push).not.toHaveBeenCalled();
  });

  it("renders a working plain anchor when no router is registered", async () => {
    expect(getAppRouter()).toBeNull();
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<AppLink href="/campaigns" data-testid="nav" onClick={onClick}>Campaigns</AppLink>);
    await user.click(screen.getByTestId("nav"));
    expect(onClick).toHaveBeenCalled();
    expect(screen.getByTestId("nav")).toHaveAttribute("href", "/campaigns");
  });

  it("does not intercept external URLs or hash links", async () => {
    const user = userEvent.setup();
    const push = vi.fn();
    registerAppRouter({ history: { push } });
    render(<AppLink href="https://example.com/x" data-testid="ext">X</AppLink>);
    await user.click(screen.getByTestId("ext"));
    expect(push).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify they fail.** Run: `npm --prefix web test -- src/ui/AppLink.test.tsx`. Expected: FAIL with `Failed to resolve import` (neither file exists).

- [ ] **Step 3: Implement the registry.** Create `web/src/shell/appNavigation.ts`:
```ts
/** Minimal structural router surface: the real TanStack Router is assignable. */
export type AppRouterLike = { history: { push(path: string): void } };

let current: AppRouterLike | null = null;

export function registerAppRouter(router: AppRouterLike): void {
  current = router;
}

export function getAppRouter(): AppRouterLike | null {
  return current;
}

/** Test seam: every suite that registers must reset in afterEach. */
export function resetAppRouter(): void {
  current = null;
}
```

- [ ] **Step 4: Implement the component.** Create `web/src/ui/AppLink.tsx`:
```tsx
import type { AnchorHTMLAttributes, MouseEvent, ReactNode } from "react";

import { getAppRouter } from "../shell/appNavigation.js";

export type AppLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
  href: string;
  children: ReactNode;
};

/**
 * In-app anchor. Renders a native `<a href>` always (deep links, no-JS,
 * standalone renders without a RouterProvider keep working). When a router
 * is registered, unmodified left-clicks on same-origin `/` paths navigate
 * client-side instead of reloading the document. Modifier/middle clicks,
 * external URLs, and hash links always fall through to the browser.
 */
export function AppLink({ href, onClick, children, ...rest }: AppLinkProps) {
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented) return;
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (!href.startsWith("/")) return;
    const router = getAppRouter();
    if (router === null) return;
    event.preventDefault();
    router.history.push(href);
  };
  return (
    <a href={href} onClick={handleClick} {...rest}>
      {children}
    </a>
  );
}
```

- [ ] **Step 5: Run to verify they pass.** Same command as Step 2. Expected: PASS (4/4). Then `npm --prefix web run typecheck`. Expected: clean.

- [ ] **Step 6: Commit.** `git add web/src/shell/appNavigation.ts web/src/ui/AppLink.tsx web/src/ui/AppLink.test.tsx`; `git commit -m "feat(web): add AppLink client-side anchor with router registry"`.

---

### Task 2: Register the router + migrate AppShell navigation

**Files:**
- Modify: `web/src/router.tsx` (register inside `createAppRouter`)
- Modify: `web/src/shell/AppShell.tsx` (header 6 links + bottom nav 4 links)
- Modify: `web/src/shell/AppShell.test.tsx` (reset registry in `afterEach`; add push test)

**Interfaces:**
- Consumes: Task 1 `registerAppRouter`, `AppLink`.
- Produces: registered live router; shell nav client-side (used by Task 4 e2e).

- [ ] **Step 1: Write the failing shell test.** Append to the `describe("AppShell")` block in `web/src/shell/AppShell.test.tsx`:
```tsx
it("client-navigates header links through the registered router", async () => {
  const push = vi.fn();
  registerAppRouter({ history: { push } });
  renderShell(<AppShell><span data-testid="child">x</span></AppShell>);
  const header = within(screen.getByRole("banner"));
  await userEvent.setup().click(header.getByRole("link", { name: "Campaigns" }));
  expect(push).toHaveBeenCalledWith("/campaigns");
});
```
Add `within` to the `@testing-library/react` import in that test file edit step.
Add imports `registerAppRouter, resetAppRouter` from `./appNavigation.js`, and extend the existing `afterEach` to call `resetAppRouter()`:
```ts
afterEach(() => { resetAppRouter(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
```

- [ ] **Step 2: Run to verify it fails.** Run: `npm --prefix web test -- src/shell/AppShell.test.tsx -t "client-navigates header links"`. Expected: FAIL with `expected spy to have been called with "/campaigns", called 0 times` (plain anchors; nothing registered).

- [ ] **Step 3: Register the router.** In `web/src/router.tsx`, add the import and register inside `createAppRouter`:
```ts
import { registerAppRouter } from "./shell/appNavigation.js";
```
```ts
export function createAppRouter() {
  const router = createRouter({ routeTree });
  registerAppRouter(router);
  return router;
}
```
(The real TanStack Router object satisfies `AppRouterLike` structurally via `history.push`.)

- [ ] **Step 4: Migrate the shell anchors.** In `web/src/shell/AppShell.tsx`, import `AppLink` from `../ui/AppLink.js` and replace the 6 header `<a href=...>` links and 4 bottom-nav `<a href=...>` links one-for-one, preserving `className`, text, and order. Keep the skip link (`href="#main-content"`) as a plain anchor. Example (repeat for all 10):
```tsx
<AppLink href="/campaigns" className={styles.navLink}>{t("shell.nav.campaigns")}</AppLink>
```
Keep the "Intentional plain anchors" comment but narrow it to the skip link.

- [ ] **Step 5: Run to verify they pass.** Run: `npm --prefix web test -- src/shell/AppShell.test.tsx`. Expected: PASS (19/19). Then `npm --prefix web run typecheck`. Expected: clean.

- [ ] **Step 6: Commit.** `git add web/src/router.tsx web/src/shell/AppShell.tsx web/src/shell/AppShell.test.tsx`; `git commit -m "feat(web): client-side shell navigation via AppLink"`.

---

### Task 3: Migrate content links to AppLink

**Files:**
- Modify: `web/src/library/SystemLibrary.tsx` (row link line 40)
- Modify: `web/src/campaigns/CampaignLibrary.tsx` (row line 68, empty-state join line 61; header actions at lines 36–53 already intercept — leave them)
- Modify: `web/src/campaigns/CampaignDetail.tsx` (back-to-list lines 223, 238)
- Modify: `web/src/campaigns/InvitationReview.tsx` (accepted-open line 234)
- Modify: `web/src/player/Onboarding.tsx` (entry links lines 47, 50)
- Modify: `web/src/player/PersonalActivity.tsx` (row link line 131)
- Modify: `web/src/publish/VersionHistory.tsx` (CTA lines 172–178; delete the stale plain-anchor comment at lines 169–171)
- Modify: `web/src/publish/PublishDialog.tsx` (CTA lines 153–159; delete the stale comment at lines 149–152)
- Modify: `web/src/characters/CreateCharacter.tsx` (empty-state action line 736, recovery links line 845)
- Modify tests: `web/src/library/SystemLibrary.test.tsx`, `web/src/campaigns/CampaignLibrary.test.tsx`, `web/src/campaigns/InvitationReview.test.tsx`, `web/src/publish/VersionHistory.test.tsx`, `web/src/publish/PublishDialog.test.tsx`, `web/src/characters/CreateCharacter.test.tsx` (extend where a render harness exists; see steps)

**Interfaces:**
- Consumes: Task 1 `AppLink`.
- Produces: all in-app anchors client-side (used by Task 4 e2e).

- [ ] **Step 1: Write failing push tests where harnesses exist.** For each file below, add one test that registers a fake router, clicks the link, and expects `push` with the exact href. All fail now (plain anchors never call `push`). Fixture IDs below are illustrative — use the exact IDs already present in each file's render harness. Pattern (adapt `render` harness per file):
```tsx
it("client-navigates the row link", async () => {
  const push = vi.fn();
  registerAppRouter({ history: { push } });
  // ... existing render harness for the component ...
  await userEvent.setup().click(screen.getByRole("link", { name: "D20" }));
  expect(push).toHaveBeenCalledWith("/systems/s1");
});
```
Add to: `SystemLibrary.test.tsx` (row link; assert `push` with `/systems/s1`), `CampaignLibrary.test.tsx` (row link `/campaigns/c1`; keep existing href assertions untouched), `InvitationReview.test.tsx` (accepted-open `/campaigns/c1`), `VersionHistory.test.tsx` (CTA `/characters/new?systemVersionId=v1`), `PublishDialog.test.tsx` (CTA with published version id), `CreateCharacter.test.tsx` (empty-state action `/`; reuse the P1b render with empty versions, click `Your systems`, expect `push` with `/`). Each test's `afterEach` must call `resetAppRouter()` (add to the file's existing `afterEach` or add one).

- [ ] **Step 2: Run to verify they fail.** Run each file (e.g. `npm --prefix web test -- src/library/SystemLibrary.test.tsx`). Expected: FAIL with push called 0 times.

- [ ] **Step 3: Migrate the anchors.** In each file, import `AppLink` and replace the anchor tag, preserving every prop (`className`, `aria-label`, `data-testid`, `title`, children). Examples:
```tsx
// SystemLibrary.tsx:40
<AppLink href={`/systems/${s.systemId}`}>{s.name}</AppLink>
```
```tsx
// CampaignLibrary.tsx:68 + :61
<AppLink href={`/campaigns/${campaign.campaignId}`}>{campaign.title}</AppLink>
action={<AppLink href="/invitations">{t("campaign.library.join")}</AppLink>}
```
```tsx
// CampaignDetail.tsx:223 + :238 (both identical)
action={<AppLink href="/campaigns">{t("campaign.detail.backToList")}</AppLink>}
```
```tsx
// InvitationReview.tsx:234
action={<AppLink href={`/campaigns/${review.campaignId}`}>{t("campaign.invitations.accepted.open")}</AppLink>}
```
```tsx
// Onboarding.tsx:47 + :50 (preserve data-testid + className)
<AppLink href="/characters/new" data-testid="welcome-create" className={styles.createLink}>
  {t("player.welcome.create")}
</AppLink>{" "}
<AppLink href="/characters" data-testid="welcome-library" className={styles.libraryLink}>
  {t("player.welcome.library")}
</AppLink>
```
```tsx
// PersonalActivity.tsx:131-137 (preserve className + aria-label)
<AppLink
  href={`/characters/${character.characterId}`}
  className={styles.rowLink}
  aria-label={t("player.library.open", { name: character.name })}
>
  {character.name}
</AppLink>
```
```tsx
// VersionHistory.tsx:172-178 (drop the stale comment)
<AppLink
  className={styles.action}
  href={`/characters/new?systemVersionId=${v.versionId}`}
  data-testid={`version-history-create-character-${v.versionId}`}
>
  {t("versionHistory.action.createCharacter")}
</AppLink>
```
```tsx
// PublishDialog.tsx:153-159 (drop the stale comment)
<AppLink
  className={styles.createLink}
  href={`/characters/new?systemVersionId=${published.versionId}`}
  data-testid="publish-dialog-create-character"
>
  {t("publish.success.createCharacter")}
</AppLink>
```
```tsx
// CreateCharacter.tsx:736 + :845
action={<AppLink href="/">{t("character.create.pickVersion.emptyAction")}</AppLink>}
```
```tsx
<a> → <AppLink href={`/characters/${entry.characterId}`}>{entry.name}</AppLink>
```

- [ ] **Step 4: Run to verify they pass.** Run all touched test files plus `npm --prefix web run typecheck`. Expected: PASS/clean. Existing href assertions keep passing unchanged (AppLink preserves `href`).

- [ ] **Step 5: Commit.** Stage the 9 component files plus touched test files; `git commit -m "feat(web): client-side content links via AppLink"`.

---

### Task 4: No-reload e2e + full verification

**Files:**
- Create: `web/tests/e2e/clientNavigation.spec.ts`

**Interfaces:**
- Consumes: Tasks 1–3 (registered router, migrated links).
- Produces: exit evidence for this plan.

- [ ] **Step 1: Write the exit spec.** Create `web/tests/e2e/clientNavigation.spec.ts`:
```ts
import { test, expect, type Page } from "@playwright/test";

async function signIn(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByTestId("dev-signin-code").fill("code-test-a");
  await page.getByTestId("dev-signin").click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible({ timeout: 30_000 });
}

test("client navigation: header hops keep the document alive", async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page);
  await page.goto("/characters");
  await expect(page.getByRole("heading", { name: "Your library" })).toBeVisible({ timeout: 30_000 });
  // Boot marker: a full reload wipes window state, client nav preserves it.
  await page.evaluate(() => { (window as { __navAlive?: boolean }).__navAlive = true; });
  await page.locator('header nav a:has-text("Campaigns")').click();
  await expect(page).toHaveURL(/\/campaigns/, { timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "Campaigns" })).toBeVisible({ timeout: 30_000 });
  expect(await page.evaluate(() => (window as { __navAlive?: boolean }).__navAlive)).toBe(true);
  await page.locator('header nav a:has-text("Activity")').click();
  await expect(page).toHaveURL(/\/activity/, { timeout: 30_000 });
  expect(await page.evaluate(() => (window as { __navAlive?: boolean }).__navAlive)).toBe(true);
  await page.locator('header nav a:has-text("Characters")').click();
  await expect(page).toHaveURL(/\/characters$/, { timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "Your library" })).toBeVisible({ timeout: 30_000 });
  expect(await page.evaluate(() => (window as { __navAlive?: boolean }).__navAlive)).toBe(true);
  // The sign-in panel never appears for the signed-in actor mid-navigation.
  expect(await page.getByTestId("dev-signin-panel").count()).toBe(0);
});
```

- [ ] **Step 2: Run it against caller-managed resources.** From `web/`: `CI=1 DATABASE_URL="postgres://sweetroll:sweetroll@localhost:5432/<isolated-db>" AUTHORITATIVE_ROLL_SECRET="development-only-roll-secret-32-bytes" BACKEND_PORT=<free> WEB_PORT=<free> SWEETROLL_BACKEND_TARGET="http://localhost:<backend-port>" npx playwright test tests/e2e/clientNavigation.spec.ts --reporter=list` (create the isolated DB first via `node -e` pg `CREATE DATABASE`, drop it after; never the dev database). Expected: PASS. (Pre-Tasks-1–3 this fails at the `__navAlive` assertion: every hop reloads.)

- [ ] **Step 3: Run full verification.** Root `npm test`, `npm run typecheck`, `npm run contracts:check`, `npm run build`; web `npm test`, `npm run typecheck`, `npm run build`; `git diff --check`. Expected: all green. (Canonical `npm run test:e2e` remains the release gate; the new spec joins it automatically.)

- [ ] **Step 4: Commit.** `git add web/tests/e2e/clientNavigation.spec.ts`; `git commit -m "feat(web): prove client-side navigation without reloads in exit e2e"`.
