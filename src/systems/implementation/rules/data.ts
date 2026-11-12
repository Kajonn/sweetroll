import type { ExpressionAstV1, ScalarValue, ValueType } from "../package/schema/index.js";
import { children } from "./groups.js";

export type RulesDataset = {
  id: string;
  keyColumn?: string;
  columns?: Readonly<Record<string, ValueType>>;
  records: readonly { values: Readonly<Record<string, ScalarValue>> }[];
};

export const AGGREGATE_FUNCTIONS = ["sum", "count", "sumWhere", "countWhere", "maxOf"] as const;
export type AggregateFunction = typeof AGGREGATE_FUNCTIONS[number];
export type SlotEnvironment = Readonly<Record<string, {
  capacity: number;
  fields: Readonly<Record<string, ValueType | "unsupported" | "mixed">>;
}>>;
export type AggregateEntry = {
  values: Readonly<Record<string, unknown>>;
  quantity: number;
  /** Fields whose value is per unit; sums multiply only these by `quantity`. */
  quantityFields?: ReadonlySet<string>;
};
export type AggregateCall = { name: AggregateFunction; slot: string; field?: string; flag?: string };
export type Call = Extract<ExpressionAstV1, { kind: "call" }>;

export function isAggregate(name: Call["function"]): name is AggregateFunction {
  return AGGREGATE_FUNCTIONS.some(candidate => candidate === name);
}

export function literalId(node: ExpressionAstV1 | undefined): string | undefined {
  return node?.kind === "stringLiteral" && /^[a-z][a-z0-9_]{0,63}$/.test(node.value)
    ? node.value
    : undefined;
}

export function aggregateCall(node: Call): AggregateCall | undefined {
  if (!isAggregate(node.function)) return undefined;
  const name = node.function;
  const hasField = name === "sum" || name === "sumWhere" || name === "maxOf";
  const hasFlag = name === "sumWhere" || name === "countWhere";
  if (node.arguments.length !== 1 + Number(hasField) + Number(hasFlag)) return undefined;
  const slot = literalId(node.arguments[0]);
  const field = hasField ? literalId(node.arguments[1]) : undefined;
  const flag = hasFlag ? literalId(node.arguments[hasField ? 2 : 1]) : undefined;
  if (!slot || (hasField && !field) || (hasFlag && !flag)) return undefined;
  return { name, slot, ...(field && { field }), ...(flag && { flag }) };
}

export function aggregateKey(call: AggregateCall): string {
  return [call.name, call.slot, call.field, call.flag].filter(part => part !== undefined).join(":");
}

export function aggregateValue(call: AggregateCall, entries: readonly AggregateEntry[]): number {
  let total = 0;
  let highest: number | undefined;
  for (const { values, quantity, quantityFields } of entries) {
    if (call.flag !== undefined && values[call.flag] !== true) continue;
    if (call.field === undefined) {
      total += 1;
      continue;
    }
    const value = Object.hasOwn(values, call.field) ? values[call.field] : undefined;
    if (typeof value !== "number") continue;
    if (call.name === "maxOf") highest = highest === undefined ? value : Math.max(highest, value);
    else total += value * (quantityFields?.has(call.field) ? quantity : 1);
  }
  return call.name === "maxOf" ? highest ?? 0 : total;
}

export function lookupValue(
  dataset: RulesDataset,
  key: ScalarValue,
  column: string,
  band: boolean,
): ScalarValue | undefined {
  if (dataset.keyColumn === undefined) return undefined;
  let bestKey = -Infinity;
  let result: ScalarValue | undefined;
  for (const { values } of dataset.records) {
    const candidate = values[dataset.keyColumn];
    if (candidate === key) return values[column];
    if (band && typeof key === "number" && typeof candidate === "number" && candidate <= key && candidate > bestKey) {
      bestKey = candidate;
      result = values[column];
    }
  }
  return result;
}

export function dataObservationCost(ast: ExpressionAstV1, capacities: ReadonlyMap<string, number>): number {
  const call = ast.kind === "call" ? aggregateCall(ast) : undefined;
  const own = call === undefined ? 0 : capacities.get(call.slot) ?? 0;
  return children(ast).reduce((cost, child) => cost + dataObservationCost(child, capacities), own);
}
