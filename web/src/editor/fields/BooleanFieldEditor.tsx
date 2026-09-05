import type { BooleanFieldV1, FieldV1 } from "../../state/documentFieldTypes.js";
import { DefinitionIdInput } from "./DefinitionIdInput.js";
import styles from "./FieldEditor.module.css";

function isBoolean(field: FieldV1): field is BooleanFieldV1 {
  return field.kind === "boolean";
}

export type BooleanFieldEditorProps = {
  field: FieldV1;
  onChange: (next: FieldV1) => void;
  referencedBy?: number | undefined;
  disabled?: boolean | undefined;
};

export function BooleanFieldEditor({
  field,
  onChange,
  referencedBy,
  disabled,
}: BooleanFieldEditorProps) {
  if (!isBoolean(field)) {
    return (
      <p className={styles.unsupported} data-testid="boolean-field-unsupported">
        Unsupported boolean kind: {field.kind}
      </p>
    );
  }
  const update = (patch: Partial<BooleanFieldV1>) => {
    onChange({ ...field, ...patch });
  };
  return (
    <section className={styles.field} data-testid={`boolean-field-${field.id}`}>
      <div className={styles.row}>
        <DefinitionIdInput
          value={field.id}
          onChange={(next) => update({ id: next })}
          referencedBy={referencedBy}
          disabled={disabled}
        />
      </div>
      <div className={styles.row}>
        <label className={styles.field} htmlFor={`boolean-field-label-${field.id}`}>
          Label
          <input
            id={`boolean-field-label-${field.id}`}
            type="text"
            value={field.label}
            maxLength={120}
            onChange={(e) => update({ label: e.target.value })}
            data-testid={`boolean-field-label-${field.id}`}
            disabled={disabled}
          />
        </label>
        <label className={styles.checkbox}>
          <input
            type="checkbox"
            checked={field.required}
            onChange={(e) => update({ required: e.target.checked })}
            data-testid={`boolean-field-required-${field.id}`}
            disabled={disabled}
          />
          Required
        </label>
      </div>
      <div className={styles.row}>
        <fieldset className={styles.options} disabled={disabled}>
          <legend>Default</legend>
          {(
            [
              { value: true, label: "True" },
              { value: false, label: "False" },
            ] as const
          ).map((opt) => (
            <label key={opt.label} className={styles.checkbox}>
              <input
                type="radio"
                name={`boolean-field-default-${field.id}`}
                checked={field.default === opt.value}
                onChange={() => update({ default: opt.value })}
                data-testid={`boolean-field-default-${opt.value ? "true" : "false"}-${field.id}`}
              />
              {opt.label}
            </label>
          ))}
        </fieldset>
      </div>
    </section>
  );
}
