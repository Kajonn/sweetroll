import type { CustomDie } from "../package/schema/dice.js";
import type {DieResult, RollBreakdown} from "./result.js";
export type {DieResult, RollBreakdown} from "./result.js";
import { aggregateCall, aggregateKey, aggregateValue, isAggregate, literalId, lookupValue, type AggregateEntry, type RulesDataset } from "./data.js";
import {referenceKey} from "./typecheck.js";
import { children } from "./groups.js";
import type { PoolAst } from "../package/schema/expression.js";
import type { CompiledExpressionV1, ExpressionAstV1, ScalarValue } from "../package/schema/index.js";
import { PACKAGE_LIMITS } from "../package/limits.js";
import { renderExpression } from "./render.js";

export type Rng = () => number;

export type BindingValue = ScalarValue | string[];

export type EvaluationBindings = {
  fields: Record<string, BindingValue>;
  inputs: Record<string, BindingValue>;
  item?: Record<string, BindingValue>;
  /** Outcome expressions: values of the finished roll (`roll.total`). */
  roll?: Record<string, BindingValue>;
  /** Outcome expressions: the finished roll's named groups, for rolled("group"). */
  rolled?: RolledPools;
  dice?: readonly CustomDie[] | undefined;
  datasets?: readonly RulesDataset[];
  slotEntries?: (slot: string) => readonly AggregateEntry[];
  aggregates?: Record<string, BindingValue>;
};

export type EvaluationBinding = {
  scope: "fields" | "inputs" | "item" | "aggregates";
  definitionId: string;
  value: BindingValue;
};

export type EvaluationLimits = {
  dicePerRoll: number;
  sidesPerDie: number;
};

export type RuntimeDiagnostic = {
  code: "arithmetic_failure" | "budget_exceeded";
  path: string;
  message: string;
};


export type RollResult = { total: number; dice: DieResult[]; expression: string; breakdown: RollBreakdown };

/** Dice of the named groups a roll drew, kept in memory for outcome expressions; never stored. */
export type RolledPools = ReadonlyMap<string, { total: number; chains: DieResult[][] }>;

export type EvalResult =
  | { ok: true; roll: RollResult | null; result: ScalarValue; diagnostics: RuntimeDiagnostic[]; bindings: EvaluationBinding[]; rolled: RolledPools }
  | { ok: false; diagnostics: RuntimeDiagnostic[] };

type Ctx = {
  bindings: EvaluationBindings;
  bindingTrace: EvaluationBinding[];
  limits: EvaluationLimits;
  draw: PoolDraw;
  dice: DieResult[];
  diagnostics: RuntimeDiagnostic[];
  expression: string;
  nodeIds: Map<ExpressionAstV1, string>;
  evaluatedNodes: Set<ExpressionAstV1>;
  breakdown: RollBreakdown | undefined;
  pools: Map<string, { total: number; chains: DieResult[][] }>;
};

function fail(ctx: Ctx, message: string): undefined {
  ctx.diagnostics.push({ code: "arithmetic_failure", path: ctx.expression, message });
  return undefined;
}

function budgetExceeded(ctx: Ctx, message: string): undefined {
  ctx.diagnostics.push({ code: "budget_exceeded", path: ctx.expression, message });
  return undefined;
}

function num(v: BindingValue): number | undefined {
  return typeof v === "number" ? v : undefined;
}

function bool(v: BindingValue): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

export type PoolDraw = (id: string, chainId: string) => number;

function integer(node: ExpressionAstV1, ctx: Ctx, name: string, min: number, max = Number.MAX_SAFE_INTEGER): number | undefined {
  const value = evalNode(node, ctx);
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    if (max !== Number.MAX_SAFE_INTEGER) return fail(ctx, `${name} must be an integer between ${min} and ${max}`);
    if (min !== -Number.MAX_SAFE_INTEGER) return fail(ctx, `${name} must be an integer of at least ${min}`);
    return fail(ctx, `${name} must be a safe integer`);
  }
  return value;
}

function groupId(node: PoolAst, ctx: Ctx): string {
  return node.source.kind === "rolled" ? node.source.groupId : node.group?.id ?? `@${ctx.nodeIds.get(node)!}`;
}

