import { useState } from "react";

import { t } from "../../i18n/index.js";
import { Button, FormField } from "../../ui/index.js";
import styles from "./RollActionEditor.module.css";

export type RollOutcomeEntry = { id: string; label: string; expressionId: string };
type OutcomeLists = { outcomes?: RollOutcomeEntry[]; details?: RollOutcomeEntry[]; id: string };

/**
 * How the parent editor stores the formulas behind outcomes and details.
 * They are `outcome` expressions in the document, owned by one action.
 */
export type OutcomeExpressions = {
  sourceFor(expressionId: string): string;
  /** Adds an outcome expression and returns its new document-wide ID. */
  add(kind: "outcomes" | "details", source: string): string;
  setSource(expressionId: string, source: string): void;
  remove(expressionId: string): void;
};

function nextEntryId(existing: readonly RollOutcomeEntry[], prefix: string): string {
  for (let index = 1; index < 10_000; index++) {
    const candidate = `${prefix}_${index}`;
    if (!existing.some((entry) => entry.id === candidate)) return candidate;
  }
  return `${prefix}_${Date.now()}`;
}

function FormulaInput({ id, label, source, disabled, onCommit }: {
  id: string; label: string; source: string; disabled: boolean; onCommit(source: string): void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <FormField label={label}>
      <input
        id={id}
        type="text"
        value={draft ?? source}
        maxLength={1024}
        disabled={disabled}
        data-testid={id}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (draft !== null && draft !== source) onCommit(draft);
          setDraft(null);
        }}
      />
    </FormField>
  );
}

/**
 * Outcome bands and detail values of one roll action (design 6.4). The first
 * outcome whose condition is true names the result, so order matters.
 */
export function RollOutcomesEditor<A extends OutcomeLists>({ action, onChange, expressions, disabled = false }: {
  action: A;
  onChange(next: A): void;
  expressions: OutcomeExpressions;
  disabled?: boolean | undefined;
}) {
  const renderList = (kind: "outcomes" | "details") => {
    const entries = action[kind] ?? [];
    const write = (next: RollOutcomeEntry[]) => {
      const { [kind]: _previous, ...rest } = action;
      onChange((next.length === 0 ? rest : { ...rest, [kind]: next }) as A);
    };
    const move = (index: number, offset: -1 | 1) => {
      const next = [...entries];
      const [entry] = next.splice(index, 1);
      next.splice(index + offset, 0, entry!);
      write(next);
    };
    const prefix = kind === "outcomes" ? "outcome" : "detail";
    return (
      <div className={styles.field} data-testid={`roll-action-${kind}-${action.id}`}>
        <strong>{t(`editor.action.roll.${kind}.title`)}</strong>
        <p>{t(`editor.action.roll.${kind}.help`)}</p>
        {entries.length === 0 ? <span>{t(`editor.action.roll.${kind}.empty`)}</span> : null}
        <ol>
          {entries.map((entry, index) => {
            const rowId = `roll-action-${prefix}-${action.id}-${entry.id}`;
            return (
              <li key={entry.id} className={styles.row}>
                <FormField label={t("editor.action.roll.outcomes.label")}>
                  <input
                    id={`${rowId}-label`}
                    type="text"
                    value={entry.label}
                    maxLength={120}
                    disabled={disabled}
                    data-testid={`${rowId}-label`}
                    onChange={(event) => write(entries.map((candidate) => candidate.id === entry.id ? { ...candidate, label: event.target.value } : candidate))}
                  />
                </FormField>
                <FormulaInput
                  id={`${rowId}-formula`}
                  label={t(kind === "outcomes" ? "editor.action.roll.outcomes.condition" : "editor.action.roll.details.value")}
                  source={expressions.sourceFor(entry.expressionId)}
                  disabled={disabled}
                  onCommit={(source) => expressions.setSource(entry.expressionId, source)}
                />
                {kind === "outcomes" ? <>
                  <Button variant="secondary" disabled={disabled || index === 0} onClick={() => move(index, -1)}>
                    {t("editor.action.roll.outcomes.moveUp", { label: entry.label })}
                  </Button>
                  <Button variant="secondary" disabled={disabled || index === entries.length - 1} onClick={() => move(index, 1)}>
                    {t("editor.action.roll.outcomes.moveDown", { label: entry.label })}
                  </Button>
                </> : null}
                <Button
                  variant="secondary"
                  disabled={disabled}
                  data-testid={`${rowId}-remove`}
                  onClick={() => {
                    write(entries.filter((candidate) => candidate.id !== entry.id));
                    expressions.remove(entry.expressionId);
                  }}
                >
                  {t("editor.action.roll.outcomes.remove", { label: entry.label })}
                </Button>
              </li>
            );
          })}
        </ol>
        <Button
          variant="secondary"
          disabled={disabled || entries.length >= (kind === "outcomes" ? 16 : 8)}
          data-testid={`roll-action-${prefix}-add-${action.id}`}
          onClick={() => {
            const source = kind === "outcomes" ? "roll.total >= 10" : "roll.total";
            const expressionId = expressions.add(kind, source);
            write([...entries, {
              id: nextEntryId(entries, prefix),
              label: t(kind === "outcomes" ? "editor.action.roll.outcomes.newLabel" : "editor.action.roll.details.newLabel"),
              expressionId,
            }]);
          }}
        >
          {t(`editor.action.roll.${kind}.add`)}
        </Button>
      </div>
    );
  };
  return <div className={styles.row}>{renderList("outcomes")}{renderList("details")}</div>;
}
