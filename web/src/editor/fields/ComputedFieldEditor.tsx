import { useState } from "react";

import { t } from "../../i18n/index.js";
import {
  tokenizeExpression,
  type ExpressionDiagnostic,
} from "../../ports/expressions.js";
import type {
  ComputedFieldV1,
  FieldV1,
} from "../../state/documentFieldTypes.js";
import { DefinitionIdInput } from "./DefinitionIdInput.js";
import styles from "./FieldEditor.module.css";

function isComputed(field: FieldV1): field is ComputedFieldV1 {
  return field.kind === "computed";
}

export type ComputedFieldEditorProps = {
  field: FieldV1;
  onChange: (next: FieldV1) => void;
  referencedBy?: number | undefined;
  disabled?: boolean | undefined;
};

export function ComputedFieldEditor({
  field,
  onChange,
  referencedBy,
  disabled,
}: ComputedFieldEditorProps) {
  if (!isComputed(field)) {
    return (
      <p className={styles.unsupported} data-testid="computed-field-unsupported">
        {t("editor.fields.unsupported.computed", { kind: field.kind })}
      </p>
    );
  }
  const update = (patch: Partial<ComputedFieldV1>) => {
    onChange({ ...field, ...patch });
  };

  const [draftSource, setDraftSource] = useState("");
  const tokenizeResult = tokenizeExpression(draftSource);
  const diagnostics: ReadonlyArray<ExpressionDiagnostic> = tokenizeResult.ok
    ? []
    : tokenizeResult.diagnostics;

  return (
    <section className={styles.field} data-testid={`computed-field-${field.id}`}>
      <div className={styles.row}>
        <DefinitionIdInput
          value={field.id}
          onChange={(next) => update({ id: next })}
          referencedBy={referencedBy}
          disabled={disabled}
        />
      </div>
      <div className={styles.row}>
        <label className={styles.field} htmlFor={`computed-field-label-${field.id}`}>
          {t("editor.fields.label")}
          <input
            id={`computed-field-label-${field.id}`}
            type="text"
            value={field.label}
            maxLength={120}
            onChange={(e) => update({ label: e.target.value })}
            data-testid={`computed-field-label-${field.id}`}
            disabled={disabled}
          />
        </label>
        <label
          className={styles.field}
          htmlFor={`computed-field-value-type-${field.id}`}
        >
          {t("editor.fields.computed.valueType")}
          <select
            id={`computed-field-value-type-${field.id}`}
            value={field.valueType}
            onChange={(e) =>
              update({
                valueType: e.target.value as ComputedFieldV1["valueType"],
              })
            }
            data-testid={`computed-field-value-type-${field.id}`}
            disabled={disabled}
          >
            <option value="number">{t("editor.fields.computed.valueType.number")}</option>
            <option value="text">{t("editor.fields.computed.valueType.text")}</option>
            <option value="boolean">{t("editor.fields.computed.valueType.boolean")}</option>
          </select>
        </label>
      </div>
      <div className={styles.row}>
        <label
          className={styles.field}
          htmlFor={`computed-field-source-${field.id}`}
        >
          {t("editor.fields.computed.expression")}
          <textarea
            id={`computed-field-source-${field.id}`}
            value={draftSource}
            onChange={(e) => setDraftSource(e.target.value)}
            rows={4}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            placeholder={t("editor.fields.computed.expression.placeholder")}
            data-testid={`computed-field-source-${field.id}`}
            disabled={disabled}
          />
        </label>
      </div>
      <div
        className={styles.row}
        data-testid={`computed-field-diagnostics-${field.id}`}
      >
        <p className={styles.field}>
          {t("editor.fields.computed.diagnostics.title")}
          {diagnostics.length === 0 ? (
            <span data-testid={`computed-field-no-diagnostic-${field.id}`}>
              {t("editor.fields.computed.noDiagnostics")}
            </span>
          ) : (
            <ul
              className={styles.options}
              data-testid={`computed-field-diagnostic-list-${field.id}`}
            >
              {diagnostics.map((d, i) => (
                <li
                  key={`${d.code}-${i}`}
                  data-testid={`computed-field-diagnostic-${field.id}`}
                  data-code={d.code}
                >
                  {t("editor.fields.computed.diagnostic", {
                    code: d.code,
                    message: d.message,
                  })}
                </li>
              ))}
            </ul>
          )}
        </p>
      </div>
      <div className={styles.row}>
        <label
          className={styles.field}
          htmlFor={`computed-field-fallback-${field.id}`}
        >
          {t("editor.fields.computed.fallback")}
          <FallbackInput
            field={field}
            disabled={disabled}
          />
        </label>
      </div>
      <p
        className={styles.placeholder}
        data-testid={`computed-field-fallback-hint-${field.id}`}
      >
        {t("editor.fields.computed.fallback.hint")}
      </p>
    </section>
  );
}

function FallbackInput({
  field,
  disabled,
}: {
  field: ComputedFieldV1;
  disabled: boolean | undefined;
}) {
  const [draft, setDraft] = useState<string>("");
  if (field.valueType === "boolean") {
    return (
      <select
        id={`computed-field-fallback-${field.id}`}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        data-testid={`computed-field-fallback-${field.id}`}
        disabled={disabled}
      >
        <option value="true">{t("editor.fields.boolean.true")}</option>
        <option value="false">{t("editor.fields.boolean.false")}</option>
      </select>
    );
  }
  if (field.valueType === "number") {
    return (
      <input
        id={`computed-field-fallback-${field.id}`}
        type="number"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        data-testid={`computed-field-fallback-${field.id}`}
        disabled={disabled}
      />
    );
  }
  return (
    <input
      id={`computed-field-fallback-${field.id}`}
      type="text"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      data-testid={`computed-field-fallback-${field.id}`}
      disabled={disabled}
    />
  );
}
