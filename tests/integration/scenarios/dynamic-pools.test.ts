import { expect } from "vitest";
import { dynamicPoolDocument, dynamicPoolFixtures } from "../../../src/systems/implementation/package/fixtures/dynamic-pools.js";
import type { DieResult, RollBreakdown } from "../../../src/systems/implementation/rules/result.js";
import { scenario } from "./runner.js";

type Revision = { revision: number };
type Roll = { rollId: string; total: number; dice: DieResult[]; breakdown: RollBreakdown };

function chainTotals(roll: Roll, groupId: string): number[] {
  const totals = new Map<string, number>();
  const chains = new Map<string, string>();
  for (const die of roll.dice.filter((die) => die.groupId === groupId)) {
    const id = die.rerolledFrom ?? (die.explodedFrom ? chains.get(die.explodedFrom)! : die.id!);
    chains.set(die.id!, id);
    totals.set(id, (totals.get(id) ?? 0) + die.value);
  }
  return [...totals.values()];
}

for (const fixture of dynamicPoolFixtures) {
  scenario(`Dynamic pools: publish, roll and read back ${fixture.name}`, async ({ actor, phase }) => {
    const creator = await actor("ada", ["systems:write", "characters:write", "characters:read", "campaigns:write", "campaigns:read"]);
    const document = dynamicPoolDocument(fixture);
    await phase("Publish the pool rules");
    const { system: { systemId }, draft } = await creator.command<{ system: { systemId: string }; draft: Revision }>(
      "POST /systems", { name: document.metadata.name }, 201,
    );
    const saved = await creator.json<{ draft: Revision }>(`PUT /systems/${systemId}/draft`, {
      expectedRevision: draft.revision, document,
    });
    const { versionId } = await creator.command<{ versionId: string }>(`POST /systems/${systemId}/publish`, {
      expectedRevision: saved.draft.revision, semanticVersion: "1.0.0", releaseNotes: "Dynamic dice pools",
    }, 201);

    await phase("Roll and verify the saved breakdown");
    const campaign = await creator.command<Revision & { campaignId: string }>("POST /campaigns", { title: fixture.name, systemVersionId: versionId }, 201);
    const campaignPath = `/campaigns/${campaign.campaignId}` as const;
    const character = await creator.command<Revision & { characterId: string }>(`POST ${campaignPath}/characters`, {
      name: "Rin", entityDefinitionId: "character", expectedCampaignRevision: campaign.revision,
      initialValues: { trait_die: 12, pool_size: 3, keep_count: 2 },
    }, 201);
    const characterPath = `/characters/${character.characterId}` as const;
    const { roll } = await creator.command<{ roll: Roll }>(`POST ${characterPath}/actions/check`, {
      expectedRevision: character.revision, audience: "campaign",
      inputs: fixture.id === "difficulty" ? { difficulty: 7 } : {},
    });
    expect(roll.breakdown.groups.map((group) => group.id)).toEqual(fixture.groups);
    const history = await creator.json<{ events: { roll?: Roll }[] }>(`GET ${characterPath}/activity`);
    expect(history.events).toContainEqual(expect.objectContaining({
      roll: expect.objectContaining({ total: roll.total, dice: roll.dice, breakdown: roll.breakdown }),
    }));
    const exported = await creator.command<{ rolls: (Roll & { breakdownText: string })[] }>(`POST ${campaignPath}/exports`, {});
    expect(exported.rolls).toMatchObject([{ dice: roll.dice, breakdown: roll.breakdown, breakdownText: expect.stringContaining(`Total: ${roll.total}`) }]);
    if (fixture.id === "doubles" || fixture.id === "difficulty") expect(exported.rolls[0]?.breakdownText).toContain("Reused");
    const [first, second] = fixture.groups;
    const faces = chainTotals(roll, first);
    switch (fixture.id) {
      case "doubles":
        expect(roll.total).toBe(faces[0]! + (faces[0]! % 11 === 0 || faces[0] === 100 ? 100 : 0));
        expect(roll.dice).toHaveLength(1);
        break;
      case "difficulty":
        expect(roll.total).toBe(faces.filter((face) => face >= 7).length - faces.filter((face) => face === 1).length);
        expect(roll.dice).toHaveLength(3);
        break;
      case "step":
        expect(roll.total).toBe(Math.max(faces[0]!, chainTotals(roll, second!)[0]!));
        expect(roll.breakdown.groups[0]?.sides).toBe(12);
        break;
      case "keep":
        expect(roll.total).toBe(faces.sort((a, b) => b - a).slice(0, 2).reduce((sum, face) => sum + face, 0));
        expect(roll.breakdown.groups[0]).toMatchObject({ count: 3, keepCount: 2, modifiers: ["explode"] });
        break;
    }
  });
}
