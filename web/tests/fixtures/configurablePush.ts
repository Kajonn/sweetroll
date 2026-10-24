import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { namedDicePoolDocument } from "../../../src/systems/implementation/package/fixtures/named-dice-pool.js";
import type { SystemDocumentV1 } from "../../../src/systems/implementation/package/schema/index.js";

export const key = () => randomUUID();
export async function json(
  request: APIRequestContext,
  method: string,
  path: string,
  data?: unknown,
) {
  const response = await request.fetch(path, {
    method,
    timeout: 30000,
    ...(data === undefined ? {} : { data }),
  });
  expect(
    response.ok(),
    `${method} ${path}: ${response.status()} ${await response.text()}`,
  ).toBe(true);
  return response.json();
}
export async function signIn(page: Page, code = "code-test-a") {
  await page.goto("/");
  const signed = await json(page.request, "POST", "/dev/signin", {
    code,
    redirectUri: new URL("/cb", page.url()).href,
  });
  await page.reload();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  return signed.userId as string;
}
export function pushDocument(): SystemDocumentV1 {
  const document = namedDicePoolDocument();
  document.schemaVersion = "1.2";
  const action = document.actions.find((a) => a.kind === "roll")!;
  if (action.kind !== "roll") throw Error("fixture");
  action.pushPolicy = {
    version: "1.0",
    maxAttempts: 2,
    successThreshold: 1,
    allowOnSuccess: true,
    groups: [{ groupId: "attribute", lockedFaces: [], reportedFaces: [1] }],
  };
  return document;
}
export function withItem(document: SystemDocumentV1) {
  const action = document.actions.find((a) => a.kind === "roll")!;
  if (action.kind !== "roll") throw Error("fixture");
  document.slots = [{ id: "gear_slot", label: "Equipment", accepts: ["item"] }];
  document.templates = [
    {
      id: "pool_tool",
      label: "Push Tool",
      kind: "item",
      fields: [],
      grantedActions: [
        {
          ...structuredClone(action),
          id: "tool_pool",
          label: "Tool Pool",
          expressionId: "tool_pool_expr",
          inputs: [
            {
              id: "gear_bonus",
              label: "Tool Bonus",
              valueType: "integer",
              required: false,
              default: 0,
            },
          ],
        },
      ],
    },
  ];
  document.expressions.push({
    ...document.expressions.find((e) => e.id === "pool_roll_expr")!,
    id: "tool_pool_expr",
    source: document.expressions
      .find((e) => e.id === "pool_roll_expr")!
      .source.replaceAll("inputs.bonus_dice", "inputs.gear_bonus"),
  });
  document.sheets[0]!.sections[1]!.elements.push({
    kind: "slot",
    id: "equipment",
    slotId: "gear_slot",
  });
  return document;
}
export async function workspace(
  request: APIRequestContext,
  document = withItem(pushDocument()),
) {
  const created = await json(request, "POST", "/api/systems", {
    source: { kind: "blank", name: `Push Journey ${key()}` },
    idempotencyKey: key(),
  });
  const id = created.workspace.system.systemId as string;
  console.log("PUSH_JOURNEY_SYSTEM", id);
  const saved = await json(request, "PUT", `/api/systems/${id}/draft`, {
    expectedRevision: created.workspace.draft.revision,
    document,
  });
  return { id, workspace: saved.workspace };
}
export async function publish(request: APIRequestContext, id: string) {
  const opened = await json(request, "GET", `/api/systems/${id}`);
  const result = await json(request, "POST", `/api/systems/${id}/publish`, {
    expectedRevision: opened.workspace.draft.revision,
    semanticVersion: "1.0.0",
    releaseNotes: "Configurable push journey",
    acknowledgeBreaking: true,
    idempotencyKey: key(),
  });
  return result.version.versionId as string;
}
export async function createCharacter(
  request: APIRequestContext,
  versionId: string,
) {
  const character = (
    await json(request, "POST", "/api/characters", {
      systemVersionId: versionId,
      entityDefinitionId: "character",
      name: `Push Hero ${key()}`,
      idempotencyKey: key(),
    })
  ).character;
  console.log("PUSH_JOURNEY_CHARACTER", character.characterId);
  return character;
}
export async function cleanup(
  request: APIRequestContext,
  systemId: string,
  characterIds: string[],
  campaignId?: string,
) {
  const result: { characters: string[]; system?: string; campaign?: string } = {
    characters: [],
  };
  for (const id of characterIds) {
    const current = await json(request, "GET", `/api/characters/${id}`);
    if (current.character.lifecycle !== "archived")
      await json(request, "PATCH", `/api/characters/${id}`, {
        command: "archive",
        expectedRevision: current.character.revision,
        idempotencyKey: key(),
      });
    expect(
      (await json(request, "GET", `/api/characters/${id}`)).character.lifecycle,
    ).toBe("archived");
    result.characters.push(id);
  }
  if (campaignId) {
    const current = await json(request, "GET", `/api/campaigns/${campaignId}`);
    await json(request, "POST", `/api/campaigns/${campaignId}/archive`, {
      expectedCampaignRevision: current.campaign.revision,
      idempotencyKey: key(),
    });
    result.campaign = campaignId;
  }
  await json(request, "PATCH", `/api/systems/${systemId}`, {
    lifecycle: "archived",
    access: "private",
  });
  expect(
    (await json(request, "GET", `/api/systems/${systemId}`)).workspace.system
      .lifecycle,
  ).toBe("archived");
  result.system = systemId;
  return result;
}
export async function resultOf(
  page: Page,
  action: () => Promise<unknown>,
  suffix: string,
) {
  const response = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      new URL(r.url()).pathname.endsWith(suffix),
    { timeout: 30000 },
  );
  await action();
  const r = await response;
  expect(r.status(), await r.text()).toBe(200);
  return r.json();
}
export async function cachedPushState(
  page: Page,
  actorId: string,
  characterId: string,
) {
  return page.evaluate(
    async ({ actorId, characterId }) =>
      new Promise<{ rollId: string | null; attempts: unknown[] }>(
        (resolve, reject) => {
          const open = indexedDB.open("sweetroll-characters");
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const db = open.result,
              tx = db.transaction(["characters", "onlineAttempts"]);
            const character = tx
                .objectStore("characters")
                .get([actorId, characterId]),
              attempts = tx.objectStore("onlineAttempts").getAll();
            tx.oncomplete = () => {
              resolve({
                rollId: character.result?.lastRoll?.push?.rollId ?? null,
                attempts: attempts.result.filter(
                  (a: any) =>
                    a.actorId === actorId && a.characterId === characterId,
                ),
              });
              db.close();
            };
            tx.onerror = () => {
              reject(tx.error);
              db.close();
            };
          };
        },
      ),
    { actorId, characterId },
  );
}
export function assertChild(parent: any, child: any) {
  expect(child.push).toMatchObject({
    rootRollId: parent.push.rootRollId,
    parentRollId: parent.push.rollId,
    attempt: parent.push.attempt + 1,
    maxAttempts: parent.push.maxAttempts,
  });
  expect(child.bindings).toEqual(parent.bindings);
  expect(child.dice.map((d: any) => [d.id, d.groupId, d.sides])).toEqual(
    parent.dice.map((d: any) => [d.id, d.groupId, d.sides]),
  );
  const rerolled = new Set(child.push.rerolledDiceIds);
  expect(rerolled.size).toBeGreaterThan(0);
  for (const die of parent.dice)
    if (!rerolled.has(die.id))
      expect(child.dice.find((d: any) => d.id === die.id)).toEqual(die);
}
