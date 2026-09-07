import type { APIRequestContext, Browser, Page } from "@playwright/test";

/**
 * Test-only production authentication fixture (Task 11).
 *
 * The production build never renders the dev sign-in panel, so browser
 * contexts authenticate by posting directly to the existing test-identity
 * endpoint (`/dev/signin`, served through the preview `/dev` proxy by the
 * test-auth backend). The backend seeds the deterministic test OIDC adapter
 * with `code-test-a` / `code-test-b`; no production synthetic user exists.
 * `page.request` shares the browser context's cookie jar, so the sign-in
 * cookie lands in the context that will open sheets.
 */

export const TEST_USER_A = { code: "code-test-a", name: "Offline Test A" } as const;
export const TEST_USER_B = { code: "code-test-b", name: "Offline Test B" } as const;

export type ReferenceSystem = {
  key: "d20" | "pbta" | "pool";
  /** Published template version seeded by migration/http bootstrap. */
  systemVersionId: string;
  resourceId: string;
  resourceLabel: string;
  /** Sheet heading shown for the resource section is the resource label. */
  decreaseButton: string;
  increaseButton: string;
};

export const D20_REFERENCE_SYSTEM: ReferenceSystem = {
  key: "d20",
  systemVersionId: "a0000000-0000-5000-8000-000000000002",
  resourceId: "health",
  resourceLabel: "Health",
  decreaseButton: "Decrease Health",
  increaseButton: "Increase Health",
};

export const PBTA_REFERENCE_SYSTEM: ReferenceSystem = {
  key: "pbta",
  systemVersionId: "b0000000-0000-5000-8000-000000000002",
  resourceId: "harm",
  resourceLabel: "Harm",
  decreaseButton: "Decrease Harm",
  increaseButton: "Increase Harm",
};

export const POOL_REFERENCE_SYSTEM: ReferenceSystem = {
  key: "pool",
  systemVersionId: "c0000000-0000-5000-8000-000000000002",
  resourceId: "stress",
  resourceLabel: "Stress",
  decreaseButton: "Decrease Stress",
  increaseButton: "Increase Stress",
};

export const REFERENCE_SYSTEMS: readonly ReferenceSystem[] = [
  D20_REFERENCE_SYSTEM,
  PBTA_REFERENCE_SYSTEM,
  POOL_REFERENCE_SYSTEM,
] as const;

/** Sign the context behind `request` in as `code` via the test endpoint. */
export async function testSignIn(request: APIRequestContext, code: string): Promise<string> {
  const response = await request.post("/dev/signin", {
    data: { code, redirectUri: "http://localhost:4173/cb" },
  });
  if (response.status() !== 200) {
    throw new Error(`test sign-in (${code}) failed: ${response.status()} ${await response.text()}`);
  }
  const body = (await response.json()) as { userId: string };
  if (typeof body.userId !== "string" || body.userId.length === 0) {
    throw new Error(`test sign-in (${code}) returned no userId`);
  }
  return body.userId;
}

/** New isolated browser context signed in as `code`. Independent users must use separate contexts. */
export async function newSignedInContext(browser: Browser, code: string) {
  const context = await browser.newContext({ baseURL: "http://localhost:4173" });
  const probe = await context.newPage();
  const userId = await testSignIn(probe.request, code);
  await probe.close();
  return { context, userId };
}

export async function createCharacter(
  request: APIRequestContext,
  input: { systemVersionId: string; name: string },
): Promise<{ characterId: string; revision: number }> {
  const response = await request.post("/api/characters", {
    data: {
      systemVersionId: input.systemVersionId,
      entityDefinitionId: "character",
      name: input.name,
      idempotencyKey: `offline-acceptance-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    },
  });
  if (response.status() !== 201) {
    throw new Error(`create character failed: ${response.status()} ${await response.text()}`);
  }
  const body = (await response.json()) as { character: { characterId: string; revision: number } };
  return { characterId: body.character.characterId, revision: body.character.revision };
}

export async function readCharacter(request: APIRequestContext, characterId: string) {
  const response = await request.get(`/api/characters/${characterId}`);
  if (response.status() !== 200) {
    throw new Error(`read character failed: ${response.status()} ${await response.text()}`);
  }
  return (await response.json()) as {
    character: {
      characterId: string;
      revision: number;
      name: string;
      state: { values: Record<string, unknown> };
    };
    requestId: string;
  };
}

export async function readActivity(request: APIRequestContext, characterId: string) {
  const response = await request.get(`/api/characters/${characterId}/activity`);
  if (response.status() !== 200) {
    throw new Error(`read activity failed: ${response.status()} ${await response.text()}`);
  }
  return (await response.json()) as { events: Array<{ kind: string }>; nextCursor: string | null; requestId: string };
}

/** Wait until the sheet shows the character heading and sync state settles. */
export async function expectSheetReady(page: Page, characterName: string) {
  const { expect } = await import("@playwright/test");
  await expect(page.getByRole("heading", { name: characterName })).toBeVisible({ timeout: 30_000 });
}

/** Wait for the worker-backed "Available offline" badge (durable snapshot + controlling worker cache). */
export async function expectOfflineAvailable(page: Page) {
  const { expect } = await import("@playwright/test");
  await expect(page.getByText("Available offline", { exact: true })).toBeVisible({ timeout: 60_000 });
}

/** Assert the page has no horizontal overflow at its current viewport. */
export async function expectNoHorizontalOverflow(page: Page) {
  const { expect } = await import("@playwright/test");
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth + 1);
}