function evalNode(node: ExpressionAstV1, ctx: Ctx): BindingValue | undefined {
  const value = evalValueNode(node, ctx);
  if (typeof value === "number" && !Number.isFinite(value)) return fail(ctx, "expression produced a non-finite number");
  if (value !== undefined && ctx.breakdown !== undefined) {
    ctx.evaluatedNodes.add(node);
    ctx.breakdown.terms.push({
      id: ctx.nodeIds.get(node)!,
      operation: node.kind === "binary" || node.kind === "unary" ? node.operator
        : node.kind === "call" ? node.function === "round" ? `round_${node.roundMode ?? "nearest"}` : node.function
        : node.kind === "pool" ? node.reducer?.kind ?? (node.source.kind === "rolled" ? "rolled" : "sum")
        : node.kind === "reference" ? "binding" : node.kind.endsWith("Literal") ? "literal" : node.kind,
      operandIds: children(node).filter((child) => ctx.evaluatedNodes.has(child)).map((child) => ctx.nodeIds.get(child)!),
      value,
      ...(node.kind === "pool" && {
        groupId: groupId(node, ctx),
        ...(node.reducer?.kind === "countSymbol" && { symbol: node.reducer.symbol }),
        ...(node.source.kind === "rolled" && { reused: true as const }),
      }),
    });
  }
  return value;
}

type DieSource = { sides: number; custom: CustomDie | undefined };

function drawDie(
  ctx: Ctx,
  { sides, custom }: DieSource,
  groupId: string,
  id: string,
  chainId: string,
  link?: Pick<DieResult, "rerolledFrom" | "explodedFrom">,
): DieResult | undefined {
  if (ctx.dice.length >= ctx.limits.dicePerRoll)
    return budgetExceeded(ctx, `dice count ${ctx.dice.length + 1} exceeds the ${ctx.limits.dicePerRoll}-die-per-roll limit`);
  const index = Math.max(1, Math.ceil(ctx.draw(id, chainId) * sides));
  const face = custom?.faces[index - 1];
  const die: DieResult = {
    sides, value: face?.value ?? index, kept: true, id, groupId, ...link,
    ...(face?.label === undefined ? {} : { faceLabel: face.label }),
    ...(face?.symbols === undefined ? {} : { symbols: face.symbols }),
  };
  ctx.dice.push(die);
  return die;
}

const EXPLOSIONS_PER_DIE = 10;

function drawChains(ctx: Ctx, id: string, count: number, source: DieSource, reroll: number | undefined, explode: number | undefined): DieResult[][] | undefined {
  const chains: DieResult[][] = [];
  for (let index = 0; index < count; index++) {
    const chainId = `${id}:${index}`;
    let die = drawDie(ctx, source, id, chainId, chainId);
    if (!die) return undefined;
    if (die.value === reroll) {
      die.kept = false;
      die = drawDie(ctx, source, id, `${chainId}:r`, chainId, { rerolledFrom: chainId });
      if (!die) return undefined;
    }
    const chain = [die];
    for (let extra = 1; extra <= EXPLOSIONS_PER_DIE && die.value === explode; extra++) {
      die = drawDie(ctx, source, id, `${chainId}:e${extra}`, chainId, { explodedFrom: die.id! });
      if (!die) return undefined;
      chain.push(die);
    }
    chains.push(chain);
  }
  return chains;
}

function reducePool(chains: DieResult[][], operation: RollBreakdown["groups"][number]["operation"], amount: number | string, record: boolean): number {
  if (typeof amount === "string") {
    return chains.flat().reduce((sum, die) => {
      const symbols = die.symbols;
      return sum + (symbols && Object.hasOwn(symbols, amount) ? symbols[amount]! : 0);
    }, 0);
  }
  const values = chains.map((chain) => ({ chain, total: chain.reduce((sum, die) => sum + die.value, 0) }));
  if (operation === "sum") return values.reduce((sum, value) => sum + value.total, 0);
  if (operation === "keepHighest" || operation === "keepLowest") {
    values.sort((a, b) => operation === "keepHighest" ? b.total - a.total : a.total - b.total);
    if (record) for (const { chain } of values.slice(amount)) for (const die of chain) die.kept = false;
    return values.slice(0, amount).reduce((sum, value) => sum + value.total, 0);
  }
  let successes = 0;
  for (const { chain, total } of values) {
    const success = operation === "countAtLeast" ? total >= amount : operation === "countAtMost" ? total <= amount : total === amount;
    if (success) successes++;
    if (record) for (const die of chain) die.success = success;
  }
  return successes;
}

