import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildI6Harness, ctxFor, type I6Harness } from "./i6-app.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl === undefined ? describe.skip : describe;

describeWithDatabase("campaign aggregate (Task 2)", () => {
  let h: I6Harness;

  beforeAll(async () => {
    h = await buildI6Harness();
  });

  afterAll(async () => {
    await h.close();
  });

  async function createCampaign(input?: {
    title?: string;
    description?: string;
    versionId?: string;
    key?: string;
    actor?: keyof I6Harness["users"];
  }) {
    const actor = input?.actor === undefined ? h.users.gm : h.users[input.actor];
    return h.campaigns.create(ctxFor(actor), {
      systemVersionId: input?.versionId ?? h.versionId,
      title: input?.title ?? `Campaign ${randomUUID()}`,
      description: input?.description ?? "",
      idempotencyKey: input?.key ?? randomUUID(),
    });
  }

  it("creates a campaign from a real accessible version with the creator as immutable active owner", async () => {
    const created = await createCampaign({ title: "The Long Watch" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value).toMatchObject({
      ownerId: h.users.gm.actorId,
      systemVersionId: h.versionId,
      title: "The Long Watch",
      status: "active",
      revision: 1,
      accessRevision: 1,
    });

    const members = await h.campaigns.listMembers(ctxFor(h.users.gm), {
      campaignId: created.value.campaignId,
    });
    expect(members.ok).toBe(true);
    if (!members.ok) return;
    expect(members.value.members).toEqual([
      expect.objectContaining({
        userId: h.users.gm.actorId,
        role: "owner",
        status: "active",
        generation: 1,
      }),
    ]);

    const demote = await h.campaigns.changeRole(ctxFor(h.users.gm), {
      campaignId: created.value.campaignId,
      userId: h.users.gm.actorId,
      role: "player",
      expectedCampaignRevision: 1,
      idempotencyKey: randomUUID(),
    });
    expect(demote.ok).toBe(false);
    if (demote.ok) return;
    expect(demote.error.code).toBe("bad_request");

    const remove = await h.campaigns.removeMember(ctxFor(h.users.gm), {
      campaignId: created.value.campaignId,
      userId: h.users.gm.actorId,
      expectedCampaignRevision: 1,
      idempotencyKey: randomUUID(),
    });
    expect(remove.ok).toBe(false);
    if (remove.ok) return;
    expect(remove.error.code).toBe("bad_request");
  });

  it("hides campaigns from outsiders and scopes lists to active memberships", async () => {
    const gmCampaign = await createCampaign();
    expect(gmCampaign.ok).toBe(true);
    if (!gmCampaign.ok) return;
    const otherCampaign = await createCampaign({ actor: "other", versionId: h.otherVersionId });
    expect(otherCampaign.ok).toBe(true);
    if (!otherCampaign.ok) return;

    const outsiderOpen = await h.campaigns.open(ctxFor(h.users.outsider), {
      campaignId: gmCampaign.value.campaignId,
    });
    expect(outsiderOpen).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "not_found" }),
    });

    const outsiderMembers = await h.campaigns.listMembers(ctxFor(h.users.outsider), {
      campaignId: gmCampaign.value.campaignId,
    });
    expect(outsiderMembers.ok).toBe(false);

    const gmList = await h.campaigns.list(ctxFor(h.users.gm), {});
    expect(gmList.ok).toBe(true);
    if (!gmList.ok) return;
    const gmIds = gmList.value.campaigns.map((campaign) => campaign.campaignId);
    expect(gmIds).toContain(gmCampaign.value.campaignId);
    expect(gmIds).not.toContain(otherCampaign.value.campaignId);

    const outsiderList = await h.campaigns.list(ctxFor(h.users.outsider), {});
    expect(outsiderList).toEqual({ ok: true, value: { campaigns: [], nextCursor: null } });
  });

  it("rejects unknown, draft-adjacent and inaccessible versions without leaking", async () => {
    const unknown = await createCampaign({ versionId: randomUUID() });
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    expect(unknown.error.code).toBe("not_found");

    // A draft-lifecycle version of an otherwise accessible system is rejected:
    // only published versions satisfy the accessible-version predicate.
    const draftVersionId = randomUUID();
    await h.pool.query(
      `INSERT INTO system_versions (id, system_id, semantic_version, checksum, package_json, release_notes, lifecycle)
       VALUES ($1, $2, '9.9.9', $3, '{}'::jsonb, '', 'draft')`,
      [draftVersionId, h.systemId, `draft-${randomUUID()}`],
    );
    const draft = await createCampaign({ versionId: draftVersionId });
    expect(draft.ok).toBe(false);
    if (draft.ok) return;
    expect(draft.error.code).toBe("not_found");

    // other's private published version is not accessible to gm.
    const foreign = await createCampaign({ versionId: h.otherVersionId });
    expect(foreign.ok).toBe(false);
    if (foreign.ok) return;
    expect(foreign.error.code).toBe("not_found");
  });

  it("replays create on the same key and rejects changed input", async () => {
    const key = randomUUID();
    const first = await createCampaign({ title: "Replayed", key });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const replay = await createCampaign({ title: "Replayed", key });
    expect(replay).toEqual(first);

    // The replay committed no spurious second row: exactly one campaign row
    // and one receipt row exist for the key.
    const rows = await h.pool.query("SELECT id FROM campaigns WHERE title = 'Replayed'");
    expect(rows.rows).toHaveLength(1);
    const receipts = await h.pool.query(
      `SELECT COUNT(*)::int AS count
          FROM campaign_command_executions
         WHERE actor_id = $1 AND command_kind = 'campaign_create' AND idempotency_key = $2`,
      [h.users.gm.actorId, key],
    );
    expect(receipts.rows[0].count).toBe(1);

    const mismatch = await h.campaigns.create(ctxFor(h.users.gm), {
      systemVersionId: h.versionId,
      title: "Changed",
      description: "",
      idempotencyKey: key,
    });
    expect(mismatch.ok).toBe(false);
    if (mismatch.ok) return;
    expect(mismatch.error.code).toBe("idempotency_mismatch");
  });

  it("replays update on the same key without double-applying", async () => {
    const created = await createCampaign();
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const campaignId = created.value.campaignId;

    const key = randomUUID();
    const first = await h.campaigns.update(ctxFor(h.users.gm), {
      campaignId,
      title: "Applied once",
      expectedCampaignRevision: 1,
      idempotencyKey: key,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.revision).toBe(2);

    const replay = await h.campaigns.update(ctxFor(h.users.gm), {
      campaignId,
      title: "Applied once",
      expectedCampaignRevision: 1,
      idempotencyKey: key,
    });
    expect(replay).toEqual(first);

    // No second application: revision still 2 and a single audit record.
    const opened = await h.campaigns.open(ctxFor(h.users.gm), { campaignId });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.value.revision).toBe(2);
    const audits = await h.pool.query(
      `SELECT COUNT(*)::int AS count
          FROM campaign_audit_records
         WHERE campaign_id = $1 AND kind = 'campaign_updated'`,
      [campaignId],
    );
    expect(audits.rows[0].count).toBe(1);
  });

  it("collapses management-role failures to not_found and keeps definite caller errors as bad_request", async () => {
    const created = await createCampaign();
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const campaignId = created.value.campaignId;

    // Seed active non-owner members directly: invitations arrive in Task 6.
    await h.pool.query(
      `INSERT INTO campaign_members (campaign_id, user_id, role)
       VALUES ($1, $2, 'player'), ($1, $3, 'player')`,
      [campaignId, h.users.player.actorId, h.users.other.actorId],
    );

    // Active player managing roles is a management-role failure: not_found.
    const playerChange = await h.campaigns.changeRole(ctxFor(h.users.player), {
      campaignId,
      userId: h.users.player.actorId,
      role: "player",
      expectedCampaignRevision: 1,
      idempotencyKey: randomUUID(),
    });
    expect(playerChange).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "not_found" }),
    });

    // A player removing another active member is a definite caller error.
    const playerRemovesOther = await h.campaigns.removeMember(ctxFor(h.users.player), {
      campaignId,
      userId: h.users.other.actorId,
      expectedCampaignRevision: 1,
      idempotencyKey: randomUUID(),
    });
    expect(playerRemovesOther.ok).toBe(false);
    if (playerRemovesOther.ok) return;
    expect(playerRemovesOther.error.code).toBe("bad_request");

    // Owner promotes both to co_gm (revisions 1 -> 2 -> 3).
    const promotePlayer = await h.campaigns.changeRole(ctxFor(h.users.gm), {
      campaignId,
      userId: h.users.player.actorId,
      role: "co_gm",
      expectedCampaignRevision: 1,
      idempotencyKey: randomUUID(),
    });
    expect(promotePlayer.ok).toBe(true);
    const promoteOther = await h.campaigns.changeRole(ctxFor(h.users.gm), {
      campaignId,
      userId: h.users.other.actorId,
      role: "co_gm",
      expectedCampaignRevision: 2,
      idempotencyKey: randomUUID(),
    });
    expect(promoteOther.ok).toBe(true);

    // A co_gm managing a peer co_gm collapses to not_found (both operations).
    const peerDemote = await h.campaigns.changeRole(ctxFor(h.users.player), {
      campaignId,
      userId: h.users.other.actorId,
      role: "player",
      expectedCampaignRevision: 3,
      idempotencyKey: randomUUID(),
    });
    expect(peerDemote).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "not_found" }),
    });
    const peerRemove = await h.campaigns.removeMember(ctxFor(h.users.player), {
      campaignId,
      userId: h.users.other.actorId,
      expectedCampaignRevision: 3,
      idempotencyKey: randomUUID(),
    });
    expect(peerRemove).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "not_found" }),
    });

    // Touching the owner stays a definite caller error (bad_request).
    const touchOwner = await h.campaigns.changeRole(ctxFor(h.users.player), {
      campaignId,
      userId: h.users.gm.actorId,
      role: "player",
      expectedCampaignRevision: 3,
      idempotencyKey: randomUUID(),
    });
    expect(touchOwner.ok).toBe(false);
    if (touchOwner.ok) return;
    expect(touchOwner.error.code).toBe("bad_request");

    // Denied paths mutated nothing: revision still 3, other still co_gm.
    const opened = await h.campaigns.open(ctxFor(h.users.gm), { campaignId });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.value.revision).toBe(3);
    const roster = await h.campaigns.listMembers(ctxFor(h.users.gm), { campaignId });
    expect(roster.ok).toBe(true);
    if (!roster.ok) return;
    expect(
      roster.value.members.find((member) => member.userId === h.users.other.actorId),
    ).toMatchObject({ role: "co_gm", status: "active" });
  });

  it("updates metadata with revision checks and rejects oversize input before transactions", async () => {
    const created = await createCampaign();
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const campaignId = created.value.campaignId;

    const oversize = await h.campaigns.update(ctxFor(h.users.gm), {
      campaignId,
      title: "x".repeat(201),
      expectedCampaignRevision: 1,
      idempotencyKey: randomUUID(),
    });
    expect(oversize.ok).toBe(false);

    const stale = await h.campaigns.update(ctxFor(h.users.gm), {
      campaignId,
      title: "Stale",
      expectedCampaignRevision: 999,
      idempotencyKey: randomUUID(),
    });
    expect(stale).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "conflict", latestRevision: 1 }),
    });

    const updated = await h.campaigns.update(ctxFor(h.users.gm), {
      campaignId,
      title: "Renamed",
      description: "A longer tale.",
      expectedCampaignRevision: 1,
      idempotencyKey: randomUUID(),
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.value).toMatchObject({ title: "Renamed", revision: 2, accessRevision: 1 });
  });

  it("archives prevent mutations while allowing reads, recovery and departure", async () => {
    const created = await createCampaign();
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const campaignId = created.value.campaignId;

    const archived = await h.campaigns.archive(ctxFor(h.users.gm), {
      campaignId,
      expectedCampaignRevision: 1,
      idempotencyKey: randomUUID(),
    });
    expect(archived.ok).toBe(true);
    if (!archived.ok) return;
    expect(archived.value).toMatchObject({ status: "archived", revision: 2, accessRevision: 2 });

    const mutate = await h.campaigns.update(ctxFor(h.users.gm), {
      campaignId,
      title: "Blocked",
      expectedCampaignRevision: 2,
      idempotencyKey: randomUUID(),
    });
    expect(mutate).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "conflict", latestRevision: 2 }),
    });

    const roleChange = await h.campaigns.changeRole(ctxFor(h.users.gm), {
      campaignId,
      userId: h.users.gm.actorId,
      role: "player",
      expectedCampaignRevision: 2,
      idempotencyKey: randomUUID(),
    });
    expect(roleChange.ok).toBe(false);
    if (roleChange.ok) return;
    expect(roleChange.error.code).toBe("conflict");

    const read = await h.campaigns.open(ctxFor(h.users.gm), { campaignId });
    expect(read.ok).toBe(true);

    const roster = await h.campaigns.listMembers(ctxFor(h.users.gm), { campaignId });
    expect(roster.ok).toBe(true);

    // Departure is not gated by the archive check: the owner-immutable rule
    // fires instead of an archived conflict.
    const depart = await h.campaigns.removeMember(ctxFor(h.users.gm), {
      campaignId,
      userId: h.users.gm.actorId,
      expectedCampaignRevision: 2,
      idempotencyKey: randomUUID(),
    });
    expect(depart.ok).toBe(false);
    if (depart.ok) return;
    expect(depart.error.code).toBe("bad_request");

    const recovered = await h.campaigns.recover(ctxFor(h.users.gm), {
      campaignId,
      expectedCampaignRevision: 2,
      idempotencyKey: randomUUID(),
    });
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;
    expect(recovered.value).toMatchObject({ status: "active", revision: 3, accessRevision: 3 });
  });

  it("returns not_found for missing campaigns", async () => {
    const missing = randomUUID();
    const opened = await h.campaigns.open(ctxFor(h.users.gm), { campaignId: missing });
    expect(opened).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "not_found" }),
    });
    const archived = await h.campaigns.archive(ctxFor(h.users.gm), {
      campaignId: missing,
      expectedCampaignRevision: 1,
      idempotencyKey: randomUUID(),
    });
    expect(archived.ok).toBe(false);
    if (archived.ok) return;
    expect(archived.error.code).toBe("not_found");
  });

  it("rejects malformed pagination input", async () => {
    const badLimit = await h.campaigns.list(ctxFor(h.users.gm), { limit: 101 });
    expect(badLimit.ok).toBe(false);
    const badCursor = await h.campaigns.list(ctxFor(h.users.gm), { cursor: "not-a-cursor" });
    expect(badCursor.ok).toBe(false);
  });

  it("campaign roles never authorize system draft read/write", async () => {
    const foreignDraft = await h.app.inject({
      method: "GET",
      url: `/systems/${h.systemId}`,
      headers: { cookie: h.users.other.cookie },
    });
    expect(foreignDraft.statusCode).toBe(404);

    const reverseDraft = await h.app.inject({
      method: "GET",
      url: `/systems/${h.otherSystemId}`,
      headers: { cookie: h.users.gm.cookie },
    });
    expect(reverseDraft.statusCode).toBe(404);
  });
});
