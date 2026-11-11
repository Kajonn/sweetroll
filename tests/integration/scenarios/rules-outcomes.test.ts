import { randomUUID } from "node:crypto";

import { expect } from "vitest";

import { derivedTemplateDocument } from "../../../src/systems/implementation/package/fixtures/campaign-derived.js";
import {
  gradedPercentileDocument, gradedPushDocument, movesDocument,
} from "../../../src/systems/implementation/package/fixtures/outcome-systems.js";
import type { SystemDocumentV1 } from "../../../src/systems/implementation/package/schema/index.js";
import { scenario, type ScenarioActor } from "./runner.js";

/**
 * Rules coverage R5: rolls name their outcome. Dice are rolled by the server,
 * so every check derives the expected outcome from the reported total.
 */
type Revision = { revision: number };
type Roll = {
  rollId: string; total: number; output: string; dice: Array<{ value: number }>;
  outcome?: { id: string; label: string }; details?: Array<{ id: string; label: string; value: number }>;
};
type Rolled = Revision & { roll: Roll };

async function publish(author: ScenarioActor, document: SystemDocumentV1) {
  const created = await author.command<{ system: { systemId: string }; draft: Revision }>("POST /systems", { name: document.metadata.name }, 201);
  const system = `/systems/${created.system.systemId}` as const;
  const draft = await author.json<{ draft: Revision }>(`PUT ${system}/draft`, { document, expectedRevision: created.draft.revision });
  const { versionId } = await author.command<{ versionId: string }>(`POST ${system}/publish`, {
    expectedRevision: draft.draft.revision, semanticVersion: "1.0.0", releaseNotes: document.metadata.name,
  }, 201);
  return versionId;
}

scenario("outcomes: banded moves, graded percentile tests and a graded push", async ({ actor, phase }) => {
  const author = await actor("ada", ["systems:write", "characters:read", "characters:write"]);

  await phase("Hearthbound moves");
  const moves = await author.command<Revision & { characterId: string }>("POST /characters", {
    name: "Wren", systemVersionId: await publish(author, movesDocument()), entityDefinitionId: "character", initialValues: { move_stat: 1 },
  }, 201);
  let revision = moves.revision;
  const seen = new Set<string>();
  for (let attempt = 0; attempt < 12; attempt++) {
    const { roll, revision: next } = await author.command<Rolled>(`POST /characters/${moves.characterId}/actions/make_move`, {
      inputs: { forward: 0 }, expectedRevision: revision,
    });
    revision = next;
    const expected = roll.total >= 10 ? ["strong_hit", "Strong hit"] : roll.total >= 7 ? ["weak_hit", "Weak hit"] : ["miss", "Miss"];
    expect(roll.outcome).toEqual({ id: expected[0], label: expected[1] });
    expect(roll.output).toBe(`${expected[1]} (${roll.total})`);
    seen.add(roll.outcome!.id);
  }
  expect(seen.size).toBeGreaterThan(1);
  // Stored rolls show the outcome through their output text.
  const activity = await author.json<{ events: Array<{ roll?: { output: string } }> }>(`GET /characters/${moves.characterId}/activity?limit=5`);
  expect(activity.events.filter((event) => event.roll).every((event) => /^(Strong hit|Weak hit|Miss) \(\d+\)$/.test(event.roll!.output))).toBe(true);

  await phase("Brass Ledger skill tests");
  const ledger = await author.command<Revision & { characterId: string }>("POST /characters", {
    name: "Ode", systemVersionId: await publish(author, gradedPercentileDocument()), entityDefinitionId: "character", initialValues: { skill: 55 },
  }, 201);
  revision = ledger.revision;
  for (let attempt = 0; attempt < 12; attempt++) {
    const { roll, revision: next } = await author.command<Rolled>(`POST /characters/${ledger.characterId}/actions/check`, { inputs: {}, expectedRevision: revision });
    revision = next;
    const face = roll.dice[0]!.value;
    const doubles = Math.floor(face / 10) === face % 10;
    const expected = face <= 55 ? (doubles ? "Critical" : "Success") : doubles ? "Fumble" : "Failure";
    const levels = 5 - Math.floor(face / 10);
    expect(roll.total).toBe(face);
    expect(roll.outcome?.label).toBe(expected);
    expect(roll.details).toEqual([{ id: "levels", label: "Success levels", value: levels }]);
    expect(roll.output).toBe(`${face} against 55: ${expected}, ${levels} success levels`);
  }

  await phase("A pushed roll is graded again");
  const relay = await author.command<Revision & { characterId: string }>("POST /characters", {
    name: "Iona", systemVersionId: await publish(author, gradedPushDocument()), entityDefinitionId: "character",
    initialValues: { attribute: 3, skill: 1, gear: 1 },
  }, 201);
  const grade = (roll: Roll) => roll.total >= 1 ? "Success" : "Failure";
  const first = await author.command<Rolled>(`POST /characters/${relay.characterId}/actions/test_pool`, {
    inputs: { bonus_dice: 0 }, expectedRevision: relay.revision,
  });
  expect(first.roll.outcome?.label).toBe(grade(first.roll));
  expect(first.roll.output.endsWith(` — ${grade(first.roll)}`)).toBe(true);
  const pushed = await author.command<Rolled>(`POST /characters/${relay.characterId}/rolls/${first.roll.rollId}/push`, { expectedRevision: first.revision });
  expect(pushed.roll.rollId).not.toBe(first.roll.rollId);
  expect(pushed.roll.outcome?.label).toBe(grade(pushed.roll));
  expect(pushed.roll.output.endsWith(` — ${grade(pushed.roll)}`)).toBe(true);
});

