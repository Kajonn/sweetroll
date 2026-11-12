import type { CampaignRollContext, NormalizedRoll, RuntimeResult } from "../../runtime.js";
import type { ActionV1, RollActionV1, SystemPackageV1 } from "../package/schema/index.js";
import type { EvaluationBindings } from "../rules/evaluate.js";
import { resolveObservedValues } from "./resolve.js";
import { decodeRuntimeState, buildFieldBindings } from "./state.js";

export function campaignRollRequirements(action: ActionV1): Pick<RollActionV1, "target" | "respondsTo"> {
  return action.kind === "roll" ? {
    ...(action.target ? { target: action.target } : {}),
    ...(action.respondsTo ? { respondsTo: action.respondsTo } : {}),
  } : {};
}

type RollContextBindings = Pick<EvaluationBindings, "target" | "opposed">;

export function resolveRollContext(
  pkg: SystemPackageV1,
  action: RollActionV1,
  context: CampaignRollContext | undefined,
): RuntimeResult<RollContextBindings> {
  const badRequest = (message: string): RuntimeResult<never> =>
    ({ ok: false, error: { code: "bad_request", message, definitionId: action.id } });
  const target = context?.target;
  const opposed = context?.opposed;
  if (action.target && !target) return badRequest("Select a target character for this action.");
  if (!action.target && target) return badRequest("This action does not accept a target character.");
  if (action.respondsTo && !opposed) return badRequest("Select a recorded roll to respond to.");
  if (!action.respondsTo && opposed) return badRequest("This action does not respond to a recorded roll.");

  const bindings: RollContextBindings = {};
  if (target) {
    const entity = pkg.entities.find(candidate => candidate.id === action.target?.entityId);
    if (!entity || target.entityId !== entity.id) {
      return { ok: false, error: { code: "not_found", message: "Target character not found." } };
    }
    const decoded = decodeRuntimeState(entity, target.state);
    if (!decoded.ok) return decoded;
    const observed = resolveObservedValues(pkg, entity, decoded.value);
    if (!observed.ok) return observed;
    bindings.target = { ...buildFieldBindings(entity, observed.value.state), ...observed.value.derivedValues };
  }
  if (opposed) bindings.opposed = { total: opposed.total };
  return { ok: true, value: bindings };
}

export function rollContextReferences(context: CampaignRollContext | undefined): Pick<NormalizedRoll, "targetCharacterId" | "respondsTo"> {
  return {
    ...(context?.target ? { targetCharacterId: context.target.characterId } : {}),
    ...(context?.opposed ? { respondsTo: context.opposed.rollId } : {}),
  };
}
