import { useState } from "react";
import {
  parse,
  renderExpression,
  type ExpressionAstV1,
} from "@sweetroll/rules";
import { Button, FormField, Select } from "../../ui/index.js";
import { t } from "../../i18n/index.js";

type Group = {
  id: string;
  label: string;
  count: string;
  sides: number;
  threshold: number | null;
};
export function readGuidedGroups(source: string): Group[] | null {
  const parsed = parse(source);
  if (!parsed.ok) return null;
  const out: Group[] = [];
  const walk = (node: ExpressionAstV1): boolean => {
    if (node.kind === "binary" && node.operator === "+")
      return walk(node.left) && walk(node.right);
    const dice = node.kind === "successCount" ? node.dice : node;
    if (dice.kind !== "dice" || dice.group === undefined) return false;
    out.push({
      ...dice.group,
      count: renderExpression(dice.count),
      sides: dice.sides,
      threshold: node.kind === "successCount" ? node.threshold : null,
    });
    return true;
  };
  return walk(parsed.ast) ? out : null;
}
export function writeGuidedGroups(groups: Group[]): string {
  return (
    groups
      .map((g) => {
        const dice = `group(${JSON.stringify(g.id)}, ${JSON.stringify(g.label)}, dice(${g.count}, ${g.sides}))`;
        return g.threshold === null
          ? dice
          : `countSuccesses(${dice}, ${g.threshold})`;
      })
      .join(" + ") || "0"
  );
}

export function GroupedPoolEditor({
  source,
  onChange,
  choices,
  disabled,
}: {
  source: string;
  onChange: (source: string) => void;
  choices: Array<{ value: string; label: string }>;
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
        sides: 6,
        threshold: 6,
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
                      value={String(g.sides)}
                      options={[
                        4,
                        6,
                        8,
                        10,
                        12,
                        20,
                        100,
                        ...([4, 6, 8, 10, 12, 20, 100].includes(g.sides)
                          ? []
                          : [g.sides]),
                      ].map((n) => ({ value: String(n), label: `d${n}` }))}
                      onChange={(e) => patch({ sides: Number(e.target.value) })}
                    />
                    <Select
                      label={t("roll.groups.operation")}
                      value={g.threshold === null ? "sum" : "success"}
                      options={[
                        { value: "sum", label: t("roll.groups.sum") },
                        { value: "success", label: t("roll.groups.successes") },
                      ]}
                      onChange={(e) =>
                        patch({
                          threshold: e.target.value === "sum" ? null : 6,
                        })
                      }
                    />
                    {g.threshold !== null ? (
                      <FormField label={t("roll.groups.threshold")}>
                        <input
                          type="number"
                          step="1"
                          value={g.threshold}
                          onChange={(e) => {
                            const n = Number(e.target.value);
                            if (Number.isInteger(n) && n >= 0)
                              patch({ threshold: n });
                          }}
                        />
                      </FormField>
                    ) : null}
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