function evalPool(node: PoolAst, ctx: Ctx): number | undefined {
  const { source, reducer } = node;
  const id = groupId(node, ctx);
  const operation = reducer?.kind ?? "sum";
  const keep = operation === "keepHighest" || operation === "keepLowest";
  const readAmount = () => reducer?.kind === "countSymbol" ? reducer.symbol : reducer
    ? integer(reducer.amount, ctx, keep ? "keep count" : "success threshold", keep ? 0 : -Number.MAX_SAFE_INTEGER, keep ? ctx.limits.dicePerRoll : undefined)
    : 0;
  if (source.kind === "rolled") {
    const prior = ctx.pools.get(id);
    if (!prior) return fail(ctx, `group '${id}' has not been rolled`);
    if (!reducer) return prior.total;
    const amount = readAmount();
    return amount === undefined ? undefined : reducePool(prior.chains, operation, amount, false);
  }

  const count = integer(source.count, ctx, "dice count", 0);
  if (count === undefined) return undefined;
  const custom = source.kind === "custom"
    ? ctx.bindings.dice?.find((die) => die.id === source.dieId)
    : undefined;
  if (source.kind === "custom" && !custom) return fail(ctx, `unknown custom die '${source.dieId}'`);
  const sides = source.kind === "dice" ? integer(source.sides, ctx, "die sides", 1) : custom?.faces.length;
  if (sides === undefined) return undefined;
  if (count + ctx.dice.length > ctx.limits.dicePerRoll)
    return budgetExceeded(ctx, `dice count ${count + ctx.dice.length} exceeds the ${ctx.limits.dicePerRoll}-die-per-roll limit`);
  if (sides > ctx.limits.sidesPerDie)
    return budgetExceeded(ctx, `die sides ${sides} exceed the ${ctx.limits.sidesPerDie}-side-per-die limit`);

  let reroll: number | undefined;
  let explode: number | undefined;
  for (const modifier of node.modifiers) {
    const face = custom
      ? modifier.face ? evalNode(modifier.face, ctx) : Math.max(...custom.faces.map((face) => face.value))
      : modifier.face ? integer(modifier.face, ctx, `${modifier.kind} face`, 1, sides) : sides;
    if (custom && face !== undefined && (typeof face !== "number" || !custom.faces.some((candidate) => candidate.value === face))) {
      return fail(ctx, `${modifier.kind} face must match a value on '${custom.id}'`);
    }
    if (typeof face !== "number") return undefined;
    if (modifier.kind === "rerollOnce") reroll = face;
    else explode = face;
  }
  const amount = readAmount();
  if (amount === undefined) return undefined;
  const first = ctx.dice.length;
  const chains = drawChains(ctx, id, count, { sides, custom }, reroll, explode);
  if (!chains) return undefined;
  const total = reducePool(chains, operation, amount, true);
  if (node.group) ctx.pools.set(id, { total, chains });
  ctx.breakdown?.groups.push({
    id, label: node.group?.label ?? custom?.label ?? "Dice", count, sides, operation, total,
    ...(custom && { dieId: custom.id }),
    diceIds: ctx.dice.slice(first).map((die) => die.id!),
    ...(typeof amount === "string" ? { symbol: amount } : reducer && (keep ? { keepCount: amount } : { threshold: amount })),
    ...(node.modifiers.length > 0 && { modifiers: node.modifiers.map((modifier) => modifier.kind) }),
  });
  return total;
}

