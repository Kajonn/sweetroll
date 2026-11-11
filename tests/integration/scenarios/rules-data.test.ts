import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { advancedD20Document } from "../../../src/systems/implementation/package/fixtures/advanced-d20.js";
import { scenario } from "./runner.js";

type Revision = { revision: number };
type Sheet = {
  derivedValues: Record<string, number>;
  values: { health: { current: number; max: number }; rank: string };
};

scenario("Roadwardens: equip armor, carry supplies and advance a level", async ({ actor, phase }) => {
  const author = await actor("ada", ["systems:write", "characters:read", "characters:write"]);
  const document = advancedD20Document();
  await phase("Publish the Roadwardens rules");
  const created = await author.command<{ system: { systemId: string }; draft: Revision }>("POST /systems", {
    name: document.metadata.name,
  }, 201);
  const system = `/systems/${created.system.systemId}` as const;
  const draft = await author.json<{ draft: Revision }>(`PUT ${system}/draft`, {
    document, expectedRevision: created.draft.revision,
  });
  const { versionId } = await author.command<{ versionId: string }>(`POST ${system}/publish`, {
    expectedRevision: draft.draft.revision, semanticVersion: "1.0.0", releaseNotes: "Roadwardens rules",
  }, 201);
  const hero = await author.command<Revision & { characterId: string }>("POST /characters", {
    name: "Tarin", systemVersionId: versionId, entityDefinitionId: "character",
  }, 201);
  const path = `/characters/${hero.characterId}` as const;
  const sheet = () => author.json<Sheet>(`GET ${path}`);
  expect(await sheet()).toMatchObject({
    derivedValues: { defense: 10, carried: 0, proficiency_bonus: 2 },
    values: { health: { current: 10, max: 10 }, rank: "rookie" },
  });

  await phase("Equip two items and inspect one");
  const entryId = randomUUID();
  let { revision } = await author.command<Revision>(`POST ${path}/entries`, {
    expectedRevision: hero.revision, entryId, slotId: "equipment", templateId: "leather", quantity: 2,
  });
  expect((await sheet()).derivedValues).toMatchObject({ defense: 14, carried: 6 });
  const rolled = await author.command<Revision & { roll: { total: number; bindings: unknown[] } }>(`POST ${path}/actions/inspect_armor`, {
    entryId, expectedRevision: revision,
  });
  revision = rolled.revision;
  expect(rolled.roll).toMatchObject({ total: 4, bindings: [
    { scope: "fields", definitionId: "armor", value: 1 },
    { scope: "item", definitionId: "armor", value: 2 },
  ] });
  ({ revision } = await author.command<Revision>(`PATCH ${path}/entries/${entryId}`, {
    expectedRevision: revision, values: { equipped: false }, quantity: 3,
  }));
  expect((await sheet()).derivedValues).toMatchObject({ defense: 10, carried: 9 });

  await phase("Advance and apply damage within the calculated limit");
  ({ revision } = await author.command<Revision>(`POST ${path}/fields/level/set`, { expectedRevision: revision, value: 4 }));
  expect(await sheet()).toMatchObject({
    derivedValues: { proficiency_bonus: 3 }, values: { health: { current: 10, max: 18 } },
  });
  await author.status(`PUT ${path}/resources/health`, 422, { max: 20, expectedRevision: revision, idempotencyKey: "calculated-max" });
  ({ revision } = await author.command<Revision>(`PUT ${path}/resources/health`, { current: 17, expectedRevision: revision }));
  ({ revision } = await author.command<Revision>(`POST ${path}/fields/level/set`, { expectedRevision: revision, value: 1 }));
  expect((await sheet()).values.health).toEqual({ current: 10, max: 10 });
});