for (const source of ["sheet", "item"] as const) {
  scenario(`push preserves output-only values from the original ${source} action`, async ({ actor }) => {
    const author = await actor("ada", ["systems:write", "characters:write"]);
    const document = derivedTemplateDocument();
    document.entities[0]!.fields.push({
      kind: "text", id: "name", label: "Name", required: false, default: "", minLength: 0, maxLength: 100,
    });
    const check = document.actions.find((action) => action.id === "check");
    const pool = document.templates[0]!.grantedActions.find((action) => action.id === "sword_pool");
    if (check?.kind !== "roll" || pool?.kind !== "roll") throw new Error("Missing fixture actions");
    check.pushPolicy = structuredClone(pool.pushPolicy!);
    document.expressions.find((expression) => expression.id === check.expressionId)!.source = 'group("attribute", "Attribute", d20)';

    const action = source === "sheet" ? check : pool;
    action.inputs = [{ id: "note", label: "Note", valueType: "text", required: true, default: "" }];
    action.outputTemplate = source === "sheet" ? "{fields.name} ({inputs.note}): {total}"
      : "{fields.name} ({inputs.note}) with {item.name}: {total}";
    const expectedPrefix = source === "sheet" ? "Iona (scouting)" : "Iona (scouting) with Old blade";
    const hero = await author.command<Revision & { characterId: string }>("POST /characters", {
      name: "Iona", systemVersionId: await publish(author, document), entityDefinitionId: "character", initialValues: { name: "Iona" },
    }, 201);
    const path = `/characters/${hero.characterId}` as const;
    const entryId = source === "item" ? randomUUID() : undefined;
    let revision = hero.revision;
    if (entryId) {
      ({ revision } = await author.command<Revision>(`POST ${path}/entries`, {
        entryId, slotId: "inventory", templateId: "sword", values: { name: "Old blade" }, expectedRevision: revision,
      }));
    }
    const root = await author.command<Rolled>(`POST ${path}/actions/${action.id}`, {
      ...(entryId ? { entryId } : {}), inputs: { note: "scouting" }, expectedRevision: revision,
    });
    expect(root.roll.output).toBe(`${expectedPrefix}: ${root.roll.total}`);

    ({ revision } = await author.command<Revision>(`POST ${path}/fields/name/set`, {
      value: "New name", expectedRevision: root.revision,
    }));
    if (entryId) {
      ({ revision } = await author.command<Revision>(`PATCH ${path}/entries/${entryId}`, {
        values: { name: "New blade" }, expectedRevision: revision,
      }));
    }
    const pushed = await author.command<Rolled>(`POST ${path}/rolls/${root.roll.rollId}/push`, { expectedRevision: revision });
    expect(pushed.roll.output).toBe(`${expectedPrefix}: ${pushed.roll.total}`);
  });
}
