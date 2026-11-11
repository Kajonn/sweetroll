import type { ReactNode } from "react";
import { Disclosure } from "../ui/Disclosure.js";
import { formatDieFace, type RollBreakdown as Breakdown, type DieResult, type PushResult } from "@sweetroll/rules";
import { t } from "../i18n/index.js";

/** One shared view for authoritative results, history, GM and non-factual previews. */
export function RollBreakdown({
  roll,
  children,
}: {
  children?: ReactNode;
  roll: {
    push?:PushResult | undefined;
    dice: DieResult[];
    breakdown?: Breakdown | undefined;
    total?: number | undefined;
  };
}) {
  const b = roll.breakdown;
  if (b === undefined || b.version !== "1.0") return null;
  const terms = new Map(b.terms.map((term) => [term.id, term]));
  const groups = new Map(b.groups.map((group) => [group.id, group]));
  const dice = new Map(roll.dice.map((die) => [die.id, die]));
  const face = (id: string) => {
    const die = dice.get(id);
    return die === undefined ? "?" : formatDieFace(die);
  };
  const explain = (id: string, depth = 0): string => {
    const term = terms.get(id);
    if (!term || depth > 64) return "?";
    const group =
      term.groupId === undefined ? undefined : groups.get(term.groupId);
    if (group) {
      return `${group.label}${term.reused ? ` [reuse: ${term.operation}${term.symbol ? ` ${term.symbol}` : ""}]` : ""} (${String(term.value)})`;
    }
    if (term.operation === "binding" || term.operation === "literal" || term.operation === "fallback")
      return String(term.value);
    const args = term.operandIds.map((child) => explain(child, depth + 1));
    if (
      args.length === 2 &&
      [
        "+",
        "-",
        "*",
        "/",
        "%",
        "<",
        "<=",
        ">",
        ">=",
        "==",
        "!=",
        "&&",
        "||",
      ].includes(term.operation)
    )
      return `(${args.join(` ${term.operation === "*" ? "×" : term.operation} `)})`;
    return `${term.operation}(${args.join(", ")})`;
  };
  return (
    <section aria-label={t("roll.groups.breakdown")} data-testid="roll-breakdown" style={{ overflowWrap: "anywhere", minWidth: 0 }}>
      {roll.push ? <p>{roll.push.attempt === 0 ? `Original roll · up to ${roll.push.maxAttempts} pushes` : `Push ${roll.push.attempt} of ${roll.push.maxAttempts}`}</p> : null}
      <ul>
        {b.groups.map(group => <li key={group.id} data-testid={`roll-group-${group.id}`}>
          <strong>{group.label}</strong>: {group.dieId ? `${group.count} × ${group.dieId}` : `${group.count}d${group.sides}`} · {describeOperation(group)}: {group.total}
          {group.diceIds.length === 0 ? ` · ${t("roll.groups.empty")}` : null}
          {group.dieId && group.diceIds.length > 0 ? (
            <ul aria-label={t("roll.groups.faces", { label: group.label })}>
              {roll.dice.filter(die => die.groupId === group.id && die.kept).map(die => (
                <li key={die.id}>{formatDieFace(die)}</li>
              ))}
            </ul>
          ) : null}
        </li>)}
      </ul>
      {roll.push?.faceOutcomes.map(outcome => <p key={`${outcome.groupId}:${outcome.face}`}>{groups.get(outcome.groupId)?.label ?? outcome.groupId} face {outcome.face}: {outcome.combinedCount} in combined pool, {outcome.rerolledCount} newly rolled. Manual bookkeeping only.</p>)}
      <Disclosure label={t("character.rollResult.showDetails")}>
        {roll.push ? <p>Original saved pool</p> : null}
        <ul>
          {b.groups.map(group => <li key={group.id}>
            <strong>{group.label}</strong>
            <ul>{roll.dice.filter(die => die.groupId === group.id).map(die => <li key={die.id}>
              {group.dieId ? formatDieFace(die) : `d${die.sides}=${die.value}`}
              {die.rerolledFrom ? ` · Rerolled from ${face(die.rerolledFrom)}` : null}
              {die.explodedFrom ? ` · Explosion after ${face(die.explodedFrom)}` : null}
              {roll.push && roll.push.attempt > 0 ? ` · ${roll.push.rerolledDiceIds.includes(die.id ?? "") ? "Rerolled" : "Retained"}` : null}
              {" · "}{t(die.kept ? "roll.groups.kept" : "roll.groups.discarded")}
              {die.success === undefined ? null : ` · ${t(die.success ? "roll.groups.success" : "roll.groups.failure")}`}
            </li>)}</ul>
          </li>)}
        </ul>
        <p>{t("roll.groups.calculation")}: {explain(b.rootId)} = {String(terms.get(b.rootId)?.value ?? roll.total ?? "?")}</p>
        {children}
      </Disclosure>
    </section>
  );
}

function describeOperation(group: Breakdown["groups"][number]): string {
  switch (group.operation) {
    case "countAtLeast": return `${t("roll.groups.successes")} ≥ ${group.threshold}`;
    case "countAtMost": return `${t("roll.groups.successes")} ≤ ${group.threshold}`;
    case "countSymbol": return t("roll.groups.countSymbol", { symbol: group.symbol ?? "" });
    case "countEqual": return `${t("roll.groups.successes")} = ${group.threshold}`;
    case "keepHighest": return `${t("roll.groups.keepHighest")} ${group.keepCount ?? ""}`.trim();
    case "keepLowest": return `${t("roll.groups.keepLowest")} ${group.keepCount ?? ""}`.trim();
    case "sum": return t("roll.groups.sum");
  }
}
