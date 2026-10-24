import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Pool, PoolClient } from "pg";
import { canReadRoll } from "../campaigns/policy.js";
import type { MembershipRecord } from "../campaigns/persistence.js";
import {
  DieResultSchema,
  PushResultSchema,
  RollBreakdownSchema,
} from "../systems/implementation/rules/result.js";
import {
  PushContextSchema,
  type PushContext,
} from "../systems/implementation/runtime/push-context.js";
import { ScalarValueSchema } from "../systems/implementation/package/schema/common.js";
import type {
  NormalizedRoll,
  NormalizedRollAudience,
} from "../systems/runtime.js";
import type { ApplyCommandInput, CharacterRecord } from "./persistence.js";
import type { CharacterError } from "./index.js";
const SavedResultSchema = Type.Object({
  dice: Type.Array(DieResultSchema, { maxItems: 100 }),
  breakdown: RollBreakdownSchema,
  bindings: Type.Array(
    Type.Object(
      {
        scope: Type.Union([Type.Literal("fields"), Type.Literal("inputs")]),
        definitionId: Type.String({ maxLength: 64 }),
        value: ScalarValueSchema,
      },
      { additionalProperties: false },
    ),
    { maxItems: 256 },
  ),
  total: Type.Number(),
});
export type StoredPushRoll = {
  roll: NormalizedRoll;
  context: PushContext;
  actorId: string;
  principalId: string;
  scopeCampaignId: string | null;
};
export async function readPushRoll(
  db: Pick<Pool, "query">,
  characterId: string,
  rollId: string,
): Promise<StoredPushRoll | null> {
  const { rows } = await db.query(
    `SELECT id,actor_id,action_id,expression,dice_json,bindings_json,breakdown_json,total,rendered_output,audience,scope_campaign_id,parent_roll_id,root_roll_id,push_attempt,push_context_json,push_result_json,audience_actor_id FROM character_rolls WHERE character_id=$1 AND id=$2`,
    [characterId, rollId],
  );
  const r = rows[0];
  if (!r || r.push_result_json === null) return null;
  if (
    !Value.Check(PushContextSchema, r.push_context_json) ||
    !r.push_context_json.scope ||
    !Value.Check(PushResultSchema, r.push_result_json) ||
    !Value.Check(SavedResultSchema, {
      dice: r.dice_json,
      breakdown: r.breakdown_json,
      bindings: r.bindings_json,
      total: r.total,
    }) ||
    !r.audience_actor_id ||
    r.push_result_json.rollId !== r.id ||
    r.push_result_json.rootRollId !== r.root_roll_id ||
    r.push_result_json.parentRollId !== r.parent_roll_id ||
    r.push_result_json.attempt !== r.push_attempt ||
    r.push_result_json.maxAttempts !== r.push_context_json.policy.maxAttempts ||
    !["owner_only", "gm_only", "campaign"].includes(r.audience)
  )
    throw Error("Corrupt saved push result");
  return {
    context: r.push_context_json,
    actorId: r.actor_id,
    principalId: r.audience_actor_id,
    scopeCampaignId: r.scope_campaign_id,
    roll: {
      actionId: r.action_id,
      expression: r.expression,
      dice: r.dice_json,
      bindings: r.bindings_json,
      breakdown: r.breakdown_json,
      total: r.total,
      output: r.rendered_output,
      audience: r.audience,
      push: r.push_result_json,
    },
  };
}
export function samePushScope(
  context: PushContext,
  record: CharacterRecord,
): boolean {
  return Value.Equal(context.scope, {
    ownerId: record.ownerId,
    campaignId: record.campaignId,
    placementGeneration: record.placementGeneration,
  });
}
export function mayReadPush(
  parent: StoredPushRoll,
  actorId: string,
  record: CharacterRecord,
  membership: MembershipRecord | null,
): boolean {
  if (
    !samePushScope(parent.context, record) ||
    parent.scopeCampaignId !== record.campaignId
  )
    return false;
  return record.campaignId === null
    ? record.ownerId === actorId
    : canReadRoll({
        roll: {
          campaignId: record.campaignId,
          actorId: parent.principalId,
          audience: parent.roll.audience,
        },
        membership,
      });
}
export function narrowerAudience(
  a: NormalizedRollAudience,
  b: NormalizedRollAudience,
): NormalizedRollAudience {
  const rank = { owner_only: 0, gm_only: 1, campaign: 2 };
  return rank[a] <= rank[b] ? a : b;
}
export type PushCommit = {
  context: PushContext;
  principalId: string;
  audience: NormalizedRollAudience;
};
export async function preparePushCommit(
  client: PoolClient,
  input: ApplyCommandInput,
  record: CharacterRecord,
  defaultAudience: NormalizedRollAudience,
  membership: MembershipRecord | null,
): Promise<
  { ok: true; value: PushCommit | null } | { ok: false; error: CharacterError }
