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

/** Preview origin under test (dedicated I4 remediation port 4174 by default). */
export const PREVIEW_ORIGIN = `http://localhost:${process.env.PREVIEW_PORT ?? "4174"}`;

export type ReferenceSystem = {
  key: "d20" | "pbta" | "pool";
  /** Published template version seeded by migration/http bootstrap. */
  systemVersionId: string;
  resourceId: string;
  resourceLabel: string;
  /** Sheet heading shown for the resource section is the resource label. */
  decreaseButton: string;
  increaseButton: string;
  /** Roll action button label rendered on the sheet. */
  actionLabel: string;
  /** A bound editable field exercised by UI edit (label + value to type). */
  editFieldLabel: string;
  editFieldValue: string;
  /**
   * Required-but-unbound completion control. `d20` exposes `Proficient`
   * natively; `pbta`/`pool` bind every required field on their reference
   * sheets, so the journey publishes a minimal authorized clone variant
   * that drops `variantDropsElement` (a required field's sheet element)
   * and completes it here instead.
   */
  completionLabel: string;
  completionKind: "checkbox" | "text";
  /** Sheet element id removed by the clone variant (null = reference as-is). */
  variantDropsElement: string | null;
};

export const D20_REFERENCE_SYSTEM: ReferenceSystem = {
  key: "d20",
  systemVersionId: "a0000000-0000-5000-8000-000000000002",
  resourceId: "health",
  resourceLabel: "Health",
  decreaseButton: "Decrease Health",
  increaseButton: "Increase Health",
  actionLabel: "Check",
  editFieldLabel: "Ability Score",
  editFieldValue: "14",
  completionLabel: "Proficient",
  completionKind: "checkbox",
  variantDropsElement: null,
};

export const PBTA_REFERENCE_SYSTEM: ReferenceSystem = {
  key: "pbta",
  systemVersionId: "b0000000-0000-5000-8000-000000000002",
  resourceId: "harm",
  resourceLabel: "Harm",
  decreaseButton: "Decrease Harm",
  increaseButton: "Increase Harm",
  actionLabel: "Make Move",
  editFieldLabel: "Move Stat",
  editFieldValue: "2",
  completionLabel: "Condition",
  completionKind: "checkbox",
  variantDropsElement: "condition_element",
};

export const POOL_REFERENCE_SYSTEM: ReferenceSystem = {
  key: "pool",
  systemVersionId: "c0000000-0000-5000-8000-000000000002",
  resourceId: "stress",
  resourceLabel: "Stress",
  decreaseButton: "Decrease Stress",
  increaseButton: "Increase Stress",
  actionLabel: "Test Pool",
  editFieldLabel: "Attribute",
  editFieldValue: "4",
  completionLabel: "Skill",
  completionKind: "text",
  variantDropsElement: "skill_element",
};

export const REFERENCE_SYSTEMS: readonly ReferenceSystem[] = [
  D20_REFERENCE_SYSTEM,
  PBTA_REFERENCE_SYSTEM,
  POOL_REFERENCE_SYSTEM,
] as const;

