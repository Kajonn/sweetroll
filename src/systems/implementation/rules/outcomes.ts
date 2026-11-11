import type { CompiledExpressionV1 } from "../package/schema/index.js";
import { evaluate, type BindingValue, type EvaluationBinding, type EvaluationBindings, type EvaluationLimits, type RolledPools } from "./evaluate.js";

/** Design 6.4 (rules coverage R5): what a finished roll means, beyond its number. */
export type RollOutcome = { id: string; label: string };
export type RollDetail = { id: string; label: string; value: number };
export type RollDescription = {
  outcome?: RollOutcome;
  details?: RollDetail[];
  output: string;
  /** Values the outcomes read that the roll itself did not; saved with the roll so a push can describe its result. */
  bindings: EvaluationBinding[];
  /** Rendered field, input and item placeholders for the private push snapshot. */
  outputValues: Record<string, string>;
};

type OutcomeEntry = { id: string; label: string; expressionId: string };
export type DescribedAction = {
  outcomes?: readonly OutcomeEntry[];
  details?: readonly OutcomeEntry[];
  outputTemplate: string;
};

const PLACEHOLDER = /\{([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*)\}/g;

/** Placeholders a template uses, such as `total`, `outcome`, `detail.margin` or `fields.name`. */
export function outputPlaceholders(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER)].map((match) => match[1]!);
}

/** Reason a placeholder cannot be used by this action, or null when it can. */
export function placeholderProblem(
  placeholder: string,
  action: DescribedAction,
  scopes: { fields: Readonly<Record<string, unknown>>; inputs: Readonly<Record<string, unknown>>; item?: Readonly<Record<string, unknown>> },
): string | null {
  if (placeholder === "total") return null;
  if (placeholder === "outcome") {
    return (action.outcomes?.length ?? 0) > 0 ? null : "{outcome} needs at least one outcome on this action.";
  }
  const dot = placeholder.indexOf(".");
  const scope = dot < 0 ? placeholder : placeholder.slice(0, dot);
  const id = dot < 0 ? "" : placeholder.slice(dot + 1);
  if (scope === "detail") {
    return action.details?.some((detail) => detail.id === id) ? null : `{${placeholder}} does not name a detail of this action.`;
  }
  if (scope === "fields" || scope === "inputs" || scope === "item") {
    const known = scopes[scope];
    return known !== undefined && Object.hasOwn(known, id) ? null : `{${placeholder}} does not name a value this action can read.`;
  }
  return `{${placeholder}} is not a known placeholder. Use {total}, {outcome}, {detail.id}, {fields.id} or {inputs.id}.`;
}

function text(value: BindingValue | undefined): string {
  if (value === undefined || value === null) return "";
  return Array.isArray(value) ? value.join(", ") : String(value);
}

/**
 * Evaluates an action's outcome bands (first true band wins) and detail values
 * against a finished roll, then fills the output template. Rolls stay factual:
 * nothing here changes character state.
 */
export function describeRoll(input: {
  action: DescribedAction;
  expression: (id: string) => CompiledExpressionV1 | undefined;
  total: number;
  bindings: EvaluationBindings;
  savedOutputValues?: Readonly<Record<string, string>> | undefined;
  rolled: RolledPools;
  limits: EvaluationLimits;
}): RollDescription {
  const { action, total } = input;
  const bindings: EvaluationBindings = { ...input.bindings, roll: { total }, rolled: input.rolled };
  const read: EvaluationBinding[] = [];
  const valueOf = (entry: OutcomeEntry) => {
    const expression = input.expression(entry.expressionId);
    if (expression === undefined || expression.context !== "outcome") return undefined;
    const evaluated = evaluate(expression, bindings, undefined, input.limits);
    // A failed condition or value falls back to its declared fallback.
    if (!evaluated.ok) return expression.fallback;
    for (const binding of evaluated.bindings) {
      if (!read.some((known) => known.scope === binding.scope && known.definitionId === binding.definitionId)) read.push(binding);
    }
    return evaluated.result;
  };
  const matched = action.outcomes?.find((entry) => valueOf(entry) === true);
  const outcome = matched === undefined ? undefined : { id: matched.id, label: matched.label };
  const details = action.details?.flatMap((entry) => {
    const value = valueOf(entry);
    return typeof value === "number" && Number.isFinite(value) ? [{ id: entry.id, label: entry.label, value }] : [];
  });
  const usesOutcome = outputPlaceholders(action.outputTemplate).includes("outcome");
  const outputValues: Record<string, string> = {};
  const filled = action.outputTemplate.replace(PLACEHOLDER, (whole, placeholder: string) => {
    if (placeholder === "total") return String(total);
    if (placeholder === "outcome") return outcome?.label ?? "";
    const dot = placeholder.indexOf(".");
    if (dot < 0) return whole;
    const scope = placeholder.slice(0, dot);
    const id = placeholder.slice(dot + 1);
    if (scope === "detail") {
      const detail = details?.find((candidate) => candidate.id === id);
      return detail === undefined ? "" : String(detail.value);
    }
    if (scope === "fields" || scope === "inputs" || scope === "item") {
      const values = input.bindings[scope];
      const value = input.savedOutputValues?.[placeholder] ??
        (values !== undefined && Object.hasOwn(values, id) ? text(values[id]) : undefined);
      if (value === undefined) return "";
      outputValues[placeholder] = value;
      return value;
    }
    return whole;
  });
  // The outcome is always visible where only the output text is shown.
  const output = outcome !== undefined && !usesOutcome ? `${filled} — ${outcome.label}` : filled;
  return {
    ...(outcome === undefined ? {} : { outcome }),
    ...(details === undefined || details.length === 0 ? {} : { details }),
    output,
    bindings: read,
    outputValues,
  };
}

/** Roll bindings followed by the outcome bindings the roll did not already record. */
export function mergeBindings(roll: readonly EvaluationBinding[], extra: readonly EvaluationBinding[]): EvaluationBinding[] {
  return [...roll, ...extra.filter((binding) =>
    !roll.some((known) => known.scope === binding.scope && known.definitionId === binding.definitionId))];
}
