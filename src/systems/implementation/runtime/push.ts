import type { EvaluationBindings } from "../rules/evaluate.js";
import {derivedEntryError} from "./effective-entry.js";
import {effectiveTemplateId} from "./entries.js";
import { compositionOf, qualifiedId, unqualifiedId } from "../rules/compose.js";
import { Value } from "@sinclair/typebox/value";
import type {
  CharacterEntryV1,
  EntityDefinitionV1,
  RollActionV1,
  SystemPackageV1,
} from "../package/schema/index.js";
import type {
  NormalizedRoll,
  RuntimeResult,
  RuntimeStateV1,
} from "../../runtime.js";
import type { PushContext } from "./push-context.js";
import { findOwnedAction } from "./action-ownership.js";
import { describeRoll } from "../rules/outcomes.js";
import { findGrantedAction } from "./resolve-entries.js";
import { validateEntryForSlot } from "./entries.js";
import { createDeterministicRng } from "./deterministic-rng.js";
import { evaluatePush, pushEligibility } from "../rules/push.js";
export function makePushContext(
  pkg: SystemPackageV1,
  entityId: string,
  action: RollActionV1,
  entry?: CharacterEntryV1,
): PushContext | undefined {
  if (!action.pushPolicy) return undefined;
  // Design 6.8: extension expressions are stored by plain ID plus origin.
  const expression = unqualifiedId(action.expressionId);
  const composition = compositionOf(pkg);
  return {
    version: "1.0",
    versionId: pkg.versionId,
    packageChecksum: pkg.integrity.checksum,
    entityId,
    expressionId: expression.id,
    ...(expression.origin === null ? {} : { extensionId: expression.origin }),
    ...(composition === undefined ? {} : { compositionChecksum: composition.compositionChecksum }),
    outputTemplate: action.outputTemplate,
    policy: structuredClone(action.pushPolicy),
    ...(entry && effectiveTemplateId(entry)
      ? {
          entry: {
            entryId: entry.entryId,
            templateId: effectiveTemplateId(entry)!,
            slotId: entry.slotId,
            ...(entry.source ? { source: structuredClone(entry.source) } : {}),
          },
        }
      : {}),
  };
}
export function validatePushSource(
  pkg: SystemPackageV1,
  entity: EntityDefinitionV1,
  state: RuntimeStateV1,
  parent: NormalizedRoll,
  context: PushContext,
): string | RollActionV1 {
  if (
    pkg.versionId !== context.versionId ||
    pkg.integrity.checksum !== context.packageChecksum ||
    compositionOf(pkg)?.compositionChecksum !== context.compositionChecksum ||
    entity.id !== context.entityId
  )
    return "rules_changed";
  let action;
  if (context.entry) {
    const owned = findGrantedAction(
      pkg,
      state,
      context.entry.entryId,
      parent.actionId,
    );
    if (
      !owned ||
      !Value.Equal(
        {
          entryId: owned.entry.entryId,
          templateId: effectiveTemplateId(owned.entry)!,
          slotId: owned.entry.slotId,
          ...(owned.entry.source ? { source: owned.entry.source } : {}),
        },
        context.entry,
      )
    )
      return "source_unavailable";
    const siblings = Object.values(state.entries).filter(
      (e) =>
        e.slotId === owned.entry.slotId && e.entryId !== owned.entry.entryId,
    ).length;
    if (
      derivedEntryError(pkg,entity,owned.entry,siblings)!==null ||
      !validateEntryForSlot(
        owned.entry,
        pkg.slots,
        pkg.templates,
        siblings,
      ).ok ||
      ("nominal" in owned.action && owned.action.nominal)
    )
      return "source_unavailable";
    action = owned.action;
  } else action = findOwnedAction(pkg, entity.id, parent.actionId);
  if (
    !action ||
    action.kind !== "roll" ||
    action.expressionId !== qualifiedId(context.extensionId, context.expressionId) ||
    action.outputTemplate !== context.outputTemplate ||
    !Value.Equal(action.pushPolicy, context.policy)
  )
    return "source_unavailable";
  return action;
}
export function resolveRuntimePush(input: {
  pkg: SystemPackageV1;
  entity: EntityDefinitionV1;
  state: RuntimeStateV1;
  parent: NormalizedRoll;
  context: PushContext;
  executionId: string;
  secret: string;
  optionsOnly?: boolean;
}): RuntimeResult<{ roll: NormalizedRoll; context: PushContext }> {
  const { pkg, entity, state, parent, context } = input;
  const fail = (reason: string): RuntimeResult<never> => ({
    ok: false,
    error: {
      code: "push_unavailable",
      message: `Push unavailable: ${reason.replaceAll("_", " ")}.`,
      pushReason: reason,
    },
  });
  const source = validatePushSource(pkg, entity, state, parent, context);
  if (typeof source === "string") return fail(source);
  if (!parent.push) return fail("no_policy");
  const options = pushEligibility(context.policy, parent, parent.push.attempt);
  if (!options.canPush) return fail(options.reason!);
  if (input.optionsOnly) return { ok: true, value: { roll: parent, context } };
  const expressionKey = qualifiedId(context.extensionId, context.expressionId);
  const expression = pkg.expressions.find((e) => e.id === expressionKey);
  if (!expression) return fail("invalid_snapshot");
  const saved = { fields: {}, inputs: {}, item: {}, aggregates: {} } satisfies Record<string, Record<string, unknown>>;
  const bindings: EvaluationBindings = { ...saved, datasets: pkg.referenceData };
  for (const b of parent.bindings) {
    const scope: EvaluationBindings["fields"] = saved[b.scope];
    scope[b.definitionId] = b.value;
  }
  const result = evaluatePush({
    expression,
    policy: context.policy,
    parent,
    bindings,
    attempt: parent.push.attempt,
    rng: createDeterministicRng(input.secret, input.executionId),
    limits: pkg.effectiveLimits,
  });
  if (!result.ok) return fail(result.reason);
  // The pushed roll is described again: its outcome can differ from the parent's.
  const { outcome: _outcome, details: _details, ...carried } = parent;
  const { bindings: _read, ...described } = describeRoll({
    action: source,
    expression: (id) => pkg.expressions.find((candidate) => candidate.id === qualifiedId(context.extensionId, id)),
    total: result.roll.total,
    bindings,
    rolled: result.rolled,
    limits: pkg.effectiveLimits,
  });
  return {
    ok: true,
    value: {
      context,
      roll: {
        ...carried,
        ...result.roll,
        ...described,
        push: {
          ...parent.push,
          parentRollId: parent.push.rollId,
          rollId: input.executionId,
          attempt: parent.push.attempt + 1,
          rerolledDiceIds: result.rerolledDiceIds,
          faceOutcomes: result.faceOutcomes,
        },
      },
    },
  };
}
