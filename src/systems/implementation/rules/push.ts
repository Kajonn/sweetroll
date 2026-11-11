import { Value } from "@sinclair/typebox/value";
import { matchesPoolModifiers } from "./push-policy.js";
import { evaluate } from "./evaluate.js";
import { PushPolicySchema } from "../package/schema/push-policy.js";
import type {
  CompiledExpressionV1,
  PushPolicy,
} from "../package/schema/index.js";
import type {
  EvaluationBindings,
  EvaluationLimits,
  Rng,
  RollResult,
} from "./evaluate.js";
type SavedPool = Omit<RollResult, "breakdown"> & { breakdown?: RollResult["breakdown"] };

export type PushEvaluationInput = {
  expression: CompiledExpressionV1;
  policy: PushPolicy;
  parent: SavedPool;
  bindings: EvaluationBindings;
  attempt: number;
  rng: Rng;
  limits: EvaluationLimits;
};
export type FaceOutcome = {
  groupId: string;
  face: number;
  combinedCount: number;
  rerolledCount: number;
};
export type PushEvaluationResult =
  | {
      ok: true;
      roll: RollResult;
      rerolledDiceIds: string[];
      faceOutcomes: FaceOutcome[];
    }
  | { ok: false; reason: string };
export function pushEligibility(
  policy: PushPolicy,
  parent: SavedPool,
  attempt: number,
): { canPush: boolean; reason: string | null; eligibleDiceIds: string[] } {
  const unavailable = (reason: string) => ({
    canPush: false,
    reason,
    eligibleDiceIds: [],
  });
  if (
    !Value.Check(PushPolicySchema, policy) ||
    !Number.isInteger(attempt) ||
    attempt < 0 ||
    !parent.breakdown ||
    parent.dice.length > 100
  )
    return unavailable("invalid_snapshot");
  if (attempt >= policy.maxAttempts) return unavailable("exhausted");
  if (!policy.allowOnSuccess && parent.total >= policy.successThreshold)
    return unavailable("successful_roll");
  const groups = new Map(policy.groups.map((g) => [g.groupId, g]));
  const snapshotGroups = new Map(parent.breakdown.groups.map((group) => [group.id, group]));
  const eligibleDiceIds = parent.dice
    .filter((die) => {
      if (!die.kept || !die.id || !die.groupId || die.explodedFrom) return false;
      const policyGroup = groups.get(die.groupId);
      const snapshot = snapshotGroups.get(die.groupId);
      return policyGroup !== undefined && snapshot !== undefined &&
        matchesPoolModifiers(policyGroup.modifiers, snapshot.modifiers) &&
        !policyGroup.lockedFaces.includes(die.value);
    })
    .map((die) => die.rerolledFrom ?? die.id!);
  return eligibleDiceIds.length
    ? { canPush: true, reason: null, eligibleDiceIds }
    : unavailable("no_eligible_dice");
}
export function evaluatePush(input: PushEvaluationInput): PushEvaluationResult {
  const { parent, policy, expression, bindings, attempt, limits } = input;
  const options = pushEligibility(policy, parent, attempt);
  if (!options.canPush) return { ok: false, reason: options.reason! };
  try {
    let index = 0;
    const original = evaluate(
      expression,
      bindings,
      () => {
        const d = parent.dice[index++];
        if (!d) throw Error("extra die");
        return (d.value - 0.5) / d.sides;
      },
      limits,
    );
    if (
      !original.ok ||
      !original.roll ||
      original.diagnostics.length ||
      index !== parent.dice.length ||
      !Value.Equal(original.roll, {
        expression: parent.expression,
        total: parent.total,
        dice: parent.dice,
        breakdown: parent.breakdown,
      })
    )
      return { ok: false, reason: "invalid_snapshot" };
    const eligible = new Set(options.eligibleDiceIds);
    const savedDice = new Map(parent.dice.map((die) => [die.id, die]));
    const redrawn = new Set<string>();
    const result = evaluate(expression, bindings, undefined, limits, (id, chainId) => {
      if (!eligible.has(chainId)) {
        const saved = savedDice.get(id);
        if (!saved) throw Error("missing retained die");
        return (saved.value - 0.5) / saved.sides;
      }
      const draw = input.rng();
      if (!Number.isFinite(draw) || draw < 0 || draw > 1) throw Error("invalid draw");
      redrawn.add(id);
      return draw;
    });
    if (!result.ok || !result.roll || result.diagnostics.length)
      return { ok: false, reason: "invalid_snapshot" };
    return {
      ok: true,
      roll: result.roll,
      rerolledDiceIds: [...redrawn],
      faceOutcomes: policy.groups.flatMap((g) =>
        g.reportedFaces.map((face) => ({
          groupId: g.groupId,
          face,
          combinedCount: result.roll!.dice.filter(
            (d) => d.kept && d.groupId === g.groupId && d.value === face,
          ).length,
          rerolledCount: result.roll!.dice.filter(
            (d) =>
              d.kept && d.groupId === g.groupId &&
              d.value === face &&
              redrawn.has(d.id!),
          ).length,
        })),
      ),
    };
  } catch {
    return { ok: false, reason: "invalid_snapshot" };
  }
}
