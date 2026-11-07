import { randomUUID } from "node:crypto";

import { expect } from "vitest";

import { scenario, type ScenarioActor } from "./runner.js";

type Revision = { revision: number };
type Sheet = Revision & {
  characterId: string;
  values: Record<string, unknown>;
  derivedValues: Record<string, number>;
};
type Roll = { total: number; dice: Array<{ sides: number; value: number; kept: boolean }> };

scenario("Forged in the Dark: run a harbor score and recover in downtime", async ({ actor, phase }) => {
  const gm = await actor("ada", ["systems:write", "characters:write", "campaigns:write"]);
  const lockrunner = await actor("bob", ["characters:write", "campaigns:write"]);
  const wirewright = await actor("dan", ["characters:write", "campaigns:write"]);

  await phase("Clone and publish the built-in rules");
  const { templates } = await gm.json<{ templates: Array<{ name: string; versionId: string }> }>("GET /templates");
  const template = templates.find(({ name }) => name === "Template: Forged in the Dark");
  if (!template) throw new Error("Forged in the Dark is missing from the starter templates");
  const { system: { systemId }, draft, assessment } = await gm.command<{
    system: { systemId: string }; draft: Revision; assessment: { valid: boolean; diagnostics: unknown[] };
  }>("POST /systems", { source: { kind: "clone", versionId: template.versionId } }, 201);
  expect(assessment).toEqual({ valid: true, diagnostics: [] });
  const { versionId } = await gm.command<{ versionId: string }>(`POST /systems/${systemId}/publish`, {
    expectedRevision: draft.revision, semanticVersion: "1.0.0", releaseNotes: "Bellharbor campaign edition",
  }, 201);

  await phase("Assemble the Tidemark crew");
  const { campaignId } = await gm.command<{ campaignId: string }>("POST /campaigns", {
    title: "The Harbor Ledger", systemVersionId: versionId,
  }, 201);
  const campaignPath = `/campaigns/${campaignId}` as const;
  const campaignRevision = async () => (await gm.json<Revision>(`GET ${campaignPath}`)).revision;

  for (const player of [lockrunner, wirewright]) {
    const { token } = await gm.command<{ token: string }>(`POST ${campaignPath}/invitations`, {
      intendedRole: "player", expectedCampaignRevision: await campaignRevision(),
    }, 201);
    const review = await player.json<{ invitationRevision: number; accessRevision: number }>("POST /invitations/review", { token });
    await player.command("POST /invitations/accept", {
      campaignId, token, expectedInvitationRevision: review.invitationRevision, reviewedAccessRevision: review.accessRevision,
    });
  }

  const place = async (name: string, entityDefinitionId: string, controllerUserIds: string[], initialValues: object) =>
    gm.command<Sheet>(`POST ${campaignPath}/characters`, {
      name, entityDefinitionId, controllerUserIds, initialValues, expectedCampaignRevision: await campaignRevision(),
    }, 201);

  const controllers = [lockrunner.actorId, wirewright.actorId];
  const crew = await place("The Tidemark Crew", "crew", controllers, { crew_type: "Harbor thieves", hold: "Weak" });
  const clock = await place("Harbor patrol alarm", "clock", controllers, { segments: { current: 0, max: 4 } });
  const maren = await place("Maren Voss", "character", [lockrunner.actorId], {
    playbook: "lockrunner", finesse: 2, prowl: 2, survey: 1, sway: 1, tinker: 1, vice: "Cards at the mooring house",
  });
  const ivo = await place("Ivo Bell", "character", [wirewright.actorId], {
    playbook: "wirewright", tinker: 2, study: 1, survey: 1, finesse: 1, prowl: 1, consort: 1,
  });
  expect(maren.derivedValues).toMatchObject({ insight: 2, prowess: 2, resolve: 1 });
  expect(ivo.derivedValues).toMatchObject({ insight: 3, prowess: 2, resolve: 1 });
  await wirewright.status(`GET /characters/${maren.characterId}`, 404);

  async function bump(who: ScenarioActor, sheet: Sheet, field: string, delta: number) {
    for (let step = 0; step < Math.abs(delta); step += 1) {
      const { revision } = await who.command<Revision>(`POST /characters/${sheet.characterId}/resources/${field}/bump`, {
        direction: delta > 0 ? "up" : "down", expectedRevision: sheet.revision,
      });
      sheet.revision = revision;
    }
  }

  async function roll(who: ScenarioActor, sheet: Sheet, pool: number) {
    const result = await who.command<Revision & { roll: Roll }>(
      `POST /characters/${sheet.characterId}/actions/roll_${pool}_dice`,
      { expectedRevision: sheet.revision, audience: "campaign" },
    );
    sheet.revision = result.revision;
    const { dice, total } = result.roll;
    expect(dice).toHaveLength(pool === 0 ? 2 : pool);
    expect(dice.every(({ sides, value }) => sides === 6 && value >= 1 && value <= 6)).toBe(true);
    const faces = dice.map(({ value }) => value);
    expect(total).toBe(pool === 0 ? Math.min(...faces) : Math.max(...faces));
    expect(dice.filter(({ kept }) => kept).map(({ value }) => value)).toEqual([total]);
    return result.roll;
  }

  await phase("Run the harbor score");
  await gm.command(`POST ${campaignPath}/content`, {
    title: "The job", audience: "all_players", body: "Copy the embargo ledger before the harbor patrol sweeps the customs office.",
  }, 201);
  await roll(lockrunner, maren, 1); // Engagement establishes the opening position.
  const gear = await lockrunner.command<Revision>(`POST /characters/${maren.characterId}/entries`, {
    templateId: "glass_cutter", slotId: "gear", entryId: randomUUID(), expectedRevision: maren.revision,
  });
  const declaredLoad = await lockrunner.command<Revision>(`POST /characters/${maren.characterId}/fields/load_used/set`, {
    value: 1, expectedRevision: gear.revision,
  });
  maren.revision = declaredLoad.revision;
  await bump(lockrunner, maren, "stress", 2);
  const window = await roll(lockrunner, maren, Number(maren.values.finesse) + 1);
  const signal = await roll(wirewright, ivo, 0); // Ivo has no Sway dice for the bluff.
  const alarmTicks = Number(window.total < 6) + Number(signal.total < 6);
  await bump(gm, clock, "segments", alarmTicks);

  // The GM offers reduced harm as the crew escapes through a collapsing walkway.
  const resistance = await roll(lockrunner, maren, maren.derivedValues.prowess!);
  const critical = resistance.dice.filter(({ value }) => value === 6).length >= 2;
  const stressAfterScore = 2 + (critical ? -1 : 6 - resistance.total);
  await bump(lockrunner, maren, "stress", stressAfterScore - 2);

  await phase("Record payoff, heat and downtime");
  await bump(gm, crew, "treasury", 2);
  await bump(gm, crew, "heat", 2);
  const vice = await roll(lockrunner, maren, Math.min(
    maren.derivedValues.insight!, maren.derivedValues.prowess!, maren.derivedValues.resolve!,
  ));
  await bump(lockrunner, maren, "stress", -Math.min(stressAfterScore, vice.total));
  await bump(lockrunner, maren, "downtime_used", 1);
  const project = await place("Chart the maintenance tunnels", "clock", controllers, {});
  const work = await roll(wirewright, ivo, Number(ivo.values.tinker));
  const projectTicks = work.total <= 3 ? 1 : work.total <= 5 ? 2
    : work.dice.filter(({ value }) => value === 6).length >= 2 ? 5 : 3;
  await bump(wirewright, project, "segments", projectTicks);
  await bump(wirewright, ivo, "downtime_used", 1);

  const marenAfter = await lockrunner.json<Sheet>(`GET /characters/${maren.characterId}`);
  expect(marenAfter.values).toMatchObject({
    stress: { current: Math.max(0, stressAfterScore - vice.total), max: 9 },
    load_used: 1, downtime_used: { current: 1, max: 2 },
  });
  expect(await wirewright.json(`GET /characters/${crew.characterId}`)).toMatchObject({
    values: { treasury: { current: 2, max: 4 }, heat: { current: 2, max: 9 } },
  });
  expect(await lockrunner.json(`GET /characters/${clock.characterId}`)).toMatchObject({
    values: { segments: { current: alarmTicks, max: 4 } },
  });
  expect(await lockrunner.json(`GET /characters/${project.characterId}`)).toMatchObject({
    values: { segments: { current: projectTicks, max: 6 } },
  });
  const { events } = await wirewright.json<{ events: Array<{ kind: string; actorId: string }> }>(
    `GET ${campaignPath}/activity?limit=100`,
  );
  const rolls = events.filter(({ kind }) => kind === "roll_executed").map(({ actorId }) => actorId);
  expect(rolls.sort()).toEqual([
    lockrunner.actorId, lockrunner.actorId, lockrunner.actorId, lockrunner.actorId, wirewright.actorId, wirewright.actorId,
  ].sort());
});
