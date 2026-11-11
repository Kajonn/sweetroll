import { randomUUID } from "node:crypto";

import { expect } from "vitest";

import { namedDicePoolDocument } from "../../../src/systems/implementation/package/fixtures/named-dice-pool.js";
import type { DieResult, PushResult, RollBreakdown } from "../../../src/systems/implementation/rules/result.js";
import { scenario } from "./runner.js";

type Revision = { revision: number };
type Roll = {
  rollId: string;
  audience: string;
  dice: DieResult[];
  total: number;
  bindings: unknown[];
  breakdown: RollBreakdown;
  push: PushResult;
};
type RollCommand = Revision & { roll: Roll };

scenario("Dice pool: salvage the relay and push a saved roll", async ({ actor, phase }) => {
  const gm = await actor("ada", ["systems:write", "characters:read", "campaigns:write"]);
  const scout = await actor("bob", ["characters:write", "campaigns:write"]);
  const mechanic = await actor("dan", ["campaigns:write"]);

  await phase("Publish the expedition rules");
  const document = namedDicePoolDocument();
  document.metadata.name = "Relay Salvage";

  const action = document.actions.find((entry) => entry.id === "test_pool");
  if (action?.kind !== "roll") throw new Error("Missing the named-pool roll action");
  action.pushPolicy = {
    version: "1.0", maxAttempts: 1, successThreshold: 1, allowOnSuccess: true,
    groups: [{ groupId: "attribute", lockedFaces: [], reportedFaces: [1] }],
  };

  const { system: { systemId }, draft } = await gm.command<{ system: { systemId: string }; draft: Revision }>(
    "POST /systems", { name: document.metadata.name }, 201,
  );
  const saved = await gm.json<{ draft: Revision }>(`PUT /systems/${systemId}/draft`, {
    expectedRevision: draft.revision, document,
  });
  const { versionId } = await gm.command<{ versionId: string }>(`POST /systems/${systemId}/publish`, {
    expectedRevision: saved.draft.revision, semanticVersion: "1.0.0", releaseNotes: "Expedition rules",
  }, 201);
  await gm.json(`PUT /systems/${systemId}/sharing`, { access: "link" });

  await phase("Assemble the salvage crew");
  const campaign = await gm.command<{ campaignId: string }>("POST /campaigns", {
    title: "The Silent Relay", systemVersionId: versionId,
  }, 201);
  const campaignPath = `/campaigns/${campaign.campaignId}` as const;
  for (const player of [scout, mechanic]) {
    const { revision } = await gm.json<Revision>(`GET ${campaignPath}`);
    const { token } = await gm.command<{ token: string }>(`POST ${campaignPath}/invitations`, {
      intendedRole: "player", expectedCampaignRevision: revision,
    }, 201);
    const review = await player.json<{ invitationRevision: number; accessRevision: number }>("POST /invitations/review", { token });
    await player.command("POST /invitations/accept", {
      campaignId: campaign.campaignId, token, expectedInvitationRevision: review.invitationRevision,
      reviewedAccessRevision: review.accessRevision,
    });
  }
  const created = await scout.command<Revision & { characterId: string }>("POST /characters", {
    name: "Iona Vale", systemVersionId: versionId, entityDefinitionId: "character",
    initialValues: { attribute: 2, skill: 2, gear: 1 },
  }, 201);
  const { revision: campaignRevision } = await scout.json<Revision>(`GET ${campaignPath}`);
  const attached = await scout.command<Revision>(`POST ${campaignPath}/characters/${created.characterId}/adopt`, {
    expectedCampaignRevision: campaignRevision, expectedCharacterRevision: created.revision, acknowledgedDisclosure: true,
  });
  const sheetPath = `/characters/${created.characterId}` as const;
  const rollRequest = `POST ${sheetPath}/actions/test_pool` as const;

  await phase("Scout the relay privately");
  const { roll: original, revision } = await scout.command<RollCommand>(rollRequest, {
    inputs: { bonus_dice: 1 }, expectedRevision: attached.revision, audience: "gm_only",
  });
  const originalPath = `${sheetPath}/rolls/${original.rollId}` as const;
  expect(original.push).toMatchObject({ rootRollId: original.rollId, parentRollId: null, attempt: 0 });
  expect(original.breakdown.groups).toMatchObject([
    { id: "attribute", count: 3, sides: 6, operation: "countAtLeast", threshold: 6 },
    { id: "skill", count: 2, sides: 8, operation: "countAtLeast", threshold: 5 },
    { id: "gear", count: 1, sides: 4, operation: "sum" },
  ]);

  await phase("Edit the sheet and push the saved attempt");
  const updated = await scout.command<Revision>(`POST ${sheetPath}/fields/attribute/set`, {
    value: 4, expectedRevision: revision,
  });
  const attributeDice = original.dice.filter((die) => die.groupId === "attribute").map((die) => die.id);
  expect(await scout.json(`GET ${originalPath}/push-options`)).toMatchObject({
    canPush: true, revision: updated.revision, eligibleDiceIds: attributeDice, nextAttempt: 1, maxAttempts: 1,
  });
  const pushRequest = `POST ${originalPath}/push` as const;
  const pushBody = { expectedRevision: updated.revision, idempotencyKey: randomUUID() };
  const pushed = await scout.command<RollCommand>(pushRequest, pushBody);
  expect(pushed.roll.rollId).not.toBe(original.rollId);
  expect(pushed.roll.push).toMatchObject({
    rootRollId: original.rollId, parentRollId: original.rollId, attempt: 1, rerolledDiceIds: attributeDice,
  });
  expect(pushed.roll.audience).toBe("gm_only");
  expect(pushed.roll.bindings).toEqual(original.bindings);
  expect(pushed.roll.dice.filter((die) => die.groupId !== "attribute"))
    .toEqual(original.dice.filter((die) => die.groupId !== "attribute"));
  expect(await scout.command(pushRequest, pushBody)).toEqual(pushed);
  const childPath = `${sheetPath}/rolls/${pushed.roll.rollId}` as const;
  expect(await scout.json(`GET ${childPath}/push-options`)).toMatchObject({ canPush: false, reason: "exhausted" });
  await scout.command(`POST ${childPath}/push`, { expectedRevision: pushed.revision }, 422);

  await phase("Report a fresh roll to the crew");
  const { roll: shared } = await scout.command<RollCommand>(rollRequest, {
    inputs: { bonus_dice: 1 }, expectedRevision: pushed.revision, audience: "campaign",
  });
  expect(shared.breakdown.groups.find((group) => group.id === "attribute")?.count).toBe(5);

  // Calculate the expected totals from the server's dice so replay never depends on specific faces.
  for (const roll of [original, pushed.roll, shared]) {
    const attributeSuccesses = roll.dice.filter((die) => die.groupId === "attribute" && die.value === 6).length;
    const skillSuccesses = roll.dice.filter((die) => die.groupId === "skill" && die.value >= 5).length;
    const gearTotal = roll.dice.filter((die) => die.groupId === "gear").reduce((sum, die) => sum + die.value, 0);
    expect(roll.total).toBe(attributeSuccesses + 2 * skillSuccesses + gearTotal);
  }
  expect(await gm.json(`GET ${originalPath}`)).toEqual(original);
  expect(await gm.json(`GET ${childPath}`)).toEqual(pushed.roll);

  type Feed = { events: Array<{ kind: string; actorId: string; sourceRollId: string | null }> };
  const gmFeed = await gm.json<Feed>(`GET ${campaignPath}/activity`);
  expect(gmFeed.events.filter((event) => event.kind === "roll_executed").map((event) => event.sourceRollId).sort())
    .toEqual([shared.rollId, pushed.roll.rollId, original.rollId].sort());
  const crewFeed = await mechanic.json<Feed>(`GET ${campaignPath}/activity`);
  expect(crewFeed.events.filter((event) => event.kind === "roll_executed"))
    .toEqual([expect.objectContaining({ actorId: scout.actorId, sourceRollId: shared.rollId })]);
});
