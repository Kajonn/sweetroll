import { useMemo, useState } from "react";

import { evaluateRoll } from "../../api/evaluateExpression.js";
import type { ApiClient } from "../../api/client.js";
import { t } from "../../i18n/index.js";
import type { ScalarValue, ValueType } from "../../ports/evaluateExpression.js";
import { ExpressionEditor } from "../expressions/ExpressionEditor.js";
import styles from "./RollActionEditor.module.css";

export type DefinitionId = string;

export type ActionInputV1 = {
  id: DefinitionId;
  label: string;
  valueType: "integer" | "decimal" | "boolean" | "text";
  required: boolean;
  default: ScalarValue;
};

export type RollActionV1 = {
  kind: "roll";
  id: DefinitionId;
  label: string;
  expressionId: DefinitionId;
  inputs: ActionInputV1[];
  outputTemplate: string;
};

export type RollActionEditorProps = {
  client: ApiClient;
  systemId: string;
  action: RollActionV1;
  onChange: (next: RollActionV1) => void;
  expressionSource: string;
  onExpressionSourceChange: (next: string) => void;
  fieldTypes: Record<string, ValueType>;
  disabled?: boolean | undefined;
  /**
   * Guided (basics-first) mode for the dice tab: hides the grammar surfaces
   * (expression-id input + ExpressionEditor) and shows a dice-kind picker
   * instead. The full expression source stays editable in Advanced.
   */
  guided?: boolean | undefined;
  diceKind?: string | undefined;
  onDiceKindChange?: ((next: string) => void) | undefined;
};

/** Canned dice sources offered by the guided dice-kind picker. */
export const GUIDED_DICE_KINDS: ReadonlyArray<string> = ["d4", "d6", "d8", "d10", "d12", "d20"];

function nextInputId(existing: ReadonlyArray<ActionInputV1>): DefinitionId {
  for (let i = 1; i < 10_000; i++) {
    const candidate = `input_${i}`;
    if (!existing.some((e) => e.id === candidate)) return candidate;
  }
  return `input_${Date.now()}`;
}

function defaultValueFor(valueType: ActionInputV1["valueType"]): ScalarValue {
  switch (valueType) {
    case "integer":
    case "decimal":
      return 0;
    case "boolean":
      return false;
    case "text":
      return "";
  }
}

function defaultActionInput(existing: ReadonlyArray<ActionInputV1>): ActionInputV1 {
  return {
    id: nextInputId(existing),
    label: "",
    valueType: "integer",
    required: false,
    default: defaultValueFor("integer"),
  };
}

function coerceDefault(value: string, valueType: ActionInputV1["valueType"]): ScalarValue {
  switch (valueType) {
    case "integer":
    case "decimal": {
      const n = Number(value);
      return Number.isFinite(n) ? n : 0;
    }
    case "boolean":
      return value === "true";
    case "text":
      return value;
  }
}

function defaultBinding(valueType: ValueType): ScalarValue {
  switch (valueType) {
    case "number":
      return 0;
    case "text":
      return "";
    case "boolean":
      return false;
  }
}

function formatOutput(template: string, total: number | null): string {
  if (total === null) return template;
  return template.replace(/\{total\}/g, String(total));
}