function evalValueNode(node: ExpressionAstV1, ctx: Ctx): BindingValue | undefined {
  switch (node.kind) {
    case "numberLiteral":
      return node.value;
    case "stringLiteral":
      return node.value;
    case "booleanLiteral":
      return node.value;
    case "reference": {
      const key = referenceKey(node);
      const scope = ctx.bindings[node.scope] ?? {};
      const val = Object.hasOwn(scope, key) ? scope[key] : undefined;
      if (val === undefined) return fail(ctx, `missing reference ${node.scope}.${key}`);
      // `roll.*` is the roll itself, not an input to it, so it is not traced.
      if (node.scope !== "roll") ctx.bindingTrace.push({ scope: node.scope, definitionId: key, value: val });
      return val;
    }
    case "unary": {
      const v = evalNode(node.operand, ctx);
      if (v === undefined) return undefined;
      if (node.operator === "-") {
        const n = num(v);
        if (n === undefined) return fail(ctx, "unary '-' expects a number");
        return -n;
      }
      const b = bool(v);
      if (b === undefined) return fail(ctx, "unary '!' expects a boolean");
      return !b;
    }
    case "binary": {
      const op = node.operator;
      if (op === "&&" || op === "||") {
        const l = evalNode(node.left, ctx);
        if (l === undefined) return undefined;
        const lb = bool(l);
        if (lb === undefined) return fail(ctx, `'${op}' expects booleans`);
        if (op === "&&" && !lb) return false;
        if (op === "||" && lb) return true;
        const r = evalNode(node.right, ctx);
        if (r === undefined) return undefined;
        const rb = bool(r);
        if (rb === undefined) return fail(ctx, `'${op}' expects booleans`);
        return rb;
      }
      const l = evalNode(node.left, ctx);
      if (l === undefined) return undefined;
      const r = evalNode(node.right, ctx);
      if (r === undefined) return undefined;
      switch (op) {
        case "+": {
          const ln = num(l);
          const rn = num(r);
          if (ln === undefined || rn === undefined) return fail(ctx, "'+' expects numbers");
          return ln + rn;
        }
        case "-": {
          const ln = num(l);
          const rn = num(r);
          if (ln === undefined || rn === undefined) return fail(ctx, "'-' expects numbers");
          return ln - rn;
        }
        case "*": {
          const ln = num(l);
          const rn = num(r);
          if (ln === undefined || rn === undefined) return fail(ctx, "'*' expects numbers");
          return ln * rn;
        }
        case "/":
        case "%": {
          const ln = num(l);
          const rn = num(r);
          if (ln === undefined || rn === undefined) return fail(ctx, `'${op}' expects numbers`);
          if (rn === 0) return fail(ctx, op === "/" ? "division by zero" : "remainder by zero");
          return op === "/" ? ln / rn : ln % rn;
        }
        case "<": {
          const ln = num(l);
          const rn = num(r);
          if (ln === undefined || rn === undefined) return fail(ctx, "'<' expects numbers");
          return ln < rn;
        }
        case "<=": {
          const ln = num(l);
          const rn = num(r);
          if (ln === undefined || rn === undefined) return fail(ctx, "'<=' expects numbers");
          return ln <= rn;
        }
        case ">": {
          const ln = num(l);
          const rn = num(r);
          if (ln === undefined || rn === undefined) return fail(ctx, "'>' expects numbers");
          return ln > rn;
        }
        case ">=": {
          const ln = num(l);
          const rn = num(r);
          if (ln === undefined || rn === undefined) return fail(ctx, "'>=' expects numbers");
          return ln >= rn;
        }
        case "==":
          return (l === r);
        case "!=":
          return !(l === r);
      }
    }
    case "call": {
      if (node.function === "lookup" || node.function === "lookupBand") {
        const dataset = ctx.bindings.datasets?.find(table => table.id === literalId(node.arguments[0]));
        const column = literalId(node.arguments[2]);
        if (dataset === undefined || column === undefined || node.arguments[1] === undefined) {
          return fail(ctx, "unknown lookup dataset or column");
        }
        const key = evalNode(node.arguments[1], ctx);
        if (key === undefined) return undefined;
        if (key === null || Array.isArray(key)) return fail(ctx, "lookup needs a scalar key");
        const value = lookupValue(dataset, key, column, node.function === "lookupBand");
        return value === undefined || value === null
          ? fail(ctx, `no row in '${dataset.id}' for the lookup key`)
          : value;
      }
      if (isAggregate(node.function)) {
        const call = aggregateCall(node);
        if (!call) return fail(ctx, "invalid aggregate arguments");
        const key = aggregateKey(call);
        const value = ctx.bindings.slotEntries
          ? aggregateValue(call, ctx.bindings.slotEntries(call.slot))
          : ctx.bindings.aggregates?.[key];
        if (typeof value !== "number" || !Number.isFinite(value)) return fail(ctx, "slot aggregate is unavailable");
        ctx.bindingTrace.push({ scope: "aggregates", definitionId: key, value });
        return value;
      }
      if (node.function === "if") {
        const condition = evalNode(node.arguments[0]!, ctx);
        if (condition === undefined) return undefined;
        if (typeof condition !== "boolean") return fail(ctx, "if expects a boolean condition");
        return evalNode(node.arguments[condition ? 1 : 2]!, ctx);
      }
      if (node.function === "has") {
        const choices = evalNode(node.arguments[0]!, ctx);
        if (choices === undefined) return undefined;
        const option = evalNode(node.arguments[1]!, ctx);
        if (option === undefined) return undefined;
        if (!Array.isArray(choices) || typeof option !== "string") return fail(ctx, "has expects a multi-choice field and option ID");
        return choices.includes(option);
      }
      if (node.function === "round") {
        const v = evalNode(node.arguments[0]!, ctx);
        if (v === undefined) return undefined;
        const n = num(v);
        if (n === undefined) return fail(ctx, "round expects a number");
        const mode = node.roundMode ?? "nearest";
        if (mode === "up") return Math.ceil(n);
        if (mode === "down") return Math.floor(n);
        return Math.round(n);
      }
      const numbers: number[] = [];
      for (const argument of node.arguments) {
        const value = evalNode(argument, ctx);
        if (value === undefined) return undefined;
        const number = num(value);
        if (number === undefined) return fail(ctx, `${node.function} expects numbers`);
        numbers.push(number);
      }
      switch (node.function) {
        case "min": return Math.min(...numbers);
        case "max": return Math.max(...numbers);
        case "floor": return Math.floor(numbers[0]!);
        case "ceil": return Math.ceil(numbers[0]!);
        case "abs": return Math.abs(numbers[0]!);
      }
    }
    case "pool":
      return evalPool(node, ctx);
  }
}

