import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createCampaignsModule,
  type Campaigns,
  type MemberView,
} from "../../src/campaigns/index.js";
import { DEFAULT_CAMPAIGN_LIMITS } from "../../src/platform/config.js";
import { buildI6Harness, ctxFor, type I6Harness } from "./i6-app.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl === undefined ? describe.skip : describe;

describeWithDatabase("campaign membership races and owner protection (Task 3)", () => {
  let h: I6Harness;

  beforeAll(async () => {
    h = await buildI6Harness();
  });

  afterAll(async () => {
    await h.close();
  });

  async function createCampaign(input?: {
    title?: string;
    actor?: keyof I6Harness["users"];
  }) {
    const actor = input?.actor === undefined ? h.users.gm : h.users[input.actor];
    return h.campaigns.create(ctxFor(actor), {
      systemVersionId: h.versionId,
      title: input?.title ?? `Membership ${randomUUID()}`,
      description: "",
      idempotencyKey: randomUUID(),
    });
  }

  /** Seed an active non-owner member directly: invitations arrive in Task 6. */
  async function seedMember(
    campaignId: string,
    userId: string,
    role: "co_gm" | "player" = "player",
  ): Promise<void> {
    await h.pool.query(
      `INSERT INTO campaign_members (campaign_id, user_id, role, status, generation)
       VALUES ($1, $2, $3, 'active', 1)`,
      [campaignId, userId, role],
    );
  }

  async function openRevision(campaignId: string): Promise<{ revision: number; accessRevision: number }> {
    const opened = await h.campaigns.open(ctxFor(h.users.gm), { campaignId });
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error("campaign vanished under test");
    return { revision: opened.value.revision, accessRevision: opened.value.accessRevision };
  }

  async function auditCount(campaignId: string, kind: string): Promise<number> {
    const rows = await h.pool.query(
      `SELECT COUNT(*)::int AS count FROM campaign_audit_records WHERE campaign_id = $1 AND kind = $2`,
      [campaignId, kind],
    );
    return rows.rows[0].count as number;
  }

  async function receiptCount(actorId: string, kind: string, key: string): Promise<number> {
    const rows = await h.pool.query(
      `SELECT COUNT(*)::int AS count FROM campaign_command_executions
        WHERE actor_id = $1 AND command_kind = $2 AND idempotency_key = $3`,
      [actorId, kind, key],
    );
    return rows.rows[0].count as number;
  }

  it("enforces the owner-protection matrix across GM, player, co-GM and outsider", async () => {
    const created = await createCampaign();
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const campaignId = created.value.campaignId;
    await seedMember(campaignId, h.users.player.actorId);
    await seedMember(campaignId, h.users.other.actorId);
    const gm = ctxFor(h.users.gm);
    const player = ctxFor(h.users.player);
    const outsider = ctxFor(h.users.outsider);

    // The owner row is immutable: no self-demotion and no self-removal.
    const selfDemote = await h.campaigns.changeRole(gm, {
      campaignId,
      userId: h.users.gm.actorId,
      role: "player",
      expectedCampaignRevision: 1,
      idempotencyKey: randomUUID(),
    });
    expect(selfDemote.ok).toBe(false);
    if (selfDemote.ok) return;
    expect(selfDemote.error.code).toBe("bad_request");

    const selfRemove = await h.campaigns.removeMember(gm, {
      campaignId,
      userId: h.users.gm.actorId,
      expectedCampaignRevision: 1,
      idempotencyKey: randomUUID(),
    });
    expect(selfRemove.ok).toBe(false);
    if (selfRemove.ok) return;
    expect(selfRemove.error.code).toBe("bad_request");

    // A player managing roles collapses to not_found (not_manager mapping).
    const playerManages = await h.campaigns.changeRole(player, {
      campaignId,
      userId: h.users.player.actorId,
      role: "player",
      expectedCampaignRevision: 1,
      idempotencyKey: randomUUID(),
    });
    expect(playerManages).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "not_found" }),
    });

    // A player removing another member is a definite caller error (self_only).
    const playerRemovesOther = await h.campaigns.removeMember(player, {
      campaignId,
      userId: h.users.other.actorId,
      expectedCampaignRevision: 1,
      idempotencyKey: randomUUID(),
    });
    expect(playerRemovesOther.ok).toBe(false);
    if (playerRemovesOther.ok) return;
    expect(playerRemovesOther.error.code).toBe("bad_request");

    // Only the owner promotes co-GMs: a player promoting a peer collapses.
    const peerPromote = await h.campaigns.changeRole(player, {
      campaignId,
      userId: h.users.other.actorId,
      role: "co_gm",
      expectedCampaignRevision: 1,
      idempotencyKey: randomUUID(),
    });
    expect(peerPromote).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "not_found" }),
    });

    const promotePlayer = await h.campaigns.changeRole(gm, {
      campaignId,
      userId: h.users.player.actorId,
      role: "co_gm",
      expectedCampaignRevision: 1,
      idempotencyKey: randomUUID(),
    });
    expect(promotePlayer.ok).toBe(true);
    if (!promotePlayer.ok) return;
    expect(promotePlayer.value).toMatchObject({ role: "co_gm", status: "active" });

    // A co-GM may manage player memberships but may not mint peer co-GMs.
    const coGmPromotesPeer = await h.campaigns.changeRole(player, {
      campaignId,
      userId: h.users.other.actorId,
      role: "co_gm",
      expectedCampaignRevision: 2,
      idempotencyKey: randomUUID(),
    });
    expect(coGmPromotesPeer).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "not_found" }),
    });

    const coGmManagesPlayer = await h.campaigns.changeRole(player, {
      campaignId,
      userId: h.users.other.actorId,
      role: "player",
      expectedCampaignRevision: 2,
      idempotencyKey: randomUUID(),
    });
    expect(coGmManagesPlayer.ok).toBe(true);

    const promoteOther = await h.campaigns.changeRole(gm, {
      campaignId,
      userId: h.users.other.actorId,
      role: "co_gm",
      expectedCampaignRevision: 3,
      idempotencyKey: randomUUID(),
    });
    expect(promoteOther.ok).toBe(true);

    // Co-GMs cannot modify peers, the owner, or escalate themselves.
    const peerDemote = await h.campaigns.changeRole(player, {
      campaignId,
      userId: h.users.other.actorId,
      role: "player",
      expectedCampaignRevision: 4,
      idempotencyKey: randomUUID(),
    });
    expect(peerDemote).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "not_found" }),
    });
    const peerRemove = await h.campaigns.removeMember(player, {
      campaignId,
      userId: h.users.other.actorId,
      expectedCampaignRevision: 4,
      idempotencyKey: randomUUID(),
    });
    expect(peerRemove).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "not_found" }),
    });
    const selfDemoteCoGm = await h.campaigns.changeRole(player, {
      campaignId,
      userId: h.users.player.actorId,
      role: "player",
      expectedCampaignRevision: 4,
      idempotencyKey: randomUUID(),
    });
    expect(selfDemoteCoGm).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "not_found" }),
    });
    const touchOwnerRole = await h.campaigns.changeRole(player, {
      campaignId,
      userId: h.users.gm.actorId,
      role: "player",
      expectedCampaignRevision: 4,
      idempotencyKey: randomUUID(),
    });
    expect(touchOwnerRole.ok).toBe(false);
    if (touchOwnerRole.ok) return;
    expect(touchOwnerRole.error.code).toBe("bad_request");
    const touchOwnerRemove = await h.campaigns.removeMember(player, {
      campaignId,
      userId: h.users.gm.actorId,
      expectedCampaignRevision: 4,
      idempotencyKey: randomUUID(),
    });
    expect(touchOwnerRemove.ok).toBe(false);
    if (touchOwnerRemove.ok) return;
    expect(touchOwnerRemove.error.code).toBe("bad_request");

    // Outsiders learn nothing: every membership path collapses to not_found.
    for (const probe of [
      h.campaigns.changeRole(outsider, {
        campaignId,
        userId: h.users.other.actorId,
        role: "player",
        expectedCampaignRevision: 4,
        idempotencyKey: randomUUID(),
      }),
      h.campaigns.removeMember(outsider, {
        campaignId,
        userId: h.users.other.actorId,
        expectedCampaignRevision: 4,
        idempotencyKey: randomUUID(),
      }),
      h.campaigns.open(outsider, { campaignId }),
      h.campaigns.listMembers(outsider, { campaignId }),
    ]) {
      expect(await probe).toEqual({
        ok: false,
        error: expect.objectContaining({ code: "not_found" }),
      });
    }

    // The owner demotes a co-GM and removes the other: both succeed.
    const demoteOther = await h.campaigns.changeRole(gm, {
      campaignId,
      userId: h.users.other.actorId,
      role: "player",
      expectedCampaignRevision: 4,
      idempotencyKey: randomUUID(),
    });
    expect(demoteOther.ok).toBe(true);
    const removeCoGm = await h.campaigns.removeMember(gm, {
      campaignId,
      userId: h.users.player.actorId,
      expectedCampaignRevision: 5,
      idempotencyKey: randomUUID(),
    });
    expect(removeCoGm.ok).toBe(true);
    if (!removeCoGm.ok) return;
    expect(removeCoGm.value).toMatchObject({ role: "co_gm", status: "removed", generation: 2 });

    // Bumps: promote(2) + player-manage(3) + promote(4) + demote(5) + remove(6).
    expect(await openRevision(campaignId)).toEqual({ revision: 6, accessRevision: 6 });
    const roster = await h.campaigns.listMembers(gm, { campaignId });
    expect(roster.ok).toBe(true);
    if (!roster.ok) return;
    expect(
      roster.value.members.find((member) => member.userId === h.users.other.actorId),
    ).toMatchObject({ role: "player", status: "active" });
  });

  it("lets a player self-leave with a replayable acknowledgement and rejoins on a new generation", async () => {
    const created = await createCampaign();
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const campaignId = created.value.campaignId;
    await seedMember(campaignId, h.users.player.actorId);

    const leaveKey = randomUUID();
    const left = await h.campaigns.removeMember(ctxFor(h.users.player), {
      campaignId,
      userId: h.users.player.actorId,
      expectedCampaignRevision: 1,
      idempotencyKey: leaveKey,
    });
    expect(left.ok).toBe(true);
    if (!left.ok) return;
    expect(left.value).toMatchObject({ status: "removed", generation: 2 });
    expect(await openRevision(campaignId)).toEqual({ revision: 2, accessRevision: 2 });
    expect(await auditCount(campaignId, "campaign_member_removed")).toBe(1);
    expect(await receiptCount(h.users.player.actorId, "campaign_remove_member", leaveKey)).toBe(1);

    // Departure revokes reads for the leaver.
    expect(await h.campaigns.open(ctxFor(h.users.player), { campaignId })).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "not_found" }),
    });
    expect(await h.campaigns.listMembers(ctxFor(h.users.player), { campaignId })).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "not_found" }),
    });

    // Exact replay returns the minimal acknowledgement without membership.
    const replay = await h.campaigns.removeMember(ctxFor(h.users.player), {
      campaignId,
      userId: h.users.player.actorId,
      expectedCampaignRevision: 1,
      idempotencyKey: leaveKey,
    });
    expect(replay).toEqual(left);
    expect(await openRevision(campaignId)).toEqual({ revision: 2, accessRevision: 2 });
    expect(await auditCount(campaignId, "campaign_member_removed")).toBe(1);

    // Rejoin (Task 6 invitation accept) mints a new generation: it never
    // reactivates the removed row in place.
    await h.pool.query(
      `UPDATE campaign_members
          SET status = 'active', generation = generation + 1, updated_at = now()
        WHERE campaign_id = $1 AND user_id = $2`,
      [campaignId, h.users.player.actorId],
    );
    const roster = await h.campaigns.listMembers(ctxFor(h.users.gm), { campaignId });
    expect(roster.ok).toBe(true);
    if (!roster.ok) return;
    expect(
      roster.value.members.find((member) => member.userId === h.users.player.actorId),
    ).toMatchObject({ status: "active", generation: 3 });

    // The stale leave receipt still replays its own generation-2
    // acknowledgement and does not resurrect or disturb the live row.
    const staleReplay = await h.campaigns.removeMember(ctxFor(h.users.player), {
      campaignId,
      userId: h.users.player.actorId,
      expectedCampaignRevision: 1,
      idempotencyKey: leaveKey,
    });
    expect(staleReplay).toEqual(left);

    // The rejoined member leaves again on a fresh key at current revision.
    const secondLeave = await h.campaigns.removeMember(ctxFor(h.users.player), {
      campaignId,
      userId: h.users.player.actorId,
      expectedCampaignRevision: 2,
      idempotencyKey: randomUUID(),
    });
    expect(secondLeave.ok).toBe(true);
    if (!secondLeave.ok) return;
    expect(secondLeave.value).toMatchObject({ status: "removed", generation: 4 });
    expect(await openRevision(campaignId)).toEqual({ revision: 3, accessRevision: 3 });
  });

  it("allows non-owner departure while archived but rejects role changes", async () => {
    const created = await createCampaign();
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const campaignId = created.value.campaignId;
    await seedMember(campaignId, h.users.player.actorId);

    const archived = await h.campaigns.archive(ctxFor(h.users.gm), {
      campaignId,
      expectedCampaignRevision: 1,
      idempotencyKey: randomUUID(),
    });
    expect(archived.ok).toBe(true);
    if (!archived.ok) return;
    expect(archived.value).toMatchObject({ status: "archived", revision: 2, accessRevision: 2 });

    // Role changes stay gated by the archive check.
    const roleChange = await h.campaigns.changeRole(ctxFor(h.users.gm), {
      campaignId,
      userId: h.users.player.actorId,
      role: "co_gm",
      expectedCampaignRevision: 2,
      idempotencyKey: randomUUID(),
    });
    expect(roleChange).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "conflict", latestRevision: 2 }),
    });

    // Departure is not archive-gated: the seeded player leaves at revision 2.
    const departed = await h.campaigns.removeMember(ctxFor(h.users.player), {
      campaignId,
      userId: h.users.player.actorId,
      expectedCampaignRevision: 2,
      idempotencyKey: randomUUID(),
    });
    expect(departed.ok).toBe(true);
    if (!departed.ok) return;
    expect(departed.value).toMatchObject({ status: "removed", generation: 2 });
    expect(await openRevision(campaignId)).toEqual({ revision: 3, accessRevision: 3 });

    // Owner immutability still fires first while archived.
    const ownerDeparts = await h.campaigns.removeMember(ctxFor(h.users.gm), {
      campaignId,
      userId: h.users.gm.actorId,
      expectedCampaignRevision: 3,
      idempotencyKey: randomUUID(),
    });
    expect(ownerDeparts.ok).toBe(false);
    if (ownerDeparts.ok) return;
    expect(ownerDeparts.error.code).toBe("bad_request");

    // A member seeded before the archive leaves as well, then recovery works.
    await seedMember(campaignId, h.users.other.actorId);
    const otherDeparts = await h.campaigns.removeMember(ctxFor(h.users.other), {
      campaignId,
      userId: h.users.other.actorId,
      expectedCampaignRevision: 3,
      idempotencyKey: randomUUID(),
    });
    expect(otherDeparts.ok).toBe(true);
    const recovered = await h.campaigns.recover(ctxFor(h.users.gm), {
      campaignId,
      expectedCampaignRevision: 4,
      idempotencyKey: randomUUID(),
    });
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;
    expect(recovered.value).toMatchObject({ status: "active", revision: 5, accessRevision: 5 });
  });

  it("serializes concurrent role change and removal at one revision: exactly one wins", async () => {
    const created = await createCampaign();
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const campaignId = created.value.campaignId;
    await seedMember(campaignId, h.users.player.actorId);

    // Both commands are admitted together and synchronize on the campaign
    // row lock (no sleeps): the winner bumps revision 1 -> 2 and the loser
    // fails its post-authorization revision check.
    const changeAtRevision = h.campaigns.changeRole(ctxFor(h.users.gm), {
      campaignId,
      userId: h.users.player.actorId,
      role: "co_gm",
      expectedCampaignRevision: 1,
      idempotencyKey: randomUUID(),
    });
    const removeAtSameRevision = h.campaigns.removeMember(ctxFor(h.users.gm), {
      campaignId,
      userId: h.users.player.actorId,
      expectedCampaignRevision: 1,
      idempotencyKey: randomUUID(),
    });
    const outcomes = await Promise.all([changeAtRevision, removeAtSameRevision]);
    expect(outcomes).toEqual(
      expect.arrayContaining([expect.objectContaining({ ok: false })]),
    );

    const successes = outcomes.filter((outcome) => outcome.ok);
    const failures = outcomes.filter((outcome) => !outcome.ok);
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    const failure = failures[0];
    expect(failure?.ok).toBe(false);
    if (failure === undefined || failure.ok) return;
    expect(failure.error.code).toBe("conflict");
    expect(failure.error.latestRevision).toBe(2);

    // Exactly one membership write committed: nonzero counts prove the
    // winner applied once and the loser applied nothing.
    expect(await openRevision(campaignId)).toEqual({ revision: 2, accessRevision: 2 });
    const roleAudits = await auditCount(campaignId, "campaign_role_changed");
    const removalAudits = await auditCount(campaignId, "campaign_member_removed");
    expect(roleAudits + removalAudits).toBe(1);

    const roster = await h.campaigns.listMembers(ctxFor(h.users.gm), { campaignId });
    expect(roster.ok).toBe(true);
    if (!roster.ok) return;
    const member = roster.value.members.find(
      (entry) => entry.userId === h.users.player.actorId,
    );
    if (roleAudits === 1) {
      expect(member).toMatchObject({ role: "co_gm", status: "active" });
    } else {
      expect(member).toMatchObject({ status: "removed", generation: 2 });
    }
  });

  it("executes concurrent same-key role changes once and replays removals exactly", async () => {
    const created = await createCampaign();
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const campaignId = created.value.campaignId;
    await seedMember(campaignId, h.users.player.actorId);
    await seedMember(campaignId, h.users.other.actorId);
    const gm = ctxFor(h.users.gm);

    const roleKey = randomUUID();
    const first = await h.campaigns.changeRole(gm, {
      campaignId,
      userId: h.users.player.actorId,
      role: "co_gm",
      expectedCampaignRevision: 1,
      idempotencyKey: roleKey,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // Same key admitted twice at once: one application, two identical results.
    const [replayA, replayB] = await Promise.all([
      h.campaigns.changeRole(gm, {
        campaignId,
        userId: h.users.player.actorId,
        role: "co_gm",
        expectedCampaignRevision: 1,
        idempotencyKey: roleKey,
      }),
      h.campaigns.changeRole(gm, {
        campaignId,
        userId: h.users.player.actorId,
        role: "co_gm",
        expectedCampaignRevision: 1,
        idempotencyKey: roleKey,
      }),
    ]);
    expect(replayA).toEqual(first);
    expect(replayB).toEqual(first);
    expect(await openRevision(campaignId)).toEqual({ revision: 2, accessRevision: 2 });
    expect(await auditCount(campaignId, "campaign_role_changed")).toBe(1);
    expect(await receiptCount(h.users.gm.actorId, "campaign_change_role", roleKey)).toBe(1);

    // Sequential removal replay is byte-identical with single row effects.
    const removeKey = randomUUID();
    const removed = await h.campaigns.removeMember(gm, {
      campaignId,
      userId: h.users.other.actorId,
      expectedCampaignRevision: 2,
      idempotencyKey: removeKey,
    });
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(removed.value).toMatchObject({ status: "removed", generation: 2 });

    const removeReplay = await h.campaigns.removeMember(gm, {
      campaignId,
      userId: h.users.other.actorId,
      expectedCampaignRevision: 2,
      idempotencyKey: removeKey,
    });
    expect(removeReplay).toEqual(removed);
    expect(await openRevision(campaignId)).toEqual({ revision: 3, accessRevision: 3 });
    expect(await auditCount(campaignId, "campaign_member_removed")).toBe(1);
    expect(await receiptCount(h.users.gm.actorId, "campaign_remove_member", removeKey)).toBe(1);
    const row = await h.pool.query(
      `SELECT status, generation FROM campaign_members WHERE campaign_id = $1 AND user_id = $2`,
      [campaignId, h.users.other.actorId],
    );
    expect(row.rows[0]).toMatchObject({ status: "removed", generation: 2 });

    // Reusing the key with different input is a mismatch, not a replay.
    const mismatch = await h.campaigns.removeMember(gm, {
      campaignId,
      userId: h.users.other.actorId,
      expectedCampaignRevision: 3,
      idempotencyKey: removeKey,
    });
    expect(mismatch.ok).toBe(false);
    if (mismatch.ok) return;
    expect(mismatch.error.code).toBe("idempotency_mismatch");
  });

  it("advances revision and access revision only on membership and lifecycle writes", async () => {
    const created = await createCampaign();
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const campaignId = created.value.campaignId;
    expect(created.value).toMatchObject({ revision: 1, accessRevision: 1 });
    await seedMember(campaignId, h.users.player.actorId);
    await seedMember(campaignId, h.users.other.actorId);
    const gm = ctxFor(h.users.gm);

    const promoted = await h.campaigns.changeRole(gm, {
      campaignId,
      userId: h.users.player.actorId,
      role: "co_gm",
      expectedCampaignRevision: 1,
      idempotencyKey: randomUUID(),
    });
    expect(promoted.ok).toBe(true);
    expect(await openRevision(campaignId)).toEqual({ revision: 2, accessRevision: 2 });

    const removed = await h.campaigns.removeMember(gm, {
      campaignId,
      userId: h.users.other.actorId,
      expectedCampaignRevision: 2,
      idempotencyKey: randomUUID(),
    });
    expect(removed.ok).toBe(true);
    expect(await openRevision(campaignId)).toEqual({ revision: 3, accessRevision: 3 });

    // Metadata edits advance revision but leave access revision alone.
    const renamed = await h.campaigns.update(gm, {
      campaignId,
      title: "Renamed for invalidation",
      expectedCampaignRevision: 3,
      idempotencyKey: randomUUID(),
    });
    expect(renamed.ok).toBe(true);
    if (!renamed.ok) return;
    expect(renamed.value).toMatchObject({ revision: 4, accessRevision: 3 });

    const archived = await h.campaigns.archive(gm, {
      campaignId,
      expectedCampaignRevision: 4,
      idempotencyKey: randomUUID(),
    });
    expect(archived.ok).toBe(true);
    if (!archived.ok) return;
    expect(archived.value).toMatchObject({ revision: 5, accessRevision: 4 });

    const recovered = await h.campaigns.recover(gm, {
      campaignId,
      expectedCampaignRevision: 5,
      idempotencyKey: randomUUID(),
    });
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;
    expect(recovered.value).toMatchObject({ revision: 6, accessRevision: 5 });
  });

  it("scopes cursors to their campaign and issuing actor", async () => {
    const first = await createCampaign();
    const second = await createCampaign();
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    const campaignA = first.value.campaignId;
    const campaignB = second.value.campaignId;
    await seedMember(campaignA, h.users.player.actorId);
    await seedMember(campaignA, h.users.other.actorId);

    const page = await h.campaigns.listMembers(ctxFor(h.users.gm), {
      campaignId: campaignA,
      limit: 1,
    });
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.value.members).toHaveLength(1);
    const memberCursor = page.value.nextCursor;
    expect(memberCursor).not.toBeNull();

    // A members cursor is bound to its campaign: cross-campaign use fails.
    const crossCampaign = await h.campaigns.listMembers(ctxFor(h.users.gm), {
      campaignId: campaignB,
      limit: 1,
      cursor: memberCursor,
    });
    expect(crossCampaign.ok).toBe(false);
    if (crossCampaign.ok) return;
    expect(crossCampaign.error.code).toBe("bad_request");

    // The same cursor continues its own campaign.
    const continued = await h.campaigns.listMembers(ctxFor(h.users.gm), {
      campaignId: campaignA,
      limit: 1,
      cursor: memberCursor,
    });
    expect(continued.ok).toBe(true);
    if (!continued.ok) return;
    expect(continued.value.members).toHaveLength(1);
    expect(continued.value.members[0]?.userId).not.toBe(page.value.members[0]?.userId);

    // Malformed roster cursors stay rejected.
    const malformed = await h.campaigns.listMembers(ctxFor(h.users.gm), {
      campaignId: campaignA,
      cursor: "not-a-cursor",
    });
    expect(malformed.ok).toBe(false);
    if (malformed.ok) return;
    expect(malformed.error.code).toBe("bad_request");

    // A campaigns cursor is bound to the actor it was issued to.
    const campaignsPage = await h.campaigns.list(ctxFor(h.users.gm), { limit: 1 });
    expect(campaignsPage.ok).toBe(true);
    if (!campaignsPage.ok) return;
    const campaignsCursor = campaignsPage.value.nextCursor;
    expect(campaignsCursor).not.toBeNull();
    const crossActor = await h.campaigns.list(ctxFor(h.users.other), {
      limit: 1,
      cursor: campaignsCursor,
    });
    expect(crossActor.ok).toBe(false);
    if (crossActor.ok) return;
    expect(crossActor.error.code).toBe("bad_request");
  });

  it("bounds lists and paginates deterministic ties without in-memory filtering", async () => {
    const created = await createCampaign();
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const campaignId = created.value.campaignId;
    await seedMember(campaignId, h.users.player.actorId);
    await seedMember(campaignId, h.users.other.actorId);
    await seedMember(campaignId, h.users.outsider.actorId);

    expect(await h.campaigns.listMembers(ctxFor(h.users.gm), { campaignId, limit: 0 })).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "bad_request" }),
    });
    expect(await h.campaigns.listMembers(ctxFor(h.users.gm), { campaignId, limit: 101 })).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "bad_request" }),
    });
    expect(await h.campaigns.list(ctxFor(h.users.gm), { limit: 0 })).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "bad_request" }),
    });

    // Force a full created_at tie so ordering falls back to the user_id
    // tiebreaker deterministically.
    const tie = "2026-02-01T00:00:00.000Z";
    await h.pool.query(
      `UPDATE campaign_members SET created_at = $2::timestamptz, updated_at = $2::timestamptz
        WHERE campaign_id = $1`,
      [campaignId, tie],
    );
    const expected = await h.pool.query(
      `SELECT user_id FROM campaign_members WHERE campaign_id = $1
        ORDER BY created_at DESC, user_id DESC`,
      [campaignId],
    );
    const expectedOrder = expected.rows.map((row) => row.user_id as string);
    expect(expectedOrder.length).toBeGreaterThan(0);

    // Walk every page with limit 1: each row appears exactly once, the
    // database order is honored, and the final page closes the cursor.
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let step = 0; step < expectedOrder.length + 1; step += 1) {
      const result = await h.campaigns.listMembers(ctxFor(h.users.gm), {
        campaignId,
        limit: 1,
        cursor,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.members.length).toBeLessThanOrEqual(1);
      for (const member of result.value.members) {
        // Rows are selected with the campaign predicate in SQL; every
        // returned row belongs to the requested campaign by construction.
        expect(member.campaignId).toBe(campaignId);
        seen.push(member.userId);
      }
      cursor = result.value.nextCursor;
      if (cursor === null) break;
    }
    expect(cursor).toBeNull();
    expect(seen).toEqual(expectedOrder);

    // Campaign ties behave the same under (created_at, id): pin three
    // campaigns to one timestamp and compare relative order with SQL.
    const extraA = await createCampaign();
    const extraB = await createCampaign();
    expect(extraA.ok && extraB.ok).toBe(true);
    if (!extraA.ok || !extraB.ok) return;
    const tiedIds = [campaignId, extraA.value.campaignId, extraB.value.campaignId];
    await h.pool.query(`UPDATE campaigns SET created_at = $2::timestamptz WHERE id = ANY($1)`, [
      tiedIds,
      tie,
    ]);
    const sqlOrder = await h.pool.query(
      `SELECT id FROM campaigns WHERE id = ANY($1) ORDER BY created_at DESC, id DESC`,
      [tiedIds],
    );
    const full = await h.campaigns.list(ctxFor(h.users.gm), { limit: 100 });
    expect(full.ok).toBe(true);
    if (!full.ok) return;
    const relative = full.value.campaigns
      .map((entry) => entry.campaignId)
      .filter((id) => tiedIds.includes(id));
    expect(relative).toEqual(sqlOrder.rows.map((row) => row.id as string));

    // Bounded traversal visits every visible campaign exactly once.
    const visited: string[] = [];
    let campaignCursor: string | null = null;
    for (let step = 0; step < 500; step += 1) {
      const result = await h.campaigns.list(ctxFor(h.users.gm), { limit: 2, cursor: campaignCursor });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.campaigns.length).toBeLessThanOrEqual(2);
      expect(result.value.campaigns.length).toBeGreaterThan(0);
      visited.push(...result.value.campaigns.map((entry) => entry.campaignId));
      campaignCursor = result.value.nextCursor;
      if (campaignCursor === null) break;
    }
    expect(campaignCursor).toBeNull();
    expect(new Set(visited).size).toBe(visited.length);
    expect(visited).toContain(campaignId);
  });

  it("exposes poll-on-view revisions and registers no public campaign routes yet", async () => {
    const created = await createCampaign();
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const campaignId = created.value.campaignId;
    await seedMember(campaignId, h.users.player.actorId);

    const before = await h.campaigns.open(ctxFor(h.users.gm), { campaignId });
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    expect(before.value).toMatchObject({ revision: 1, accessRevision: 1 });

    const promoted = await h.campaigns.changeRole(ctxFor(h.users.gm), {
      campaignId,
      userId: h.users.player.actorId,
      role: "co_gm",
      expectedCampaignRevision: 1,
      idempotencyKey: randomUUID(),
    });
    expect(promoted.ok).toBe(true);

    // Reads begun after the committed write observe the new revisions, so a
    // future client can invalidate cached policy on (revision, accessRevision).
    const after = await h.campaigns.open(ctxFor(h.users.gm), { campaignId });
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value).toMatchObject({ revision: 2, accessRevision: 2 });
    const listed = await h.campaigns.list(ctxFor(h.users.gm), { limit: 100 });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(
      listed.value.campaigns.find((entry) => entry.campaignId === campaignId),
    ).toMatchObject({ revision: 2, accessRevision: 2 });

    // No HTTP adapter exists in this task: protected campaign responses will
    // require `Cache-Control: no-store` when adapters land, and no route may
    // be registered until the Task 4 removal hook performs member return.
    expect(h.app.printRoutes()).not.toContain("campaign");
  });

  it("runs member removal through a same-transaction hook for Task 4 return", async () => {
    const created = await createCampaign();
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const campaignId = created.value.campaignId;
    await seedMember(campaignId, h.users.player.actorId);

    // The hook observes the removed row on the same transaction client,
    // before audit/receipt commit: Task 4 plugs character return here.
    let observed: { status: string; generation: number; userId: string } | null = null;
    const hooked: Campaigns = createCampaignsModule({
      pool: h.pool,
      limits: DEFAULT_CAMPAIGN_LIMITS,
      hooks: {
        afterMemberRemoved: async (client, removal) => {
          const rows = await client.query(
            `SELECT status, generation FROM campaign_members
              WHERE campaign_id = $1 AND user_id = $2`,
            [removal.campaignId, removal.userId],
          );
          const row = rows.rows[0] as { status: string; generation: number };
          observed = { status: row.status, generation: row.generation, userId: removal.userId };
          const member: MemberView | null = rows.rows[0] === undefined ? null : removal.membership;
          expect(member).toMatchObject({ status: "removed" });
        },
      },
    });

    const removed = await hooked.removeMember(ctxFor(h.users.gm), {
      campaignId,
      userId: h.users.player.actorId,
      expectedCampaignRevision: 1,
      idempotencyKey: randomUUID(),
    });
    expect(removed.ok).toBe(true);
    expect(observed).toEqual({
      status: "removed",
      generation: 2,
      userId: h.users.player.actorId,
    });

    // A throwing hook aborts the whole removal: membership, revision, audit
    // and receipt all roll back together.
    const second = await createCampaign();
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const doomedId = second.value.campaignId;
    await seedMember(doomedId, h.users.player.actorId);
    const failing: Campaigns = createCampaignsModule({
      pool: h.pool,
      limits: DEFAULT_CAMPAIGN_LIMITS,
      hooks: {
        afterMemberRemoved: async () => {
          throw new Error("Task 4 return failed");
        },
      },
    });
    const failed = await failing.removeMember(ctxFor(h.users.gm), {
      campaignId: doomedId,
      userId: h.users.player.actorId,
      expectedCampaignRevision: 1,
      idempotencyKey: randomUUID(),
    });
    expect(failed).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "internal" }),
    });
    const row = await h.pool.query(
      `SELECT status, generation FROM campaign_members WHERE campaign_id = $1 AND user_id = $2`,
      [doomedId, h.users.player.actorId],
    );
    expect(row.rows[0]).toMatchObject({ status: "active", generation: 1 });
    expect(await openRevision(doomedId)).toEqual({ revision: 1, accessRevision: 1 });
    expect(await auditCount(doomedId, "campaign_member_removed")).toBe(0);
  });
});
