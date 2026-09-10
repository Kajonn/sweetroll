import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_CAMPAIGN_LIMITS } from "../../src/platform/config.js";
import { buildI6Harness, ctxFor, type I6Harness } from "./i6-app.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl === undefined ? describe.skip : describe;

describeWithDatabase("campaign content, grants and source-scoped history (Task 7)", () => {
  let h: I6Harness;

  beforeAll(async () => {
    h = await buildI6Harness();
  });

  afterAll(async () => {
    await h.close();
  });

  async function createCampaign(): Promise<string> {
    const created = await h.campaigns.create(ctxFor(h.users.gm), {
      systemVersionId: h.versionId,
      title: `Content ${randomUUID()}`,
      description: "",
      idempotencyKey: randomUUID(),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("campaign create failed");
    return created.value.campaignId;
  }

  async function revision(campaignId: string): Promise<number> {
    const opened = await h.campaigns.open(ctxFor(h.users.gm), { campaignId });
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error("campaign vanished under test");
    return opened.value.revision;
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

  async function createNote(
    campaignId: string,
    who: keyof I6Harness["users"],
    options?: {
      title?: string;
      body?: string;
      tags?: string[];
      audience?: "gm_only" | "all_players" | "selected_players" | "owner_only";
      grantedUserIds?: string[];
      key?: string;
      requestId?: string;
    },
  ) {
    const created = await h.campaigns.createContent(
      ctxFor(h.users[who], options?.requestId ?? randomUUID()),
      {
        campaignId,
        title: options?.title ?? `Note ${randomUUID()}`,
        body: options?.body ?? "plain text body",
        tags: options?.tags,
        audience: options?.audience,
        grantedUserIds: options?.grantedUserIds,
        idempotencyKey: options?.key ?? randomUUID(),
      },
    );
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(`create failed: ${JSON.stringify(created.error)}`);
    return created.value;
  }

  async function grantCount(contentId: string): Promise<number> {
    const rows = await h.pool.query(
      `SELECT COUNT(*)::int AS count FROM campaign_content_grants WHERE content_id = $1`,
      [contentId],
    );
    return rows.rows[0].count as number;
  }

  it("defaults audiences by creator role", async () => {
    const campaignId = await createCampaign();
    await seedMember(campaignId, h.users.player.actorId);

    const gmNote = await createNote(campaignId, "gm");
    expect(gmNote.audience).toBe("gm_only");
    expect(gmNote.revision).toBe(1);
    expect(gmNote.accessRevision).toBe(1);

    const playerNote = await createNote(campaignId, "player");
    expect(playerNote.audience).toBe("owner_only");
  });

  it("enforces the audience matrix across roles", async () => {
    const campaignId = await createCampaign();
    await seedMember(campaignId, h.users.player.actorId);
    await seedMember(campaignId, h.users.other.actorId);
    await seedMember(campaignId, h.users.outsider.actorId, "player");
    await h.pool.query(
      `UPDATE campaign_members SET role = 'co_gm' WHERE campaign_id = $1 AND user_id = $2`,
      [campaignId, h.users.outsider.actorId],
    );

    const gmOnly = await createNote(campaignId, "gm", { audience: "gm_only" });
    const shared = await createNote(campaignId, "gm", { audience: "all_players" });
    const selected = await createNote(campaignId, "gm", {
      audience: "selected_players",
      grantedUserIds: [h.users.player.actorId],
    });
    const privateNote = await createNote(campaignId, "player", { body: "player secret" });

    const openAs = (who: keyof I6Harness["users"], contentId: string) =>
      h.campaigns.openContent(ctxFor(h.users[who]), { contentId });

    // gm_only: owner/co-GMs only.
    expect((await openAs("gm", gmOnly.contentId)).ok).toBe(true);
    expect((await openAs("outsider", gmOnly.contentId)).ok).toBe(true);
    const playerDenied = await openAs("player", gmOnly.contentId);
    expect(playerDenied.ok).toBe(false);
    if (!playerDenied.ok) expect(playerDenied.error.code).toBe("not_found");

    // all_players: every active member.
    expect((await openAs("player", shared.contentId)).ok).toBe(true);
    expect((await openAs("other", shared.contentId)).ok).toBe(true);

    // selected_players: granted players plus GMs.
    expect((await openAs("player", selected.contentId)).ok).toBe(true);
    const ungranted = await openAs("other", selected.contentId);
    expect(ungranted.ok).toBe(false);
    if (!ungranted.ok) expect(ungranted.error.code).toBe("not_found");
    expect((await openAs("outsider", selected.contentId)).ok).toBe(true);

    // owner_only: the creating member only, no GM override.
    expect((await openAs("player", privateNote.contentId)).ok).toBe(true);
    const gmSnoop = await openAs("gm", privateNote.contentId);
    expect(gmSnoop.ok).toBe(false);
    if (!gmSnoop.ok) expect(gmSnoop.error.code).toBe("not_found");
    expect((await openAs("outsider", privateNote.contentId)).ok).toBe(false);
    expect((await openAs("other", privateNote.contentId)).ok).toBe(false);

    // A caller with no membership collapses the same way.
    const stranger = await h.campaigns.openContent(ctxFor({ actorId: randomUUID(), requestId: randomUUID() }), {
      contentId: shared.contentId,
    });
    expect(stranger.ok).toBe(false);
    if (!stranger.ok) expect(stranger.error.code).toBe("not_found");
  });

  it("prevents players from widening audience or naming grants", async () => {
    const campaignId = await createCampaign();
    await seedMember(campaignId, h.users.player.actorId);

    const widened = await h.campaigns.createContent(ctxFor(h.users.player), {
      campaignId,
      title: "sneaky",
      audience: "all_players",
      idempotencyKey: randomUUID(),
    });
    expect(widened.ok).toBe(false);
    if (!widened.ok) expect(widened.error.code).toBe("bad_request");

    const withGrants = await h.campaigns.createContent(ctxFor(h.users.player), {
      campaignId,
      title: "sneaky",
      grantedUserIds: [h.users.player.actorId],
      idempotencyKey: randomUUID(),
    });
    expect(withGrants.ok).toBe(false);
    if (!withGrants.ok) expect(withGrants.error.code).toBe("bad_request");
  });

  it("lets players edit and delete their own notes but not others", async () => {
    const campaignId = await createCampaign();
    await seedMember(campaignId, h.users.player.actorId);
    await seedMember(campaignId, h.users.other.actorId);

    const mine = await createNote(campaignId, "player", { title: "mine" });
    const updated = await h.campaigns.updateContent(ctxFor(h.users.player), {
      contentId: mine.contentId,
      title: "mine edited",
      expectedContentRevision: mine.revision,
      idempotencyKey: randomUUID(),
    });
    expect(updated.ok).toBe(true);
    if (updated.ok) expect(updated.value.title).toBe("mine edited");

    const gmNote = await createNote(campaignId, "gm", { audience: "all_players" });
    const foreignEdit = await h.campaigns.updateContent(ctxFor(h.users.player), {
      contentId: gmNote.contentId,
      title: "hijacked",
      expectedContentRevision: gmNote.revision,
      idempotencyKey: randomUUID(),
    });
    expect(foreignEdit.ok).toBe(false);
    if (!foreignEdit.ok) expect(foreignEdit.error.code).toBe("not_found");

    // A player cannot widen their own note either: audience changes are GM-only.
    const selfWiden = await h.campaigns.updateContent(ctxFor(h.users.player), {
      contentId: mine.contentId,
      audience: "all_players",
      expectedContentRevision: mine.revision + 1,
      idempotencyKey: randomUUID(),
    });
    expect(selfWiden.ok).toBe(false);
    if (!selfWiden.ok) expect(selfWiden.error.code).toBe("not_found");

    const deleted = await h.campaigns.deleteContent(ctxFor(h.users.player), {
      contentId: mine.contentId,
      expectedContentRevision: mine.revision + 1,
      idempotencyKey: randomUUID(),
    });
    expect(deleted.ok).toBe(true);
  });

  it("lets GMs edit readable content but hides inaccessible notes entirely", async () => {
    const campaignId = await createCampaign();
    await seedMember(campaignId, h.users.player.actorId);

    const shared = await createNote(campaignId, "gm", { audience: "all_players", title: "shared" });
    const edited = await h.campaigns.updateContent(ctxFor(h.users.gm), {
      contentId: shared.contentId,
      body: "gm edit",
      expectedContentRevision: shared.revision,
      idempotencyKey: randomUUID(),
    });
    expect(edited.ok).toBe(true);

    const hidden = await h.campaigns.openContent(ctxFor(h.users.gm), { contentId: shared.contentId });
    expect(hidden.ok).toBe(true);
    if (hidden.ok) expect(hidden.value.grantedUserIds).toEqual([]);
    // Unprivileged readers see no grant roster at all.
    await seedMember(campaignId, h.users.other.actorId);
    const playerView = await h.campaigns.openContent(ctxFor(h.users.other), {
      contentId: shared.contentId,
    });
    expect(playerView.ok).toBe(true);
    if (playerView.ok) expect(playerView.value).not.toHaveProperty("grantedUserIds");
  });

  it("validates bounded tags, body, audience and grant sizes before writes", async () => {
    const campaignId = await createCampaign();
    await seedMember(campaignId, h.users.player.actorId);
    const note = await createNote(campaignId, "gm");

    const overBody = await h.campaigns.createContent(ctxFor(h.users.gm), {
      campaignId,
      title: "big",
      body: "x".repeat(DEFAULT_CAMPAIGN_LIMITS.maxContentBodyLength + 1),
      idempotencyKey: randomUUID(),
    });
    expect(overBody.ok).toBe(false);

    const manyTags = await h.campaigns.createContent(ctxFor(h.users.gm), {
      campaignId,
      title: "tagged",
      tags: Array.from({ length: DEFAULT_CAMPAIGN_LIMITS.maxContentTags + 1 }, (_, i) => `t${i}`),
      idempotencyKey: randomUUID(),
    });
    expect(manyTags.ok).toBe(false);

    const longTag = await h.campaigns.createContent(ctxFor(h.users.gm), {
      campaignId,
      title: "tagged",
      tags: ["x".repeat(DEFAULT_CAMPAIGN_LIMITS.maxContentTagLength + 1)],
      idempotencyKey: randomUUID(),
    });
    expect(longTag.ok).toBe(false);

    const badAudience = await h.campaigns.createContent(ctxFor(h.users.gm), {
      campaignId,
      title: "bad",
      audience: "everyone" as "gm_only",
      idempotencyKey: randomUUID(),
    });
    expect(badAudience.ok).toBe(false);
    if (!badAudience.ok) expect(badAudience.error.code).toBe("bad_request");

    const emptyUpdate = await h.campaigns.updateContent(ctxFor(h.users.gm), {
      contentId: note.contentId,
      expectedContentRevision: note.revision,
      idempotencyKey: randomUUID(),
    });
    expect(emptyUpdate.ok).toBe(false);

    const tooManyGrants = await h.campaigns.replaceGrants(ctxFor(h.users.gm), {
      contentId: note.contentId,
      grantedUserIds: Array.from({ length: DEFAULT_CAMPAIGN_LIMITS.maxContentGrants + 1 }, () => randomUUID()),
      expectedContentRevision: note.revision,
      idempotencyKey: randomUUID(),
    });
    expect(tooManyGrants.ok).toBe(false);
    if (!tooManyGrants.ok) expect(tooManyGrants.error.code).toBe("bad_request");

    // Oversize writes leave no rows or events behind.
    const counts = await h.pool.query(
      `SELECT (SELECT COUNT(*)::int FROM campaign_content_items WHERE campaign_id = $1) AS items,
              (SELECT COUNT(*)::int FROM campaign_activity_events WHERE campaign_id = $1) AS events`,
      [campaignId],
    );
    expect(counts.rows[0]).toEqual({ items: 1, events: 1 });
  });

  it("soft-deletes and recovers under the same visibility policy", async () => {
    const campaignId = await createCampaign();
    await seedMember(campaignId, h.users.player.actorId);
    await seedMember(campaignId, h.users.other.actorId);

    const note = await createNote(campaignId, "gm", { audience: "all_players" });
    expect(
      (await h.campaigns.openContent(ctxFor(h.users.player), { contentId: note.contentId })).ok,
    ).toBe(true);

    const deleted = await h.campaigns.deleteContent(ctxFor(h.users.gm), {
      contentId: note.contentId,
      expectedContentRevision: note.revision,
      idempotencyKey: randomUUID(),
    });
    expect(deleted.ok).toBe(true);
    if (deleted.ok) {
      expect(deleted.value.status).toBe("deleted");
      expect(deleted.value.revision).toBe(2);
      expect(deleted.value.accessRevision).toBe(2);
    }

    // Deleted rows hide from ordinary reads and lists.
    expect(
      (await h.campaigns.openContent(ctxFor(h.users.player), { contentId: note.contentId })).ok,
    ).toBe(false);
    const listed = await h.campaigns.listContent(ctxFor(h.users.player), { campaignId });
    expect(listed.ok).toBe(true);
    if (listed.ok) expect(listed.value.content.map((item) => item.contentId)).not.toContain(note.contentId);

    // An unprivileged actor cannot recover what they cannot read.
    const foreignRecover = await h.campaigns.recoverContent(ctxFor(h.users.other), {
      contentId: note.contentId,
      expectedContentRevision: 2,
      idempotencyKey: randomUUID(),
    });
    expect(foreignRecover.ok).toBe(false);

    const recovered = await h.campaigns.recoverContent(ctxFor(h.users.gm), {
      contentId: note.contentId,
      expectedContentRevision: 2,
      idempotencyKey: randomUUID(),
    });
    expect(recovered.ok).toBe(true);
    if (recovered.ok) {
      expect(recovered.value.status).toBe("active");
      expect(recovered.value.revision).toBe(3);
    }
    expect(
      (await h.campaigns.openContent(ctxFor(h.users.player), { contentId: note.contentId })).ok,
    ).toBe(true);

    const alreadyActive = await h.campaigns.recoverContent(ctxFor(h.users.gm), {
      contentId: note.contentId,
      expectedContentRevision: 3,
      idempotencyKey: randomUUID(),
    });
    expect(alreadyActive.ok).toBe(false);
    if (!alreadyActive.ok) expect(alreadyActive.error.code).toBe("conflict");
  });

  it("replaces grants atomically and bumps content and access revisions together", async () => {
    const campaignId = await createCampaign();
    await seedMember(campaignId, h.users.player.actorId);
    await seedMember(campaignId, h.users.other.actorId);

    const note = await createNote(campaignId, "gm", {
      audience: "selected_players",
      grantedUserIds: [h.users.player.actorId],
    });
    expect(await grantCount(note.contentId)).toBe(1);

    const replaced = await h.campaigns.replaceGrants(ctxFor(h.users.gm), {
      contentId: note.contentId,
      grantedUserIds: [h.users.other.actorId],
      expectedContentRevision: note.revision,
      idempotencyKey: randomUUID(),
    });
    expect(replaced.ok).toBe(true);
    if (!replaced.ok) throw new Error("replace failed");
    // Create-with-grants already stands at revision 2; replacement bumps both together.
    expect(replaced.value.revision).toBe(note.revision + 1);
    expect(replaced.value.accessRevision).toBe(note.accessRevision + 1);
    expect(await grantCount(note.contentId)).toBe(1);

    // The removed grantee loses reads immediately; the new grantee gains them.
    expect(
      (await h.campaigns.openContent(ctxFor(h.users.player), { contentId: note.contentId })).ok,
    ).toBe(false);
    expect(
      (await h.campaigns.openContent(ctxFor(h.users.other), { contentId: note.contentId })).ok,
    ).toBe(true);

    const stale = await h.campaigns.replaceGrants(ctxFor(h.users.gm), {
      contentId: note.contentId,
      grantedUserIds: [],
      expectedContentRevision: note.revision,
      idempotencyKey: randomUUID(),
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.error.code).toBe("conflict");
      expect(stale.error.latestRevision).toBe(replaced.value.revision);
    }

    const playerAdmin = await h.campaigns.replaceGrants(ctxFor(h.users.other), {
      contentId: note.contentId,
      grantedUserIds: [h.users.player.actorId],
      expectedContentRevision: replaced.value.revision,
      idempotencyKey: randomUUID(),
    });
    expect(playerAdmin.ok).toBe(false);
    if (!playerAdmin.ok) expect(playerAdmin.error.code).toBe("not_found");
  });

  it("refuses to share an inaccessible owner-only note by guessed ID", async () => {
    const campaignId = await createCampaign();
    await seedMember(campaignId, h.users.player.actorId);

    const hidden = await createNote(campaignId, "player", { body: "never share this" });

    const guessedGrants = await h.campaigns.replaceGrants(ctxFor(h.users.gm), {
      contentId: hidden.contentId,
      grantedUserIds: [h.users.player.actorId],
      expectedContentRevision: hidden.revision,
      idempotencyKey: randomUUID(),
    });
    expect(guessedGrants.ok).toBe(false);
    if (!guessedGrants.ok) expect(guessedGrants.error.code).toBe("not_found");

    const guessedEdit = await h.campaigns.updateContent(ctxFor(h.users.gm), {
      contentId: hidden.contentId,
      title: "administrative edit",
      expectedContentRevision: hidden.revision,
      idempotencyKey: randomUUID(),
    });
    expect(guessedEdit.ok).toBe(false);
    if (!guessedEdit.ok) expect(guessedEdit.error.code).toBe("not_found");

    const guessedDelete = await h.campaigns.deleteContent(ctxFor(h.users.gm), {
      contentId: hidden.contentId,
      expectedContentRevision: hidden.revision,
      idempotencyKey: randomUUID(),
    });
    expect(guessedDelete.ok).toBe(false);
    expect(await grantCount(hidden.contentId)).toBe(0);
  });

  it("rejects cross-campaign, unknown and removed grant targets", async () => {
    const campaignId = await createCampaign();
    const foreignId = await createCampaign();
    await seedMember(campaignId, h.users.player.actorId);
    await seedMember(foreignId, h.users.other.actorId);

    const note = await createNote(campaignId, "gm", { audience: "selected_players" });

    // Membership in a different campaign does not satisfy the same-campaign grant.
    const crossCampaign = await h.campaigns.replaceGrants(ctxFor(h.users.gm), {
      contentId: note.contentId,
      grantedUserIds: [h.users.other.actorId],
      expectedContentRevision: note.revision,
      idempotencyKey: randomUUID(),
    });
    expect(crossCampaign.ok).toBe(false);
    if (!crossCampaign.ok) expect(crossCampaign.error.code).toBe("bad_request");

    const unknown = await h.campaigns.replaceGrants(ctxFor(h.users.gm), {
      contentId: note.contentId,
      grantedUserIds: [randomUUID()],
      expectedContentRevision: note.revision,
      idempotencyKey: randomUUID(),
    });
    expect(unknown.ok).toBe(false);

    // A removed member is no longer an active grant target.
    await seedMember(campaignId, h.users.outsider.actorId);
    const removed = await h.campaigns.removeMember(ctxFor(h.users.gm), {
      campaignId,
      userId: h.users.outsider.actorId,
      expectedCampaignRevision: await revision(campaignId),
      idempotencyKey: randomUUID(),
    });
    expect(removed.ok).toBe(true);
    const removedTarget = await h.campaigns.replaceGrants(ctxFor(h.users.gm), {
      contentId: note.contentId,
      grantedUserIds: [h.users.outsider.actorId],
      expectedContentRevision: note.revision,
      idempotencyKey: randomUUID(),
    });
    expect(removedTarget.ok).toBe(false);
    expect(await grantCount(note.contentId)).toBe(0);
  });

  it("destroys grants on departure and never reactivates them on rejoin", async () => {
    const campaignId = await createCampaign();
    await seedMember(campaignId, h.users.other.actorId);

    // The player joins through a real invitation so rejoin can too.
    const issued = await h.campaigns.issueInvitation(ctxFor(h.users.gm), {
      campaignId,
      intendedRole: "player",
      expectedCampaignRevision: await revision(campaignId),
      idempotencyKey: randomUUID(),
    });
    expect(issued.ok).toBe(true);
    if (!issued.ok || !("token" in issued.value)) throw new Error("issue failed");
    const reviewed = await h.campaigns.reviewInvitation(ctxFor(h.users.player), {
      token: issued.value.token,
    });
    expect(reviewed.ok).toBe(true);
    if (!reviewed.ok) throw new Error("review failed");
    const accepted = await h.campaigns.acceptInvitation(ctxFor(h.users.player), {
      campaignId,
      token: issued.value.token,
      expectedInvitationRevision: reviewed.value.invitationRevision,
      reviewedAccessRevision: reviewed.value.accessRevision,
      idempotencyKey: randomUUID(),
    });
    expect(accepted.ok).toBe(true);

    const note = await createNote(campaignId, "gm", {
      audience: "selected_players",
      grantedUserIds: [h.users.player.actorId],
    });
    expect(
      (await h.campaigns.openContent(ctxFor(h.users.player), { contentId: note.contentId })).ok,
    ).toBe(true);

    const departed = await h.campaigns.removeMember(ctxFor(h.users.gm), {
      campaignId,
      userId: h.users.player.actorId,
      expectedCampaignRevision: await revision(campaignId),
      idempotencyKey: randomUUID(),
    });
    expect(departed.ok).toBe(true);
    expect(await grantCount(note.contentId)).toBe(0);
    expect(
      (await h.campaigns.openContent(ctxFor(h.users.player), { contentId: note.contentId })).ok,
    ).toBe(false);

    // Rejoin with a NEW invitation: a new generation, but no restored grant.
    const reissued = await h.campaigns.issueInvitation(ctxFor(h.users.gm), {
      campaignId,
      intendedRole: "player",
      expectedCampaignRevision: await revision(campaignId),
      idempotencyKey: randomUUID(),
    });
    expect(reissued.ok).toBe(true);
    if (!reissued.ok || !("token" in reissued.value)) throw new Error("reissue failed");
    const rereviewed = await h.campaigns.reviewInvitation(ctxFor(h.users.player), {
      token: reissued.value.token,
    });
    expect(rereviewed.ok).toBe(true);
    if (!rereviewed.ok) throw new Error("rereview failed");
    const rejoined = await h.campaigns.acceptInvitation(ctxFor(h.users.player), {
      campaignId,
      token: reissued.value.token,
      expectedInvitationRevision: rereviewed.value.invitationRevision,
      reviewedAccessRevision: rereviewed.value.accessRevision,
      idempotencyKey: randomUUID(),
    });
    expect(rejoined.ok).toBe(true);
    if (rejoined.ok) expect(rejoined.value.membershipGeneration).toBeGreaterThan(1);
    expect(
      (await h.campaigns.openContent(ctxFor(h.users.player), { contentId: note.contentId })).ok,
    ).toBe(false);
    expect(await grantCount(note.contentId)).toBe(0);

    // Only an explicit fresh grant restores access.
    const live = await h.campaigns.openContent(ctxFor(h.users.gm), { contentId: note.contentId });
    expect(live.ok).toBe(true);
    if (!live.ok) throw new Error("gm lost the note");
    const regranted = await h.campaigns.replaceGrants(ctxFor(h.users.gm), {
      contentId: note.contentId,
      grantedUserIds: [h.users.player.actorId],
      expectedContentRevision: live.value.revision,
      idempotencyKey: randomUUID(),
    });
    expect(regranted.ok).toBe(true);
    expect(
      (await h.campaigns.openContent(ctxFor(h.users.player), { contentId: note.contentId })).ok,
    ).toBe(true);
  });

  it("keeps a departed creator's owner-only note hidden until they rejoin", async () => {
    const campaignId = await createCampaign();
    await seedMember(campaignId, h.users.player.actorId);

    const note = await createNote(campaignId, "player", { body: "mine alone" });
    const left = await h.campaigns.removeMember(ctxFor(h.users.player), {
      campaignId,
      userId: h.users.player.actorId,
      expectedCampaignRevision: await revision(campaignId),
      idempotencyKey: randomUUID(),
    });
    expect(left.ok).toBe(true);

    // Nobody active can read another actor's private note, not even a GM.
    expect((await h.campaigns.openContent(ctxFor(h.users.gm), { contentId: note.contentId })).ok).toBe(
      false,
    );
    const listed = await h.campaigns.listContent(ctxFor(h.users.gm), { campaignId });
    expect(listed.ok).toBe(true);
    if (listed.ok) expect(listed.value.content.map((item) => item.contentId)).not.toContain(note.contentId);

    // Rejoin restores the creator's own access: creator identity, not grants.
    await h.pool.query(
      `UPDATE campaign_members SET status = 'active', generation = generation + 1
        WHERE campaign_id = $1 AND user_id = $2`,
      [campaignId, h.users.player.actorId],
    );
    expect(
      (await h.campaigns.openContent(ctxFor(h.users.player), { contentId: note.contentId })).ok,
    ).toBe(true);
  });

  it("filters activity by current source policy and correlates request IDs", async () => {
    const campaignId = await createCampaign();
    await seedMember(campaignId, h.users.player.actorId);
    const sharedRequestId = randomUUID();

    const note = await createNote(campaignId, "gm", {
      audience: "selected_players",
      grantedUserIds: [h.users.player.actorId],
      requestId: sharedRequestId,
    });
    const live = await h.campaigns.openContent(ctxFor(h.users.gm), { contentId: note.contentId });
    expect(live.ok).toBe(true);
    if (!live.ok) throw new Error("gm lost the note");
    // Two commands share one request ID: correlation, not uniqueness.
    const regranted = await h.campaigns.replaceGrants(
      ctxFor(h.users.gm, sharedRequestId),
      {
        contentId: note.contentId,
        grantedUserIds: [h.users.player.actorId],
        expectedContentRevision: live.value.revision,
        idempotencyKey: randomUUID(),
      },
    );
    expect(regranted.ok).toBe(true);

    const playerActivity = await h.campaigns.listActivity(ctxFor(h.users.player), { campaignId });
    expect(playerActivity.ok).toBe(true);
    if (!playerActivity.ok) throw new Error("activity failed");
    const sourceIds = playerActivity.value.events.map((event) => event.sourceContentId);
    expect(sourceIds).toContain(note.contentId);
    const correlated = playerActivity.value.events.filter((event) => event.requestId === sharedRequestId);
    expect(correlated.length).toBeGreaterThanOrEqual(2);
    // Minimal references only: no bodies leak through activity payloads.
    expect(JSON.stringify(playerActivity.value)).not.toContain("plain text body");

    // Narrowing the grant hides every event for that source, immediately.
    const narrowed = await h.campaigns.replaceGrants(ctxFor(h.users.gm), {
      contentId: note.contentId,
      grantedUserIds: [],
      expectedContentRevision: regranted.value.revision,
      idempotencyKey: randomUUID(),
    });
    expect(narrowed.ok).toBe(true);
    const afterRemoval = await h.campaigns.listActivity(ctxFor(h.users.player), { campaignId });
    expect(afterRemoval.ok).toBe(true);
    if (!afterRemoval.ok) throw new Error("activity failed");
    expect(afterRemoval.value.events.map((event) => event.sourceContentId)).not.toContain(note.contentId);
  });

  it("reuses cursors safely after narrowing without leaking rows", async () => {
    const campaignId = await createCampaign();
    await seedMember(campaignId, h.users.player.actorId);

    const first = await createNote(campaignId, "gm", {
      audience: "selected_players",
      grantedUserIds: [h.users.player.actorId],
      title: "first",
    });
    await createNote(campaignId, "gm", { audience: "all_players", title: "second" });

    const pageOne = await h.campaigns.listContent(ctxFor(h.users.player), { campaignId, limit: 1 });
    expect(pageOne.ok).toBe(true);
    if (!pageOne.ok) throw new Error("list failed");
    expect(pageOne.value.content).toHaveLength(1);
    const cursor = pageOne.value.nextCursor;
    expect(cursor).not.toBeNull();

    // Narrow the selected note away, then continue with the old cursor.
    const live = await h.campaigns.openContent(ctxFor(h.users.gm), { contentId: first.contentId });
    expect(live.ok).toBe(true);
    if (!live.ok) throw new Error("gm lost the note");
    const narrowed = await h.campaigns.replaceGrants(ctxFor(h.users.gm), {
      contentId: first.contentId,
      grantedUserIds: [],
      expectedContentRevision: live.value.revision,
      idempotencyKey: randomUUID(),
    });
    expect(narrowed.ok).toBe(true);

    const pageTwo = await h.campaigns.listContent(ctxFor(h.users.player), { campaignId, limit: 1, cursor });
    expect(pageTwo.ok).toBe(true);
    if (!pageTwo.ok) throw new Error("continued list failed");
    expect(pageTwo.value.content.map((item) => item.contentId)).not.toContain(first.contentId);

    // Cursors never cross campaigns or actors.
    const foreignCampaign = await createCampaign();
    const crossCampaign = await h.campaigns.listContent(ctxFor(h.users.player), {
      campaignId: foreignCampaign,
      cursor,
    });
    expect(crossCampaign.ok).toBe(false);
    const crossActor = await h.campaigns.listContent(ctxFor(h.users.other), {
      campaignId,
      cursor,
    });
    expect(crossActor.ok).toBe(false);
  });

  it("replays idempotent writes and rejects mismatched keys", async () => {
    const campaignId = await createCampaign();
    await seedMember(campaignId, h.users.player.actorId);
    const key = randomUUID();

    const first = await createNote(campaignId, "gm", { key, title: "replay me" });
    const replayed = await createNote(campaignId, "gm", { key, title: "replay me" });
    expect(replayed.contentId).toBe(first.contentId);
    const rows = await h.pool.query(
      `SELECT COUNT(*)::int AS count FROM campaign_content_items WHERE campaign_id = $1`,
      [campaignId],
    );
    expect(rows.rows[0].count).toBe(1);

    const mismatch = await h.campaigns.createContent(ctxFor(h.users.gm), {
      campaignId,
      title: "different",
      idempotencyKey: key,
    });
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.error.code).toBe("idempotency_mismatch");

    const updateKey = randomUUID();
    const updated = await h.campaigns.updateContent(ctxFor(h.users.gm), {
      contentId: first.contentId,
      title: "v2",
      expectedContentRevision: first.revision,
      idempotencyKey: updateKey,
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) throw new Error("update failed");
    const updateReplay = await h.campaigns.updateContent(ctxFor(h.users.gm), {
      contentId: first.contentId,
      title: "v2",
      expectedContentRevision: first.revision,
      idempotencyKey: updateKey,
    });
    expect(updateReplay.ok).toBe(true);
    if (updateReplay.ok) expect(updateReplay.value.revision).toBe(updated.value.revision);
  });

  it("blocks content writes in archived campaigns but allows reads", async () => {
    const campaignId = await createCampaign();
    await seedMember(campaignId, h.users.player.actorId);
    const note = await createNote(campaignId, "gm", { audience: "all_players" });

    const archived = await h.campaigns.archive(ctxFor(h.users.gm), {
      campaignId,
      expectedCampaignRevision: await revision(campaignId),
      idempotencyKey: randomUUID(),
    });
    expect(archived.ok).toBe(true);

    const createBlocked = await h.campaigns.createContent(ctxFor(h.users.gm), {
      campaignId,
      title: "late",
      idempotencyKey: randomUUID(),
    });
    expect(createBlocked.ok).toBe(false);
    if (!createBlocked.ok) expect(createBlocked.error.code).toBe("conflict");

    const updateBlocked = await h.campaigns.updateContent(ctxFor(h.users.gm), {
      contentId: note.contentId,
      title: "late edit",
      expectedContentRevision: note.revision,
      idempotencyKey: randomUUID(),
    });
    expect(updateBlocked.ok).toBe(false);

    const grantsBlocked = await h.campaigns.replaceGrants(ctxFor(h.users.gm), {
      contentId: note.contentId,
      grantedUserIds: [h.users.player.actorId],
      expectedContentRevision: note.revision,
      idempotencyKey: randomUUID(),
    });
    expect(grantsBlocked.ok).toBe(false);

    // Reads stay available while archived.
    expect(
      (await h.campaigns.openContent(ctxFor(h.users.player), { contentId: note.contentId })).ok,
    ).toBe(true);
    expect((await h.campaigns.listContent(ctxFor(h.users.player), { campaignId })).ok).toBe(true);
    expect((await h.campaigns.listActivity(ctxFor(h.users.player), { campaignId })).ok).toBe(true);
  });

  it("collapses unknown and foreign content IDs to not_found", async () => {
    const campaignId = await createCampaign();
    const foreignId = await createCampaign();
    await seedMember(campaignId, h.users.player.actorId);
    const foreign = await createNote(foreignId, "gm", { audience: "all_players" });

    const missing = randomUUID();
    expect((await h.campaigns.openContent(ctxFor(h.users.gm), { contentId: missing })).ok).toBe(false);
    const foreignRead = await h.campaigns.openContent(ctxFor(h.users.player), {
      contentId: foreign.contentId,
    });
    expect(foreignRead.ok).toBe(false);
    if (!foreignRead.ok) expect(foreignRead.error.code).toBe("not_found");

    const foreignPatch = await h.campaigns.updateContent(ctxFor(h.users.player), {
      contentId: foreign.contentId,
      title: "cross-campaign edit",
      expectedContentRevision: foreign.revision,
      idempotencyKey: randomUUID(),
    });
    expect(foreignPatch.ok).toBe(false);
    if (!foreignPatch.ok) expect(foreignPatch.error.code).toBe("not_found");

    const foreignGrants = await h.campaigns.replaceGrants(ctxFor(h.users.player), {
      contentId: foreign.contentId,
      grantedUserIds: [],
      expectedContentRevision: foreign.revision,
      idempotencyKey: randomUUID(),
    });
    expect(foreignGrants.ok).toBe(false);
    if (!foreignGrants.ok) expect(foreignGrants.error.code).toBe("not_found");
  });

  it("walks the revision and access-revision ladder", async () => {
    const campaignId = await createCampaign();
    const note = await createNote(campaignId, "gm", { audience: "all_players", title: "ladder" });
    expect([note.revision, note.accessRevision]).toEqual([1, 1]);

    const patched = await h.campaigns.updateContent(ctxFor(h.users.gm), {
      contentId: note.contentId,
      title: "ladder v2",
      expectedContentRevision: 1,
      idempotencyKey: randomUUID(),
    });
    expect(patched.ok).toBe(true);
    if (!patched.ok) throw new Error("patch failed");
    // A text-only patch bumps the content revision, not the access generation.
    expect([patched.value.revision, patched.value.accessRevision]).toEqual([2, 1]);

    const narrowed = await h.campaigns.updateContent(ctxFor(h.users.gm), {
      contentId: note.contentId,
      audience: "selected_players",
      expectedContentRevision: 2,
      idempotencyKey: randomUUID(),
    });
    expect(narrowed.ok).toBe(true);
    if (!narrowed.ok) throw new Error("narrow failed");
    expect([narrowed.value.revision, narrowed.value.accessRevision]).toEqual([3, 2]);

    const granted = await h.campaigns.replaceGrants(ctxFor(h.users.gm), {
      contentId: note.contentId,
      grantedUserIds: [],
      expectedContentRevision: 3,
      idempotencyKey: randomUUID(),
    });
    expect(granted.ok).toBe(true);
    if (!granted.ok) throw new Error("grants failed");
    expect([granted.value.revision, granted.value.accessRevision]).toEqual([4, 3]);

    const deleted = await h.campaigns.deleteContent(ctxFor(h.users.gm), {
      contentId: note.contentId,
      expectedContentRevision: 4,
      idempotencyKey: randomUUID(),
    });
    expect(deleted.ok).toBe(true);
    if (!deleted.ok) throw new Error("delete failed");
    expect([deleted.value.revision, deleted.value.accessRevision]).toEqual([5, 4]);

    const recovered = await h.campaigns.recoverContent(ctxFor(h.users.gm), {
      contentId: note.contentId,
      expectedContentRevision: 5,
      idempotencyKey: randomUUID(),
    });
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) throw new Error("recover failed");
    expect([recovered.value.revision, recovered.value.accessRevision]).toEqual([6, 5]);
  });
});