export function evaluate(
  compiled: CompiledExpressionV1,
  bindings: EvaluationBindings,
  rng?: Rng,
  limits: EvaluationLimits = PACKAGE_LIMITS,
  draw?: PoolDraw,
): EvalResult {
  const expression = renderExpression(compiled.ast);
  const nodeIds = new Map<ExpressionAstV1, string>();
  const identify = (node: ExpressionAstV1, path: string): void => {
    nodeIds.set(node, path);
    children(node).forEach((child, index) => identify(child, `${path}.${index}`));
  };
  const breakdown: RollBreakdown | undefined = compiled.context === "roll"
    ? { version: "1.0", rootId: "root", groups: [], terms: [] }
    : undefined;
  if (breakdown) identify(compiled.ast, breakdown.rootId);
  const ctx: Ctx = {
    nodeIds,
    evaluatedNodes: new Set(),
    breakdown,
    pools: new Map(bindings.rolled ?? []),
    bindings,
    bindingTrace: [],
    limits,
    draw: draw ?? rng ?? Math.random,
    dice: [],
    diagnostics: [],
    expression,
  };
  const value = evalNode(compiled.ast, ctx);
  const invalidValue = value === null || Array.isArray(value) || (typeof value === "number" && !Number.isFinite(value));
  if (invalidValue) fail(ctx, "expression did not produce a finite scalar result");
  if (value === undefined || invalidValue) {
    if (ctx.diagnostics.some((diagnostic) => diagnostic.code === "budget_exceeded")) {
      return { ok: false, diagnostics: ctx.diagnostics };
    }
    const diagnostics = ctx.diagnostics.length > 0
      ? ctx.diagnostics
      : [{ code: "arithmetic_failure" as const, path: expression, message: "evaluation failed" }];
    if (breakdown) {
      if (breakdown.terms.at(-1)?.id === breakdown.rootId) breakdown.terms.pop();
      breakdown.terms.push({ id: breakdown.rootId, operation: "fallback", operandIds: [], value: compiled.fallback });
    }
    const roll = breakdown ? { total: num(compiled.fallback) ?? 0, dice: ctx.dice, expression, breakdown } : null;
    return { ok: true, result: compiled.fallback, roll, diagnostics, bindings: ctx.bindingTrace, rolled: ctx.pools };
  }
  const roll = breakdown ? { total: num(value) ?? 0, dice: ctx.dice, expression, breakdown } : null;
  return { ok: true, result: value, roll, diagnostics: ctx.diagnostics, bindings: ctx.bindingTrace, rolled: ctx.pools };
}
