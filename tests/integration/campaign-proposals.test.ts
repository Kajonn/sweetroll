import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildI6Harness, ctxFor, type I6Harness } from "./i6-app.js";
const describeDB = process.env.TEST_DATABASE_URL ? describe : describe.skip;
describeDB("private campaign template proposals", () => {
  let h: I6Harness;
  beforeAll(async () => {
    h = await buildI6Harness();
  });
  afterAll(async () => {
    await h?.close();
  });
  async function setup() {
    const c = await h.campaigns.create(ctxFor(h.users.gm), {
      systemVersionId: h.versionId,
      title: "Proposals",
      description: "",
      idempotencyKey: randomUUID(),
    });
    if (!c.ok) throw new Error(JSON.stringify(c.error));
    for (const [who, role] of [
      ["player", "player"],
      ["other", "player"],
    ] as const)
      await h.pool.query(
        "INSERT INTO campaign_members(campaign_id,user_id,role,status,generation) VALUES($1,$2,$3,'active',1)",
        [c.value.campaignId, h.users[who].actorId, role],
      );
    return c.value.campaignId;
  }
  function request(
    id: string,
    who: keyof I6Harness["users"],
    method: "GET" | "POST",
    suffix = "",
    payload?: unknown,
  ) {
    return h.app.inject({
      method,
      url: `/campaigns/${id}/item-proposals${suffix}`,
      headers: { cookie: h.users[who].cookie },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  }
  const body = (kind = "item") => ({
    kind,
    content: {
      name: "Private key",
      description: "Only reviewers",
      ...(kind === "item" ? { defaultQuantity: 2 } : {}),
    },
    expectedProposalRevision: 0,
    idempotencyKey: randomUUID(),
  });
  async function submit(id: string) {
    const b = body();
    const r = await request(id, "player", "POST", "", b);
    expect(r.statusCode, r.body).toBe(201);
    return { b, p: r.json().proposal };
  }
  it("submits all four data-only kinds, scopes discovery before pagination and denies private direct IDs", async () => {
    const id = await setup();
    for (const kind of ["item", "spell", "talent", "effect"]) {
      const b = body(kind);
      const r = await request(id, "player", "POST", "", b);
      expect(r.statusCode, r.body).toBe(201);
      const p = r.json().proposal;
      expect(p).toMatchObject({
        kind,
        status: "pending",
        revision: 1,
        content: b.content,
        decision: null,
        approvedTemplateId: null,
      });
      expect(p).not.toHaveProperty("eligibility");
      expect(p).not.toHaveProperty("generation");
      expect(
        (await request(id, "other", "GET", `/${p.proposalId}`)).statusCode,
      ).toBe(404);
      expect(
        (await request(id, "outsider", "GET", `/${p.proposalId}`)).statusCode,
      ).toBe(404);
    }
    expect((await request(id, "other", "GET")).json().proposals).toEqual([]);
    const first = await request(id, "player", "GET", "?limit=1");
    expect(first.json().proposals).toHaveLength(1);
    expect(first.json().nextCursor).toBeTruthy();
    expect(
      (
        await request(
          id,
          "gm",
          "GET",
          `?limit=1&cursor=${first.json().nextCursor}`,
        )
      ).statusCode,
    ).toBe(400);
    expect((await request(id, "gm", "GET")).json().proposals).toHaveLength(4);
    expect(
      (
        await h.pool.query(
          "SELECT * FROM campaign_activity_events WHERE campaign_id=$1",
          [id],
        )
      ).rows,
    ).toHaveLength(0);
  });
  it("rejects executable, server-owned, unknown and invalid content at HTTP and module boundaries", async () => {
    const id = await setup();
    for (const extra of [
      { base: { templateId: "x" } },
      { defaultValues: {} },
      { actions: [] },
      { snapshot: {} },
      { submitterId: h.users.other.actorId },
    ]) {
      const b = body();
      Object.assign(b.content, extra);
      expect((await request(id, "player", "POST", "", b)).statusCode).toBe(400);
    }
    for (const b of [
      { ...body(), submitterId: h.users.other.actorId },
      { ...body("spell"), content: { name: "Bad", defaultQuantity: 1 } },
      { ...body(), content: { name: " " } },
      { ...body(), content: { name: "a".repeat(201) } },
    ])
      expect((await request(id, "player", "POST", "", b)).statusCode).toBe(400);
    expect((await request(id, "gm", "POST", "", body())).statusCode).toBe(403);
    expect((await request(id, "outsider", "POST", "", body())).statusCode).toBe(
      404,
    );
  });
  it("replays exact submission and binds receipts and private reads to membership generation", async () => {
    const id = await setup();
    const { b, p } = await submit(id);
    expect(
      (await request(id, "player", "POST", "", b)).json().proposal,
    ).toEqual(p);
    expect(
      (
        await request(id, "player", "POST", "", {
          ...b,
          content: { name: "Changed" },
        })
      ).statusCode,
    ).toBe(409);
    await h.pool.query(
      "UPDATE campaign_members SET generation=generation+1 WHERE campaign_id=$1 AND user_id=$2",
      [id, h.users.player.actorId],
    );
    expect((await request(id, "player", "POST", "", b)).statusCode).toBe(404);
    expect(
      (await request(id, "player", "GET", `/${p.proposalId}`)).statusCode,
    ).toBe(404);
    expect((await request(id, "player", "GET")).json().proposals).toEqual([]);
    expect(
      (await request(id, "gm", "GET", `/${p.proposalId}`)).json().proposal
        .eligibility,
    ).toEqual({ canApprove: false, reason: "submitter_inactive" });
    const decision = {
      expectedProposalRevision: 1,
      idempotencyKey: randomUUID(),
    };
    expect(
      (await request(id, "gm", "POST", `/${p.proposalId}/approve`, decision))
        .statusCode,
    ).toBe(409);
    expect(
      (await request(id, "gm", "POST", `/${p.proposalId}/reject`, decision))
        .statusCode,
    ).toBe(200);
  });
  it("serializes competing decisions, publishes exactly one independent template and replays its original identity", async () => {
    const id = await setup();
    const { p } = await submit(id);
    await h.pool.query(
      "UPDATE campaign_members SET role='co_gm' WHERE campaign_id=$1 AND user_id=$2",
      [id, h.users.other.actorId],
    );
    const d = { expectedProposalRevision: 1, idempotencyKey: randomUUID() };
    const responses = await Promise.all([
      request(id, "gm", "POST", `/${p.proposalId}/approve`, d),
      request(id, "other", "POST", `/${p.proposalId}/approve`, {
        ...d,
        idempotencyKey: randomUUID(),
      }),
    ]);
    expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const winner = responses.findIndex((r) => r.statusCode === 200);
    const result = responses[winner]!.json();
    expect(result.template).toMatchObject({
      content: p.content,
      revision: 1,
      contentRevision: 1,
      audience: "all_players",
    });
    expect(result.proposal).toMatchObject({
      status: "approved",
      revision: 2,
      approvedTemplateId: result.template.templateId,
    });
    expect(
      (
        await h.pool.query(
          "SELECT * FROM campaign_item_templates WHERE campaign_id=$1",
          [id],
        )
      ).rows,
    ).toHaveLength(1);
    if (winner === 0) {
      await h.pool.query(
        "UPDATE campaign_item_templates SET status='archived',revision=revision+1 WHERE id=$1",
        [result.template.templateId],
      );
      expect(
        (await request(id, "gm", "POST", `/${p.proposalId}/approve`, d)).json()
          .template.templateId,
      ).toBe(result.template.templateId);
    }
    expect(
      (await request(id, "player", "POST", `/${p.proposalId}/reject`, d))
        .statusCode,
    ).toBe(403);
    const activity = (
      await h.pool.query(
        "SELECT * FROM campaign_activity_events WHERE campaign_id=$1",
        [id],
      )
    ).rows;
    expect(activity).toHaveLength(1);
    expect(JSON.stringify(activity)).not.toContain(p.proposalId);
  });
  it("rejects without publication, enforces archived writes and includes proposals only in GM exports", async () => {
    const id = await setup();
    const { p } = await submit(id);
    const d = {
      expectedProposalRevision: 1,
      idempotencyKey: randomUUID(),
      reason: "Private review",
    };
    const rejected = await request(
      id,
      "gm",
      "POST",
      `/${p.proposalId}/reject`,
      d,
    );
    expect(rejected.statusCode, rejected.body).toBe(200);
    expect(
      (await request(id, "gm", "POST", `/${p.proposalId}/reject`, d)).json()
        .proposal,
    ).toEqual(rejected.json().proposal);
    expect(
      (
        await h.pool.query(
          "SELECT * FROM campaign_item_templates WHERE campaign_id=$1",
          [id],
        )
      ).rows,
    ).toHaveLength(0);
    expect(
      (
        await h.pool.query(
          "SELECT * FROM campaign_activity_events WHERE campaign_id=$1",
          [id],
        )
      ).rows,
    ).toHaveLength(0);
    const e = await h.campaigns.exportCampaign(ctxFor(h.users.gm), {
      campaignId: id,
      idempotencyKey: randomUUID(),
    });
    expect(e).toMatchObject({
      ok: true,
      value: { proposals: [{ proposalId: p.proposalId, status: "rejected" }] },
    });
    expect(
      await h.campaigns.exportCampaign(ctxFor(h.users.player), {
        campaignId: id,
        idempotencyKey: randomUUID(),
      }),
    ).toMatchObject({ ok: false });
    await h.pool.query("UPDATE campaigns SET status='archived' WHERE id=$1", [
      id,
    ]);
    expect((await request(id, "player", "POST", "", body())).statusCode).toBe(
      409,
    );
    expect((await request(id, "player", "GET")).statusCode).toBe(200);
  });
  it("rolls back catalog, decision, activity, audit and receipts after injected late failures", async () => {
    const id = await setup();
    const { p } = await submit(id);
    const baseline = await h.pool.query(
      "SELECT count(*)::int n FROM campaign_audit_records WHERE campaign_id=$1",
      [id],
    );
    for (const table of [
      "campaign_item_template_revisions",
      "campaign_item_proposals",
      "campaign_activity_events",
      "campaign_audit_records",
      "campaign_command_executions",
    ]) {
      await h.pool.query(
        `CREATE FUNCTION fail_proposal_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END; $$`,
      );
      await h.pool.query(
        `CREATE TRIGGER fail_proposal_write BEFORE ${table === "campaign_item_proposals" ? "UPDATE" : "INSERT"} ON ${table} FOR EACH ROW EXECUTE FUNCTION fail_proposal_write()`,
      );
      const key = randomUUID();
      const r = await request(id, "gm", "POST", `/${p.proposalId}/approve`, {
        expectedProposalRevision: 1,
        idempotencyKey: key,
      });
      expect(r.statusCode, r.body).toBe(500);
      await h.pool.query(
        `DROP TRIGGER fail_proposal_write ON ${table}; DROP FUNCTION fail_proposal_write()`,
      );
      expect(
        (await request(id, "gm", "GET", `/${p.proposalId}`)).json().proposal,
      ).toMatchObject({
        status: "pending",
        revision: 1,
        approvedTemplateId: null,
      });
      for (const target of [
        "campaign_item_templates",
        "campaign_activity_events",
      ])
        expect(
          (
            await h.pool.query(
              `SELECT count(*)::int n FROM ${target} WHERE campaign_id=$1`,
              [id],
            )
          ).rows[0].n,
        ).toBe(0);
      expect(
        (
          await h.pool.query(
            "SELECT count(*)::int n FROM campaign_audit_records WHERE campaign_id=$1",
            [id],
          )
        ).rows,
      ).toEqual(baseline.rows);
      expect(
        (
          await h.pool.query(
            "SELECT count(*)::int n FROM campaign_command_executions WHERE idempotency_key=$1",
            [key],
          )
        ).rows[0].n,
      ).toBe(0);
    }
  });
  it("enforces both submission quotas and catalog capacity without consuming a successful decision", async () => {
    const id = await setup();
    const all = await Promise.all(
      Array.from({ length: 21 }, () =>
        request(id, "player", "POST", "", body()),
      ),
    );
    expect(all.filter((r) => r.statusCode === 201)).toHaveLength(20);
    expect(all.filter((r) => r.statusCode === 413)).toHaveLength(1);
    const p = all.find((r) => r.statusCode === 201)!.json().proposal;
    await h.pool.query(
      `WITH inserted AS (INSERT INTO campaign_item_templates(id,campaign_id,creator_id,kind) SELECT gen_random_uuid(),$1,$2,'item' FROM generate_series(1,500) RETURNING id) INSERT INTO campaign_item_template_revisions(template_id,content_revision,author_id,content_json) SELECT id,1,$2,'{"name":"Full"}'::jsonb FROM inserted`,
      [id, h.users.gm.actorId],
    );
    const d = { expectedProposalRevision: 1, idempotencyKey: randomUUID() };
    expect(
      (await request(id, "gm", "POST", `/${p.proposalId}/approve`, d))
        .statusCode,
    ).toBe(413);
    expect(
      (await request(id, "gm", "GET", `/${p.proposalId}`)).json().proposal,
    ).toMatchObject({
      status: "pending",
      eligibility: { canApprove: false, reason: "catalog_full" },
    });
    expect(
      (await request(id, "gm", "POST", `/${p.proposalId}/reject`, d))
        .statusCode,
    ).toBe(200);
    const totalId = await setup();
    await h.pool.query(
      `INSERT INTO campaign_item_proposals(id,campaign_id,submitter_id,membership_generation,kind,content_json) SELECT gen_random_uuid(),$1,$2,1,'item','{"name":"Bounded"}'::jsonb FROM generate_series(1,500)`,
      [totalId, h.users.player.actorId],
    );
    expect(
      (await request(totalId, "other", "POST", "", body())).statusCode,
    ).toBe(413);
  });
  it("denies decision receipt replay after demotion and GM export replay after removal", async () => {
    const id = await setup();
    const { p } = await submit(id);
    await h.pool.query(
      "UPDATE campaign_members SET role='co_gm' WHERE campaign_id=$1 AND user_id=$2",
      [id, h.users.other.actorId],
    );
    const d = { expectedProposalRevision: 1, idempotencyKey: randomUUID() };
    expect(
      (await request(id, "other", "POST", `/${p.proposalId}/approve`, d))
        .statusCode,
    ).toBe(200);
    const e = { campaignId: id, idempotencyKey: randomUUID() };
    expect(
      await h.campaigns.exportCampaign(ctxFor(h.users.other), e),
    ).toMatchObject({ ok: true });
    await h.pool.query(
      "UPDATE campaign_members SET role='player' WHERE campaign_id=$1 AND user_id=$2",
      [id, h.users.other.actorId],
    );
    expect(
      (await request(id, "other", "POST", `/${p.proposalId}/approve`, d))
        .statusCode,
    ).toBe(403);
    expect(
      (await request(id, "other", "GET", `/${p.proposalId}`)).statusCode,
    ).toBe(404);
    expect(
      await h.campaigns.exportCampaign(ctxFor(h.users.other), e),
    ).toMatchObject({ ok: false });
    await h.pool.query(
      "UPDATE campaign_members SET status='removed' WHERE campaign_id=$1 AND user_id=$2",
      [id, h.users.other.actorId],
    );
    expect(
      (await request(id, "other", "POST", `/${p.proposalId}/approve`, d))
        .statusCode,
    ).toBe(404);
  });
  it("keeps immutable submitted content, independent template edits and expired receipts from republishing", async () => {
    const id = await setup();
    const { p, b } = await submit(id);
    await expect(
      h.pool.query(
        "UPDATE campaign_item_proposals SET content_json=$2 WHERE id=$1",
        [p.proposalId, { name: "Tampered" }],
      ),
    ).rejects.toThrow(/immutable/);
    const d = { expectedProposalRevision: 1, idempotencyKey: randomUUID() };
    const r = await request(id, "gm", "POST", `/${p.proposalId}/approve`, d);
    expect(r.statusCode, r.body).toBe(200);
    const t = r.json().template;
    expect(
      await h.campaigns.updateTemplate(ctxFor(h.users.gm), {
        campaignId: id,
        templateId: t.templateId,
        expectedTemplateRevision: 1,
        idempotencyKey: randomUUID(),
        content: { name: "GM catalog edit" },
      }),
    ).toMatchObject({ ok: true });
    expect(
      (await request(id, "player", "GET", `/${p.proposalId}`)).json().proposal
        .content,
    ).toEqual(b.content);
    await h.pool.query(
      "UPDATE campaign_command_executions SET expires_at=now()-interval '1 day' WHERE idempotency_key=$1",
      [d.idempotencyKey],
    );
    expect(
      (await request(id, "gm", "POST", `/${p.proposalId}/approve`, d))
        .statusCode,
    ).toBe(409);
    expect(
      (
        await request(id, "gm", "POST", `/${p.proposalId}/approve`, {
          ...d,
          idempotencyKey: randomUUID(),
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await h.pool.query(
          "SELECT count(*)::int n FROM campaign_item_templates WHERE campaign_id=$1",
          [id],
        )
      ).rows[0].n,
    ).toBe(1);
  });
});
