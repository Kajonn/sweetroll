import { t } from "../../i18n/index.js";
import { Button, FormField } from "../../ui/index.js";
import styles from "../actions/RollActionEditor.module.css";

export type DefinitionId = string;

export type ReferenceDataScalarValue = string | number | boolean | null;

export type ReferenceRecordV1 = {
  id: DefinitionId;
  label: string;
  values: Record<DefinitionId, ReferenceDataScalarValue>;
};

export type ReferenceDataV1 = {
  id: DefinitionId;
  label: string;
  records: ReferenceRecordV1[];
};

export type ReferenceDataEditorProps = {
  referenceData: ReferenceDataV1;
  onChange: (next: ReferenceDataV1) => void;
  disabled?: boolean | undefined;
};

function nextRecordId(existing: ReadonlyArray<ReferenceRecordV1>): DefinitionId {
  for (let i = 1; i < 10_000; i++) {
    const candidate = `record_${i}`;
    if (!existing.some((r) => r.id === candidate)) return candidate;
  }
  return `record_${Date.now()}`;
}

function defaultRecord(existing: ReadonlyArray<ReferenceRecordV1>): ReferenceRecordV1 {
  return {
    id: nextRecordId(existing),
    label: "",
    values: {},
  };
}

function serializeValues(values: Record<DefinitionId, ReferenceDataScalarValue>): string {
  const entries = Object.entries(values);
  if (entries.length === 0) return "{}";
  return JSON.stringify(Object.fromEntries(entries), null, 2);
}

function parseValues(source: string): Record<DefinitionId, ReferenceDataScalarValue> {
  const trimmed = source.trim();
  if (trimmed === "" || trimmed === "{}") return {};
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<DefinitionId, ReferenceDataScalarValue> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean" || v === null) {
        out[k] = v;
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function ReferenceDataEditor({
  referenceData,
  onChange,
  disabled,
}: ReferenceDataEditorProps) {
  const setLabel = (label: string) => {
    onChange({ ...referenceData, label });
  };

  const replaceRecord = (id: DefinitionId, patch: Partial<ReferenceRecordV1>) => {
    const records = referenceData.records.map((r) =>
      r.id === id ? { ...r, ...patch } : r,
    );
    onChange({ ...referenceData, records });
  };

  const removeRecord = (id: DefinitionId) => {
    onChange({
      ...referenceData,
      records: referenceData.records.filter((r) => r.id !== id),
    });
  };

  const addRecord = () => {
    const record = defaultRecord(referenceData.records);
    onChange({ ...referenceData, records: [...referenceData.records, record] });
  };

  return (
    <section
      className={styles.layout}
      data-testid={`reference-data-${referenceData.id}`}
      aria-label={referenceData.label || referenceData.id}
    >
      <div className={styles.row}>
        <span
          className={styles.field}
          data-testid={`reference-data-typeId-${referenceData.id}`}
          aria-label={t("editor.referenceData.typeId")}
        >
          {t("editor.referenceData.typeIdLabel", { id: referenceData.id })}
        </span>
        <div className={styles.field}>
          <FormField label={t("editor.referenceData.label")}>
            <input
              id={`reference-data-label-${referenceData.id}`}
              type="text"
              value={referenceData.label}
              maxLength={120}
              onChange={(e) => setLabel(e.target.value)}
              data-testid={`reference-data-label-${referenceData.id}`}
              disabled={disabled}
            />
          </FormField>
        </div>
      </div>
      <div className={styles.row} data-testid={`reference-data-records-${referenceData.id}`}>
        <div className={styles.field}>
          {t("editor.referenceData.records")}
          {referenceData.records.length === 0 ? (
            <span data-testid={`reference-data-records-empty-${referenceData.id}`}>
              {t("editor.referenceData.empty")}
            </span>
          ) : (
            <ul className={styles.inputsList}>
              {referenceData.records.map((record) => (
                <li
                  key={record.id}
                  className={styles.inputItem}
                  data-testid={`reference-data-record-${record.id}`}
                >
                  <div className={styles.field}>
                    <FormField label={t("editor.referenceData.recordId")}>
                      <input
                        id={`reference-data-record-id-${record.id}`}
                        type="text"
                        value={record.id}
                        onChange={(e) => replaceRecord(record.id, { id: e.target.value })}
                        data-testid={`reference-data-record-id-${record.id}`}
                        disabled={disabled}
                      />
                    </FormField>
                  </div>
                  <div className={styles.field}>
                    <FormField label={t("editor.referenceData.recordLabel")}>
                      <input
                        id={`reference-data-record-label-${record.id}`}
                        type="text"
                        value={record.label}
                        maxLength={120}
                        onChange={(e) => replaceRecord(record.id, { label: e.target.value })}
                        data-testid={`reference-data-record-label-${record.id}`}
                        disabled={disabled}
                      />
                    </FormField>
                  </div>
                  <div className={styles.field}>
                    <FormField label={t("editor.referenceData.values")}>
                      <textarea
                        id={`reference-data-record-values-${record.id}`}
                        value={serializeValues(record.values)}
                        onChange={(e) =>
                          replaceRecord(record.id, { values: parseValues(e.target.value) })
                        }
                        placeholder={t("editor.referenceData.valuesPlaceholder")}
                        data-testid={`reference-data-record-values-${record.id}`}
                        disabled={disabled}
                        rows={4}
                      />
                    </FormField>
                  </div>
                  <Button
                    variant="secondary"
                    className={styles.removeButton}
                    onClick={() => removeRecord(record.id)}
                    aria-label={t("editor.referenceData.removeRecord", { id: record.id })}
                    data-testid={`reference-data-record-remove-${record.id}`}
                    disabled={disabled}
                  >
                    {t("editor.referenceData.removeRecordLabel")}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <div className={styles.row}>
        <Button
          variant="secondary"
          onClick={addRecord}
          data-testid={`reference-data-records-add-${referenceData.id}`}
          disabled={disabled}
        >
          {t("editor.referenceData.addRecord")}
        </Button>
      </div>
    </section>
  );
}
