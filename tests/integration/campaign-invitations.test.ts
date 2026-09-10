import { createHash, randomUUID } from "node:crypto";

import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createCampaignsModule, type Campaigns } from "../../src/campaigns/index.js";
import { hashInvitationToken } from "../../src/campaigns/invitations.js";
import { DEFAULT_CAMPAIGN_LIMITS } from "../../src/platform/config.js";
import { buildI6Harness, ctxFor, type I6Harness } from "./i6-app.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl === undefined ? describe.skip : describe;

function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

describeWithDatabase("campaign single-use invitations and recovery (Task 6)", () => {
  let h: I6Harness;

  beforeAll(async () => {
    h = await buildI6Harness();
    // Standalone character creation below needs the fixture versions usable
    // by every member, like a shared table version.
    await h.pool.query(`UPDATE systems SET access = 'public'`);
  });

  afterAll(async () => {
    await h.close();
  });

  async function createCampaign(): Promise<string> {
    const created = await h.campaigns.create(ctxFor(h.users.gm), {
      systemVersionId: h.versionId,
      title: `Invitations ${randomUUID()}`,
      description: "",
      idempotencyKey: randomUUID(),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("campaign create failed");
    return created.value.campaignId;
  }

  async function revisions(campaignId: string): Promise<{ revision: number; accessRevision: number }> {
    const opened = await h.campaigns.open(ctxFor(h.users.gm), { campaignId });
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error("campaign vanished under test");
    return { revision: opened.value.revision, accessRevision: opened.value.accessRevision };
  }

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

  /** Issues as GM and asserts the secret-bearing success shape. */
  async function issuePlayerInvite(
    campaignId: string,
    options?: {
      as?: keyof I6Harness["users"];
      role?: "player" | "co_gm";
      expiresAt?: string | Date;
      key?: string;
    },
  ) {
    const actor = options?.as ?? "gm";
    const { revision } = await revisions(campaignId);
    const issued = await h.campaigns.issueInvitation(ctxFor(h.users[actor]), {
      campaignId,
      intendedRole: options?.role ?? "player",
      expectedCampaignRevision: revision,
      idempotencyKey: options?.key ?? randomUUID(),
      ...(options?.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
    });
    expect(issued.ok).toBe(true);
    if (!issued.ok) throw new Error(`issue failed: ${JSON.stringify(issued.error)}`);
    expect(issued.value).toHaveProperty("token");
    if (!("token" in issued.value)) throw new Error("issue did not return a token");
    return issued.value;
  }

  async function reviewAs(token: string, who: keyof I6Harness["users"]) {
    const reviewed = await h.campaigns.reviewInvitation(ctxFor(h.users[who]), { token });
    expect(reviewed.ok).toBe(true);
    if (!reviewed.ok) throw new Error(`review failed: ${JSON.stringify(reviewed.error)}`);
    return reviewed.value;
  }

  async function acceptAs(
    campaignId: string,
    token: string,
    review: { invitationRevision: number; accessRevision: number },
    who: keyof I6Harness["users"],
    key: string = randomUUID(),
  ) {
    return h.campaigns.acceptInvitation(ctxFor(h.users[who]), {
      campaignId,
      token,
      expectedInvitationRevision: review.invitationRevision,
      reviewedAccessRevision: review.accessRevision,
      idempotencyKey: key,
    });
  }

  async function invitationCount(campaignId: string): Promise<number> {
    const rows = await h.pool.query(`SELECT COUNT(*)::int AS count FROM campaign_invitations WHERE campaign_id = $1`, [
      campaignId,
    ]);
    return rows.rows[0].count as number;
  }

  async function invitationRow(invitationId: string) {
    const rows = await h.pool.query(
      `SELECT id, campaign_id, issued_by, intended_role, token_hash, status, revision,
              consuming_actor_id, accepted_membership_generation, expires_at
         FROM campaign_invitations WHERE id = $1`,
      [invitationId],
    );
    return rows.rows[0] as
      | {
          id: string;
          campaign_id: string;
          issued_by: string;
          intended_role: string;
          token_hash: string;
          status: string;
          revision: number;
          consuming_actor_id: string | null;
          accepted_membership_generation: number | null;
          expires_at: Date;
        }
      | undefined;
  }

  async function receiptJson(actorId: string, kind: string, key: string): Promise<unknown> {
    const rows = await h.pool.query(
      `SELECT result_json FROM campaign_command_executions
        WHERE actor_id = $1 AND command_kind = $2 AND idempotency_key = $3`,
      [actorId, kind, key],
    );
    return rows.rows[0]?.result_json ?? null;
  }

  async function receiptCount(actorId: string, kind: string, key: string): Promise<number> {
    const rows = await h.pool.query(
      `SELECT COUNT(*)::int AS count FROM campaign_command_executions
        WHERE actor_id = $1 AND command_kind = $2 AND idempotency_key = $3`,
      [actorId, kind, key],
    );
    return rows.rows[0].count as number;
  }

  async function auditSummaries(campaignId: string): Promise<string[]> {
    const rows = await h.pool.query(
      `SELECT summary FROM campaign_audit_records WHERE campaign_id = $1 ORDER BY occurred_at, id`,
      [campaignId],
    );
    return rows.rows.map((row) => row.summary as string);
  }

  async function memberRow(campaignId: string, userId: string) {
    const rows = await h.pool.query(
      `SELECT role, status, generation FROM campaign_members WHERE campaign_id = $1 AND user_id = $2`,
      [campaignId, userId],
    );
    return rows.rows[0] as { role: string; status: string; generation: number } | undefined;
  }

  async function inPlacementTxn<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await h.pool.connect();
    try {
      await client.query("BEGIN");
      const value = await work(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  it("issues a one-time token and replays same-key requests as metadata only", async () => {
    const campaignId = await createCampaign();
    const key = randomUUID();
    const { revision } = await revisions(campaignId);
    const issued = await h.campaigns.issueInvitation(ctxFor(h.users.gm), {
      campaignId,
      intendedRole: "player",
      expectedCampaignRevision: revision,
      idempotencyKey: key,
    });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    expect(issued.value).toHaveProperty("token");
    if (!("token" in issued.value)) return;
    const { token, invitationId } = issued.value;
    // 32 bytes of server randomness, hash-only storage.
    expect(Buffer.from(token, "base64url").length).toBe(32);
    expect(issued.value).toMatchObject({ campaignId, intendedRole: "player", invitationRevision: 1 });
    const stored = await invitationRow(invitationId);
    expect(stored).toMatchObject({ status: "pending", revision: 1 });
    expect(stored?.token_hash).toBe(tokenHash(token));
    expect(stored?.token_hash).not.toContain(token.slice(0, 8));

    // The receipt and audit trail never see token bytes or the hash.
    const receipt = await receiptJson(h.users.gm.actorId, "campaign_invitation_issue", key);
    expect(receipt).not.toBeNull();
    expect(JSON.stringify(receipt)).not.toContain(token);
    expect(JSON.stringify(receipt)).not.toContain(tokenHash(token));
    expect(receipt).not.toHaveProperty("token");
    for (const summary of await auditSummaries(campaignId)) {
      expect(summary).not.toContain(token);
      expect(summary).not.toContain(tokenHash(token));
    }

    // Same-key replay returns metadata with tokenUnavailable, not a token.
    const replayed = await h.campaigns.issueInvitation(ctxFor(h.users.gm), {
      campaignId,
      intendedRole: "player",
      expectedCampaignRevision: revision,
      idempotencyKey: key,
    });
    expect(replayed.ok).toBe(true);
    if (!replayed.ok) return;
    expect(replayed.value).toMatchObject({ invitationId, tokenUnavailable: true });
    expect(replayed.value).not.toHaveProperty("token");
    expect(await invitationCount(campaignId)).toBe(1);
    expect(await receiptCount(h.users.gm.actorId, "campaign_invitation_issue", key)).toBe(1);

    // Same key with different input is a mismatch, not a second invitation.
    const mismatched = await h.campaigns.issueInvitation(ctxFor(h.users.gm), {
      campaignId,
      intendedRole: "co_gm",
      expectedCampaignRevision: revision,
      idempotencyKey: key,
    });
    expect(mismatched).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "idempotency_mismatch" }),
    });
    expect(await invitationCount(campaignId)).toBe(1);
  });

  it("restricts elevated roles to the owner and bounds expiry", async () => {
    const campaignId = await createCampaign();
    await seedMember(campaignId, h.users.other.actorId, "co_gm");
    await seedMember(campaignId, h.users.player.actorId, "player");

    // Co-GMs may invite players but never elevated roles.
    const playerInvite = await h.campaigns.issueInvitation(ctxFor(h.users.other), {
      campaignId,
      intendedRole: "player",
      expectedCampaignRevision: (await revisions(campaignId)).revision,
      idempotencyKey: randomUUID(),
    });
    expect(playerInvite.ok).toBe(true);
    const elevated = await h.campaigns.issueInvitation(ctxFor(h.users.other), {
      campaignId,
      intendedRole: "co_gm",
      expectedCampaignRevision: (await revisions(campaignId)).revision,
      idempotencyKey: randomUUID(),
    });
    expect(elevated).toEqual({ ok: false, error: expect.objectContaining({ code: "not_found" }) });

    // Players and outsiders cannot issue at all.
    for (const who of ["player", "outsider"] as const) {
      const denied = await h.campaigns.issueInvitation(ctxFor(h.users[who]), {
        campaignId,
        intendedRole: "player",
        expectedCampaignRevision: (await revisions(campaignId)).revision,
        idempotencyKey: randomUUID(),
      });
      expect(denied).toEqual({ ok: false, error: expect.objectContaining({ code: "not_found" }) });
    }

    // The owner may invite co-GMs.
    const coGmInvite = await issuePlayerInvite(campaignId, { role: "co_gm" });
    expect(coGmInvite).toMatchObject({ intendedRole: "co_gm" });

    // Expiry defaults to 7 days, caps at 30 days, and must be strictly future.
    const now = Date.now();
    expect(new Date(coGmInvite.expiresAt).getTime()).toBeGreaterThan(now + 6 * 24 * 60 * 60 * 1000);
    expect(new Date(coGmInvite.expiresAt).getTime()).toBeLessThanOrEqual(now + 7 * 24 * 60 * 60 * 1000 + 60_000);
    const past = await h.campaigns.issueInvitation(ctxFor(h.users.gm), {
      campaignId,
      intendedRole: "player",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      expectedCampaignRevision: (await revisions(campaignId)).revision,
      idempotencyKey: randomUUID(),
    });
    expect(past).toEqual({ ok: false, error: expect.objectContaining({ code: "bad_request" }) });
    const tooFar = await h.campaigns.issueInvitation(ctxFor(h.users.gm), {
      campaignId,
      intendedRole: "player",
      expiresAt: new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString(),
      expectedCampaignRevision: (await revisions(campaignId)).revision,
      idempotencyKey: randomUUID(),
    });
    expect(tooFar).toEqual({ ok: false, error: expect.objectContaining({ code: "bad_request" }) });
    const maxed = await issuePlayerInvite(campaignId, {
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000 - 60_000).toISOString(),
    });
    expect(new Date(maxed.expiresAt).getTime()).toBeGreaterThan(Date.now());

    // Archived campaigns cannot issue invitations.
    const { revision } = await revisions(campaignId);
    const archived = await h.campaigns.archive(ctxFor(h.users.gm), {
      campaignId,
      expectedCampaignRevision: revision,
      idempotencyKey: randomUUID(),
    });
    expect(archived.ok).toBe(true);
    const whileArchived = await h.campaigns.issueInvitation(ctxFor(h.users.gm), {
      campaignId,
      intendedRole: "player",
      expectedCampaignRevision: (await revisions(campaignId)).revision,
      idempotencyKey: randomUUID(),
    });
    expect(whileArchived).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "conflict" }),
    });
  });

  it("reviews campaign identity without leaking roster, content or sheets", async () => {
    const campaignId = await createCampaign();
    const invite = await issuePlayerInvite(campaignId);
    const reviewed = await reviewAs(invite.token, "outsider");
    expect(reviewed).toMatchObject({
      invitationId: invite.invitationId,
      campaignId,
      intendedRole: "player",
      invitationRevision: 1,
    });
    expect(reviewed.inviterDisplayName).toBe("Ada");
    expect(typeof reviewed.campaignTitle).toBe("string");
    expect(typeof reviewed.systemVersionId).toBe("string");
    expect(typeof reviewed.accessRevision).toBe("number");
    // Exactly the disclosed fields: no members, content, hashes or tokens.
    expect(Object.keys(reviewed).sort()).toEqual(
      [
        "accessRevision",
        "campaignId",
        "campaignTitle",
        "expiresAt",
        "intendedRole",
        "invitationId",
        "invitationRevision",
        "inviterDisplayName",
        "systemVersionId",
      ].sort(),
    );

    // Unknown, empty and overlong tokens collapse to the same generic denial.
    for (const token of ["no-such-token", "", "x".repeat(600)]) {
      const denied = await h.campaigns.reviewInvitation(ctxFor(h.users.outsider), { token });
      expect(denied).toEqual({
        ok: false,
        error: { code: "not_found", message: "This invitation is unavailable." },
      });
    }
  });

  it("consumes an invitation exactly once across actors", async () => {
    const campaignId = await createCampaign();
    const invite = await issuePlayerInvite(campaignId);
    const review = await reviewAs(invite.token, "player");

    const accepted = await acceptAs(campaignId, invite.token, review, "player");
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.value).toMatchObject({
      invitationId: invite.invitationId,
      campaignId,
      membershipGeneration: 1,
    });
    expect(accepted.value.membership).toMatchObject({
      role: "player",
      status: "active",
      generation: 1,
    });
    expect(await memberRow(campaignId, h.users.player.actorId)).toMatchObject({
      role: "player",
      status: "active",
      generation: 1,
    });
    expect(await invitationRow(invite.invitationId)).toMatchObject({
      status: "accepted",
      revision: 2,
      consuming_actor_id: h.users.player.actorId,
      accepted_membership_generation: 1,
    });

    // A second actor gets a generic denial with no campaign data.
    const raced = await acceptAs(campaignId, invite.token, review, "other");
    expect(raced).toEqual({
      ok: false,
      error: { code: "not_found", message: "This invitation is unavailable." },
    });
    expect(JSON.stringify(raced)).not.toContain(campaignId);

    // The winner replays its own outcome on the same key (fresh invitation
    // so the confirmation path is exercised end to end).
    const invite2 = await issuePlayerInvite(campaignId);
    const review2 = await reviewAs(invite2.token, "other");
    const joinKey = randomUUID();
    const joined = await acceptAs(campaignId, invite2.token, review2, "other", joinKey);
    expect(joined.ok).toBe(true);
    const confirmed = await acceptAs(campaignId, invite2.token, review2, "other", joinKey);
    expect(confirmed).toEqual(joined);

    // Stale invitation revisions demand re-review instead of consuming: rotate
    // a pending invite, then present the old revision with the new token.
    const invite3 = await issuePlayerInvite(campaignId);
    const { revision: rotateRevision } = await revisions(campaignId);
    const rotated3 = await h.campaigns.rotateInvitation(ctxFor(h.users.gm), {
      campaignId,
      invitationId: invite3.invitationId,
      expectedInvitationRevision: 1,
      expectedCampaignRevision: rotateRevision,
      idempotencyKey: randomUUID(),
    });
    expect(rotated3.ok).toBe(true);
    if (!rotated3.ok || !("token" in rotated3.value)) return;
    const stale = await h.campaigns.acceptInvitation(ctxFor(h.users.outsider), {
      campaignId,
      token: rotated3.value.token,
      expectedInvitationRevision: 1,
      reviewedAccessRevision: (await revisions(campaignId)).accessRevision,
      idempotencyKey: randomUUID(),
    });
    expect(stale).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "conflict" }),
    });
  });

  it("requires re-review after invitation or access changes", async () => {
    const campaignId = await createCampaign();
    const invite = await issuePlayerInvite(campaignId);
    const staleReview = await reviewAs(invite.token, "player");

    // Any later admin change bumps access: the old review is stale.
    await issuePlayerInvite(campaignId);
    const changed = await acceptAs(campaignId, invite.token, staleReview, "player");
    expect(changed).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "conflict" }),
    });

    const fresh = await reviewAs(invite.token, "player");
    expect(fresh.accessRevision).toBeGreaterThan(staleReview.accessRevision);
    const accepted = await acceptAs(campaignId, invite.token, fresh, "player");
    expect(accepted.ok).toBe(true);
  });

  it("rotates to a new token, invalidating the old link, with metadata-only replay", async () => {
    const campaignId = await createCampaign();
    const invite = await issuePlayerInvite(campaignId);
    const rotateKey = randomUUID();
    const { revision: campaignRevision } = await revisions(campaignId);
    const rotated = await h.campaigns.rotateInvitation(ctxFor(h.users.gm), {
      campaignId,
      invitationId: invite.invitationId,
      expectedInvitationRevision: 1,
      expectedCampaignRevision: campaignRevision,
      idempotencyKey: rotateKey,
    });
    expect(rotated.ok).toBe(true);
    if (!rotated.ok || !("token" in rotated.value)) throw new Error("rotation did not return a token");
    expect(rotated.value.token).not.toBe(invite.token);
    expect(Buffer.from(rotated.value.token, "base64url").length).toBe(32);
    expect(rotated.value).toMatchObject({ invitationId: invite.invitationId, invitationRevision: 2 });

    // The old link is dead for review and consumption alike.
    expect(await h.campaigns.reviewInvitation(ctxFor(h.users.player), { token: invite.token })).toEqual({
      ok: false,
      error: { code: "not_found", message: "This invitation is unavailable." },
    });
    const deadAccept = await h.campaigns.acceptInvitation(ctxFor(h.users.player), {
      campaignId,
      token: invite.token,
      expectedInvitationRevision: 1,
      reviewedAccessRevision: (await revisions(campaignId)).accessRevision,
      idempotencyKey: randomUUID(),
    });
    expect(deadAccept).toEqual({
      ok: false,
      error: { code: "not_found", message: "This invitation is unavailable." },
    });

    // Same-key rotation replay returns metadata only: no second rotation.
    const { revision: campaignRevisionAfter } = await revisions(campaignId);
    const replayed = await h.campaigns.rotateInvitation(ctxFor(h.users.gm), {
      campaignId,
      invitationId: invite.invitationId,
      expectedInvitationRevision: 1,
      expectedCampaignRevision: campaignRevision,
      idempotencyKey: rotateKey,
    });
    expect(replayed.ok).toBe(true);
    if (!replayed.ok) return;
    expect(replayed.value).toMatchObject({ invitationId: invite.invitationId, tokenUnavailable: true });
    expect(replayed.value).not.toHaveProperty("token");
    expect(await invitationRow(invite.invitationId)).toMatchObject({ revision: 2 });
    expect(JSON.stringify(await receiptJson(h.users.gm.actorId, "campaign_invitation_rotate", rotateKey))).not.toContain(
      rotated.value.token,
    );
    void campaignRevisionAfter;

    // Another lost response needs another explicit rotation, which mints again.
    const rotatedAgain = await h.campaigns.rotateInvitation(ctxFor(h.users.gm), {
      campaignId,
      invitationId: invite.invitationId,
      expectedInvitationRevision: 2,
      expectedCampaignRevision: (await revisions(campaignId)).revision,
      idempotencyKey: randomUUID(),
    });
    expect(rotatedAgain.ok).toBe(true);
    if (!rotatedAgain.ok || !("token" in rotatedAgain.value)) return;
    const review = await reviewAs(rotatedAgain.value.token, "player");
    expect((await acceptAs(campaignId, rotatedAgain.value.token, review, "player")).ok).toBe(true);
  });

  it("refuses elevation by active members without consuming the token", async () => {
    const campaignId = await createCampaign();
    const first = await issuePlayerInvite(campaignId);
    const accepted = await acceptAs(campaignId, first.token, await reviewAs(first.token, "player"), "player");
    expect(accepted.ok).toBe(true);

    const second = await issuePlayerInvite(campaignId);
    const review = await reviewAs(second.token, "player");
    const elevated = await acceptAs(campaignId, second.token, review, "player");
    expect(elevated).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "bad_request" }),
    });
    // The token survives the refused attempt and stays usable by someone else.
    expect(await invitationRow(second.invitationId)).toMatchObject({ status: "pending", revision: 1 });
    const joined = await acceptAs(campaignId, second.token, await reviewAs(second.token, "other"), "other");
    expect(joined.ok).toBe(true);
    if (!joined.ok) return;
    expect(joined.value.membership).toMatchObject({ role: "player", generation: 1 });
  });

  it("declines without membership and replays its own outcome", async () => {
    const campaignId = await createCampaign();
    const invite = await issuePlayerInvite(campaignId);
    const review = await reviewAs(invite.token, "other");
    const key = randomUUID();
    const declined = await h.campaigns.declineInvitation(ctxFor(h.users.other), {
      campaignId,
      token: invite.token,
      expectedInvitationRevision: review.invitationRevision,
      reviewedAccessRevision: review.accessRevision,
      idempotencyKey: key,
    });
    expect(declined).toEqual({
      ok: true,
      value: { invitationId: invite.invitationId, campaignId, status: "declined" },
    });
    expect(await memberRow(campaignId, h.users.other.actorId)).toBeUndefined();
    expect(await invitationRow(invite.invitationId)).toMatchObject({ status: "declined" });

    const replayed = await h.campaigns.declineInvitation(ctxFor(h.users.other), {
      campaignId,
      token: invite.token,
      expectedInvitationRevision: review.invitationRevision,
      reviewedAccessRevision: review.accessRevision,
      idempotencyKey: key,
    });
    expect(replayed).toEqual(declined);

    // A declined token can no longer accept.
    const acceptAfterDecline = await h.campaigns.acceptInvitation(ctxFor(h.users.player), {
      campaignId,
      token: invite.token,
      expectedInvitationRevision: 2,
      reviewedAccessRevision: (await revisions(campaignId)).accessRevision,
      idempotencyKey: randomUUID(),
    });
    expect(acceptAfterDecline).toEqual({
      ok: false,
      error: { code: "not_found", message: "This invitation is unavailable." },
    });
  });

  it("revokes pending invites and lets consumed invites revoke without losing membership", async () => {
    const campaignId = await createCampaign();
    const invite = await issuePlayerInvite(campaignId);
    const { revision } = await revisions(campaignId);
    const revoked = await h.campaigns.revokeInvitation(ctxFor(h.users.gm), {
      campaignId,
      invitationId: invite.invitationId,
      expectedInvitationRevision: 1,
      expectedCampaignRevision: revision,
      idempotencyKey: randomUUID(),
    });
    expect(revoked.ok).toBe(true);
    if (!revoked.ok) return;
    expect(revoked.value).toMatchObject({ invitationId: invite.invitationId, status: "revoked" });
    expect(await invitationRow(invite.invitationId)).toMatchObject({ status: "revoked" });

    const acceptRevoked = await h.campaigns.acceptInvitation(ctxFor(h.users.player), {
      campaignId,
      token: invite.token,
      expectedInvitationRevision: 2,
      reviewedAccessRevision: (await revisions(campaignId)).accessRevision,
      idempotencyKey: randomUUID(),
    });
    expect(acceptRevoked).toEqual({
      ok: false,
      error: { code: "not_found", message: "This invitation is unavailable." },
    });

    // A consumed invite revokes cleanly; the membership stands.
    const join = await issuePlayerInvite(campaignId);
    const accepted = await acceptAs(campaignId, join.token, await reviewAs(join.token, "player"), "player");
    expect(accepted.ok).toBe(true);
    const consumedRow = await invitationRow(join.invitationId);
    const revokeConsumed = await h.campaigns.revokeInvitation(ctxFor(h.users.gm), {
      campaignId,
      invitationId: join.invitationId,
      expectedInvitationRevision: consumedRow?.revision ?? 2,
      expectedCampaignRevision: (await revisions(campaignId)).revision,
      idempotencyKey: randomUUID(),
    });
    expect(revokeConsumed.ok).toBe(true);
    expect(await memberRow(campaignId, h.users.player.actorId)).toMatchObject({ status: "active" });

    // Consumed and revoked invites no longer rotate.
    for (const id of [join.invitationId, invite.invitationId]) {
      const row = await invitationRow(id);
      const rotated = await h.campaigns.rotateInvitation(ctxFor(h.users.gm), {
        campaignId,
        invitationId: id,
        expectedInvitationRevision: row?.revision ?? 1,
        expectedCampaignRevision: (await revisions(campaignId)).revision,
        idempotencyKey: randomUUID(),
      });
      expect(rotated).toEqual({ ok: false, error: expect.objectContaining({ code: "conflict" }) });
    }
  });

  it("races two consumers to exactly one membership", async () => {
    const campaignId = await createCampaign();
    const invite = await issuePlayerInvite(campaignId);
    const review = await reviewAs(invite.token, "player");

    const [playerOutcome, otherOutcome] = await Promise.all([
      acceptAs(campaignId, invite.token, review, "player"),
      acceptAs(campaignId, invite.token, review, "other"),
    ]);
    const winners = [playerOutcome, otherOutcome].filter((outcome) => outcome.ok);
    const losers = [playerOutcome, otherOutcome].filter((outcome) => !outcome.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]).toEqual({
      ok: false,
      error: { code: "not_found", message: "This invitation is unavailable." },
    });

    const winnerId = playerOutcome.ok ? h.users.player.actorId : h.users.other.actorId;
    const loserId = playerOutcome.ok ? h.users.other.actorId : h.users.player.actorId;
    expect(await invitationRow(invite.invitationId)).toMatchObject({
      status: "accepted",
      consuming_actor_id: winnerId,
      accepted_membership_generation: 1,
    });
    expect(await memberRow(campaignId, winnerId)).toMatchObject({ status: "active", generation: 1 });
    expect(await memberRow(campaignId, loserId)).toBeUndefined();
    const audits = (await auditSummaries(campaignId)).filter((summary) => summary === "Campaign invitation accepted");
    expect(audits).toHaveLength(1);
  });

  it("rejoins through a new invitation-accept with a new generation and no restored controllers", async () => {
    const campaignId = await createCampaign();
    const first = await issuePlayerInvite(campaignId);
    const joinReview = await reviewAs(first.token, "player");
    const joinKey = randomUUID();
    const joined = await acceptAs(campaignId, first.token, joinReview, "player", joinKey);
    expect(joined.ok).toBe(true);
    if (!joined.ok) return;

    // Adopt a personal sheet so departure has controllers to clear.
    const created = await h.characters.create(ctxFor(h.users.player), {
      systemVersionId: h.versionId,
      entityDefinitionId: "character",
      name: `Rejoin hero ${randomUUID().slice(0, 8)}`,
      idempotencyKey: randomUUID(),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const adoptRevision = (await revisions(campaignId)).revision;
    const adopted = await inPlacementTxn((client) =>
      h.placement.adopt(client, ctxFor(h.users.player), {
        campaignId,
        expectedCampaignRevision: adoptRevision,
        membershipGeneration: 1,
        characterId: created.value.characterId,
        expectedCharacterRevision: created.value.revision,
        acknowledgedDisclosure: true,
        idempotencyKey: randomUUID(),
      }),
    );
    expect(adopted.ok).toBe(true);

    const left = await h.campaigns.removeMember(ctxFor(h.users.player), {
      campaignId,
      userId: h.users.player.actorId,
      expectedCampaignRevision: (await revisions(campaignId)).revision,
      idempotencyKey: randomUUID(),
    });
    expect(left.ok).toBe(true);
    expect(await memberRow(campaignId, h.users.player.actorId)).toMatchObject({ status: "removed" });
    const controllersAfterLeave = await h.pool.query(
      `SELECT COUNT(*)::int AS count FROM character_controllers WHERE user_id = $1`,
      [h.users.player.actorId],
    );
    expect(controllersAfterLeave.rows).toEqual([{ count: 0 }]);

    // The consumed token cannot recreate the removed membership.
    const deadAccept = await h.campaigns.acceptInvitation(ctxFor(h.users.player), {
      campaignId,
      token: first.token,
      expectedInvitationRevision: 2,
      reviewedAccessRevision: (await revisions(campaignId)).accessRevision,
      idempotencyKey: randomUUID(),
    });
    expect(deadAccept).toEqual({
      ok: false,
      error: { code: "not_found", message: "This invitation is unavailable." },
    });
    // The stale accept receipt confirms nothing after removal: exact same
    // input replays to result_unavailable, never to a resurrected row.
    const staleReplay = await h.campaigns.acceptInvitation(ctxFor(h.users.player), {
      campaignId,
      token: first.token,
      expectedInvitationRevision: joinReview.invitationRevision,
      reviewedAccessRevision: joinReview.accessRevision,
      idempotencyKey: joinKey,
    });
    expect(staleReplay).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "result_unavailable" }),
    });

    // A NEW invitation rejoins on a fresh generation; old grants stay invalid.
    const second = await issuePlayerInvite(campaignId);
    const rejoined = await acceptAs(campaignId, second.token, await reviewAs(second.token, "player"), "player");
    expect(rejoined.ok).toBe(true);
    if (!rejoined.ok) return;
    expect(rejoined.value.membershipGeneration).toBeGreaterThan(1);
    expect(await memberRow(campaignId, h.users.player.actorId)).toMatchObject({
      status: "active",
      generation: rejoined.value.membershipGeneration,
    });
    const controllersAfterRejoin = await h.pool.query(
      `SELECT COUNT(*)::int AS count FROM character_controllers WHERE user_id = $1`,
      [h.users.player.actorId],
    );
    expect(controllersAfterRejoin.rows).toEqual([{ count: 0 }]);
    const sheet = await h.pool.query(`SELECT owner_id, campaign_id FROM characters WHERE id = $1`, [
      created.value.characterId,
    ]);
    // The adopted sheet returned to its owner on departure and rejoin does
    // not pull it back in.
    expect(sheet.rows).toEqual([{ owner_id: h.users.player.actorId, campaign_id: null }]);
  });

  it("rejects archived and expired consumption while keeping valid membership", async () => {
    const campaignId = await createCampaign();
    const join = await issuePlayerInvite(campaignId);
    expect(await acceptAs(campaignId, join.token, await reviewAs(join.token, "player"), "player")).toMatchObject({
      ok: true,
    });

    // Issued before archival, consumed after: unavailable, unconsumed.
    const pending = await issuePlayerInvite(campaignId);
    const pendingReview = await reviewAs(pending.token, "other");
    const { revision } = await revisions(campaignId);
    expect(
      await h.campaigns.archive(ctxFor(h.users.gm), {
        campaignId,
        expectedCampaignRevision: revision,
        idempotencyKey: randomUUID(),
      }),
    ).toMatchObject({ ok: true });
    const archivedAccept = await acceptAs(campaignId, pending.token, pendingReview, "other");
    expect(archivedAccept).toEqual({
      ok: false,
      error: { code: "not_found", message: "This invitation is unavailable." },
    });
    expect(await invitationRow(pending.invitationId)).toMatchObject({ status: "pending" });
    expect(await memberRow(campaignId, h.users.player.actorId)).toMatchObject({ status: "active" });

    // An expired invitation never joins and never disturbs membership.
    const recovered = await h.campaigns.recover(ctxFor(h.users.gm), {
      campaignId,
      expectedCampaignRevision: (await revisions(campaignId)).revision,
      idempotencyKey: randomUUID(),
    });
    expect(recovered.ok).toBe(true);
    const expiring = await issuePlayerInvite(campaignId);
    await h.pool.query(`UPDATE campaign_invitations SET expires_at = now() - interval '1 hour' WHERE id = $1`, [
      expiring.invitationId,
    ]);
    expect(await h.campaigns.reviewInvitation(ctxFor(h.users.other), { token: expiring.token })).toEqual({
      ok: false,
      error: { code: "not_found", message: "This invitation is unavailable." },
    });
    const expiredAccept = await h.campaigns.acceptInvitation(ctxFor(h.users.other), {
      campaignId,
      token: expiring.token,
      expectedInvitationRevision: 1,
      reviewedAccessRevision: (await revisions(campaignId)).accessRevision,
      idempotencyKey: randomUUID(),
    });
    expect(expiredAccept).toEqual({
      ok: false,
      error: { code: "not_found", message: "This invitation is unavailable." },
    });
    expect(await memberRow(campaignId, h.users.player.actorId)).toMatchObject({ status: "active", generation: 1 });
  });

  it("expires accept receipts so stale replays become unavailable", async () => {
    const campaignId = await createCampaign();
    const invite = await issuePlayerInvite(campaignId);
    const review = await reviewAs(invite.token, "player");
    const key = randomUUID();
    const joined = await acceptAs(campaignId, invite.token, review, "player", key);
    expect(joined.ok).toBe(true);

    await h.pool.query(
      `UPDATE campaign_command_executions SET expires_at = now() - interval '1 hour'
        WHERE actor_id = $1 AND command_kind = 'campaign_invitation_accept' AND idempotency_key = $2`,
      [h.users.player.actorId, key],
    );
    const replayed = await h.campaigns.acceptInvitation(ctxFor(h.users.player), {
      campaignId,
      token: invite.token,
      expectedInvitationRevision: review.invitationRevision,
      reviewedAccessRevision: review.accessRevision,
      idempotencyKey: key,
    });
    // Same input hash, but the receipt lapsed: no confirmation.
    expect(replayed).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "result_unavailable" }),
    });
    // The committed membership stands regardless.
    expect(await memberRow(campaignId, h.users.player.actorId)).toMatchObject({ status: "active" });
  });

  it("limits issue, review and consume attempts without logging tokens", async () => {
    const bounded: Campaigns = createCampaignsModule({
      pool: h.pool,
      limits: DEFAULT_CAMPAIGN_LIMITS,
      charactersPlacement: h.placement,
      invitationRateLimit: { windowMs: 60_000, maxAttempts: 2 },
    });
    const created = await bounded.create(ctxFor(h.users.gm), {
      systemVersionId: h.versionId,
      title: `Rate limited ${randomUUID()}`,
      description: "",
      idempotencyKey: randomUUID(),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const campaignId = created.value.campaignId;

    async function boundedIssue() {
      const opened = await bounded.open(ctxFor(h.users.gm), { campaignId });
      if (!opened.ok) throw new Error("campaign vanished");
      return bounded.issueInvitation(ctxFor(h.users.gm), {
        campaignId,
        intendedRole: "player",
        expectedCampaignRevision: opened.value.revision,
        idempotencyKey: randomUUID(),
      });
    }

    const first = await boundedIssue();
    const second = await boundedIssue();
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    const third = await boundedIssue();
    expect(third).toEqual({ ok: false, error: expect.objectContaining({ code: "rate_limited" }) });

    // Review budget is independent per operation: two reads pass, then reject.
    if (!first.ok || !("token" in first.value)) return;
    const token = first.value.token;
    expect((await bounded.reviewInvitation(ctxFor(h.users.player), { token })).ok).toBe(true);
    expect((await bounded.reviewInvitation(ctxFor(h.users.player), { token })).ok).toBe(true);
    const reviewLimited = await bounded.reviewInvitation(ctxFor(h.users.player), { token });
    expect(reviewLimited).toEqual({ ok: false, error: expect.objectContaining({ code: "rate_limited" }) });
    expect(JSON.stringify(reviewLimited)).not.toContain(token);

    // Consume attempts (even failing ones) count, then reject without secrets.
    const probe = "definitely-not-a-token";
    expect(
      await bounded.acceptInvitation(ctxFor(h.users.other), {
        campaignId,
        token: probe,
        expectedInvitationRevision: 1,
        reviewedAccessRevision: 1,
        idempotencyKey: randomUUID(),
      }),
    ).toMatchObject({ ok: false });
    expect(
      await bounded.declineInvitation(ctxFor(h.users.other), {
        campaignId,
        token: probe,
        expectedInvitationRevision: 1,
        reviewedAccessRevision: 1,
        idempotencyKey: randomUUID(),
      }),
    ).toMatchObject({ ok: false });
    const consumeLimited = await bounded.acceptInvitation(ctxFor(h.users.other), {
      campaignId,
      token: probe,
      expectedInvitationRevision: 1,
      reviewedAccessRevision: 1,
      idempotencyKey: randomUUID(),
    });
    expect(consumeLimited).toEqual({ ok: false, error: expect.objectContaining({ code: "rate_limited" }) });
    expect(JSON.stringify(consumeLimited)).not.toContain(probe);
  });

  it("enforces the configured member bound on accept", async () => {
    const small: Campaigns = createCampaignsModule({
      pool: h.pool,
      limits: { ...DEFAULT_CAMPAIGN_LIMITS, maxMembers: 1 },
      charactersPlacement: h.placement,
    });
    const created = await small.create(ctxFor(h.users.gm), {
      systemVersionId: h.versionId,
      title: `Full house ${randomUUID()}`,
      description: "",
      idempotencyKey: randomUUID(),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const campaignId = created.value.campaignId;
    const opened = await small.open(ctxFor(h.users.gm), { campaignId });
    if (!opened.ok) return;
    const issued = await small.issueInvitation(ctxFor(h.users.gm), {
      campaignId,
      intendedRole: "player",
      expectedCampaignRevision: opened.value.revision,
      idempotencyKey: randomUUID(),
    });
    expect(issued.ok).toBe(true);
    if (!issued.ok || !("token" in issued.value)) return;
    const review = await small.reviewInvitation(ctxFor(h.users.player), { token: issued.value.token });
    expect(review.ok).toBe(true);
    if (!review.ok) return;
    const full = await small.acceptInvitation(ctxFor(h.users.player), {
      campaignId,
      token: issued.value.token,
      expectedInvitationRevision: review.value.invitationRevision,
      reviewedAccessRevision: review.value.accessRevision,
      idempotencyKey: randomUUID(),
    });
    expect(full).toEqual({ ok: false, error: expect.objectContaining({ code: "conflict" }) });
    expect(await memberRow(campaignId, h.users.player.actorId)).toBeUndefined();
  });

  it("lists invitations to GMs only with bounded cursor pages", async () => {
    const campaignId = await createCampaign();
    await seedMember(campaignId, h.users.other.actorId, "co_gm");
    await seedMember(campaignId, h.users.player.actorId, "player");
    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      ids.push((await issuePlayerInvite(campaignId)).invitationId);
    }

    const listed = await h.campaigns.listInvitations(ctxFor(h.users.gm), { campaignId, limit: 1 });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.invitations).toHaveLength(1);
    expect(listed.value.nextCursor).not.toBeNull();
    const seen = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const result = await h.campaigns.listInvitations(ctxFor(h.users.other), { campaignId, limit: 1, cursor });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      for (const item of result.value.invitations) {
        seen.add(item.invitationId);
        // Metadata only: exact keys, no hashes or tokens.
        expect(Object.keys(item).sort()).toEqual(
          ["createdAt", "expiresAt", "intendedRole", "invitationId", "invitationRevision", "issuedBy", "status"].sort(),
        );
      }
      cursor = result.value.nextCursor;
      if (cursor === null) break;
    }
    expect(cursor).toBeNull();
    expect([...seen].sort()).toEqual([...ids].sort());

    // Non-managers and outsiders collapse to not_found.
    for (const who of ["player", "outsider"] as const) {
      expect(await h.campaigns.listInvitations(ctxFor(h.users[who]), { campaignId })).toEqual({
        ok: false,
        error: expect.objectContaining({ code: "not_found" }),
      });
    }
    // Cursors never cross scopes: a members cursor is rejected here.
    const members = await h.campaigns.listMembers(ctxFor(h.users.gm), { campaignId, limit: 1 });
    expect(members.ok).toBe(true);
    if (!members.ok || members.value.nextCursor === null) return;
    expect(
      await h.campaigns.listInvitations(ctxFor(h.users.gm), { campaignId, cursor: members.value.nextCursor }),
    ).toEqual({ ok: false, error: expect.objectContaining({ code: "bad_request" }) });
  });
});
