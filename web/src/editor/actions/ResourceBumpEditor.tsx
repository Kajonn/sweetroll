import { t } from "../../i18n/index.js";
import type { ResourceFieldV1 } from "../../state/documentFieldTypes.js";
import styles from "./RollActionEditor.module.css";

export type DefinitionId = string;

export type ResourceDeltaOperationV1 = {
  kind: "delta";
  amount: number;
};

export type ResourceResetOperationV1 = {
  kind: "reset";
};

export type ResourceBumpOperationV1 =
  | ResourceDeltaOperationV1
  | ResourceResetOperationV1;

export type ResourceBumpActionV1 = {
  kind: "resourceBump";
  id: DefinitionId;
  label: string;
  resourceId: DefinitionId;
  operation: ResourceBumpOperationV1;
};

export type ResourceBumpEditorProps = {
  action: ResourceBumpActionV1;
  onChange: (next: ResourceBumpActionV1) => void;
  availableResources: ReadonlyArray<ResourceFieldV1>;
  disabled?: boolean | undefined;
};

export function ResourceBumpEditor({
  action,
  onChange,
  availableResources,
  disabled,
}: ResourceBumpEditorProps) {
  const selectedResource =
    availableResources.find((r) => r.id === action.resourceId) ?? null;

  const setLabel = (label: string) => onChange({ ...action, label });
  const setResourceId = (resourceId: DefinitionId) =>
    onChange({ ...action, resourceId });

  const setOperationKind = (kind: "delta" | "reset") => {
    if (action.operation.kind === kind) return;
    if (kind === "delta") {
      onChange({ ...action, operation: { kind: "delta", amount: 1 } });
    } else {
      onChange({ ...action, operation: { kind: "reset" } });
    }
  };

  const setDeltaAmount = (amount: number) => {
    onChange({ ...action, operation: { kind: "delta", amount } });
  };

  return (
    <section
      className={styles.layout}
      data-testid={`resource-bump-action-${action.id}`}
      aria-label={action.label}
    >
      <div className={styles.row}>
        <label
          className={styles.field}
          htmlFor={`resource-bump-action-label-${action.id}`}
        >
          {t("editor.action.resourceBump.label")}
          <input
            id={`resource-bump-action-label-${action.id}`}
            type="text"
            value={action.label}
            maxLength={120}
            onChange={(e) => setLabel(e.target.value)}
            data-testid={`resource-bump-action-label-${action.id}`}
            disabled={disabled}
          />
        </label>
        <label
          className={styles.field}
          htmlFor={`resource-bump-action-resource-id-${action.id}`}
        >
          {t("editor.action.resourceBump.resourceId")}
          <select
            id={`resource-bump-action-resource-id-${action.id}`}
            value={action.resourceId}
            onChange={(e) => setResourceId(e.target.value)}
            data-testid={`resource-bump-action-resource-id-${action.id}`}
            disabled={disabled}
          >
            <option value="">
              {t("editor.action.resourceBump.resourceId.empty")}
            </option>
            {availableResources.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label} ({r.id})
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className={styles.row}>
        <fieldset
          className={styles.field}
          disabled={disabled}
          data-testid={`resource-bump-action-operation-${action.id}`}
        >
          <legend>{t("editor.action.resourceBump.operation")}</legend>
          <label>
            <input
              type="radio"
              name={`resource-bump-operation-${action.id}`}
              value="delta"
              checked={action.operation.kind === "delta"}
              onChange={() => setOperationKind("delta")}
              data-testid={`resource-bump-operation-delta-${action.id}`}
            />
            {t("editor.action.resourceBump.operation.delta")}
          </label>
          <label>
            <input
              type="radio"
              name={`resource-bump-operation-${action.id}`}
              value="reset"
              checked={action.operation.kind === "reset"}
              onChange={() => setOperationKind("reset")}
              data-testid={`resource-bump-operation-reset-${action.id}`}
            />
            {t("editor.action.resourceBump.operation.reset")}
          </label>
        </fieldset>
      </div>
      {action.operation.kind === "delta" ? (
        <>
          <div className={styles.row}>
            <label
              className={styles.field}
              htmlFor={`resource-bump-action-amount-${action.id}`}
            >
              {t("editor.action.resourceBump.amount")}
              <input
                id={`resource-bump-action-amount-${action.id}`}
                type="number"
                step={selectedResource?.step ?? 1}
                value={action.operation.amount}
                onChange={(e) => setDeltaAmount(Number(e.target.value))}
                data-testid={`resource-bump-action-amount-${action.id}`}
                disabled={disabled}
              />
            </label>
          </div>
          <p
            className={styles.field}
            data-testid={`resource-bump-action-bound-${action.id}`}
          >
            {selectedResource !== null
              ? t("editor.action.resourceBump.bound", {
                  min: selectedResource.min,
                  max: selectedResource.max,
                })
              : t("editor.action.resourceBump.bound.empty")}
          </p>
        </>
      ) : (
        <p
          className={styles.field}
          data-testid={`resource-bump-action-reset-hint-${action.id}`}
        >
          {selectedResource !== null
            ? t("editor.action.resourceBump.resetHint", {
                to: t(
                  `editor.fields.resource.resetTo${selectedResource.resetTo === "min" ? "Min" : "Max"}`,
                ),
              })
            : t("editor.action.resourceBump.resetHint.empty")}
        </p>
      )}
    </section>
  );
}