export function RollActionEditor({
  client,
  systemId,
  action,
  onChange,
  expressionSource,
  onExpressionSourceChange,
  fieldTypes,
  disabled,
  guided,
  diceKind,
  onDiceKindChange,
}: RollActionEditorProps) {
  const [tryItResult, setTryItResult] = useState<ReturnType<typeof evaluateRoll> | null>(null);

  const inputTypes = useMemo<Record<string, ValueType>>(() => {
    const out: Record<string, ValueType> = {};
    for (const input of action.inputs) {
      out[input.id] = input.valueType === "text" ? "text" : input.valueType === "boolean" ? "boolean" : "number";
    }
    return out;
  }, [action.inputs]);

  const updateInputs = (next: ActionInputV1[]) => {
    onChange({ ...action, inputs: next });
  };

  const removeInput = (id: DefinitionId) => {
    updateInputs(action.inputs.filter((i) => i.id !== id));
  };

  const updateInput = (id: DefinitionId, patch: Partial<ActionInputV1>) => {
    updateInputs(
      action.inputs.map((i) => (i.id === id ? { ...i, ...patch } : i)),
    );
  };

  const addInput = () => {
    updateInputs([...action.inputs, defaultActionInput(action.inputs)]);
  };

  const runTryIt = () => {
    setTryItResult(
      evaluateRoll({
        source: expressionSource,
        env: { fields: fieldTypes, inputs: inputTypes },
        resultType: "number",
        fallback: 0,
        bindings: buildTryItBindings(action.inputs, fieldTypes),
      }),
    );
  };

  const modifiers =
    tryItResult !== null && tryItResult.result.ok && tryItResult.result.roll !== null
      ? tryItResult.result.roll.total -
        tryItResult.result.roll.dice.reduce((sum, d) => (d.kept ? sum + d.value : sum), 0)
      : null;

  const showEmpty = tryItResult === null;

  return (
    <section className={styles.layout} data-testid={`roll-action-${action.id}`} aria-label={action.label}>
      <div className={styles.row}>
        <label className={styles.field} htmlFor={`roll-action-label-${action.id}`}>
          {t("editor.action.roll.label")}
          <input
            id={`roll-action-label-${action.id}`}
            type="text"
            value={action.label}
            maxLength={120}
            onChange={(e) => onChange({ ...action, label: e.target.value })}
            data-testid={`roll-action-label-${action.id}`}
            disabled={disabled}
          />
        </label>
        {guided === true ? (
          <label className={styles.field} htmlFor={`dice-kind-${action.id}`}>
            {t("editor.action.roll.diceKind")}
            <select
              id={`dice-kind-${action.id}`}
              className={styles.guidedSelect}
              value={diceKind ?? "custom"}
              onChange={(e) => onDiceKindChange?.(e.target.value)}
              data-testid={`dice-kind-${action.id}`}
              disabled={disabled}
              title={t("editor.action.roll.diceKind.hint")}
            >
              {GUIDED_DICE_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {kind}
                </option>
              ))}
              <option value="custom">{t("editor.action.roll.diceKind.custom")}</option>
            </select>
          </label>
        ) : (
          <label className={styles.field} htmlFor={`roll-action-expression-id-${action.id}`}>
            {t("editor.action.roll.expressionId")}
            <input
              id={`roll-action-expression-id-${action.id}`}
              type="text"
              value={action.expressionId}
              onChange={(e) => onChange({ ...action, expressionId: e.target.value })}
              data-testid={`roll-action-expression-id-${action.id}`}
              disabled={disabled}
            />
          </label>
        )}
      </div>
      {guided === true ? null : (
        <ExpressionEditor
          client={client}
          systemId={systemId}
          source={expressionSource}
          onSourceChange={onExpressionSourceChange}
          disabled={disabled === true}
        />
      )}
      <div className={styles.row}>
        <label className={styles.field} htmlFor={`roll-action-output-${action.id}`}>
          {t("editor.action.roll.outputTemplate")}
          <input
            id={`roll-action-output-${action.id}`}
            type="text"
            value={action.outputTemplate}
            maxLength={2000}
            onChange={(e) => onChange({ ...action, outputTemplate: e.target.value })}
            placeholder={t("editor.action.roll.outputTemplate.placeholder")}
            data-testid={`roll-action-output-${action.id}`}
            disabled={disabled}
          />
        </label>
      </div>
      <div className={styles.row} data-testid={`roll-action-inputs-${action.id}`}>
        <div className={styles.field}>
          {t("editor.action.roll.inputs.title")}
          {action.inputs.length === 0 ? (
            <span data-testid={`roll-action-inputs-empty-${action.id}`}>
              {t("editor.action.roll.inputs.empty")}
            </span>
          ) : (
            <ul className={styles.inputsList}>
              {action.inputs.map((input) => (
                <li
                  key={input.id}
                  className={styles.inputItem}
                  data-testid={`roll-action-input-${input.id}`}
                >
                  <label className={styles.field} htmlFor={`roll-action-input-id-${input.id}`}>
                    {t("editor.action.roll.inputs.id")}
                    <input
                      id={`roll-action-input-id-${input.id}`}
                      type="text"
                      value={input.id}
                      onChange={(e) => updateInput(input.id, { id: e.target.value })}
                      data-testid={`roll-action-input-id-${input.id}`}
                      disabled={disabled}
                    />
                  </label>
                  <label className={styles.field} htmlFor={`roll-action-input-label-${input.id}`}>
                    {t("editor.action.roll.inputs.label")}
                    <input
                      id={`roll-action-input-label-${input.id}`}
                      type="text"
                      value={input.label}
                      maxLength={120}
                      onChange={(e) => updateInput(input.id, { label: e.target.value })}
                      data-testid={`roll-action-input-label-${input.id}`}
                      disabled={disabled}
                    />
                  </label>
                  <label className={styles.field} htmlFor={`roll-action-input-type-${input.id}`}>
                    {t("editor.action.roll.inputs.valueType")}
                    <select
                      id={`roll-action-input-type-${input.id}`}
                      value={input.valueType}
                      onChange={(e) => {
                        const valueType = e.target.value as ActionInputV1["valueType"];
                        updateInput(input.id, {
                          valueType,
                          default: defaultValueFor(valueType),
                        });
                      }}
                      data-testid={`roll-action-input-type-${input.id}`}
                      disabled={disabled}
                    >
                      <option value="integer">{t("editor.action.roll.inputs.valueType.integer")}</option>
                      <option value="decimal">{t("editor.action.roll.inputs.valueType.decimal")}</option>
                      <option value="boolean">{t("editor.action.roll.inputs.valueType.boolean")}</option>
                      <option value="text">{t("editor.action.roll.inputs.valueType.text")}</option>
                    </select>
                  </label>
                  <label className={styles.field} htmlFor={`roll-action-input-required-${input.id}`}>
                    {t("editor.action.roll.inputs.required")}
                    <input
                      id={`roll-action-input-required-${input.id}`}
                      type="checkbox"
                      checked={input.required}
                      onChange={(e) => updateInput(input.id, { required: e.target.checked })}
                      data-testid={`roll-action-input-required-${input.id}`}
                      disabled={disabled}
                    />
                  </label>
                  <label className={styles.field} htmlFor={`roll-action-input-default-${input.id}`}>
                    {t("editor.action.roll.inputs.default")}
                    <input
                      id={`roll-action-input-default-${input.id}`}
                      type={input.valueType === "boolean" ? "text" : input.valueType === "text" ? "text" : "number"}
                      value={input.valueType === "boolean" ? String(input.default) : String(input.default ?? "")}
                      onChange={(e) =>
                        updateInput(input.id, {
                          default: coerceDefault(e.target.value, input.valueType),
                        })
                      }
                      data-testid={`roll-action-input-default-${input.id}`}
                      disabled={disabled}
                    />
                  </label>
                  <button
                    type="button"
                    className={styles.removeButton}
                    onClick={() => removeInput(input.id)}
                    aria-label={t("editor.action.roll.inputs.remove", { id: input.id })}
                    data-testid={`roll-action-input-remove-${input.id}`}
                    disabled={disabled}
                  >
                    {t("editor.action.roll.inputs.remove.label")}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <div className={styles.row}>
        <button
          type="button"
          className={styles.addButton}
          onClick={addInput}
          data-testid={`roll-action-inputs-add-${action.id}`}
          disabled={disabled}
        >
          {t("editor.action.roll.inputs.add")}
        </button>
      </div>
      <div className={styles.tryItRow}>
        <button
          type="button"
          className={styles.tryItButton}
          onClick={runTryIt}
          data-testid={`roll-action-try-${action.id}`}
          disabled={disabled}
        >
          {t("editor.action.roll.tryIt")}
        </button>
      </div>
      {showEmpty ? (
        <p data-testid={`roll-action-try-empty-${action.id}`}>
          {t("editor.action.roll.tryIt.empty")}
        </p>
      ) : (
        <div
          className={styles.resultSheet}
          data-testid={`roll-action-try-result-${action.id}`}
          aria-label={t("editor.action.roll.tryIt.title")}
        >
          <h4>{t("editor.action.roll.tryIt.title")}</h4>
          <div className={styles.resultRow}>
            <span className={styles.resultLabel}>{t("editor.action.roll.tryIt.audience")}</span>
            <span data-testid={`roll-action-try-audience-${action.id}`}>
              {t("editor.action.roll.tryIt.audience.preview")}
            </span>
          </div>
          {tryItResult !== null && tryItResult.result.diagnostics.length > 0 ? (
            <div className={styles.resultRow}>
              <span className={styles.resultLabel}>{t("editor.action.roll.tryIt.diagnostics")}</span>
              <ul
                className={styles.diagnosticList}
                data-testid={`roll-action-try-diagnostics-${action.id}`}
              >
                {tryItResult.result.diagnostics.map((d, i) => (
                  <li
                    key={`${d.code}-${i}`}
                    className={styles.diagnosticItem}
                    data-code={d.code}
                    data-testid={`roll-action-try-diagnostic-${action.id}`}
                  >
                    {t("editor.action.roll.tryIt.diagnostic", { code: d.code, message: d.message })}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {tryItResult !== null && tryItResult.result.ok && tryItResult.result.roll !== null ? (
            <>
              <div className={styles.resultRow}>
                <span className={styles.resultLabel}>{t("editor.action.roll.tryIt.expression")}</span>
                <span
                  className={styles.formatted}
                  data-testid={`roll-action-try-expression-${action.id}`}
                >
                  {tryItResult.result.expression}
                </span>
              </div>
              <div className={styles.resultRow}>
                <span className={styles.resultLabel}>{t("editor.action.roll.tryIt.dice")}</span>
                <ul
                  className={styles.diceList}
                  data-testid={`roll-action-try-dice-${action.id}`}
                >
                  {tryItResult.result.roll.dice.map((d, i) => (
                    <li
                      key={`${d.sides}-${i}`}
                      className={styles.diceChip}
                      data-kept={d.kept ? "true" : "false"}
                      data-testid={`roll-action-try-die-${action.id}`}
                    >
                      d{d.sides}={d.value}
                    </li>
                  ))}
                </ul>
              </div>
              <div className={styles.resultRow}>
                <span className={styles.resultLabel}>{t("editor.action.roll.tryIt.modifiers")}</span>
                <span
                  data-testid={`roll-action-try-modifiers-${action.id}`}
                >
                  {modifiers ?? 0}
                </span>
              </div>
              <div className={styles.resultRow}>
                <span className={styles.resultLabel}>{t("editor.action.roll.tryIt.total")}</span>
                <span
                  data-testid={`roll-action-try-total-${action.id}`}
                >
                  {tryItResult.result.roll.total}
                </span>
              </div>
              <div className={styles.resultRow}>
                <span className={styles.resultLabel}>{t("editor.action.roll.tryIt.formatted")}</span>
                <span
                  className={styles.formatted}
                  data-testid={`roll-action-try-formatted-${action.id}`}
                >
                  {formatOutput(action.outputTemplate, tryItResult.result.roll.total)}
                </span>
              </div>
            </>
          ) : tryItResult !== null && tryItResult.result.ok ? (
            <div className={styles.resultRow}>
              <span className={styles.resultLabel}>{t("editor.action.roll.tryIt.total")}</span>
              <span data-testid={`roll-action-try-total-${action.id}`}>
                {String(tryItResult.result.value)}
              </span>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}

function buildTryItBindings(
  inputs: ReadonlyArray<ActionInputV1>,
  fieldTypes: Record<string, ValueType>,
): Record<string, ScalarValue> {
  const out: Record<string, ScalarValue> = {};
  for (const input of inputs) {
    out[input.id] = input.default;
  }
  for (const [id, vt] of Object.entries(fieldTypes)) {
    if (!(id in out)) out[id] = defaultBinding(vt);
  }
  return out;
}