/** Sign the context behind `request` in as `code` via the test endpoint. */
export async function testSignIn(request: APIRequestContext, code: string): Promise<string> {
  const response = await request.post("/dev/signin", {
    data: { code, redirectUri: `${PREVIEW_ORIGIN}/cb` },
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
  const context = await browser.newContext({ baseURL: PREVIEW_ORIGIN });
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

/** Short unique suffix for names/keys within one acceptance run. */
export function uid(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

type WorkspaceEnvelope = {
  workspace: {
    system: { systemId: string };
    draft: { revision: number; document: unknown } | null;
  };
};

/**
 * Minimal authorized fixture variant for completion coverage (Task 8): clone
 * the reference system through the real System Builder API, remove one
 * required field's sheet element so it becomes a completion-only field, and
 * publish. Returns the new published version id.
 */
export async function publishCompletionVariant(
  request: APIRequestContext,
  sourceVersionId: string,
  dropElementId: string,
): Promise<string> {
  const created = await request.post("/api/systems", {
    data: { source: { kind: "clone", versionId: sourceVersionId }, idempotencyKey: `variant-${uid()}` },
  });
  if (created.status() !== 201) {
    throw new Error(`clone system failed: ${created.status()} ${await created.text()}`);
  }
  const workspace = ((await created.json()) as WorkspaceEnvelope).workspace;
  const systemId = workspace.system.systemId;
  const draft = workspace.draft;
  if (draft === null) throw new Error("clone produced no draft");
  const document = draft.document as {
    sheets: Array<{ sections: Array<{ elements: Array<{ id?: string }> }> }>;
  };
  for (const sheet of document.sheets) {
    for (const section of sheet.sections) {
      section.elements = section.elements.filter(element => element.id !== dropElementId);
    }
  }
  const saved = await request.put(`/api/systems/${systemId}/draft`, {
    data: { expectedRevision: draft.revision, document },
  });
  if (saved.status() !== 200) {
    throw new Error(`save variant draft failed: ${saved.status()} ${await saved.text()}`);
  }
  const nextRevision = ((await saved.json()) as WorkspaceEnvelope).workspace.draft?.revision;
  if (typeof nextRevision !== "number") throw new Error("saved draft has no revision");
  const published = await request.post(`/api/systems/${systemId}/publish`, {
    data: {
      expectedRevision: nextRevision,
      semanticVersion: "1.0.0",
      releaseNotes: "I4 completion coverage variant",
      idempotencyKey: `variant-publish-${uid()}`,
      acknowledgeBreaking: true,
    },
  });
  if (published.status() !== 200) {
    throw new Error(`publish variant failed: ${published.status()} ${await published.text()}`);
  }
  const body = (await published.json()) as { version: { versionId: string } };
  return body.version.versionId;
}

/**
 * Owned, enumerable clone for picker coverage (OD-01): reference seeds are
 * link-access/unlisted, so versionless enumeration never offers them.
 * Cloning through the real System Builder API (link use stays authorized)
 * produces an actor-owned system that the picker lists under its kept
 * source name. The document is republished unchanged. Returns the new
 * published version id.
 */
export async function publishOwnedClone(
  request: APIRequestContext,
  sourceVersionId: string,
): Promise<string> {
  const created = await request.post("/api/systems", {
    data: { source: { kind: "clone", versionId: sourceVersionId }, idempotencyKey: `clone-${uid()}` },
  });
  if (created.status() !== 201) {
    throw new Error(`clone system failed: ${created.status()} ${await created.text()}`);
  }
  const workspace = ((await created.json()) as WorkspaceEnvelope).workspace;
  const systemId = workspace.system.systemId;
  const draft = workspace.draft;
  if (draft === null) throw new Error("clone produced no draft");
  const saved = await request.put(`/api/systems/${systemId}/draft`, {
    data: { expectedRevision: draft.revision, document: draft.document },
  });
  if (saved.status() !== 200) {
    throw new Error(`save clone draft failed: ${saved.status()} ${await saved.text()}`);
  }
  const nextRevision = ((await saved.json()) as WorkspaceEnvelope).workspace.draft?.revision;
  if (typeof nextRevision !== "number") throw new Error("saved draft has no revision");
  const published = await request.post(`/api/systems/${systemId}/publish`, {
    data: {
      expectedRevision: nextRevision,
      semanticVersion: "1.0.0",
      releaseNotes: "picker coverage clone",
      idempotencyKey: `clone-publish-${uid()}`,
      acknowledgeBreaking: true,
    },
  });
  if (published.status() !== 200) {
    throw new Error(`publish clone failed: ${published.status()} ${await published.text()}`);
  }
  const body = (await published.json()) as { version: { versionId: string } };
  return body.version.versionId;
}

/** Independent-writer field set through the real API (same owner, fresh key). */
export async function apiSetField(
  request: APIRequestContext,
  characterId: string,
  fieldId: string,
  value: unknown,
  expectedRevision: number,
): Promise<number> {
  const response = await request.post(`/api/characters/${characterId}/fields/${fieldId}/set`, {
    data: { value, expectedRevision, idempotencyKey: `writer-${uid()}` },
  });
  if (response.status() !== 200) {
    throw new Error(`writer set field failed: ${response.status()} ${await response.text()}`);
  }
  const body = (await response.json()) as { result: { character: { revision: number } } };
  return body.result.character.revision;
}

/** Independent-writer resource bump through the real API (same owner, fresh key). */
export async function apiBump(
  request: APIRequestContext,
  characterId: string,
  resourceId: string,
  direction: "up" | "down",
  expectedRevision: number,
): Promise<number> {
  const response = await request.post(`/api/characters/${characterId}/resources/${resourceId}/bump`, {
    data: { direction, expectedRevision, idempotencyKey: `writer-${uid()}` },
  });
  if (response.status() !== 200) {
    throw new Error(`writer bump failed: ${response.status()} ${await response.text()}`);
  }
  const body = (await response.json()) as { result: { character: { revision: number } } };
  return body.result.character.revision;
}

/** Authoritative server export document for download comparison. */
export async function exportCharacter(request: APIRequestContext, characterId: string): Promise<unknown> {
  const response = await request.post(`/api/characters/${characterId}/exports`);
  if (response.status() !== 200) {
    throw new Error(`export failed: ${response.status()} ${await response.text()}`);
  }
  return (await response.json()) as unknown;
}
