import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type {
  CharacterActionCommand,
  CharacterPushCommand,
  CharacterResult,
  CharacterError,
  CharacterCommandResult,
  RequestContext,
  PushOptions,
} from "./index.js";
import type {
  CampaignRollContext,
  SystemRuntime,
  RuntimeIntent,
} from "../systems/runtime.js";
import type { MembershipRecord } from "../campaigns/policy.js";
import { hashInput } from "../systems/implementation/authoring/assess.js";
import {
  PhysicalDraws,
  settledValues,
  type PhysicalDie,
  type SettledDie,
} from "../systems/physical-dice/resolution.js";
import { findProjectedAction } from "../systems/implementation/runtime/roll-context.js";
import { mapRuntimeError } from "./runtime-errors.js";
import { mayReadPush, narrowerAudience, readPushRoll } from "./push.js";
import {
  loadCampaignRollContext,
  type CharacterRecord,
  type RollAudience,
} from "./persistence.js";

export type PhysicalCommand = CharacterActionCommand | CharacterPushCommand;
export type Settlement = { tick: number; dice: SettledDie[] };
type Scope = {
  record: CharacterRecord;
  member: MembershipRecord;
  active: boolean;
  defaultAudience: RollAudience;
};
type Attempt = {
  attemptId: string;
  expiresAt: string;
  dice: PhysicalDie[];
  audience: RollAudience;
};
type Preparation = {
  command: PhysicalCommand;
  dice: PhysicalDie[];
  audience: RollAudience;
  placement: number;
  generation: number;
  contextHash: string;
  defaultAudience: RollAudience;
};
type Row = {
  id: string;
  campaign_id: string;
  preparation: Preparation;
  expires_at: Date;
  input_hash: string;
};

export type PhysicalEvidence = {
  identity: string;
  draws: PhysicalDraws;
  checkCommit(
    client: PoolClient,
    executionId: string,
    context?: CampaignRollContext,
  ): Promise<CharacterError | null>;
};
export interface PhysicalRolls {
  prepare(
    ctx: RequestContext,
    command: PhysicalCommand,
  ): Promise<CharacterResult<Attempt | null>>;
  complete(
    ctx: RequestContext,
    characterId: string,
    attemptId: string,
    settlement: Settlement,
  ): Promise<CharacterResult<CharacterCommandResult>>;
}
type Dependencies = {
  pool: Pool;
  now: () => Date;
  runtime: SystemRuntime;
  scope(ctx: RequestContext, characterId: string): Promise<Scope | null>;
  pushOptions(
    ctx: RequestContext,
    input: { characterId: string; rollId: string },
  ): Promise<CharacterResult<PushOptions>>;
  apply(
    ctx: RequestContext,
    command: PhysicalCommand,
    evidence: PhysicalEvidence,
  ): Promise<CharacterResult<CharacterCommandResult>>;
};
const missing = (): CharacterError => ({
  code: "not_found",
  message: "Campaign roll not found.",
});
const conflict = (message: string): CharacterError => ({
  code: "conflict",
  message,
});
const invalid = (message: string): CharacterError => ({
  code: "bad_request",
  message,
});

