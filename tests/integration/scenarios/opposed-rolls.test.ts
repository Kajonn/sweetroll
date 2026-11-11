import { randomUUID } from "node:crypto";

import { expect } from "vitest";

import { bridgeContestDocument } from "../../../src/systems/implementation/package/fixtures/opposed.js";
import type { NormalizedRoll } from "../../../src/systems/runtime.js";
import { scenario } from "./runner.js";

type Revision = { revision: number };
type Sheet = Revision & { characterId: string };
type RollResult = Sheet & { roll: NormalizedRoll };
const playerScopes = ["characters:read", "characters:write", "campaigns:read", "campaigns:write"] as const;

scenario("Bridge Contest: target a defender and contest a recorded roll", async ({ actor, phase }) => {
  const gm = await actor("ada", [...playerScopes, "systems:read", "systems:write"]);
  const striker = await actor("bob", [...playerScopes]);
  const defender = await actor("cara", [...playerScopes]);
  const outsider = await actor("dan", [...playerScopes]);
  const created = await gm.command<{ system: { systemId: string }; draft: Revision }>("POST /systems", { name: "Bridge Contest" }, 201);
  const system = `/systems/${created.system.systemId}` as const;
  const saved = await gm.json<{ draft: Revision }>(`PUT ${system}/draft`, {
    document: bridgeContestDocument, expectedRevision: created.draft.revision,
  });
  const { versionId } = await gm.command<{ versionId: string }>(`POST ${system}/publish`, {
    expectedRevision: saved.draft.revision, semanticVersion: "1.0.0", releaseNotes: "Attack and contest",
  }, 201);
  await gm.json(`PUT ${system}/sharing`, { access: "link" });
  const { campaignId } = await gm.command<{ campaignId: string }>("POST /campaigns", {
    title: "Bridge Contest", systemVersionId: versionId,
  }, 201);
  const campaign = `/campaigns/${campaignId}` as const;
  const revision = async () => (await gm.json<Revision>(`GET ${campaign}`)).revision;
  const sheets: Sheet[] = [];
  for (const [player, name] of [[striker, "Striker"], [defender, "Defender"]] as const) {
    const sheet = await player.command<Sheet>("POST /characters", {
      name, systemVersionId: versionId, entityDefinitionId: "character",
    }, 201);
    const invitation = await gm.command<{ token: string }>(`POST ${campaign}/invitations`, {
      intendedRole: "player", expectedCampaignRevision: await revision(),
    }, 201);
    const { invitationRevision, accessRevision } = await player.json<{ invitationRevision: number; accessRevision: number }>(
      "POST /invitations/review", { token: invitation.token },
    );
    await player.command("POST /invitations/accept", {
      campaignId, token: invitation.token, expectedInvitationRevision: invitationRevision, reviewedAccessRevision: accessRevision,
    });
    sheets.push(await player.command<Sheet>(`POST ${campaign}/characters/${sheet.characterId}/adopt`, {
      expectedCampaignRevision: await revision(), expectedCharacterRevision: sheet.revision, acknowledgedDisclosure: true,
    }));
  }
  const [a, b] = sheets as [Sheet, Sheet];
  const path = (sheet: Sheet, action: string) => `POST /characters/${sheet.characterId}/actions/${action}` as const;
  const optionsPath = (sheet: Sheet, action: string) =>
    `GET /characters/${sheet.characterId}/actions/${action}/roll-options` as const;
  const command = (sheet: Sheet, context: object) => ({
    expectedRevision: sheet.revision, audience: "campaign", idempotencyKey: randomUUID(), ...context,
  });
  const rollIds = async (who: typeof gm) => (await who.json<{ events: { sourceRollId: string | null }[] }>(
    `GET ${campaign}/activity`,
  )).events.flatMap(event => event.sourceRollId ?? []);

  await phase("Target another player's computed defense");
  await striker.status(`GET /characters/${b.characterId}`, 404);
  const attack = command(a, { targetCharacterId: b.characterId });
  await outsider.status(path(a, "attack"), 404, command(a, { targetCharacterId: b.characterId }));
  await outsider.status(optionsPath(a, "attack"), 404);
  await striker.status(optionsPath(a, "check"), 404);
  expect(await striker.json(optionsPath(a, "attack"))).toEqual({
    targets: [{ characterId: b.characterId, name: "Defender" }, { characterId: a.characterId, name: "Striker" }], rolls: [],
  });
  const hit = await striker.command<RollResult>(path(a, "attack"), attack);
  expect(hit.roll).toMatchObject({
    targetCharacterId: b.characterId, total: hit.roll.dice[0]!.value - 10,
    bindings: [{ scope: "target", definitionId: "defense", value: 10 }],
  });
  expect(hit.revision).toBe(a.revision);
  expect(await striker.command<RollResult>(path(a, "attack"), attack)).toMatchObject({ roll: hit.roll });
  await striker.status(path(a, "attack"), 409, { ...attack, targetCharacterId: a.characterId });
  await striker.status(path(a, "attack"), 422, command(a, {}));
  await striker.status(path(a, "check"), 422, command(a, { targetCharacterId: b.characterId }));

  await phase("Respond to visible rolls and enforce one response per actor");
  const [opposedId] = await rollIds(defender);
  expect(opposedId).toBeDefined();
  expect(await defender.json(optionsPath(b, "counter"))).toEqual({
    targets: [], rolls: [{ rollId: opposedId, output: hit.roll.output }],
  });
  const response = command(b, { respondsTo: opposedId });
  const counter = await defender.command<RollResult>(path(b, "counter"), response);
  expect(counter.roll).toMatchObject({
    respondsTo: opposedId, total: counter.roll.dice[0]!.value - hit.roll.total,
    bindings: [{ scope: "opposed", definitionId: "total", value: hit.roll.total }],
  });
  expect(counter.revision).toBe(b.revision);
  expect(await defender.command<RollResult>(path(b, "counter"), response)).toMatchObject({ roll: counter.roll });
  await defender.status(path(b, "counter"), 409, command(b, { respondsTo: opposedId }));
  await gm.command(path(b, "counter"), command(b, { respondsTo: opposedId }));
  await striker.command(path(a, "check"), command(a, { audience: "owner_only" }));
  const privateActivity = await striker.json<{ events: { rollId?: string; roll?: NormalizedRoll }[] }>(
    `GET /characters/${a.characterId}/activity`,
  );
  const privateId = privateActivity.events.find(event => event.roll?.audience === "owner_only")?.rollId;
  expect(privateId).toBeDefined();
  expect(await rollIds(defender)).not.toContain(privateId);
  expect((await defender.json<{ rolls: { rollId: string }[] }>(optionsPath(b, "counter"))).rolls.map(roll => roll.rollId))
    .not.toContain(privateId);
  const privateResponse = await striker.command<RollResult>(path(a, "counter"), command(a, { respondsTo: privateId }));
  expect(privateResponse.roll.audience).toBe("owner_only");
  await defender.status(path(b, "counter"), 404, command(b, { respondsTo: privateId }));
  expect((await gm.command<{ rolls: NormalizedRoll[] }>(`POST ${campaign}/exports`, {})).rolls).toEqual(expect.arrayContaining([
    expect.objectContaining({ targetCharacterId: b.characterId, bindings: hit.roll.bindings }),
    expect.objectContaining({ respondsTo: opposedId, bindings: counter.roll.bindings }),
  ]));

  await phase("Reject archived targets, removed members and standalone play");
  await gm.command(`PATCH /characters/${b.characterId}`, { command: "archive", expectedRevision: b.revision });
  await striker.status(path(a, "attack"), 404, command(a, { targetCharacterId: b.characterId }));
  expect(await striker.json(optionsPath(a, "attack"))).toEqual({
    targets: [{ characterId: a.characterId, name: "Striker" }], rolls: [],
  });
  await gm.command(`DELETE ${campaign}/members/${striker.actorId}`, { expectedCampaignRevision: await revision() });
  await striker.status(path(a, "attack"), 400, command(a, { targetCharacterId: b.characterId, audience: "owner_only" }));
  await striker.status(path(b, "counter"), 404, command(b, { respondsTo: opposedId }));
  await striker.status(optionsPath(b, "counter"), 404);
});
