import { t } from "../../i18n/index.js";
import type { FieldV1, ImageFieldV1 } from "../../state/documentFieldTypes.js";
import { DefinitionIdInput } from "./DefinitionIdInput.js";
import styles from "./FieldEditor.module.css";

function isImage(field: FieldV1): field is ImageFieldV1 {
  return field.kind === "image";
}

export type ImageFieldEditorProps = {
  field: FieldV1;
  onChange: (next: FieldV1) => void;
  referencedBy?: number | undefined;
  disabled?: boolean | undefined;
};

export function ImageFieldEditor({
  field,
  onChange,
  referencedBy,
  disabled,
}: ImageFieldEditorProps) {
  if (!isImage(field)) {
    return (
      <p className={styles.unsupported} data-testid="image-field-unsupported">
        {t("editor.fields.unsupported.image", { kind: field.kind })}
      </p>
    );
  }
  const update = (patch: Partial<ImageFieldV1>) => {
    onChange({ ...field, ...patch });
  };
  return (
    <section className={styles.field} data-testid={`image-field-${field.id}`}>
      <div className={styles.row}>
        <DefinitionIdInput
          value={field.id}
          onChange={(next) => update({ id: next })}
          referencedBy={referencedBy}
          disabled={disabled}
        />
      </div>
      <div className={styles.row}>
        <label className={styles.field} htmlFor={`image-field-label-${field.id}`}>
          {t("editor.fields.label")}
          <input
            id={`image-field-label-${field.id}`}
            type="text"
            value={field.label}
            maxLength={120}
            onChange={(e) => update({ label: e.target.value })}
            data-testid={`image-field-label-${field.id}`}
            disabled={disabled}
          />
        </label>
        <label className={styles.checkbox}>
          <input
            type="checkbox"
            checked={field.required}
            onChange={(e) => update({ required: e.target.checked })}
            data-testid={`image-field-required-${field.id}`}
            disabled={disabled}
          />
          {t("editor.fields.required")}
        </label>
      </div>
      <div className={styles.row}>
        <label className={styles.field} htmlFor={`image-field-url-${field.id}`}>
          {t("editor.fields.image.urlLabel")}
          <input
            id={`image-field-url-${field.id}`}
            type="text"
            value=""
            placeholder="https://"
            onChange={() => {}}
            data-testid={`image-field-url-${field.id}`}
            disabled
          />
        </label>
      </div>
      <div className={styles.imagePreview} data-testid={`image-field-preview-${field.id}`}>
        {field.label || field.id}
      </div>
      <p className={styles.hint} data-testid={`image-field-hint-${field.id}`}>
        {t("editor.fields.image.placeholder")}
      </p>
    </section>
  );
}
