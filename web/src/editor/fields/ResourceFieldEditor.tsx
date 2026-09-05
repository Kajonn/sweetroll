import { t } from "../../i18n/index.js";
import type { FieldV1, ResourceFieldV1 } from "../../state/documentFieldTypes.js";
import { DefinitionIdInput } from "./DefinitionIdInput.js";
import styles from "./FieldEditor.module.css";

function isResource(field: FieldV1): field is ResourceFieldV1 {
  return field.kind === "resource";
}

export type ResourceFieldEditorProps = {
  field: FieldV1;
  onChange: (next: FieldV1) => void;
  referencedBy?: number | undefined;
  disabled?: boolean | undefined;
};

export function ResourceFieldEditor({
  field,
  onChange,
  referencedBy,
  disabled,
}: ResourceFieldEditorProps) {
  if (!isResource(field)) {
    return (
      <p className={styles.unsupported} data-testid="resource-field-unsupported">
        {t("editor.fields.unsupported.resource", { kind: field.kind })}
      </p>
    );
  }
  const update = (patch: Partial<ResourceFieldV1>) => {
    onChange({ ...field, ...patch });
  };
  const updateDefault = (patch: Partial<ResourceFieldV1["default"]>) => {
    update({ default: { ...field.default, ...patch } });
  };

  return (
    <section className={styles.field} data-testid={`resource-field-${field.id}`}>
      <div className={styles.row}>
        <DefinitionIdInput
          value={field.id}
          onChange={(next) => update({ id: next })}
          referencedBy={referencedBy}
          disabled={disabled}
        />
      </div>
      <div className={styles.row}>
        <label className={styles.field} htmlFor={`resource-field-label-${field.id}`}>
          {t("editor.fields.label")}
          <input
            id={`resource-field-label-${field.id}`}
            type="text"
            value={field.label}
            maxLength={120}
            onChange={(e) => update({ label: e.target.value })}
            data-testid={`resource-field-label-${field.id}`}
            disabled={disabled}
          />
        </label>
      </div>
      <div className={styles.row}>
        <label className={styles.field} htmlFor={`resource-field-current-${field.id}`}>
          {t("editor.fields.resource.current")}
          <input
            id={`resource-field-current-${field.id}`}
            type="number"
            step={field.step}
            value={field.default.current}
            onChange={(e) => updateDefault({ current: Number(e.target.value) })}
            data-testid={`resource-field-current-${field.id}`}
            disabled={disabled}
          />
        </label>
        <label className={styles.field} htmlFor={`resource-field-default-max-${field.id}`}>
          {t("editor.fields.resource.defaultMax")}
          <input
            id={`resource-field-default-max-${field.id}`}
            type="number"
            step={field.step}
            value={field.default.max}
            onChange={(e) => updateDefault({ max: Number(e.target.value) })}
            data-testid={`resource-field-default-max-${field.id}`}
            disabled={disabled}
          />
        </label>
      </div>
      <div className={styles.row}>
        <label className={styles.field} htmlFor={`resource-field-min-${field.id}`}>
          {t("editor.fields.min")}
          <input
            id={`resource-field-min-${field.id}`}
            type="number"
            step={field.step}
            value={field.min}
            onChange={(e) => update({ min: Number(e.target.value) })}
            data-testid={`resource-field-min-${field.id}`}
            disabled={disabled}
          />
        </label>
        <label className={styles.field} htmlFor={`resource-field-max-${field.id}`}>
          {t("editor.fields.max")}
          <input
            id={`resource-field-max-${field.id}`}
            type="number"
            step={field.step}
            value={field.max}
            onChange={(e) => update({ max: Number(e.target.value) })}
            data-testid={`resource-field-max-${field.id}`}
            disabled={disabled}
          />
        </label>
        <label className={styles.field} htmlFor={`resource-field-step-${field.id}`}>
          {t("editor.fields.step")}
          <input
            id={`resource-field-step-${field.id}`}
            type="number"
            min={1}
            value={field.step}
            onChange={(e) => update({ step: Number(e.target.value) })}
            data-testid={`resource-field-step-${field.id}`}
            disabled={disabled}
          />
        </label>
      </div>
      <div className={styles.row}>
        <fieldset className={styles.options} disabled={disabled}>
          <legend>{t("editor.fields.resource.resetRule")}</legend>
          {(
            [
              { value: "min", label: t("editor.fields.resource.resetToMin") },
              { value: "max", label: t("editor.fields.resource.resetToMax") },
            ] as const
          ).map((opt) => (
            <label key={opt.value} className={styles.checkbox}>
              <input
                type="radio"
                name={`resource-field-reset-${field.id}`}
                checked={field.resetTo === opt.value}
                onChange={() => update({ resetTo: opt.value })}
                data-testid={`resource-field-reset-to-${opt.value}-${field.id}`}
              />
              {opt.label}
            </label>
          ))}
        </fieldset>
      </div>
      <p className={styles.placeholder} data-testid={`resource-field-reset-hint-${field.id}`}>
        {t("editor.fields.resource.resetRuleHint")}
      </p>
    </section>
  );
}