export function createPhysicalRolls({
  pool,
  now,
  runtime,
  scope,
  pushOptions,
  apply,
}: Dependencies): PhysicalRolls {
  return {
    async prepare(ctx, command) {
      const current = await scope(ctx, command.characterId);
      if (!current) return { ok: false, error: missing() };
      const { record, member, defaultAudience } = current;
      if (!current.active || command.expectedRevision !== record.revision)
        return {
          ok: false,
          error: conflict("Refresh the campaign character before rolling."),
        };
      const attemptId = randomUUID();
      const draws = new PhysicalDraws();
      const rules = {
        versionId: record.systemVersionId,
        extensions: record.extensions,
        entityId: record.entityDefinitionId,
      };
      const evaluator = await runtime.prepareResolve(rules);
      if (!evaluator.ok)
        return { ok: false, error: mapRuntimeError(evaluator.error) };
      let audience = defaultAudience;
      let context: CampaignRollContext | undefined;
      let intent: RuntimeIntent;
      if (command.kind === "pushRoll") {
        const parent = await readPushRoll(
          pool,
          command.characterId,
          command.parentRollId,
        );
        if (!parent || !mayReadPush(parent, ctx.actorId, record, member))
          return { ok: false, error: missing() };
        const options = await pushOptions(ctx, {
          characterId: record.characterId,
          rollId: command.parentRollId,
        });
        if (!options.ok) return options;
        if (!options.value.canPush)
          return { ok: false, error: conflict("This roll cannot be pushed.") };
        audience = narrowerAudience(parent.roll.audience, defaultAudience);
        intent = {
          kind: "push",
          parent: parent.roll,
          context: parent.context,
          executionId: attemptId,
          physical: draws,
        };
      } else {
        if (
          !command.entryId &&
          evaluator.value.deckIdFor(command.actionId) !== null
        )
          return { ok: true, value: null };
        audience = command.audience ?? defaultAudience;
        if (command.targetCharacterId || command.respondsTo) {
          const observed = evaluator.value({
            state: record.state,
            intent: { kind: "observe" },
          });
          if (!observed.ok)
            return { ok: false, error: mapRuntimeError(observed.error) };
          const action = findProjectedAction(
            observed.value.projection,
            command.actionId,
            command.entryId,
          );
          if (
            action?.kind !== "action" ||
            Boolean(action.target) !== Boolean(command.targetCharacterId) ||
            Boolean(action.respondsTo) !== Boolean(command.respondsTo)
          )
            return {
              ok: false,
              error: invalid("Roll context does not match the action."),
            };
          const selected = await loadCampaignRollContext(pool, record, member, {
            ...(action.target && { targetEntityId: action.target.entityId }),
            ...(command.targetCharacterId && {
              targetCharacterId: command.targetCharacterId,
            }),
            ...(command.respondsTo && { respondsTo: command.respondsTo }),
          });
          if (!selected.ok) return selected;
          context = selected.context;
          if (selected.audience)
            audience = narrowerAudience(audience, selected.audience);
        }
        intent = {
          kind: "action",
          actionId: command.actionId,
          inputs: command.inputs,
          executionId: attemptId,
          physical: draws,
          ...(command.entryId && { entryId: command.entryId }),
          ...(context && { campaignRoll: context }),
        };
      }
      const preview = evaluator.value({ state: record.state, intent });
      if (!draws.supported) return { ok: true, value: null };
      if (!preview.ok)
        return { ok: false, error: mapRuntimeError(preview.error) };
      if (!preview.value.roll || !draws.complete)
        return { ok: true, value: null };
      const preparation: Preparation = {
        command,
        dice: draws.dice,
        audience,
        defaultAudience,
        placement: record.placementGeneration,
        generation: member.generation,
        contextHash: hashInput(context ?? null),
      };
      const hash = hashInput(command);
      await pool.query(
        `INSERT INTO physical_roll_attempts
         (id, actor_id, character_id, campaign_id, idempotency_key, input_hash, preparation, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (actor_id,idempotency_key) DO NOTHING`,
        [
          attemptId,
          ctx.actorId,
          record.characterId,
          member.campaignId,
          command.idempotencyKey,
          hash,
          preparation,
          new Date(now().getTime() + 60_000),
        ],
      );
      const {
        rows: [row],
      } = await pool.query<Row>(
        "SELECT * FROM physical_roll_attempts WHERE actor_id=$1 AND idempotency_key=$2",
        [ctx.actorId, command.idempotencyKey],
      );
      if (!row || row.input_hash !== hash)
        return {
          ok: false,
          error: {
            code: "idempotency_mismatch",
            message: "This key already identifies another roll.",
          },
        };
      const live = await scope(ctx, command.characterId);
      if (
        !live ||
        !live.active ||
        live.member.campaignId !== row.campaign_id ||
        live.member.generation !== row.preparation.generation ||
        live.record.placementGeneration !== row.preparation.placement
      )
        return { ok: false, error: missing() };
      if (
        row.expires_at <= now() ||
        live.defaultAudience !== defaultAudience ||
        live.record.revision !== command.expectedRevision ||
        hashInput(preparation) !== hashInput(row.preparation)
      )
        return {
          ok: false,
          error: conflict("The prepared roll expired or its source changed."),
        };
      return {
        ok: true,
        value: {
          attemptId: row.id,
          expiresAt: row.expires_at.toISOString(),
          dice: row.preparation.dice,
          audience,
        },
      };
    },
    async complete(ctx, characterId, attemptId, settlement) {
      const {
        rows: [row],
      } = await pool.query<Row>(
        "SELECT * FROM physical_roll_attempts WHERE id=$1 AND actor_id=$2 AND character_id=$3",
        [attemptId, ctx.actorId, characterId],
      );
      if (!row) return { ok: false, error: missing() };
      const proof = row.preparation;
      const live = await scope(ctx, characterId);
      if (
        !live ||
        live.member.campaignId !== row.campaign_id ||
        live.member.generation !== proof.generation ||
        live.record.placementGeneration !== proof.placement
      )
        return { ok: false, error: missing() };
      const values = settledValues(proof.dice, settlement.dice);
      if (
        !values ||
        !Number.isSafeInteger(settlement.tick) ||
        settlement.tick < 1 ||
        settlement.tick > 3600
      )
        return {
          ok: false,
          error: invalid("The settlement does not match the prepared roll."),
        };
      const draws = new PhysicalDraws(proof.dice, values);
      return apply(ctx, proof.command, {
        identity: hashInput({ attemptId, settlement }),
        draws,
        async checkCommit(client, executionId, context) {
          if (
            !draws.complete ||
            hashInput(context ?? null) !== proof.contextHash
          )
            return conflict("The roll inputs changed after preparation.");
          // The normal command transaction holds the campaign and character locks.
          const saved = await client.query(
            `UPDATE physical_roll_attempts a SET settled=$1, execution_id=$2
             FROM characters c, campaign_members m, campaigns g
             WHERE a.id=$3 AND a.execution_id IS NULL AND a.expires_at > $4 AND c.id=a.character_id
               AND c.campaign_id=a.campaign_id AND c.placement_generation=$5 AND m.campaign_id=a.campaign_id
               AND m.user_id=a.actor_id AND m.status='active' AND m.generation=$6 AND g.id=a.campaign_id
               AND ($7::boolean OR g.roll_audience_default=$8)`,
            [
              settlement,
              executionId,
              attemptId,
              now(),
              proof.placement,
              proof.generation,
              proof.command.kind === "executeAction" &&
                proof.command.audience !== undefined,
              proof.defaultAudience,
            ],
          );
          return saved.rowCount === 1
            ? null
            : conflict(
                "The prepared roll expired or its campaign scope changed.",
              );
        },
      });
    },
  };
}
