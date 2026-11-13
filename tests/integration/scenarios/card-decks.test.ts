import { randomUUID } from "node:crypto";

import { expect } from "vitest";

import { emberRoadDocument } from "../../../src/systems/implementation/package/fixtures/card-decks.js";
import type { NormalizedRoll } from "../../../src/systems/runtime.js";
import { scenario } from "./runner.js";

type Revision = { revision: number };
type Sheet = Revision & { characterId: string };
type DrawResult = Sheet & { roll: NormalizedRoll | null };
type Decks = { decks: { deckId: string; label: string; total: number; remaining: number }[] };
const playerScopes = ["characters:read", "characters:write", "campaigns:read", "campaigns:write"] as const;

scenario("Ember Road: a shared campaign deck and a standalone deck", async ({ actor, phase }) => {
  const gm = await actor("ada", [...playerScopes, "systems:read", "systems:write"]);
  const seer = await actor("bob", [...playerScopes]);
  const scout = await actor("cara", [...playerScopes]);
  const outsider = await actor("dan", [...playerScopes]);

  await phase("Publish the deck through the public API");
  const created = await gm.command<{ system: { systemId: string }; draft: Revision }>("POST /systems", { name: "Ember Road" }, 201);
  const system = `/systems/${created.system.systemId}` as const;
  const saved = await gm.json<{ draft: Revision }>(`PUT ${system}/draft`, {
    document: emberRoadDocument, expectedRevision: created.draft.revision,
  });
  const { versionId } = await gm.command<{ versionId: string }>(`POST ${system}/publish`, {
    expectedRevision: saved.draft.revision, semanticVersion: "1.0.0", releaseNotes: "Omen deck",
  }, 201);
  await gm.json(`PUT ${system}/sharing`, { access: "link" });
  const { campaignId } = await gm.command<{ campaignId: string }>("POST /campaigns", {
    title: "Ember Road", systemVersionId: versionId,
  }, 201);
  const campaign = `/campaigns/${campaignId}` as const;
  const revision = async () => (await gm.json<Revision>(`GET ${campaign}`)).revision;
  const sheets: Sheet[] = [];
  for (const [player, name] of [[seer, "Seer"], [scout, "Scout"]] as const) {
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
  const act = (sheet: Sheet, action: string) => `POST /characters/${sheet.characterId}/actions/${action}` as const;
  const decksOf = (sheet: Sheet) => `GET /characters/${sheet.characterId}/decks` as const;
  const command = (sheet: Sheet, extra: object = {}) => ({
    expectedRevision: sheet.revision, audience: "campaign", inputs: {}, idempotencyKey: randomUUID(), ...extra,
  });
  const cardsOf = (result: DrawResult) => result.roll!.breakdown.cards!.drawn.map(card => card.id);

  await phase("Concurrent draws never deal the same card");
  expect(await seer.json<Decks>(decksOf(a))).toEqual({
    decks: [{ deckId: "omen_deck", label: "Omen deck", total: 12, remaining: 12 }],
  });
  await outsider.status(decksOf(a), 404);
  await outsider.status(act(a, "read_omens"), 404, command(a));
  const first = command(a);
  const draws = await Promise.all([
    seer.command<DrawResult>(act(a, "read_omens"), first),
    scout.command<DrawResult>(act(b, "read_omens"), command(b)),
    gm.command<DrawResult>(act(a, "read_omens"), command(a)),
    seer.command<DrawResult>(act(a, "read_omens"), command(a)),
    scout.command<DrawResult>(act(b, "read_omens"), command(b)),
  ]);
  const dealt = draws.flatMap(cardsOf);
  expect(dealt).toHaveLength(10);
  expect(new Set(dealt).size).toBe(10);
  expect(draws.map(draw => draw.roll!.breakdown.cards!.remaining).sort((x, y) => x - y)).toEqual([2, 4, 6, 8, 10]);
  expect(draws[0]!.revision).toBe(a.revision);
  expect(draws[0]!.roll).toMatchObject({ actionId: "read_omens", total: 2, audience: "campaign", dice: [] });
  expect(draws[0]!.roll!.breakdown.cards!.drawn[0]!.values).toMatchObject({ suit: expect.any(String), rank: expect.any(Number) });

  await phase("Replays, the last cards and the empty deck");
  expect(cardsOf(await seer.command<DrawResult>(act(a, "read_omens"), first))).toEqual(cardsOf(draws[0]!));
  expect(await scout.json<Decks>(decksOf(b))).toMatchObject({ decks: [{ remaining: 2 }] });
  const last = await scout.command<DrawResult>(act(b, "read_omens"), command(b));
  expect(new Set([...dealt, ...cardsOf(last)]).size).toBe(12);
  const empty = command(a);
  for (const attempt of [empty, empty, command(a)]) {
    const refused = await seer.json<{ message?: string; error?: { message: string } }>(act(a, "read_omens"), attempt, 422);
    expect(JSON.stringify(refused)).toContain("Omen deck has no cards left. Shuffle it to draw again.");
  }
  await seer.status(act(a, "read_omens"), 422, command(a, { inputs: { bonus: 1 } }));
  await seer.status(act(a, "read_omens"), 422, command(a, { targetCharacterId: b.characterId }));

  await phase("Shuffle returns every card and draws are recorded like rolls");
  const shuffled = await scout.command<DrawResult>(act(b, "gather_omens"), command(b));
  expect(shuffled.roll).toBeNull();
  expect(shuffled.revision).toBe(b.revision);
  expect(await seer.json<Decks>(decksOf(a))).toMatchObject({ decks: [{ remaining: 12 }] });
  const secret = await seer.command<DrawResult>(act(a, "read_omens"), command(a, { audience: "owner_only" }));
  expect(secret.roll).toMatchObject({ audience: "owner_only" });
  expect(await gm.json<Decks>(decksOf(b))).toMatchObject({ decks: [{ remaining: 10 }] });
  // The campaign feed shows a roll's result text to exactly the readers its audience allows.
  type Feed = { events: { kind: string; rollOutput: string | null }[] };
  const outputs = async (reader: typeof gm) => (await reader.json<Feed>(`GET ${campaign}/activity`)).events
    .filter(event => event.kind === "roll_executed").map(event => event.rollOutput);
  for (const reader of [gm, scout, seer]) expect(await outputs(reader)).toContain(last.roll!.output);
  expect(await outputs(seer)).toContain(secret.roll!.output);
  expect(await outputs(scout)).not.toContain(secret.roll!.output);
  expect(await outputs(gm)).not.toContain(secret.roll!.output);
  expect((await outputs(scout)).every(output => typeof output === "string")).toBe(true);
  const history = await seer.json<{ events: { roll?: NormalizedRoll }[] }>(`GET /characters/${a.characterId}/activity`);
  expect(history.events).toContainEqual(expect.objectContaining({
    roll: expect.objectContaining({ output: draws[0]!.roll!.output, breakdown: draws[0]!.roll!.breakdown }),
  }));
  const exported = await gm.command<{ rolls: (NormalizedRoll & { breakdownText: string })[] }>(`POST ${campaign}/exports`, {});
  const exportedDraw = exported.rolls.find(roll => roll.output === last.roll!.output);
  expect(exportedDraw).toMatchObject({ breakdown: last.roll!.breakdown });
  expect(exportedDraw!.breakdownText).toContain(last.roll!.breakdown.cards!.drawn[0]!.label);
  expect(exportedDraw!.breakdownText).toContain("Cards left: 0");

  await phase("A standalone character has its own deck");
  const solo = await outsider.command<Sheet>("POST /characters", {
    name: "Wanderer", systemVersionId: versionId, entityDefinitionId: "character",
  }, 201);
  expect(await outsider.json<Decks>(decksOf(solo))).toMatchObject({ decks: [{ remaining: 12 }] });
  await seer.status(decksOf(solo), 404);
  const soloCommand = (extra: object = {}) => ({ expectedRevision: solo.revision, inputs: {}, idempotencyKey: randomUUID(), ...extra });
  const soloDraws = await Promise.all([1, 2, 3].map(() => outsider.command<DrawResult>(act(solo, "read_omens"), soloCommand())));
  expect(new Set(soloDraws.flatMap(cardsOf)).size).toBe(6);
  expect(soloDraws[0]!.roll).toMatchObject({ audience: "owner_only" });
  await outsider.status(act(solo, "read_omens"), 400, soloCommand({ audience: "campaign" }));
  expect(await outsider.json<Decks>(decksOf(solo))).toMatchObject({ decks: [{ remaining: 6 }] });
  expect(await seer.json<Decks>(decksOf(a))).toMatchObject({ decks: [{ remaining: 10 }] });
  await outsider.command(act(solo, "gather_omens"), soloCommand());
  expect(await outsider.json<Decks>(decksOf(solo))).toMatchObject({ decks: [{ remaining: 12 }] });
});