> {
  const meta = input.roll?.push;
  if (!meta) return { ok: true, value: null };
  const fail = (
    code: CharacterError["code"],
    message: string,
    pushReason?: string,
  ) => ({
    ok: false as const,
    error: {
      code,
      message,
      ...(pushReason ? { pushReason } : {}),
      ...(code === "conflict" ? { latestRevision: record.revision } : {}),
    },
  });
  const context = input.pushContext;
  if (
    !context ||
    !input.roll ||
    meta.rollId !== input.executionId ||
    context.versionId !== record.systemVersionId ||
    context.entityId !== record.entityDefinitionId
  )
    return fail(
      "invalid_value",
      "Invalid saved pool context.",
      "invalid_snapshot",
    );
  if (meta.parentRollId === null) {
    if (meta.attempt !== 0 || meta.rootRollId !== meta.rollId)
      return fail(
        "invalid_value",
        "Invalid root identity.",
        "invalid_snapshot",
      );
    return {
      ok: true,
      value: {
        context: {
          ...context,
          scope: {
            ownerId: record.ownerId,
            campaignId: record.campaignId,
            placementGeneration: record.placementGeneration,
          },
        },
        principalId: input.actorId,
        audience: defaultAudience,
      },
    };
  }
  // Character lock is already held. Root precedes parent consistently.
  await client.query(
    "SELECT id FROM character_rolls WHERE character_id=$1 AND id=$2 FOR UPDATE",
    [record.characterId, meta.rootRollId],
  );
  if (meta.parentRollId !== meta.rootRollId)
    await client.query(
      "SELECT id FROM character_rolls WHERE character_id=$1 AND id=$2 FOR UPDATE",
      [record.characterId, meta.parentRollId],
    );
  const parent = await readPushRoll(
    client,
    record.characterId,
    meta.parentRollId,
  );
  if (!parent || !mayReadPush(parent, input.actorId, record, membership))
    return fail("not_found", "The roll does not exist.");
  if (
    !Value.Equal(parent.context, context) ||
    meta.rootRollId !== parent.roll.push!.rootRollId ||
    meta.attempt !== parent.roll.push!.attempt + 1 ||
    meta.attempt > context.policy.maxAttempts
  )
    return fail("invalid_value", "Invalid push lineage.", "invalid_snapshot");
  const children = await client.query(
    "SELECT id FROM character_rolls WHERE parent_roll_id=$1 LIMIT 1",
    [meta.parentRollId],
  );
  if (children.rows.length)
    return fail(
      "conflict",
      "This roll already has a push. Review its child before continuing.",
      "parent_consumed",
    );
  const audience = narrowerAudience(parent.roll.audience, defaultAudience);
  // Parent visibility does not imply visibility of a child narrowed by the
  // current campaign default. Never disclose an unreadable child in its receipt.
  if (record.campaignId !== null && !canReadRoll({
    roll: { campaignId: record.campaignId, actorId: parent.principalId, audience },
    membership,
  })) return fail("not_found", "The roll does not exist.");
  return {
    ok: true,
    value: {
      context,
      principalId: parent.principalId,
      audience,
    },
  };
}
export async function insertPushRoll(
  client: PoolClient,
  input: ApplyCommandInput,
  commit: PushCommit,
): Promise<string> {
  const r = input.roll!,
    p = r.push!;
  await client.query(
    `INSERT INTO character_rolls (id,character_id,actor_id,action_id,execution_id,expression,dice_json,bindings_json,total,rendered_output,audience,request_id,scope_campaign_id,breakdown_json,parent_roll_id,root_roll_id,push_attempt,push_context_json,push_result_json,audience_actor_id) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,$17,$18::jsonb,$19::jsonb,$20)`,
    [
      p.rollId,
      input.characterId,
      input.actorId,
      r.actionId,
      input.executionId,
      r.expression,
      JSON.stringify(r.dice),
      JSON.stringify(r.bindings),
      r.total,
      r.output,
      commit.audience,
      input.activity.requestId,
      input.campaign?.campaignId ?? null,
      JSON.stringify(r.breakdown),
      p.parentRollId,
      p.rootRollId,
      p.attempt,
      JSON.stringify(commit.context),
      JSON.stringify(p),
      commit.principalId,
    ],
  );
  await client.query(
    "INSERT INTO character_audit_records (character_id,actor_id,kind,summary,request_id) VALUES ($1,$2,$3,$4,$5)",
    [
      input.characterId,
      input.actorId,
      p.attempt === 0 ? "character_action_executed" : "character_roll_pushed",
      p.attempt === 0 ? "Push-capable roll recorded" : "Saved roll pushed",
      input.activity.requestId,
    ],
  );
  return p.rollId;
}
