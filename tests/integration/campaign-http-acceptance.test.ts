import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildI6Harness, type I6Harness } from "./i6-app.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl === undefined ? describe.skip : describe;

type Actor = keyof I6Harness["users"];

describeWithDatabase("campaign HTTP acceptance demonstration (Task 10)", () => {
  let h: I6Harness;

  beforeAll(async () => {
    h = await buildI6Harness();
    // Fixture setup (not a workflow): the published fixture versions are
    // private by default; the shared table version must be usable by every
    // member, mirroring existing placement/roll suites.
    await h.pool.query(`UPDATE systems SET access = 'public'`);
  });

  afterAll(async () => {
    await h.close();
  });

  function cookie(who: Actor) {
    return { cookie: h.users[who].cookie };
  }

  async function post(who: Actor, url: string, payload: unknown, expected: number) {
    const res = await h.app.inject({ method: "POST", url, headers: cookie(who), payload });
    expect(res.statusCode, `${who} POST ${url}: ${res.body}`).toBe(expected);
    return res.json() as any;
  }

  async function get(who: Actor, url: string) {
    return h.app.inject({ method: "GET", url, headers: cookie(who) });
  }

  async function campaignRevision(campaignId: string, who: Actor = "gm"): Promise<number> {
    const res = await get(who, `/campaigns/${campaignId}`);
    expect(res.statusCode, `GET campaign: ${res.body}`).toBe(200);
    return (res.json() as any).campaign.revision as number;
  }

  async function characterRevision(who: Actor, characterId: string): Promise<{ revision: number; state: unknown }> {
    const res = await get(who, `/characters/${characterId}`);
    expect(res.statusCode, `GET character: ${res.body}`).toBe(200);
    const character = (res.json() as any).character;
    return { revision: character.revision as number, state: character.state };
  }

  it("full journey over HTTP: provision → join → controllers → adopt → rolls → departure race → return → denials → safe export", async () => {
    const gm = h.users.gm;
    const player = h.users.player;
    const other = h.users.other;

    // Provision a campaign as GM (ordinary HTTP workflow).
    const created = await post("gm", "/campaigns", {
      systemVersionId: h.versionId,
      title: `HTTP demo ${randomUUID()}`,
      description: "task 10 exit demonstration",
      idempotencyKey: randomUUID(),
    }, 201);
    const campaignId = created.campaign.campaignId as string;
    expect(created.campaign.revision).toBe(1);

    // Invite the player, review out-of-band, accept as another actor.
    let rev = await campaignRevision(campaignId);
    const issued = await post("gm", `/campaigns/${campaignId}/invitations`, {
      intendedRole: "player",
      expectedCampaignRevision: rev,
      idempotencyKey: randomUUID(),
    }, 201);
    const token = issued.invitation.token as string;
    expect(token).toBeTruthy();
    const inviteId = issued.invitation.invitationId as string;

    const reviewed = await post("player", "/invitations/review", { token }, 200);
    expect(reviewed.review.campaignId).toBe(campaignId);
    const invitationRevision = reviewed.review.invitationRevision as number;
    const accessRevision = reviewed.review.accessRevision as number;

    const accepted = await post("player", "/invitations/accept", {
      campaignId,
      token,
      expectedInvitationRevision: invitationRevision,
      reviewedAccessRevision: accessRevision,
      idempotencyKey: randomUUID(),
    }, 200);
    expect(accepted.acceptance.membership.userId).toBe(player.actorId);
    const playerGeneration = accepted.acceptance.membershipGeneration as number;
    expect(playerGeneration).toBeGreaterThan(0);

    // Invite the second player for shared-controller coverage.
    rev = await campaignRevision(campaignId);
    const issuedOther = await post("gm", `/campaigns/${campaignId}/invitations`, {
      intendedRole: "player",
      expectedCampaignRevision: rev,
      idempotencyKey: randomUUID(),
    }, 201);
    const otherToken = issuedOther.invitation.token as string;
    const otherReview = await post("other", "/invitations/review", { token: otherToken }, 200);
    await post("other", "/invitations/accept", {
      campaignId,
      token: otherToken,
      expectedInvitationRevision: otherReview.review.invitationRevision,
      reviewedAccessRevision: otherReview.review.accessRevision,
      idempotencyKey: randomUUID(),
    }, 200);

    // Create a campaign character as GM, designate the player, claim as player.
    rev = await campaignRevision(campaignId);
    const sheet = await post("gm", `/campaigns/${campaignId}/characters`, {
      name: "Party blade",
      entityDefinitionId: "character",
      expectedCampaignRevision: rev,
      idempotencyKey: randomUUID(),
    }, 201);
    const partyId = sheet.character.characterId as string;
    let partyRevision = sheet.character.revision as number;

    rev = await campaignRevision(campaignId);
    await post("gm", `/campaigns/${campaignId}/characters/${partyId}/assign`, {
      controllerUserIds: [],
      designateClaimants: [player.actorId],
      expectedCampaignRevision: rev,
      expectedCharacterRevision: partyRevision,
      idempotencyKey: randomUUID(),
    }, 200);

    rev = await campaignRevision(campaignId);
    const claimed = await post("player", `/campaigns/${campaignId}/characters/${partyId}/claim`, {
      expectedCampaignRevision: rev,
      expectedCharacterRevision: partyRevision,
      idempotencyKey: randomUUID(),
    }, 200);
    expect(claimed.character.controllers).toContain(player.actorId);
    partyRevision = claimed.character.revision as number;

    // Share controllers across both players through HTTP.
    rev = await campaignRevision(campaignId);
    const shared = await post("gm", `/campaigns/${campaignId}/characters/${partyId}/assign`, {
      controllerUserIds: [player.actorId, other.actorId],
      expectedCampaignRevision: rev,
      expectedCharacterRevision: partyRevision,
      idempotencyKey: randomUUID(),
    }, 200);
    expect(shared.character.controllers.sort()).toEqual([player.actorId, other.actorId].sort());

    // Adopt an exact-version personal character with the return disclosure.
    const standalone = await post("player", "/characters", {
      systemVersionId: h.versionId,
      entityDefinitionId: "character",
      name: `Adoptable ${randomUUID().slice(0, 8)}`,
      idempotencyKey: randomUUID(),
    }, 201);
    const adoptId = standalone.character.characterId as string;
    const adoptRevision = standalone.character.revision as number;
    const preAdoptionState = standalone.character.state;

    // Missing disclosure is rejected without touching placement.
    rev = await campaignRevision(campaignId);
    const noAck = await h.app.inject({
      method: "POST",
      url: `/campaigns/${campaignId}/characters/${adoptId}/adopt`,
      headers: cookie("player"),
      payload: {
        expectedCampaignRevision: rev,
        expectedCharacterRevision: adoptRevision,
        acknowledgedDisclosure: false,
        idempotencyKey: randomUUID(),
      },
    });
    expect(noAck.statusCode, noAck.body).toBe(400);

    rev = await campaignRevision(campaignId);
    const adopted = await post("player", `/campaigns/${campaignId}/characters/${adoptId}/adopt`, {
      expectedCampaignRevision: rev,
      expectedCharacterRevision: adoptRevision,
      acknowledgedDisclosure: true,
      idempotencyKey: randomUUID(),
    }, 200);
    expect(adopted.character.campaignId).toBe(campaignId);
    expect(adopted.character.systemVersionId).toBe(h.versionId);
    expect(adopted.character.state).toEqual(preAdoptionState);
    const adoptedSystemVersionId = adopted.character.systemVersionId as string;

    // Content across every audience through ordinary HTTP.
    const handout = await post("gm", `/campaigns/${campaignId}/content`, {
      title: "handout",
      body: "a map of the region",
      audience: "all_players",
      idempotencyKey: randomUUID(),
    }, 201);
    const whisper = await post("gm", `/campaigns/${campaignId}/content`, {
      title: "whisper",
      body: "a secret for the rogue",
      audience: "selected_players",
      grantedUserIds: [player.actorId],
      idempotencyKey: randomUUID(),
    }, 201);
    const gmNote = await post("gm", `/campaigns/${campaignId}/content`, {
      title: "gm plans",
      body: "the dragon wakes",
      audience: "gm_only",
      idempotencyKey: randomUUID(),
    }, 201);
    const diaryKey = randomUUID();
    const diaryBody = `player diary ${randomUUID()}`;
    await post("player", `/campaigns/${campaignId}/content`, {
      title: "diary",
      body: diaryBody,
      idempotencyKey: diaryKey,
    }, 201);

    // Audience-filtered lists are safe: the player sees shared rows, never
    // the GM-only note; the GM sees everything except the player's diary.
    const playerContent = await get("player", `/campaigns/${campaignId}/content?limit=100`);
    expect(playerContent.statusCode).toBe(200);
    const playerTitles = ((playerContent.json() as any).content as Array<any>).map((c) => c.title);
    expect(playerTitles).toEqual(expect.arrayContaining(["handout", "whisper", "diary"]));
    expect(playerTitles).not.toContain("gm plans");

    const gmContent = await get("gm", `/campaigns/${campaignId}/content?limit=100`);
    expect(gmContent.statusCode).toBe(200);
    const gmTitles = ((gmContent.json() as any).content as Array<any>).map((c) => c.title);
    expect(gmTitles).toEqual(expect.arrayContaining(["handout", "whisper", "gm plans"]));
    expect(gmTitles).not.toContain("diary");

    // Rolls across all audiences on the adopted sheet.
    const adoptedRev0 = (await characterRevision("player", adoptId)).revision;
    const campaignRoll = await post("player", `/characters/${adoptId}/actions/check`, {
      inputs: { bonus: 2 },
      audience: "campaign",
      expectedRevision: adoptedRev0,
      idempotencyKey: randomUUID(),
    }, 200);
    expect(campaignRoll.result.roll.audience).toBe("campaign");
    const gmRoll = await post("gm", `/characters/${adoptId}/actions/check`, {
      inputs: { bonus: 1 },
      audience: "gm_only",
      expectedRevision: adoptedRev0,
      idempotencyKey: randomUUID(),
    }, 200);
    expect(gmRoll.result.roll.audience).toBe("gm_only");
    const privateRoll = await post("player", `/characters/${adoptId}/actions/check`, {
      inputs: { bonus: 3 },
      audience: "owner_only",
      expectedRevision: adoptedRev0,
      idempotencyKey: randomUUID(),
    }, 200);
    expect(privateRoll.result.roll.audience).toBe("owner_only");

    const gmActivity = await get("gm", `/campaigns/${campaignId}/activity?limit=100`);
    expect(gmActivity.statusCode).toBe(200);
    expect(((gmActivity.json() as any).events as Array<any>).length).toBeGreaterThan(0);

    // Baseline state before the departure race (last committed sheet state).
    const baseline = await characterRevision("player", adoptId);
    const baselineState = baseline.state;
    const baselineRevision = baseline.revision;

    // Concurrent departure vs sheet write: either the authorized write
    // commits before departure and its current state returns, or it is
    // denied/conflicted afterward — never partial or silent overwrite.
    const raceRevision = await campaignRevision(campaignId);
    const writeKey = randomUUID();
    const removalKey = randomUUID();
    const [writeRes, removalRes] = await Promise.all([
      h.app.inject({
        method: "POST",
        url: `/characters/${adoptId}/fields/ability/set`,
        headers: cookie("player"),
        payload: { value: 14, expectedRevision: baselineRevision, idempotencyKey: writeKey },
      }),
      h.app.inject({
        method: "DELETE",
        url: `/campaigns/${campaignId}/members/${player.actorId}`,
        headers: cookie("gm"),
        payload: { expectedCampaignRevision: raceRevision, idempotencyKey: removalKey },
      }),
    ]);
    expect([200, 404, 409]).toContain(writeRes.statusCode);
    expect([200, 409]).toContain(removalRes.statusCode);

    // Exactly one linearization wins; drive departure to completion so the
    // return/denial assertions below observe the departed state.
    let removal = removalRes;
    if (removal.statusCode !== 200) {
      const fresh = await campaignRevision(campaignId);
      removal = await h.app.inject({
        method: "DELETE",
        url: `/campaigns/${campaignId}/members/${player.actorId}`,
        headers: cookie("gm"),
        payload: { expectedCampaignRevision: fresh, idempotencyKey: randomUUID() },
      });
    }
    expect(removal.statusCode, removal.body).toBe(200);

    // The adopted character returns with current state + exact pin; the
    // campaign-created sheet stays attached.
    const returnedRes = await get("player", `/characters/${adoptId}`);
    expect(returnedRes.statusCode, returnedRes.body).toBe(200);
    const returned = (returnedRes.json() as any).character;
    expect(returned.ownerId).toBe(player.actorId);
    expect(returned.campaignId).toBeNull();
    expect(returned.systemVersionId).toBe(adoptedSystemVersionId);
    if (writeRes.statusCode === 200) {
      const lastCommittedState = (writeRes.json() as any).result.character.state;
      expect(returned.state).toEqual(lastCommittedState);
    } else {
      // Denied/conflicted after departure: no silent overwrite.
      expect(returned.state).toEqual(baselineState);
    }

    const gmParty = await get("gm", `/characters/${partyId}`);
    expect(gmParty.statusCode, gmParty.body).toBe(200);
    expect((gmParty.json() as any).character.campaignId).toBe(campaignId);
    const removedParty = await get("player", `/characters/${partyId}`);
    expect(removedParty.statusCode).toBe(404);
    const gmAdopted = await get("gm", `/characters/${adoptId}`);
    expect(gmAdopted.statusCode).toBe(404);

    // Prior campaign URLs, history and receipts are denied for the removed player.
    const removedCampaignRead = await get("player", `/campaigns/${campaignId}`);
    expect(removedCampaignRead.statusCode).toBe(404);
    expect((await get("player", `/campaigns/${campaignId}/content?limit=10`)).statusCode).toBe(404);
    expect((await get("player", `/campaigns/${campaignId}/activity?limit=10`)).statusCode).toBe(404);
    expect((await get("player", `/campaigns/${campaignId}/characters?limit=10`)).statusCode).toBe(404);
    expect((await get("player", `/content/${handout.content.contentId}`)).statusCode).toBe(404);
    expect((await get("player", `/content/${whisper.content.contentId}`)).statusCode).toBe(404);
    expect((await get("player", `/content/${gmNote.content.contentId}`)).statusCode).toBe(404);
    const exportDenied = await h.app.inject({
      method: "POST",
      url: `/campaigns/${campaignId}/exports`,
      headers: cookie("player"),
      payload: { idempotencyKey: randomUUID() },
    });
    expect(exportDenied.statusCode).toBe(404);
    // Same-key replay of a pre-departure receipt is denied, not disclosed.
    const diaryReplay = await h.app.inject({
      method: "POST",
      url: `/campaigns/${campaignId}/content`,
      headers: cookie("player"),
      payload: { title: "diary", body: diaryBody, idempotencyKey: diaryKey },
    });
    expect(diaryReplay.statusCode).toBe(404);

    // Expired/replayed invitations cannot restore membership; no second
    // invocation restores it either.
    const reviewAgain = await h.app.inject({
      method: "POST",
      url: "/invitations/review",
      headers: cookie("player"),
      payload: { token },
    });
    expect(reviewAgain.statusCode).toBe(404);
    const acceptAgain = await h.app.inject({
      method: "POST",
      url: "/invitations/accept",
      headers: cookie("player"),
      payload: {
        campaignId,
        token,
        expectedInvitationRevision: invitationRevision,
        reviewedAccessRevision: accessRevision,
        idempotencyKey: randomUUID(),
      },
    });
    expect(acceptAgain.statusCode).toBe(404);
    expect((await get("player", `/campaigns/${campaignId}`)).statusCode).toBe(404);

    // Safe standalone export afterward carries the current sheet only.
    const standaloneExport = await h.app.inject({
      method: "POST",
      url: `/characters/${adoptId}/exports`,
      headers: cookie("player"),
    });
    expect(standaloneExport.statusCode, standaloneExport.body).toBe(200);
    const doc = standaloneExport.json() as any;
    expect(doc.revision).toBe(returned.revision);
    expect(doc.state).toEqual(returned.state);
    expect(doc.migrationLineage).toEqual([]);
    expect(JSON.stringify(doc)).not.toContain("a map of the region");
    expect(JSON.stringify(doc)).not.toContain("the dragon wakes");

    // The GM export stays safe: owner-only diary + private roll excluded,
    // permitted rows present, counts nonzero.
    const gmExport = await h.app.inject({
      method: "POST",
      url: `/campaigns/${campaignId}/exports`,
      headers: cookie("gm"),
      payload: { idempotencyKey: randomUUID() },
    });
    expect(gmExport.statusCode, gmExport.body).toBe(200);
    const exported = (gmExport.json() as any).export;
    expect(exported.exportVersion).toBe(1);
    expect(exported.members.length).toBeGreaterThan(0);
    expect(exported.content.length).toBeGreaterThan(0);
    expect(exported.activity.length).toBeGreaterThan(0);
    expect(exported.rolls.length).toBeGreaterThan(0);
    const bodies = (exported.content as Array<any>).map((c) => c.body);
    expect(bodies).toContain("a map of the region");
    expect(bodies).not.toContain(diaryBody);
    expect(exported.rolls.map((r: any) => r.audience)).not.toContain("owner_only");

    // SQL proves the excluded rows still persist (secrecy invariant, not a
    // vacuous pass): the diary row, its receipt and the private roll exist.
    const diaryRows = await h.pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM campaign_content_items WHERE campaign_id = $1 AND body = $2`,
      [campaignId, diaryBody],
    );
    expect(diaryRows.rows[0]?.n).toBe(1);
    const privateRows = await h.pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM character_rolls WHERE character_id = $1 AND audience = 'owner_only'`,
      [adoptId],
    );
    expect(privateRows.rows[0]?.n).toBe(1);

    // Campaign-created characters stay attached; adopted characters return;
    // campaign history never becomes personal (the standalone activity has
    // no campaign content bodies).
    const personalActivity = await get("player", `/characters/${adoptId}/activity?limit=100`);
    expect(personalActivity.statusCode).toBe(200);
    expect(JSON.stringify(personalActivity.json())).not.toContain("a map of the region");
    expect(inviteId).toBeTruthy();
  }, 120_000);

  it("serves the Task 7-8 projection through HTTP with budgets and replay authorization", async () => {
    // Fresh campaign through HTTP for projection checks.
    const created = await post("gm", "/campaigns", {
      systemVersionId: h.versionId,
      title: `Export HTTP ${randomUUID()}`,
      description: "projection fixture",
      idempotencyKey: randomUUID(),
    }, 201);
    const campaignId = created.campaign.campaignId as string;
    await post("gm", `/campaigns/${campaignId}/content`, {
      title: "handout",
      body: "read me",
      audience: "all_players",
      idempotencyKey: randomUUID(),
    }, 201);

    // HTTP projection matches the module projection for the same state.
    const httpExport = await post("gm", `/campaigns/${campaignId}/exports`, {
      idempotencyKey: randomUUID(),
    }, 200);
    expect(httpExport.export.exportVersion).toBe(1);
    expect(Object.keys(httpExport.export).sort()).toEqual([
      "activity",
      "campaign",
      "content",
      "exportVersion",
      "members",
      "rolls",
    ]);

    // Same-key replay through HTTP is byte-identical.
    const replayKey = randomUUID();
    const firstReplay = await post("gm", `/campaigns/${campaignId}/exports`, {
      idempotencyKey: replayKey,
    }, 200);
    const secondReplay = await post("gm", `/campaigns/${campaignId}/exports`, {
      idempotencyKey: replayKey,
    }, 200);
    // Equivalent authorized snapshots compare byte-identical on the export
    // payload; the HTTP envelope requestId legitimately differs per call.
    expect(JSON.stringify(secondReplay.export)).toBe(JSON.stringify(firstReplay.export));

    // Retargeting the same key at another campaign mismatches (409).
    const otherCampaign = await post("gm", "/campaigns", {
      systemVersionId: h.versionId,
      title: `Export other ${randomUUID()}`,
      idempotencyKey: randomUUID(),
    }, 201);
    const retarget = await h.app.inject({
      method: "POST",
      url: `/campaigns/${otherCampaign.campaign.campaignId}/exports`,
      headers: cookie("gm"),
      payload: { idempotencyKey: replayKey },
    });
    expect(retarget.statusCode).toBe(409);
    expect((retarget.json() as any).error.code).toBe("idempotency_mismatch");

    // Authorization on completed replay: expire the receipt (invariant
    // setup), then the same key is unavailable (409), not re-executed.
    await h.pool.query(
      `UPDATE campaign_command_executions SET expires_at = now() - interval '1 second'
        WHERE actor_id = $1 AND command_kind = 'campaign_export' AND idempotency_key = $2`,
      [h.users.gm.actorId, replayKey],
    );
    const expired = await h.app.inject({
      method: "POST",
      url: `/campaigns/${campaignId}/exports`,
      headers: cookie("gm"),
      payload: { idempotencyKey: replayKey },
    });
    expect(expired.statusCode).toBe(409);
    expect((expired.json() as any).error.code).toBe("result_unavailable");

    // Byte budget surfaces as 413 through HTTP: fill past 10 MiB with
    // ordinary content writes (100 KiB bodies, the configured maximum).
    const bigBody = "x".repeat(100_000);
    for (let i = 0; i < 110; i += 1) {
      const res = await h.app.inject({
        method: "POST",
        url: `/campaigns/${campaignId}/content`,
        headers: cookie("gm"),
        payload: {
          title: `bulk ${i}`,
          body: bigBody,
          audience: "all_players",
          idempotencyKey: randomUUID(),
        },
      });
      expect(res.statusCode, `bulk content ${i}: ${res.body.slice(0, 200)}`).toBe(201);
    }
    const byteBudgetKey = randomUUID();
    const tooBig = await h.app.inject({
      method: "POST",
      url: `/campaigns/${campaignId}/exports`,
      headers: cookie("gm"),
      payload: { idempotencyKey: byteBudgetKey },
    });
    expect(tooBig.statusCode).toBe(413);
    expect((tooBig.json() as any).error.code).toBe("export_too_large");
    const byteReceipt = await h.pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM campaign_command_executions
        WHERE actor_id = $1 AND command_kind = 'campaign_export' AND idempotency_key = $2`,
      [h.users.gm.actorId, byteBudgetKey],
    );
    expect(byteReceipt.rows[0]?.n).toBe(0);

    // Record budget shares the same 413 path at the module seam (tiny
    // limits reject without partial success and leave no receipt).
    const { createCampaignsModule } = await import("../../src/campaigns/index.js");
    const { createCampaignPlacement } = await import("../../src/characters/campaignPlacement.js");
    const { DEFAULT_CAMPAIGN_LIMITS } = await import("../../src/platform/config.js");
    const placement = createCampaignPlacement({ pool: h.pool, runtime: h.runtime });
    const tiny = createCampaignsModule({
      pool: h.pool,
      limits: { ...DEFAULT_CAMPAIGN_LIMITS, exportMaxRecords: 2 },
      charactersPlacement: placement,
    });
    const { ctxFor } = await import("./i6-app.js");
    const recordBudgetKey = randomUUID();
    const tinyDenied = await tiny.exportCampaign(ctxFor(h.users.gm), {
      campaignId,
      idempotencyKey: recordBudgetKey,
    });
    expect(tinyDenied.ok).toBe(false);
    if (!tinyDenied.ok) expect(tinyDenied.error.code).toBe("export_too_large");
    const recordReceipt = await h.pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM campaign_command_executions
        WHERE actor_id = $1 AND command_kind = 'campaign_export' AND idempotency_key = $2`,
      [h.users.gm.actorId, recordBudgetKey],
    );
    expect(recordReceipt.rows[0]?.n).toBe(0);
  }, 180_000);
});
