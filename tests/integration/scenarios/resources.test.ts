import { expect } from "vitest";

import { scenario } from "./runner.js";

/**
 * Design 6.3: a resource changes by an amount or by direct input in one
 * command, including the character's maximum. Uses the d20 fixture's Health
 * resource (minimum 0, upper bound 30, step 1, default 10 / 10).
 */
type Sheet = { revision: number; values: { health: { current: number; max: number } } };
type Revision = { revision: number };

scenario("resources: apply damage in one command and raise the maximum", async ({ actor, phase, versionId }) => {
  const ada = await actor("ada", ["characters:read", "characters:write"]);
  const created = await ada.command<Revision & { characterId: string }>("POST /characters", {
    name: "Aria", systemVersionId: versionId, entityDefinitionId: "character",
  }, 201);
  const sheetPath = `/characters/${created.characterId}` as const;
  const health = async () => (await ada.json<Sheet>(`GET ${sheetPath}`)).values.health;
  let revision = created.revision;

  await phase("Apply amounts");
  ({ revision } = await ada.command<Revision>(`POST ${sheetPath}/resources/health/adjust`, { delta: -7, expectedRevision: revision }));
  expect(await health()).toEqual({ current: 3, max: 10 });
  // More damage than remains stops at the minimum instead of failing.
  ({ revision } = await ada.command<Revision>(`POST ${sheetPath}/resources/health/adjust`, { delta: -17, expectedRevision: revision }));
  expect(await health()).toEqual({ current: 0, max: 10 });

  await phase("Direct input");
  ({ revision } = await ada.command<Revision>(`PUT ${sheetPath}/resources/health`, { max: 14, expectedRevision: revision }));
  expect(await health()).toEqual({ current: 0, max: 14 });
  ({ revision } = await ada.command<Revision>(`PUT ${sheetPath}/resources/health`, { current: 14, expectedRevision: revision }));
  expect(await health()).toEqual({ current: 14, max: 14 });
  ({ revision } = await ada.command<Revision>(`PUT ${sheetPath}/resources/health`, { max: 9, expectedRevision: revision }));
  expect(await health()).toEqual({ current: 9, max: 9 });

  await phase("Rejections and retries");
  await ada.status(`PUT ${sheetPath}/resources/health`, 422, { current: 10, expectedRevision: revision, idempotencyKey: "over-max" });
  await ada.status(`PUT ${sheetPath}/resources/health`, 422, { max: 31, expectedRevision: revision, idempotencyKey: "over-bound" });
  await ada.status(`POST ${sheetPath}/resources/health/adjust`, 422, { delta: 0, expectedRevision: revision, idempotencyKey: "zero" });
  await ada.status(`POST ${sheetPath}/resources/health/adjust`, 409, { delta: -1, expectedRevision: revision - 1, idempotencyKey: "stale" });
  const once = await ada.command<Revision>(`POST ${sheetPath}/resources/health/adjust`, { delta: -2, expectedRevision: revision, idempotencyKey: "retry" });
  const again = await ada.command<Revision>(`POST ${sheetPath}/resources/health/adjust`, { delta: -2, expectedRevision: revision, idempotencyKey: "retry" });
  expect(again.revision).toBe(once.revision);
  expect(await health()).toEqual({ current: 7, max: 9 });

  await phase("Activity");
  const activity = await ada.json<{ events: Array<{ kind: string }> }>(`GET ${sheetPath}/activity?limit=100`);
  const kinds = activity.events.map((event) => event.kind);
  expect(kinds.filter((kind) => kind === "character_resource_adjusted")).toHaveLength(3);
  expect(kinds.filter((kind) => kind === "character_resource_set")).toHaveLength(3);
});
