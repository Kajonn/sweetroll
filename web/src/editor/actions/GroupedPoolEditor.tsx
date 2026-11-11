import { useState } from "react";
import {
  parse,
  renderExpression,
  type CustomDie,
  type ExpressionAstV1,
  type PoolAst,
} from "@sweetroll/rules";
import { Button, Checkbox, FormField, Select } from "../../ui/index.js";
import { t } from "../../i18n/index.js";

type Reducer = NonNullable<PoolAst["reducer"]>["kind"];
type Group = {
  id: string;
  label: string;
  count: string;
  sides: string;
  reducer: Reducer | "sum";
  amount: string;
  explode: boolean;
  explodeFace: string;
  reroll: boolean;
  rerollFace: string;
};

const REDUCERS = [
  { value: "sum", label: "Sum" },
  { value: "success", label: "Count successes" },
  { value: "countAtMost", label: "Count at most" },
  { value: "countEqual", label: "Count equal" },
  { value: "countSymbol", label: "Count symbols" },
  { value: "keepHighest", label: "Keep highest" },
  { value: "keepLowest", label: "Keep lowest" },
];

export function readGuidedGroups(source: string): Group[] | null {
  const parsed = parse(source);
  if (!parsed.ok) return null;
  const out: Group[] = [];
  const walk = (node: ExpressionAstV1): boolean => {
    if (node.kind === "binary" && node.operator === "+") return walk(node.left) && walk(node.right);
    if (node.kind !== "pool" || node.source.kind === "rolled" || node.group === undefined) return false;
    const explode = node.modifiers.find((modifier) => modifier.kind === "explode");
    const reroll = node.modifiers.find((modifier) => modifier.kind === "rerollOnce");
    out.push({
      ...node.group,
      count: renderExpression(node.source.count),
      sides: node.source.kind === "custom" ? JSON.stringify(node.source.dieId) : renderExpression(node.source.sides),
      reducer: node.reducer?.kind ?? "sum",
      amount: node.reducer?.kind === "countSymbol" ? node.reducer.symbol : node.reducer ? renderExpression(node.reducer.amount) : "6",
      explode: explode !== undefined,
      explodeFace: explode?.face ? renderExpression(explode.face) : "",
      reroll: reroll !== undefined,
      rerollFace: reroll ? renderExpression(reroll.face) : "1",
    });
    return true;
  };
  return walk(parsed.ast) ? out : null;
}

export function writeGuidedGroups(groups: Group[]): string {
  return groups.map((group) => {
    let pool = `dice(${group.count}, ${group.sides})`;
    if (group.reroll) pool = `rerollOnce(${pool}, ${group.rerollFace})`;
    if (group.explode) pool = `explode(${pool}${group.explodeFace ? `, ${group.explodeFace}` : ""})`;
    pool = `group(${JSON.stringify(group.id)}, ${JSON.stringify(group.label)}, ${pool})`;
    const reducer = group.reducer === "countAtLeast" ? "countSuccesses" : group.reducer;
    const amount = reducer === "countSymbol" ? JSON.stringify(group.amount) : group.amount;
    return reducer === "sum" ? pool : `${reducer}(${pool}, ${amount})`;
  }).join(" + ") || "0";
}

