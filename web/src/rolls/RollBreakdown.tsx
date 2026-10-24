import type { RollBreakdown as Breakdown, DieResult, PushResult } from "@sweetroll/rules";
import { t } from "../i18n/index.js";

/** One shared view for authoritative results, history, GM and non-factual previews. */
export function RollBreakdown({
  roll,
}: {
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
  const explain = (id: string, depth = 0): string => {
    const term = terms.get(id);
    if (!term || depth > 64) return "?";
    const group =
      term.groupId === undefined ? undefined : groups.get(term.groupId);
    if (group) return `${group.label} (${String(term.value)})`;
    if (term.operation === "binding" || term.operation === "literal")
      return String(term.value);
    const args = term.operandIds.map((child) => explain(child, depth + 1));
    if (
      args.length === 2 &&
      [
        "+",
        "-",
        "*",
        "/",
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
    <section
      aria-label={t("roll.groups.breakdown")}
      data-testid="roll-breakdown"
      style={{ overflowWrap: "anywhere", minWidth: 0 }}
    >
      {roll.push?<p>{roll.push.attempt===0?`Original roll · up to ${roll.push.maxAttempts} pushes`:`Push ${roll.push.attempt} of ${roll.push.maxAttempts}`} · Original saved pool</p>:null}
      <ul>
        {b.groups.map((group) => (
          <li key={group.id} data-testid={`roll-group-${group.id}`}>
            <strong>{group.label}</strong>
            {": "}
            {group.count}d{group.sides}
            {" · "}
            {group.operation === "successCount"
              ? `${t("roll.groups.successes")} ≥ ${group.threshold}`
              : group.operation === "sum"
                ? t("roll.groups.sum")
                : t(
                    group.operation === "keepHighest"
                      ? "roll.groups.keepHighest"
                      : "roll.groups.keepLowest",
                  )}
            {": "}
            {group.total}
            {group.diceIds.length === 0 ? (
              <span>
                {" · "}
                {t("roll.groups.empty")}
              </span>
            ) : (
              <ul>
                {roll.dice
                  .filter((die) => die.groupId === group.id)
                  .map((die) => (
                    <li key={die.id}>
                      d{die.sides}={die.value}
                      {roll.push&&roll.push.attempt>0?` · ${roll.push.rerolledDiceIds.includes(die.id??"")?"Rerolled":"Retained"}`:null}
                      {" · "}
                      {t(
                        die.kept ? "roll.groups.kept" : "roll.groups.discarded",
                      )}
                      {die.success === undefined ? null : (
                        <>
                          {" "}
                          ·{" "}
                          {t(
                            die.success
                              ? "roll.groups.success"
                              : "roll.groups.failure",
                          )}
                        </>
                      )}
                    </li>
                  ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
      {roll.push?.faceOutcomes.map(o=><p key={`${o.groupId}:${o.face}`}>{groups.get(o.groupId)?.label??o.groupId} face {o.face}: {o.combinedCount} in combined pool, {o.rerolledCount} newly rolled. Manual bookkeeping only.</p>)}
      <p>
        {t("roll.groups.calculation")}: {explain(b.rootId)} ={" "}
        {String(terms.get(b.rootId)?.value ?? roll.total ?? "?")}
      </p>
    </section>
  );
}
