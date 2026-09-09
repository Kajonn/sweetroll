import { listKeys, t } from "../../i18n/index.js";
import { FormField, Select } from "../../ui/index.js";
import { ExpressionEditor } from "../expressions/ExpressionEditor.js";
import styles from "../actions/RollActionEditor.module.css";

export type DefinitionId = string;

export type ValidationSeverityV1 = "error" | "warning";

export type ValidationV1 = {
  id: DefinitionId;
  expressionId: DefinitionId;
  severity: ValidationSeverityV1;
  message: string;
  targetId: DefinitionId;
};

export type ValidationExpressionOption = {
  id: DefinitionId;
  label: string;
};

export type ValidationTargetOption = {
  id: DefinitionId;
  label: string;
};

export type ValidationEditorProps = {
  client: import("../../api/client.js").ApiClient;
  systemId: string;
  validation: ValidationV1;
  onChange: (next: ValidationV1) => void;
  expressionSource: string;
  onExpressionSourceChange: (next: string) => void;
  availableExpressions: ReadonlyArray<ValidationExpressionOption>;
  availableTargets: ReadonlyArray<ValidationTargetOption>;
  disabled?: boolean | undefined;
};

export function ValidationEditor({
  client,
  systemId,
  validation,
  onChange,
  expressionSource,
  onExpressionSourceChange,
  availableExpressions,
  availableTargets,
  disabled,
}: ValidationEditorProps) {
  const setSeverity = (severity: ValidationSeverityV1) => {
    onChange({ ...validation, severity });
  };

  const setExpressionId = (expressionId: DefinitionId) => {
    onChange({ ...validation, expressionId });
  };

  const setMessage = (message: string) => {
    onChange({ ...validation, message });
  };

  const setTargetId = (targetId: DefinitionId) => {
    onChange({ ...validation, targetId });
  };

  return (
    <section
      className={styles.layout}
      data-testid={`validation-${validation.id}`}
      aria-label={validation.message || validation.id}
    >
      <div className={styles.row}>
        <div className={styles.field}>
          <Select
            label={t("editor.validation.severity")}
            id={`validation-severity-${validation.id}`}
            value={validation.severity}
            onChange={(e) => setSeverity(e.target.value as ValidationSeverityV1)}
            data-testid={`validation-severity-${validation.id}`}
            disabled={disabled}
            options={[
              { value: "error", label: t("editor.validation.severity.error") },
              { value: "warning", label: t("editor.validation.severity.warning") },
            ]}
          />
        </div>
        <div className={styles.field}>
          <Select
            label={t("editor.validation.expressionId")}
            id={`validation-expression-id-${validation.id}`}
            value={validation.expressionId}
            onChange={(e) => setExpressionId(e.target.value)}
            data-testid={`validation-expression-id-${validation.id}`}
            disabled={disabled}
            options={[
              { value: "", label: t("editor.validation.expressionId.empty") },
              ...availableExpressions.map((expr) => ({ value: expr.id, label: `${expr.label} (${expr.id})` })),
            ]}
          />
        </div>
        <div className={styles.field}>
          <Select
            label={t("editor.validation.targetId")}
            id={`validation-target-id-${validation.id}`}
            value={validation.targetId}
            onChange={(e) => setTargetId(e.target.value)}
            data-testid={`validation-target-id-${validation.id}`}
            disabled={disabled}
            options={[
              { value: "", label: t("editor.validation.targetId.empty") },
              ...availableTargets.map((target) => ({ value: target.id, label: `${target.label} (${target.id})` })),
            ]}
          />
        </div>
      </div>
      <ExpressionEditor
        client={client}
        systemId={systemId}
        source={expressionSource}
        onSourceChange={onExpressionSourceChange}
        expressionId={validation.expressionId}
        disabled={disabled === true}
      />
      <div className={styles.row}>
        <div className={styles.field}>
          <FormField label={t("editor.validation.message")}>
            <input
              id={`validation-message-${validation.id}`}
              type="text"
              list={`validation-message-options-${validation.id}`}
              value={validation.message}
              maxLength={2000}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={t("editor.validation.message.placeholder")}
              data-testid={`validation-message-${validation.id}`}
              disabled={disabled}
            />
          </FormField>
          <datalist
            id={`validation-message-options-${validation.id}`}
            data-testid={`validation-message-options-${validation.id}`}
          >
            {listKeys().map((key) => (
              <option key={key} value={key} />
            ))}
          </datalist>
        </div>
      </div>
    </section>
  );
}
