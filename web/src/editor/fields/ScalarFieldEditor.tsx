import type {
  DecimalFieldV1,
  FieldV1,
  IntegerFieldV1,
  TextFieldV1,
} from "../../state/documentFieldTypes.js";
import { DefinitionIdInput } from "./DefinitionIdInput.js";
import styles from "./FieldEditor.module.css";

function isText(field: FieldV1): field is TextFieldV1 {
  return field.kind === "text";
}
function isNumeric(field: FieldV1): field is IntegerFieldV1 | DecimalFieldV1 {
  return field.kind === "integer" || field.kind === "decimal";
}

export type ScalarFieldEditorProps = {
  field: FieldV1;
  onChange: (next: FieldV1) => void;
  referencedBy?: number | undefined;
  disabled?: boolean | undefined;
};

export function ScalarFieldEditor({
  field,
  onChange,
  referencedBy,
  disabled,
}: ScalarFieldEditorProps) {
  if (isText(field)) {
    const update = (patch: Partial<TextFieldV1>) => {
      onChange({ ...field, ...patch });
    };
    return (
      <section className={styles.field} data-testid={`scalar-field-${field.id}`}>
        <div className={styles.row}>
          <DefinitionIdInput
            value={field.id}
            onChange={(next) => update({ id: next })}
            referencedBy={referencedBy}
            disabled={disabled}
          />
        </div>
        <div className={styles.row}>
          <label className={styles.field} htmlFor={`scalar-field-label-${field.id}`}>
            Label
            <input
              id={`scalar-field-label-${field.id}`}
              type="text"
              value={field.label}
              maxLength={120}
              onChange={(e) => update({ label: e.target.value })}
              data-testid={`scalar-field-label-${field.id}`}
              disabled={disabled}
            />
          </label>
          <label className={styles.checkbox}>
            <input
              type="checkbox"
              checked={field.required}
              onChange={(e) => update({ required: e.target.checked })}
              data-testid={`scalar-field-required-${field.id}`}
              disabled={disabled}
            />
            Required
          </label>
        </div>
        <div className={styles.row}>
          <label className={styles.field}>
            Default
            <input
              type="text"
              value={field.default}
              maxLength={10_000}
              onChange={(e) => update({ default: e.target.value })}
              data-testid={`scalar-field-default-${field.id}`}
              disabled={disabled}
            />
          </label>
          <label className={styles.field}>
            Min length
            <input
              type="number"
              value={field.minLength}
              onChange={(e) => update({ minLength: Number(e.target.value) })}
              data-testid={`scalar-field-min-length-${field.id}`}
              disabled={disabled}
            />
          </label>
          <label className={styles.field}>
            Max length
            <input
              type="number"
              value={field.maxLength}
              onChange={(e) => update({ maxLength: Number(e.target.value) })}
              data-testid={`scalar-field-max-length-${field.id}`}
              disabled={disabled}
            />
          </label>
        </div>
      </section>
    );
  }
  if (isNumeric(field)) {
    const update = (patch: Partial<IntegerFieldV1 | DecimalFieldV1>) => {
      onChange({ ...field, ...patch });
    };
    return (
      <section className={styles.field} data-testid={`scalar-field-${field.id}`}>
        <div className={styles.row}>
          <DefinitionIdInput
            value={field.id}
            onChange={(next) => update({ id: next })}
            referencedBy={referencedBy}
            disabled={disabled}
          />
        </div>
        <div className={styles.row}>
          <label className={styles.field} htmlFor={`scalar-field-label-${field.id}`}>
            Label
            <input
              id={`scalar-field-label-${field.id}`}
              type="text"
              value={field.label}
              maxLength={120}
              onChange={(e) => update({ label: e.target.value })}
              data-testid={`scalar-field-label-${field.id}`}
              disabled={disabled}
            />
          </label>
          <label className={styles.checkbox}>
            <input
              type="checkbox"
              checked={field.required}
              onChange={(e) => update({ required: e.target.checked })}
              data-testid={`scalar-field-required-${field.id}`}
              disabled={disabled}
            />
            Required
          </label>
        </div>
        <div className={styles.row}>
          <label className={styles.field}>
            Default
            <input
              type="number"
              step={field.step}
              value={field.default}
              onChange={(e) => update({ default: Number(e.target.value) })}
              data-testid={`scalar-field-default-${field.id}`}
              disabled={disabled}
            />
          </label>
          <label className={styles.field}>
            Min
            <input
              type="number"
              step={field.step}
              value={field.min}
              onChange={(e) => update({ min: Number(e.target.value) })}
              data-testid={`scalar-field-min-${field.id}`}
              disabled={disabled}
            />
          </label>
          <label className={styles.field}>
            Max
            <input
              type="number"
              step={field.step}
              value={field.max}
              onChange={(e) => update({ max: Number(e.target.value) })}
              data-testid={`scalar-field-max-${field.id}`}
              disabled={disabled}
            />
          </label>
          <label className={styles.field}>
            Step
            <input
              type="number"
              value={field.step}
              min={field.kind === "integer" ? 1 : undefined}
              onChange={(e) => update({ step: Number(e.target.value) })}
              data-testid={`scalar-field-step-${field.id}`}
              disabled={disabled}
            />
          </label>
        </div>
      </section>
    );
  }
  return (
    <p className={styles.unsupported} data-testid="scalar-field-unsupported">
      Unsupported scalar kind: {field.kind}
    </p>
  );
}
