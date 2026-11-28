import { expect } from "vitest";

import { customDiceDocument, customDiceFixtures } from "../../../src/systems/implementation/package/fixtures/custom-dice.js";
import type { DieResult, RollBreakdown } from "../../../src/systems/implementation/rules/result.js";
import { scenario } from "./runner.js";

type Revision = { revision: number };
type Roll = { total: number; dice: DieResult[]; breakdown: RollBreakdown };

for (const fixture of customDiceFixtures) {
  scenario(`custom dice: ${fixture.name} publishes, rolls and exports its faces`, async ({ actor, phase }) => {
    const author = await actor("ada", ["systems:write", "systems:read", "characters:read", "characters:write", "campaigns:write", "campaigns:read"]);
    const document = customDiceDocument(fixture);
    await phase("Publish the custom die through the public API");
    const created = await author.command<{ system: { systemId: string }; draft: Revision }>("POST /systems", { name: fixture.name }, 201);
    const system = `/systems/${created.system.systemId}` as const;
    const saved = await author.json<{ draft: Revision }>(`PUT ${system}/draft`, { document, expectedRevision: created.draft.revision });
    const { versionId } = await author.command<{ versionId: string }>(`POST ${system}/publish`, {
      expectedRevision: saved.draft.revision, semanticVersion: "1.0.0", releaseNotes: "Custom dice",
    }, 201);

    await phase("Roll and read back the saved faces");
    const campaign = await author.command<Revision & { campaignId: string }>("POST /campaigns", { title: fixture.name, systemVersionId: versionId }, 201);
    const campaignPath = `/campaigns/${campaign.campaignId}` as const;
    const character = await author.command<Revision & { characterId: string }>(`POST ${campaignPath}/characters`, {
      name: "Mira", entityDefinitionId: "character", expectedCampaignRevision: campaign.revision,
    }, 201);
    const path = `/characters/${character.characterId}` as const;
    const { roll } = await author.command<{ roll: Roll }>(`POST ${path}/actions/check`, {
      expectedRevision: character.revision, audience: "campaign", inputs: {},
    });
    expect(roll.dice).toHaveLength(4);
    expect(roll.breakdown.groups).toMatchObject([{ dieId: fixture.dice.id, count: 4, sides: 3 }]);
    const definitions = new Map(fixture.dice.faces.map(face => [face.label, face]));
    for (const die of roll.dice) {
      const face = definitions.get(die.faceLabel!);
      expect(face).toBeDefined();
      expect(die.value).toBe(face?.value);
      expect(die.symbols).toEqual(face?.symbols);
    }
    const expected = fixture.id === "fudge"
      ? roll.dice.reduce((total, die) => total + die.value, 0)
      : roll.dice.reduce((total, die) => total + (die.symbols?.hit ?? 0) - (die.symbols?.snag ?? 0), 0);
    expect(roll.total).toBe(expected);
    if (fixture.id === "symbols") {
      expect(roll.breakdown.groups[0]).toMatchObject({ operation: "countSymbol", symbol: "hit" });
      expect(roll.breakdown.terms).toContainEqual(expect.objectContaining({ reused: true, operation: "countSymbol", symbol: "snag" }));
    }
    const history = await author.json<{ events: { roll?: Roll }[] }>(`GET ${path}/activity`);
    expect(history.events).toContainEqual(expect.objectContaining({
      roll: expect.objectContaining({ dice: roll.dice, breakdown: roll.breakdown, total: expected }),
    }));
    const exported = await author.command<{ rolls: (Roll & { breakdownText: string })[] }>(`POST ${campaignPath}/exports`, {});
    expect(exported.rolls).toMatchObject([{ dice: roll.dice, breakdown: roll.breakdown, total: expected }]);
    for (const die of roll.dice) expect(exported.rolls[0]?.breakdownText).toContain(die.faceLabel);
  });
}
