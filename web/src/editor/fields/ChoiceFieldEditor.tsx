import type { ReferenceDataV1 } from "../referenceData/ReferenceDataEditor.js";
import { t } from "../../i18n/index.js";
import type {
  ChoiceOptionV1,
  FieldV1,
  MultiChoiceFieldV1,
  SingleChoiceFieldV1,
} from "../../state/documentFieldTypes.js";
import { DefinitionIdInput } from "./DefinitionIdInput.js";
import styles from "./FieldEditor.module.css";

type ChoiceField = Extract<FieldV1, { kind: "singleChoice" | "multiChoice" }>;

function isChoice(field: FieldV1): field is ChoiceField {
  return field.kind === "singleChoice" || field.kind === "multiChoice";
}

function newOptionId(existing: ChoiceOptionV1[]): string {
  for (let i = 1; i < 10_000; i++) {
    const candidate = `option_${i}`;
    if (!existing.some((o) => o.id === candidate)) return candidate;
  }
  return `option_${Date.now()}`;
}

export type ChoiceFieldEditorProps = {
  field: FieldV1;
  onChange: (next: FieldV1) => void;
  datasets?: readonly ReferenceDataV1[] | undefined;
  referencedBy?: number | undefined;
  disabled?: boolean | undefined;
};

export function ChoiceFieldEditor({
  field,
  onChange,
  datasets,
  referencedBy,
  disabled,
}: ChoiceFieldEditorProps) {
  if (!isChoice(field)) {
    return (
      <p className={styles.unsupported} data-testid="choice-field-unsupported">
        {t("editor.fields.unsupported.choice", { kind: field.kind })}
      </p>
    );
  }
  const datasetId = field.optionsFrom;
  const fromDataset = datasetId !== undefined;
  const selectedDataset = datasets?.find(dataset => dataset.id === datasetId);
  const options = fromDataset ? selectedDataset?.records ?? [] : field.options;
  const chooseDataset = (id: string) => {
    const { optionsFrom: _old, ...next } = field;
    const defaultValue = field.kind === "singleChoice" ? null : [];
    onChange({ ...next, default: defaultValue, ...(id === "" ? {} : { optionsFrom: id }) } as ChoiceField);
  };
  const update = (patch: Partial<ChoiceField>) => {
    onChange({ ...field, ...patch } as ChoiceField);
  };

  const updateOption = (index: number, patch: Partial<ChoiceOptionV1>) => {
    const options = field.options.map((opt, i) => (i === index ? { ...opt, ...patch } : opt));
    update({ options });
  };

  const addOption = () => {
    const id = newOptionId(field.options);
    update({ options: [...field.options, { id, label: id }] });
  };

  const removeOption = (index: number) => {
    const target = field.options[index];
    const options = field.options.filter((_, i) => i !== index);
    let next: ChoiceField = { ...field, options } as ChoiceField;
    if (field.kind === "singleChoice" && target !== undefined && field.default === target.id) {
      next = { ...next, default: null } as ChoiceField;
    }
    if (field.kind === "multiChoice" && target !== undefined) {
      next = {
        ...next,
        default: field.default.filter((id) => id !== target.id),
      } as ChoiceField;
    }
    onChange(next);
  };

  return (
    <section className={styles.field} data-testid={`choice-field-${field.id}`}>
      <div className={styles.row}>
        <label className={styles.field} htmlFor={`choice-field-label-${field.id}`}>
          {t("editor.fields.label")}
          <input
            id={`choice-field-label-${field.id}`}
            type="text"
            value={field.label}
            maxLength={120}
            onChange={(e) => update({ label: e.target.value })}
            data-testid={`choice-field-label-${field.id}`}
            disabled={disabled}
          />
        </label>
        <label className={styles.checkbox}>
          <input
            type="checkbox"
            checked={field.required}
            onChange={(e) => update({ required: e.target.checked })}
            data-testid={`choice-field-required-${field.id}`}
            disabled={disabled}
          />
          {t("editor.fields.required")}
        </label>
      </div>
      {fromDataset || (datasets?.length ?? 0) > 0 ? <label>
        {t("editor.fields.options.dataset")}
        <select value={datasetId ?? ""} onChange={event => chooseDataset(event.target.value)} disabled={disabled}>
          <option value="">{t("editor.fields.options.static")}</option>
          {fromDataset && selectedDataset === undefined && (
            <option value={datasetId} disabled>{t("editor.fields.options.missingDataset", { id: datasetId })}</option>
          )}
          {datasets?.map(dataset => <option key={dataset.id} value={dataset.id}>{dataset.label} ({dataset.id})</option>)}
        </select>
      </label> : null}
      <div className={styles.row}>
        <fieldset className={styles.options} disabled={disabled}>
          <legend>{t("editor.fields.options")}</legend>
          {options.length === 0 && (
            <p className={styles.placeholder} data-testid={`choice-field-options-empty-${field.id}`}>
              {t("editor.fields.options.placeholder")}
            </p>
          )}
          {options.map((opt, i) => (
            <div key={`${opt.id}-${i}`} className={styles.optionsRow} data-testid={`choice-field-option-${i}-${field.id}`}>
              {field.kind === "singleChoice" ? (
                <input
                  type="radio"
                  name={`choice-field-default-${field.id}`}
                  checked={field.default === opt.id}
                  onChange={() =>
                    onChange({ ...field, default: opt.id } as SingleChoiceFieldV1)
                  }
                  aria-label={t("editor.fields.options.defaultOptionAria", { label: opt.label })}
                  data-testid={`choice-field-default-radio-${i}-${field.id}`}
                />
              ) : (
                <input
                  type="checkbox"
                  checked={field.default.includes(opt.id)}
                  onChange={() => {
                    const set = new Set(field.default);
                    if (set.has(opt.id)) set.delete(opt.id);
                    else set.add(opt.id);
                    onChange({
                      ...field,
                      default: Array.from(set),
                    } as MultiChoiceFieldV1);
                  }}
                  aria-label={t("editor.fields.options.defaultOptionAria", { label: opt.label })}
                  data-testid={`choice-field-default-checkbox-${i}-${field.id}`}
                />
              )}
              <input
                type="text"
                value={opt.label}
                maxLength={120}
                onChange={(e) => updateOption(i, { label: e.target.value })}
                aria-label={t("editor.fields.options.optionLabel")}
                data-testid={`choice-field-option-label-${i}-${field.id}`}
                disabled={disabled || fromDataset}
              />
              <button
                type="button"
                onClick={() => removeOption(i)}
                aria-label={t("editor.fields.options.removeOptionAria", { label: opt.label })}
                data-testid={`choice-field-option-remove-${i}-${field.id}`}
                disabled={disabled || fromDataset}
              >
                {t("editor.fields.options.removeOption")}
              </button>
            </div>
          ))}
          <button
            type="button"
            className={styles.addOption}
            onClick={addOption}
            data-testid={`choice-field-add-option-${field.id}`}
            disabled={disabled || fromDataset}
          >
            {t("editor.fields.options.addOption")}
          </button>
        </fieldset>
      </div>
      <div className={styles.row}>
        <DefinitionIdInput
          value={field.id}
          onChange={(next) => update({ id: next })}
          referencedBy={referencedBy}
          disabled={disabled}
        />
      </div>
    </section>
  );
}