export function GroupedPoolEditor({
  source,
  onChange,
  choices,
  dice = [],
  disabled,
}: {
  source: string;
  onChange: (source: string) => void;
  choices: Array<{ value: string; label: string }>;
  dice?: readonly CustomDie[] | undefined;
  disabled?: boolean | undefined;
}) {
  const [open, setOpen] = useState(false);
  const groups = readGuidedGroups(source);
  const emit = (next: Group[]) => onChange(writeGuidedGroups(next));
  const add = (base: Group[]) => {
    let n = 1;
    while (base.some((g) => g.id === `group_${n}`)) n++;
    return [
      ...base,
      {
        id: `group_${n}`,
        label: `Group ${n}`,
        count: choices[0]?.value ?? "1",
        sides: "6",
        reducer: "countAtLeast" as const,
        amount: "6",
        explode: false,
        explodeFace: "",
        reroll: false,
        rerollFace: "1",
      },
    ];
  };
  return (
    <section aria-label={t("roll.groups.title")}>
      <Button
        variant="secondary"
        disabled={disabled}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {t("roll.groups.title")}
      </Button>
      {open ? (
        <div>
          {groups === null ? (
            <>
              <p>{t("roll.groups.preserve")}</p>
              <Button disabled={disabled} onClick={() => emit(add([]))}>
                {t("roll.groups.replace")}
              </Button>
            </>
          ) : (
            <>
              {groups.map((g, index) => {
                const patch = (update: Partial<Group>) =>
                  emit(
                    groups.map((candidate, i) =>
                      i === index ? { ...candidate, ...update } : candidate,
                    ),
                  );
                const parsedCount = parse(g.count);
                const added =
                  parsedCount.ok &&
                  parsedCount.ast.kind === "binary" &&
                  parsedCount.ast.operator === "+" &&
                  parsedCount.ast.right.kind === "reference" &&
                  parsedCount.ast.right.scope === "inputs"
                    ? parsedCount.ast
                    : null;
                const baseCount = added
                  ? renderExpression(added.left)
                  : g.count;
                const extra = added ? renderExpression(added.right) : "";
                const setCount = (base: string, bonus: string) =>
                  patch({ count: bonus === "" ? base : `${base} + ${bonus}` });
                const options = [
                  ...Array.from({ length: 11 }, (_, i) => ({
                    value: String(i),
                    label: String(i),
                  })),
                  ...choices,
                ];
                if (!options.some((o) => o.value === baseCount))
                  options.push({ value: baseCount, label: baseCount });
                const sides = [
                  ...[4, 6, 8, 10, 12, 20, 100].map((n) => ({ value: String(n), label: `d${n}` })),
                  ...choices,
                  ...dice.map(die => ({ value: JSON.stringify(die.id), label: die.label })),
                ];
                if (!sides.some((choice) => choice.value === g.sides)) sides.push({ value: g.sides, label: g.sides });
                const amountIsExpression = !/^-?\d+$/.test(g.amount);
                const amountChoice = amountIsExpression ? g.amount : "";
                const amountOptions = [{ value: "", label: "Fixed number" }, ...choices];
                if (!amountOptions.some((choice) => choice.value === amountChoice))
                  amountOptions.push({ value: amountChoice, label: amountChoice });
                const custom = dice.find(die => JSON.stringify(die.id) === g.sides);
                const symbols = [...new Set(custom?.faces.flatMap(face => Object.keys(face.symbols ?? {})))];
                const symbolOptions = [...new Set([...symbols, g.amount])].map(symbol => ({ value: symbol, label: symbol }));
                const keep = g.reducer === "keepHighest" || g.reducer === "keepLowest";
                return (
                  <fieldset
                    key={g.id}
                    disabled={disabled}
                    style={{ minWidth: 0, maxWidth: "100%" }}
                  >
                    <legend>{g.label}</legend>
                    <FormField label={t("roll.groups.label")}>
                      <input
                        value={g.label}
                        maxLength={120}
                        onChange={(e) => patch({ label: e.target.value })}
                      />
                    </FormField>
                    <Select
                      label={t("roll.groups.count")}
                      value={baseCount}
                      options={options}
                      onChange={(e) => setCount(e.target.value, extra)}
                    />
                    <Select
                      label={t("roll.groups.extra")}
                      value={extra}
                      options={[
                        { value: "", label: "—" },
                        ...choices.filter((c) => c.value.startsWith("inputs.")),
                      ]}
                      onChange={(e) => setCount(baseCount, e.target.value)}
                    />
                    <Select
                      label={t("roll.groups.sides")}
                      value={g.sides}
                      options={sides}
                      onChange={(e) => patch({ sides: e.target.value })}
                    />
                    <Select
                      label={t("roll.groups.operation")}
                      value={g.reducer === "countAtLeast" ? "success" : g.reducer}
                      options={REDUCERS.filter(option => option.value !== "countSymbol" || symbols.length > 0 || g.reducer === "countSymbol")}
                      onChange={(e) => {
                        const reducer = e.target.value === "success" ? "countAtLeast" : e.target.value as Group["reducer"];
                        patch({ reducer, amount: reducer === "countSymbol" ? symbols[0] ?? "symbol" : reducer.startsWith("keep") ? "1" : "6" });
                      }}
                    />
                    {g.reducer === "countSymbol" ? (
                      <Select label="Symbol to count" value={g.amount} options={symbolOptions}
                        onChange={(event) => patch({ amount: event.target.value })} />
                    ) : g.reducer !== "sum" ? (
                      <>
                        <Select
                          label={keep ? "Keep count source" : "Threshold source"}
                          value={amountChoice}
                          options={amountOptions}
                          onChange={(e) => patch({ amount: e.target.value || (keep ? "1" : "6") })}
                        />
                        {!amountIsExpression ? <FormField label={keep ? "Dice to keep" : t("roll.groups.threshold")}>
                          <input
                            type="number"
                            step="1"
                            min={keep ? 0 : undefined}
                            value={g.amount}
                            onChange={(e) => {
                              const n = Number(e.target.value);
                              if (e.target.value && Number.isSafeInteger(n) && (!keep || n >= 0))
                                patch({ amount: String(n) });
                            }}
                          />
                        </FormField> : null}
                      </>
                    ) : null}
                    <Checkbox label="Reroll one face once" checked={g.reroll}
                      onChange={(e) => patch({ reroll: e.target.checked })} />
                    {g.reroll ? <FormField label="Reroll face">
                      <input value={g.rerollFace} onChange={(e) => {
                        if (parse(e.target.value).ok) patch({ rerollFace: e.target.value });
                      }} />
                    </FormField> : null}
                    <Checkbox label="Explode dice" checked={g.explode}
                      onChange={(e) => patch({ explode: e.target.checked })} />
                    {g.explode ? <FormField label="Explosion face (highest if empty)">
                      <input value={g.explodeFace} onChange={(e) => {
                        if (!e.target.value || parse(e.target.value).ok) patch({ explodeFace: e.target.value });
                      }} />
                    </FormField> : null}
                    <Button
                      variant="secondary"
                      onClick={() => emit(groups.filter((_, i) => i !== index))}
                    >
                      {t("roll.groups.remove")}
                    </Button>
                  </fieldset>
                );
              })}
              <Button
                disabled={disabled || groups.length >= 32}
                onClick={() => emit(add(groups))}
              >
                {t("roll.groups.add")}
              </Button>
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}
