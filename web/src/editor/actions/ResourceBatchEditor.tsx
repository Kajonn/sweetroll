import { t } from "../../i18n/index.js";
import type { ResourceFieldV1 } from "../../state/documentFieldTypes.js";
import { Button, FormField, NumberInput, Select } from "../../ui/index.js";
import type { ResourceBumpOperationV1 } from "./ResourceBumpEditor.js";
import styles from "./RollActionEditor.module.css";

/** Design 6.4: an ordered list of resets and amounts applied to entity resources in one command, such as a long rest. */
export type ResourceBatchActionV1 = {
  kind: "resourceBatch";
  id: string;
  label: string;
  steps: Array<{ resourceId: string; operation: ResourceBumpOperationV1 }>;
};

export type ResourceBatchEditorProps = {
  action: ResourceBatchActionV1;
  onChange: (next: ResourceBatchActionV1) => void;
  availableResources: ReadonlyArray<ResourceFieldV1>;
  disabled?: boolean | undefined;
};

const MAX_STEPS = 32;

export function ResourceBatchEditor({ action, onChange, availableResources, disabled }: ResourceBatchEditorProps) {
  const setStep = (index: number, step: ResourceBatchActionV1["steps"][number]) =>
    onChange({ ...action, steps: action.steps.map((candidate, at) => (at === index ? step : candidate)) });
  return (
    <section className={styles.layout} data-testid={`resource-batch-action-${action.id}`} aria-label={action.label}>
      <div className={styles.row}>
        <div className={styles.field}>
          <FormField label={t("editor.action.resourceBump.label")}>
            <input
              type="text"
              value={action.label}
              maxLength={120}
              onChange={(e) => onChange({ ...action, label: e.target.value })}
              data-testid={`resource-batch-action-label-${action.id}`}
              disabled={disabled}
            />
          </FormField>
        </div>
      </div>
      <ol>
        {action.steps.map((step, index) => (
          <li key={index} className={styles.row} data-testid={`resource-batch-step-${action.id}-${index}`}>
            <div className={styles.field}>
              <Select
                label={t("editor.action.resourceBump.resourceId")}
                id={`resource-batch-resource-${action.id}-${index}`}
                value={step.resourceId}
                onChange={(e) => setStep(index, { ...step, resourceId: e.target.value })}
                data-testid={`resource-batch-resource-${action.id}-${index}`}
                disabled={disabled}
                options={[
                  { value: "", label: t("editor.action.resourceBump.resourceId.empty") },
                  ...availableResources.map((r) => ({ value: r.id, label: `${r.label} (${r.id})` })),
                ]}
              />
            </div>
            <div className={styles.field}>
              <Select
                label={t("editor.action.resourceBump.operation")}
                id={`resource-batch-operation-${action.id}-${index}`}
                value={step.operation.kind}
                onChange={(e) => setStep(index, {
                  ...step, operation: e.target.value === "reset" ? { kind: "reset" } : { kind: "delta", amount: 1 },
                })}
                data-testid={`resource-batch-operation-${action.id}-${index}`}
                disabled={disabled}
                options={[
                  { value: "reset", label: t("editor.action.resourceBump.operation.reset") },
                  { value: "delta", label: t("editor.action.resourceBump.operation.delta") },
                ]}
              />
            </div>
            {step.operation.kind === "delta" ? (
              <div className={styles.field}>
                <NumberInput
                  label={t("editor.action.resourceBump.amount")}
                  id={`resource-batch-amount-${action.id}-${index}`}
                  testId={`resource-batch-amount-${action.id}-${index}`}
                  step={availableResources.find((r) => r.id === step.resourceId)?.step ?? 1}
                  value={step.operation.amount}
                  onChange={(v) => setStep(index, { ...step, operation: { kind: "delta", amount: v ?? 0 } })}
                  disabled={disabled === true}
                />
              </div>
            ) : null}
            <Button
              variant="secondary"
              onClick={() => onChange({ ...action, steps: action.steps.filter((_, at) => at !== index) })}
              data-testid={`resource-batch-remove-${action.id}-${index}`}
              disabled={disabled === true || action.steps.length === 1}
            >
              {t("editor.action.resourceBatch.removeStep")}
            </Button>
          </li>
        ))}
      </ol>
      <p className={styles.field}>{t("editor.action.resourceBatch.hint")}</p>
      <Button
        variant="secondary"
        onClick={() => onChange({ ...action, steps: [...action.steps, { resourceId: "", operation: { kind: "reset" } }] })}
        data-testid={`resource-batch-add-${action.id}`}
        disabled={disabled === true || action.steps.length >= MAX_STEPS}
      >
        {t("editor.action.resourceBatch.addStep")}
      </Button>
    </section>
  );
}
