import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { makePushApp } from "./push-fixture.js";
const handles: Awaited<ReturnType<typeof makePushApp>>[] = [];
afterEach(async () => {
  for (const h of handles.splice(0)) await h.cleanup();
});
const dbDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;
dbDescribe("saved-pool push commands", () => {
  it("uses original values after edits, replays exactly, consumes only leaves and enforces the chain maximum", async () => {
    const h = await makePushApp();
    handles.push(h);
    const root = h.root;
    expect(root.push.attempt).toBe(0);
    const edit = await h.app.inject({
      method: "POST",
      url: `/characters/${h.id}/fields/attribute/set`,
      headers: h.headers,
      payload: { value: 5, expectedRevision: 1, idempotencyKey: randomUUID() },
    });
    expect(edit.statusCode, edit.body).toBe(200);
    const options = await h.app.inject({
      method: "GET",
      url: `/characters/${h.id}/rolls/${root.push.rollId}/push-options`,
      headers: h.headers,
    });
    expect(options.statusCode, options.body).toBe(200);
    expect(options.json().options).toMatchObject({
      canPush: true,
      revision: 2,
      nextAttempt: 1,
    });
    const key = randomUUID(),
      child = await h.push(root.push.rollId, 2, key);
    expect(child.statusCode, child.body).toBe(200);
    const roll = child.json().result.roll;
    expect(
      roll.breakdown.groups.map((g: { count: number }) => g.count),
    ).toEqual(root.breakdown.groups.map((g: { count: number }) => g.count));
    expect(roll.bindings).toEqual(root.bindings);
    const replay = await h.push(root.push.rollId, 2, key);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json().result.roll).toEqual(roll);
    expect((await h.push(root.push.rollId, 1, key)).json().error.code).toBe(
      "idempotency_mismatch",
    );
    expect((await h.push(root.push.rollId, 2)).statusCode).toBe(409);
    const next = await h.push(roll.push.rollId, 2);
    expect(next.statusCode, next.body).toBe(200);
    expect(next.json().result.roll.push.attempt).toBe(2);
    const exhausted = await h.push(next.json().result.roll.push.rollId, 2);
    expect(exhausted.statusCode, exhausted.body).toBe(422);
    expect(exhausted.json().error.pushReason).toBe("exhausted");
    const history = await h.app.inject({
      method: "GET",
      url: `/characters/${h.id}/activity`,
      headers: h.headers,
    });
    expect(
      history
        .json()
        .events.filter((e: { roll?: { push: unknown } }) => e.roll?.push),
    ).toHaveLength(3);
    expect(history.body).not.toContain("pushContext");
    expect(history.body).not.toContain("push_context");
    await expect(
      h.pool.query("UPDATE character_rolls SET total=99 WHERE id=$1", [
        root.push.rollId,
      ]),
    ).rejects.toThrow(/immutable/);
  });
  it("requires the current original granted source, and permits its exact restoration", async () => {
    const h = await makePushApp("item");
    handles.push(h);
    const removed = await h.app.inject({
      method: "DELETE",
      url: `/characters/${h.id}/entries/${h.entryId}`,
      headers: h.headers,
      payload: { expectedRevision: 2, idempotencyKey: randomUUID() },
    });
    expect(removed.statusCode, removed.body).toBe(200);
    const denied = await h.push(h.root.push.rollId, 3);
    expect(denied.statusCode, denied.body).toBe(422);
    expect(denied.json().error.pushReason).toBe("source_unavailable");
    const restored = await h.app.inject({
      method: "POST",
      url: `/characters/${h.id}/entries`,
      headers: h.headers,
      payload: {
        entry: {
          entryId: h.entryId,
          slotId: "gear_slot",
          templateId: "tool",
          values: {},
          quantity: 1,
        },
        expectedRevision: 3,
        idempotencyKey: randomUUID(),
      },
    });
    expect(restored.statusCode, restored.body).toBe(200);
    const pushed = await h.push(h.root.push.rollId, 4);
    expect(pushed.statusCode, pushed.body).toBe(200);
    expect(pushed.json().result.roll.push.attempt).toBe(1);
  });
  it.each(["roll", "activity", "audit", "receipt"] as const)(
    "rolls back every effect when %s write fails, then safely reclaims the same execution",
    async (stage) => {
      const h = await makePushApp();
      handles.push(h);
      const table = {
        roll: "character_rolls",
        activity: "character_activity_events",
        audit: "character_audit_records",
        receipt: "character_command_executions",
      }[stage];
      await h.pool.query(
        `CREATE FUNCTION reject_push_probe() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected push write failure'; END; $$`,
      );
      await h.pool.query(
        `CREATE TRIGGER reject_push_probe BEFORE ${stage === "receipt" ? "UPDATE" : "INSERT"} ON ${table} FOR EACH ROW EXECUTE FUNCTION reject_push_probe()`,
      );
      const key = randomUUID(),
        failure = await h.push(h.root.push.rollId, 1, key);
      expect(failure.statusCode, failure.body).toBe(500);
      expect(
        (
          await h.pool.query(
            "SELECT count(*)::int AS n FROM character_rolls WHERE parent_roll_id=$1",
            [h.root.push.rollId],
          )
        ).rows[0].n,
      ).toBe(0);
      expect(
        (
          await h.pool.query(
            "SELECT count(*)::int AS n FROM character_activity_events WHERE character_id=$1 AND kind='character_roll_pushed'",
            [h.id],
          )
        ).rows[0].n,
      ).toBe(0);
      expect(
        (
          await h.pool.query(
            "SELECT count(*)::int AS n FROM character_audit_records WHERE character_id=$1 AND kind='character_roll_pushed'",
            [h.id],
          )
        ).rows[0].n,
      ).toBe(0);
      await h.pool.query(`DROP TRIGGER reject_push_probe ON ${table}`);
      const before = await h.pool.query(
        "UPDATE character_command_executions SET lease_expires_at=now()-interval '1 second' WHERE idempotency_key=$1 RETURNING execution_id",
        [key],
      );
      const retried = await h.push(h.root.push.rollId, 1, key);
      expect(retried.statusCode, retried.body).toBe(200);
      expect(retried.json().result.roll.push.rollId).toBe(
        before.rows[0].execution_id,
      );
    },
  );
  it("rejects all client-owned outcomes, policies and lineage", async () => {
    const h = await makePushApp();
    handles.push(h);
    for (const field of [
      "seed",
      "dice",
      "total",
      "bindings",
      "inputs",
      "actionId",
      "pushPolicy",
      "attempt",
      "eligibleDiceIds",
      "push",
      "audience",
      "output",
      "pushContext",
    ]) {
      const r = await h.push(h.root.push.rollId, 1, randomUUID(), {
        [field]: [],
      });
      expect(r.statusCode, field + " " + r.body).toBe(400);
    }
    expect(
      (
        await h.pool.query(
          "SELECT count(*)::int AS n FROM character_rolls WHERE parent_roll_id=$1",
          [h.root.push.rollId],
        )
      ).rows[0].n,
    ).toBe(0);
  });
});
