import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prepareCampaignCharacter } from "../../src/characters/campaignPlacement.js";
import { buildI6Harness, ctxFor, type I6Harness } from "./i6-app.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl === undefined ? describe.skip : describe;

type Actor = keyof I6Harness["users"];

const SHEETS = 8;
const READ_ROUNDS = 30;
const BUMP_ROUNDS = 4;
const ROLLS_PER_SHEET_PER_ACTOR = 2;
const CONCURRENCY = 8;

const p95 = (latencies: number[]): number => {
  const sorted = [...latencies].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[index]!;
};

const round1 = (value: number): number => Math.round(value * 10) / 10;

async function mapBounded<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<number[]> {
  const latencies: number[] = [];
  const queue = [...items];
  const workers = Array.from({ length: concurrency }, async () => {
    for (;;) {
      const item = queue.shift();
      if (item === undefined) return;
      const start = performance.now();
      await fn(item);
      latencies.push(performance.now() - start);
    }
  });
  await Promise.all(workers);
  return latencies;
}

describeWithDatabase("campaign four-player load and limits (Task 11)", () => {
  let h: I6Harness;

  beforeAll(async () => {
    h = await buildI6Harness();
    // Fixture setup (not a workflow): the published fixture version is
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
    expect(res.statusCode, `${who} POST ${url}: ${res.body.slice(0, 400)}`).toBe(expected);
    return res.json() as any;
  }

  async function get(who: Actor, url: string, expected = 200) {
    const res = await h.app.inject({ method: "GET", url, headers: cookie(who) });
    expect(res.statusCode, `${who} GET ${url}: ${res.body.slice(0, 400)}`).toBe(expected);
    return res.json() as any;
  }

  async function campaignRevision(campaignId: string, who: Actor = "gm"): Promise<number> {
    const body = await get(who, `/campaigns/${campaignId}`);
    return body.campaign.revision as number;
  }

  async function sheetRevision(who: Actor, characterId: string): Promise<number> {
    const body = await get(who, `/characters/${characterId}`);
    return (body.character.revision ?? body.character.reconciliation.revision) as number;
  }

  /** Ordinary HTTP workflow: invite a member and join through review/accept. */
  async function inviteAndJoin(
    campaignId: string,
    joiner: Actor,
    role: "player" | "co_gm" = "player",
  ): Promise<void> {
    const rev = await campaignRevision(campaignId);
    const issued = await post("gm", `/campaigns/${campaignId}/invitations`, {
      intendedRole: role,
      expectedCampaignRevision: rev,
      idempotencyKey: randomUUID(),
    }, 201);
    const token = issued.invitation.token as string;
    expect(token).toBeTruthy();
    const reviewed = await post(joiner, "/invitations/review", { token }, 200);
    const accepted = await post(joiner, "/invitations/accept", {
      campaignId,
      token,
      expectedInvitationRevision: reviewed.review.invitationRevision,
      reviewedAccessRevision: reviewed.review.accessRevision,
      idempotencyKey: randomUUID(),
    }, 200);
    expect(accepted.acceptance.membership.userId).toBe(h.users[joiner].actorId);
  }

  /**
   * Ordinary HTTP setup: provision a campaign, join all four members, create
   * campaign sheets and share control across every member.
   */
  async function setupSession(title: string): Promise<{ campaignId: string; sheetIds: string[] }> {
    const created = await post("gm", "/campaigns", {
      systemVersionId: h.versionId,
      title,
      description: "task 11 load session",
      idempotencyKey: randomUUID(),
    }, 201);
    const campaignId = created.campaign.campaignId as string;

    await inviteAndJoin(campaignId, "player");
    await inviteAndJoin(campaignId, "other");
    await inviteAndJoin(campaignId, "outsider");

    const sheetIds: string[] = [];
    const controllers = [
      h.users.gm.actorId,
      h.users.player.actorId,
      h.users.other.actorId,
      h.users.outsider.actorId,
    ];
    for (let i = 0; i < SHEETS; i += 1) {
      const rev = await campaignRevision(campaignId);
      const sheet = await post("gm", `/campaigns/${campaignId}/characters`, {
        name: `Table sheet ${i}`,
        entityDefinitionId: "character",
        expectedCampaignRevision: rev,
        idempotencyKey: randomUUID(),
      }, 201);
      const characterId = sheet.character.characterId as string;
      const characterRevision = sheet.character.revision as number;
      const assigned = await post("gm", `/campaigns/${campaignId}/characters/${characterId}/assign`, {
        controllerUserIds: controllers,
        expectedCampaignRevision: await campaignRevision(campaignId),
        expectedCharacterRevision: characterRevision,
        idempotencyKey: randomUUID(),
      }, 200);
      expect(assigned.character.controllers.sort()).toEqual([...controllers].sort());
      sheetIds.push(characterId);
    }
    return { campaignId, sheetIds };
  }

  it("sustains a four-player burst: concurrent reads/bumps/rolls, exactly-once effects, p95 budgets", async () => {
    const actors: Actor[] = ["gm", "player", "other", "outsider"];
    const { campaignId, sheetIds } = await setupSession(`Burst ${randomUUID()}`);

    const baseRevisions = new Map<string, number>();
    const baseHealth = new Map<string, number>();
    for (const sheetId of sheetIds) {
      const body = await get("gm", `/characters/${sheetId}`);
      baseRevisions.set(sheetId, body.character.revision as number);
      baseHealth.set(sheetId, body.character.state.values.health.current as number);
    }

    // ---- concurrent ordinary reads (all four members) ---------------------
    const readTargets = (actorIndex: number, round: number): string => {
      const sheetId = sheetIds[(actorIndex + round) % SHEETS]!;
      switch (round % 6) {
        case 0: return `/campaigns/${campaignId}`;
        case 1: return `/campaigns/${campaignId}/members?limit=25`;
        case 2: return `/campaigns/${campaignId}/content?limit=25`;
        case 3: return `/campaigns/${campaignId}/characters?limit=25`;
        case 4: return `/campaigns/${campaignId}/activity?limit=25`;
        default: return `/characters/${sheetId}`;
      }
    };
    const readJobs: Array<{ actor: Actor; url: string }> = [];
    for (let round = 0; round < READ_ROUNDS; round += 1) {
      actors.forEach((actor, actorIndex) => {
        readJobs.push({ actor, url: readTargets(actorIndex, round) });
      });
    }
    const readLatencies = await mapBounded(readJobs, CONCURRENCY, async ({ actor, url }) => {
      const res = await h.app.inject({ method: "GET", url, headers: cookie(actor) });
      expect(res.statusCode, `${actor} GET ${url}: ${res.body.slice(0, 200)}`).toBe(200);
      if (url.includes("/members?") || url.includes("/content?") || url.includes("/activity?")) {
        const rows = (res.json() as any).members ?? (res.json() as any).content ?? (res.json() as any).events;
        expect(rows.length).toBeLessThanOrEqual(25);
      }
      if (url.includes("/characters?")) {
        expect((res.json() as any).characters.length).toBeLessThanOrEqual(25);
      }
    });

    // ---- concurrent ordinary writes: GM handouts + player diaries --------
    // (players may only create owner-only notes; GMs post shared handouts).
    const contentJobs: Array<{ actor: Actor; key: string; audience?: string }> = [];
    for (let i = 0; i < 3; i += 1) {
      contentJobs.push({ actor: "gm", key: `t11-content-gm-${i}`, audience: "all_players" });
      for (const actor of ["player", "other", "outsider"] as const) {
        contentJobs.push({ actor, key: `t11-content-${actor}-${i}` });
      }
    }
    const contentLatencies = await mapBounded(contentJobs, CONCURRENCY, async ({ actor, key, audience }) => {
      await post(actor, `/campaigns/${campaignId}/content`, {
        title: `table note ${key.slice(-8)}`,
        body: "load burst note",
        ...(audience === undefined ? {} : { audience }),
        idempotencyKey: key,
      }, 201);
    });

    // ---- bump rounds: one bump per sheet per round, no revision races -----
    const bumpLatencies: number[] = [];
    const bumperFor = (round: number, sheetIndex: number): Actor =>
      actors[(round + sheetIndex) % actors.length]!;
    const firstBumpKeys = new Map<string, { actor: Actor; key: string; expectedRevision: number }>();
    for (let round = 0; round < BUMP_ROUNDS; round += 1) {
      const jobs = sheetIds.map((sheetId, sheetIndex) => {
        const actor = bumperFor(round, sheetIndex);
        const key = `t11-bump-${sheetIndex}-${round}`;
        const expectedRevision = baseRevisions.get(sheetId)! + round;
        if (round === 0 && sheetIndex === 0) firstBumpKeys.set(sheetId, { actor, key, expectedRevision });
        return { actor, sheetId, key, expectedRevision };
      });
      const roundLatencies = await mapBounded(jobs, CONCURRENCY, async ({ actor, sheetId, key, expectedRevision }) => {
        const res = await h.app.inject({
          method: "POST",
          url: `/characters/${sheetId}/resources/health/bump`,
          headers: cookie(actor),
          payload: { direction: "down", expectedRevision, idempotencyKey: key },
        });
        expect(res.statusCode, `${actor} bump ${sheetId}: ${res.body.slice(0, 200)}`).toBe(200);
      });
      bumpLatencies.push(...roundLatencies);
      for (const sheetId of sheetIds) {
        expect(await sheetRevision("gm", sheetId)).toBe(baseRevisions.get(sheetId)! + round + 1);
      }
    }

    // ---- concurrent rule actions: every actor rolls every sheet twice -----
    const finalRevision = (sheetId: string) => baseRevisions.get(sheetId)! + BUMP_ROUNDS;
    const rollJobs: Array<{ actor: Actor; sheetId: string; key: string }> = [];
    for (const sheetId of sheetIds) {
      actors.forEach((actor) => {
        for (let roll = 0; roll < ROLLS_PER_SHEET_PER_ACTOR; roll += 1) {
          rollJobs.push({ actor, sheetId, key: `t11-roll-${sheetId.slice(0, 8)}-${actor}-${roll}` });
        }
      });
    }
    const firstRoll = rollJobs[0]!;
    const rollLatencies = await mapBounded(rollJobs, CONCURRENCY, async ({ actor, sheetId, key }) => {
      const res = await h.app.inject({
        method: "POST",
        url: `/characters/${sheetId}/actions/check`,
        headers: cookie(actor),
        payload: {
          inputs: { bonus: 1 },
          audience: "campaign",
          expectedRevision: finalRevision(sheetId),
          idempotencyKey: key,
        },
      });
      expect(res.statusCode, `${actor} roll ${sheetId}: ${res.body.slice(0, 200)}`).toBe(200);
      expect(res.json().result.roll.audience).toBe("campaign");
      // Rolls never bump the sheet revision.
      expect(res.json().result.character.revision ?? res.json().result.character.reconciliation.revision)
        .toBe(finalRevision(sheetId));
    });

    // ---- exactly-once: same-key replays are identical, never re-applied ---
    const bumpReplayOf = firstBumpKeys.get(sheetIds[0]!)!;
    const bumpReplay = await h.app.inject({
      method: "POST",
      url: `/characters/${sheetIds[0]!}/resources/health/bump`,
      headers: cookie(bumpReplayOf.actor),
      payload: {
        direction: "down",
        expectedRevision: bumpReplayOf.expectedRevision,
        idempotencyKey: bumpReplayOf.key,
      },
    });
    expect(bumpReplay.statusCode).toBe(200);
    expect(
      bumpReplay.json().result.character.reconciliation.replayed
        ?? bumpReplay.json().result.character.replayed,
    ).toBe(true);

    const rollReplay = await h.app.inject({
      method: "POST",
      url: `/characters/${firstRoll.sheetId}/actions/check`,
      headers: cookie(firstRoll.actor),
      payload: {
        inputs: { bonus: 1 },
        audience: "campaign",
        expectedRevision: finalRevision(firstRoll.sheetId),
        idempotencyKey: firstRoll.key,
      },
    });
    expect(rollReplay.statusCode).toBe(200);
    expect(
      rollReplay.json().result.character.reconciliation.replayed
        ?? rollReplay.json().result.character.replayed,
    ).toBe(true);

    // ---- no lost or duplicate effects in the database ----------------------
    for (const sheetId of sheetIds) {
      const char = await h.pool.query<{ revision: number; state_json: { values: { health: { current: number } } } }>(
        "SELECT revision, state_json FROM characters WHERE id = $1",
        [sheetId],
      );
      expect(char.rows[0]!.revision).toBe(baseRevisions.get(sheetId)! + BUMP_ROUNDS);
      expect(char.rows[0]!.state_json.values.health.current).toBe(baseHealth.get(sheetId)! - BUMP_ROUNDS);

      const rolls = await h.pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM character_rolls WHERE character_id = $1",
        [sheetId],
      );
      expect(rolls.rows[0]!.n).toBe(actors.length * ROLLS_PER_SHEET_PER_ACTOR);
    }
    // Burst receipts carry (actor, kind, key), not a character stamp: each
    // actor applied 8 bumps (2 sheets x 4 rounds) + 16 rolls (8 x 2).
    for (const actor of actors) {
      const receipts = await h.pool.query<{ n: number; statuses: string[] }>(
        `SELECT count(*)::int AS n, array_agg(status) AS statuses
           FROM character_command_executions
          WHERE actor_id = $1 AND idempotency_key LIKE 't11-%'`,
        [h.users[actor].actorId],
      );
      expect(receipts.rows[0]!.n, `${actor} burst receipts`).toBe(8 + SHEETS * ROLLS_PER_SHEET_PER_ACTOR);
      expect(receipts.rows[0]!.statuses.every((status) => status === "completed")).toBe(true);
    }
    const burstReceipts = await h.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM character_command_executions WHERE idempotency_key LIKE 't11-%'`,
    );
    expect(burstReceipts.rows[0]!.n).toBe(
      SHEETS * BUMP_ROUNDS + SHEETS * actors.length * ROLLS_PER_SHEET_PER_ACTOR,
    );
    const contentRows = await h.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM campaign_content_items WHERE campaign_id = $1",
      [campaignId],
    );
    expect(contentRows.rows[0]!.n).toBe(actors.length * 3);

    // ---- bounded lists: no unbounded reads anywhere ------------------------
    for (const url of [
      `/campaigns/${campaignId}/members?limit=101`,
      `/campaigns/${campaignId}/members?limit=0`,
      `/campaigns/${campaignId}/content?limit=101`,
      `/campaigns/${campaignId}/characters?limit=101`,
      `/campaigns/${campaignId}/activity?limit=101`,
    ]) {
      const res = await h.app.inject({ method: "GET", url, headers: cookie("gm") });
      expect(res.statusCode, `bound ${url}`).toBe(400);
    }

    // ---- p95 budgets (reported, never weakened to force green) -------------
    const ordinary = [...readLatencies, ...contentLatencies, ...bumpLatencies];
    const summary = {
      reads: { count: readLatencies.length, p95Ms: round1(p95(readLatencies)) },
      contentWrites: { count: contentLatencies.length, p95Ms: round1(p95(contentLatencies)) },
      bumps: { count: bumpLatencies.length, p95Ms: round1(p95(bumpLatencies)) },
      rolls: { count: rollLatencies.length, p95Ms: round1(p95(rollLatencies)) },
    };
    // eslint-disable-next-line no-console
    console.log(`[campaign-load] p95 latencies: ${JSON.stringify(summary)}`);

    expect(readLatencies).toHaveLength(actors.length * READ_ROUNDS);
    expect(contentLatencies).toHaveLength(actors.length * 3);
    expect(bumpLatencies).toHaveLength(SHEETS * BUMP_ROUNDS);
    expect(rollLatencies).toHaveLength(SHEETS * actors.length * ROLLS_PER_SHEET_PER_ACTOR);
    expect(p95(ordinary)).toBeLessThanOrEqual(300);
    expect(p95(rollLatencies)).toBeLessThanOrEqual(500);
  }, 180_000);

  it("removes and returns at supported member/character limits with bounded traversal", async () => {
    const created = await post("gm", "/campaigns", {
      systemVersionId: h.versionId,
      title: `Limits ${randomUUID()}`,
      description: "task 11 limit session",
      idempotencyKey: randomUUID(),
    }, 201);
    const campaignId = created.campaign.campaignId as string;

    await inviteAndJoin(campaignId, "player");
    await inviteAndJoin(campaignId, "other");
    await inviteAndJoin(campaignId, "outsider");

    // Adopted sheet for the return path (ordinary HTTP with disclosure).
    const standalone = await post("player", "/characters", {
      systemVersionId: h.versionId,
      entityDefinitionId: "character",
      name: `Returnable ${randomUUID().slice(0, 8)}`,
      idempotencyKey: randomUUID(),
    }, 201);
    const adoptId = standalone.character.characterId as string;
    const adoptRevision = standalone.character.revision as number;
    const adopted = await post("player", `/campaigns/${campaignId}/characters/${adoptId}/adopt`, {
      expectedCampaignRevision: await campaignRevision(campaignId),
      expectedCharacterRevision: adoptRevision,
      acknowledgedDisclosure: true,
      idempotencyKey: randomUUID(),
    }, 200);
    expect(adopted.character.campaignId).toBe(campaignId);

    // Campaign-created sheets at volume (ordinary HTTP creates + assigns).
    const VOLUME_SHEETS = 20;
    const partyIds: string[] = [];
    for (let i = 0; i < VOLUME_SHEETS; i += 1) {
      const sheet = await post("gm", `/campaigns/${campaignId}/characters`, {
        name: `Party sheet ${i}`,
        entityDefinitionId: "character",
        expectedCampaignRevision: await campaignRevision(campaignId),
        idempotencyKey: randomUUID(),
      }, 201);
      const characterId = sheet.character.characterId as string;
      await post("gm", `/campaigns/${campaignId}/characters/${characterId}/assign`, {
        controllerUserIds: [h.users.player.actorId],
        expectedCampaignRevision: await campaignRevision(campaignId),
        expectedCharacterRevision: sheet.character.revision,
        idempotencyKey: randomUUID(),
      }, 200);
      partyIds.push(characterId);
    }
    const attachedAfterVolume = await h.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM characters WHERE campaign_id = $1",
      [campaignId],
    );
    expect(attachedAfterVolume.rows[0]!.n).toBe(VOLUME_SHEETS + 1);

    // Character cap proof at the placement seam: a placement pinned to the
    // current attached count rejects one more sheet without side effects.
    const { createCampaignPlacement } = await import("../../src/characters/campaignPlacement.js");
    const capped = createCampaignPlacement({
      pool: h.pool,
      runtime: h.runtime,
      maxAttachedCharacters: VOLUME_SHEETS + 1,
    });
    const prepared = await prepareCampaignCharacter(h.runtime, {
      systemVersionId: h.versionId,
      entityDefinitionId: "character",
    });
    expect(prepared.ok).toBe(true);
    if (prepared.ok) {
      const client = await h.pool.connect();
      try {
        await client.query("BEGIN");
        try {
          const opened = await h.campaigns.open(ctxFor(h.users.gm), { campaignId });
          expect(opened.ok).toBe(true);
          if (!opened.ok) throw new Error("campaign vanished under test");
          const members = await h.pool.query<{ user_id: string; generation: number }>(
            `SELECT user_id, generation FROM campaign_members
              WHERE campaign_id = $1 AND user_id = $2 AND status = 'active'`,
            [campaignId, h.users.gm.actorId],
          );
          const denied = await capped.createInCampaign(client, ctxFor(h.users.gm), {
            campaignId,
            expectedCampaignRevision: opened.value.revision,
            membershipGeneration: members.rows[0]!.generation,
            idempotencyKey: randomUUID(),
            name: "Over the cap",
            entityDefinitionId: "character",
            prepared: prepared.value,
            controllerUserIds: [h.users.player.actorId],
          });
          expect(denied.ok).toBe(false);
          if (!denied.ok) expect(denied.error.code).toBe("bad_request");
        } finally {
          await client.query("ROLLBACK");
        }
      } finally {
        client.release();
      }
    }

    // Fill to the supported member limit (100): owner + 3 invited + 96
    // seeded rows. Seeding is fixture setup; joins/removals stay on HTTP.
    await h.pool.query(
      `INSERT INTO users (id, display_name)
       SELECT gen_random_uuid(), 'load-member-' || g FROM generate_series(1, 96) g`,
    );
    const seeded = await h.pool.query<{ id: string }>(
      `SELECT id FROM users WHERE display_name LIKE 'load-member-%' ORDER BY display_name`,
    );
    expect(seeded.rows).toHaveLength(96);
    for (const row of seeded.rows) {
      await h.pool.query(
        `INSERT INTO campaign_members (campaign_id, user_id, role, status, generation)
         VALUES ($1, $2, 'player', 'active', 1)`,
        [campaignId, row.id],
      );
    }
    const activeCount = await h.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM campaign_members WHERE campaign_id = $1 AND status = 'active'`,
      [campaignId],
    );
    expect(activeCount.rows[0]!.n).toBe(100);

    // Bounded traversal visits every member exactly once through HTTP.
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let step = 0; step < 10; step += 1) {
      const page: any = await get(
        "gm",
        cursor === null
          ? `/campaigns/${campaignId}/members?limit=25`
          : `/campaigns/${campaignId}/members?limit=25&cursor=${encodeURIComponent(cursor)}`,
      );
      expect(page.members.length).toBeLessThanOrEqual(25);
      for (const member of page.members) {
        expect(member.campaignId).toBe(campaignId);
        seen.push(member.userId as string);
      }
      cursor = page.nextCursor;
      if (cursor === null) break;
    }
    expect(cursor).toBeNull();
    expect(seen).toHaveLength(100);
    expect(new Set(seen).size).toBe(100);

    // Member-limit proof at the accept seam while the roster is full: a
    // fresh user reviews a live token, then accept is denied as conflict and
    // mints neither membership nor receipt.
    const fullRev = await campaignRevision(campaignId);
    const issued = await post("gm", `/campaigns/${campaignId}/invitations`, {
      intendedRole: "player",
      expectedCampaignRevision: fullRev,
      idempotencyKey: randomUUID(),
    }, 201);
    const joinerRows = await h.pool.query<{ id: string }>(
      `INSERT INTO users (display_name) VALUES ('load-joiner') RETURNING id`,
    );
    const joinerId = joinerRows.rows[0]!.id;
    const { createCampaignsModule } = await import("../../src/campaigns/index.js");
    const { DEFAULT_CAMPAIGN_LIMITS } = await import("../../src/platform/config.js");
    const seam = createCampaignsModule({
      pool: h.pool,
      limits: DEFAULT_CAMPAIGN_LIMITS,
      charactersPlacement: h.placement,
    });
    const reviewed = await seam.reviewInvitation(ctxFor({ actorId: joinerId, cookie: "" }), {
      token: issued.invitation.token,
    });
    expect(reviewed.ok).toBe(true);
    if (!reviewed.ok) throw new Error("review failed under test");
    const deniedJoin = await seam.acceptInvitation(ctxFor({ actorId: joinerId, cookie: "" }), {
      campaignId,
      token: issued.invitation.token,
      expectedInvitationRevision: reviewed.value.invitationRevision,
      reviewedAccessRevision: reviewed.value.accessRevision,
      idempotencyKey: randomUUID(),
    });
    expect(deniedJoin.ok).toBe(false);
    if (!deniedJoin.ok) expect(deniedJoin.error.code).toBe("conflict");
    const joinRow = await h.pool.query(
      `SELECT status FROM campaign_members WHERE campaign_id = $1 AND user_id = $2`,
      [campaignId, joinerId],
    );
    expect(joinRow.rows).toHaveLength(0);

    // Removal at scale over HTTP: the adopted sheet returns with its pin,
    // campaign-created sheets stay attached and hide from the removed actor.
    const removal = await h.app.inject({
      method: "DELETE",
      url: `/campaigns/${campaignId}/members/${h.users.player.actorId}`,
      headers: cookie("gm"),
      payload: { expectedCampaignRevision: await campaignRevision(campaignId), idempotencyKey: randomUUID() },
    });
    expect(removal.statusCode, removal.body).toBe(200);

    const returned = await get("player", `/characters/${adoptId}`);
    expect(returned.character.ownerId).toBe(h.users.player.actorId);
    expect(returned.character.campaignId).toBeNull();
    expect(returned.character.systemVersionId).toBe(h.versionId);
    for (const partyId of partyIds.slice(0, 3)) {
      expect((await h.app.inject({
        method: "GET",
        url: `/characters/${partyId}`,
        headers: cookie("gm"),
      })).statusCode).toBe(200);
      expect((await h.app.inject({
        method: "GET",
        url: `/characters/${partyId}`,
        headers: cookie("player"),
      })).statusCode).toBe(404);
    }
    expect((await h.app.inject({
      method: "GET",
      url: `/campaigns/${campaignId}`,
      headers: cookie("player"),
    })).statusCode).toBe(404);

    // Return by rejoin: a fresh invitation reactivates the removed row with
    // a bumped generation (2 -> 3) and restores reads.
    const reissue = await post("gm", `/campaigns/${campaignId}/invitations`, {
      intendedRole: "player",
      expectedCampaignRevision: await campaignRevision(campaignId),
      idempotencyKey: randomUUID(),
    }, 201);
    const reReview = await post("player", "/invitations/review", { token: reissue.invitation.token }, 200);
    const rejoined = await post("player", "/invitations/accept", {
      campaignId,
      token: reissue.invitation.token,
      expectedInvitationRevision: reReview.review.invitationRevision,
      reviewedAccessRevision: reReview.review.accessRevision,
      idempotencyKey: randomUUID(),
    }, 200);
    expect(rejoined.acceptance.membershipGeneration).toBe(3);
    expect((await h.app.inject({
      method: "GET",
      url: `/campaigns/${campaignId}`,
      headers: cookie("player"),
    })).statusCode).toBe(200);
    const roster = await h.pool.query<{ generation: number; status: string }>(
      `SELECT generation, status FROM campaign_members
        WHERE campaign_id = $1 AND user_id = $2 ORDER BY generation`,
      [campaignId, h.users.player.actorId],
    );
    expect(roster.rows.map((row) => row.generation)).toEqual([3]);
    expect(roster.rows[0]).toMatchObject({ generation: 3, status: "active" });
  }, 180_000);
});
