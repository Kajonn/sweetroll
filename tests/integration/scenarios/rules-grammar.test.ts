import { expect } from "vitest";

import { d20Document } from "../../../src/systems/implementation/package/fixtures/d20.js";
import { scenario } from "./runner.js";

type Revision = { revision: number };
type Command = Revision & { roll: { total: number; bindings: Array<{ definitionId: string; value: unknown }> } };

scenario("rules grammar: publish and play conditional d20 bonuses", async ({ actor, phase }) => {
  const creator = await actor("ada", ["systems:write", "characters:write"]);
  const document = structuredClone(d20Document);
  document.metadata.name = "Expedition Checks";
  document.entities[0]!.fields.push(
    { id: "class", kind: "singleChoice", label: "Class", required: false, default: null,
      options: [{ id: "fighter", label: "Fighter" }] },
    { id: "skills", kind: "multiChoice", label: "Skills", required: false, default: [],
      options: [{ id: "climb", label: "Climb" }] },
  );
  document.expressions.find(expression => expression.id === "check_expr")!.source =
    'd1 + if(fields.proficient, 2, 0) + if(fields.class == "fighter", 3, 0)' +
    ' + if(has(fields.skills, "climb"), fields.health.max - fields.health.current, 0)';

  await phase("Publish the current rules contract");
  const { system: { systemId }, draft } = await creator.command<{ system: { systemId: string }; draft: Revision }>(
    "POST /systems", { name: document.metadata.name }, 201,
  );
  const saved = await creator.json<{ draft: Revision }>(`PUT /systems/${systemId}/draft`, {
    expectedRevision: draft.revision, document,
  });
  const { versionId } = await creator.command<{ versionId: string }>(`POST /systems/${systemId}/publish`, {
    expectedRevision: saved.draft.revision, semanticVersion: "1.0.0", releaseNotes: "Conditional bonuses",
  }, 201);

  await phase("Roll with and without the bonuses");
  for (const { name, initialValues, total } of [
    { name: "Fighter", initialValues: { proficient: true, class: "fighter", skills: ["climb"], health: { current: 6, max: 10 } }, total: 10 },
    { name: "Novice", initialValues: {}, total: 1 },
  ]) {
    const character = await creator.command<Revision & { characterId: string }>("POST /characters", {
      name, systemVersionId: versionId, entityDefinitionId: "character", initialValues,
    }, 201);
    const result = await creator.command<Command>(`POST /characters/${character.characterId}/actions/check`, {
      expectedRevision: character.revision,
    });
    expect(result.roll.total).toBe(total);
    expect(result.roll.bindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ definitionId: "class", value: total > 1 ? "fighter" : null }),
      expect.objectContaining({ definitionId: "skills", value: total > 1 ? ["climb"] : [] }),
    ]));
    if (total > 1) expect(result.roll.bindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ definitionId: "health.max", value: 10 }),
      expect.objectContaining({ definitionId: "health.current", value: 6 }),
    ]));
  }
});
