import { useEffect, useState, type Dispatch } from "react";

import { t } from "../../i18n/index.js";
import {
  tokenizeExpression,
  type ExpressionDiagnostic,
} from "../../ports/expressions.js";
import type {
  DocumentAction,
  SystemDocumentV1,
} from "../../state/documentReducer.js";
import type {
  ComputedFieldV1,
  FieldV1,
} from "../../state/documentFieldTypes.js";
import { commitComputedSource } from "../DocumentEditor.js";
import { DefinitionIdInput } from "./DefinitionIdInput.js";
import styles from "./FieldEditor.module.css";

function isComputed(field: FieldV1): field is ComputedFieldV1 {
  return field.kind === "computed";
}

export type ComputedFieldEditorProps = {
  field: FieldV1;
  onChange: (next: FieldV1) => void;
  /** Current expression source (lives in document.expressions, keyed by field.expressionId). */
  expressionSource?: string | undefined;
  /** Commit an edited source back to the document (called on blur). */
  onExpressionSourceChange?: ((next: string) => void) | undefined;
  /** Current expression fallback (lives in document.expressions). */
  fallback?: unknown;
  /** Commit an edited fallback back to the document (called on blur/select). */
  onFallbackChange?: ((next: unknown) => void) | undefined;
  /**
   * Document + dispatch for direct write-back via `commitComputedSource`.
   * When both are provided (and the field's expressionId already exists in
   * the document), blur commits go through the helper; the optional
   * callbacks above remain the fallback path for dispatch-less use or for
   * entries not yet in `document.expressions`.
   */
  document?: SystemDocumentV1 | undefined;
  dispatch?: Dispatch<DocumentAction> | undefined;
  referencedBy?: number | undefined;
  disabled?: boolean | undefined;
};

export function ComputedFieldEditor({
  field,
  onChange,
  expressionSource,
  onExpressionSourceChange,
  fallback,
  onFallbackChange,
  document,
  dispatch,
  referencedBy,
  disabled,
}: ComputedFieldEditorProps) {
  // Local drafts are ephemeral edit buffers only: the source of truth stays
  // in document.expressions and every blur commits the draft back through
  // the callbacks above. Hooks run unconditionally so a kind change across
  // renders cannot reorder them.
  const [draftSource, setDraftSource] = useState(expressionSource ?? "");
  useEffect(() => {
    setDraftSource(expressionSource ?? "");
  }, [expressionSource]);
  const tokenizeResult = tokenizeExpression(draftSource);
  const diagnostics: ReadonlyArray<ExpressionDiagnostic> = tokenizeResult.ok
    ? []
    : tokenizeResult.diagnostics;

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
  const commitSource = () => {
    if (
      document !== undefined &&
      dispatch !== undefined &&
      field.expressionId !== "" &&
      document.expressions?.some((entry) => entry.id === field.expressionId)
    ) {
      commitComputedSource(document, dispatch, field.expressionId, draftSource);
    } else {
      onExpressionSourceChange?.(draftSource);
    }
  };

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
            onBlur={commitSource}
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
            fallback={fallback}
            onFallbackChange={onFallbackChange}
            document={document}
            dispatch={dispatch}
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

function fallbackToDraft(fallback: unknown, valueType: ComputedFieldV1["valueType"]): string {
  if (valueType === "boolean") {
    if (fallback === true) return "true";
    if (fallback === false) return "false";
    return "";
  }
  if (valueType === "number") return typeof fallback === "number" ? String(fallback) : "";
  return typeof fallback === "string" ? fallback : "";
}

function parseFallback(raw: string, valueType: ComputedFieldV1["valueType"]): unknown {
  if (valueType === "boolean") return raw === "true";
  if (valueType === "number") {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return raw;
}

function FallbackInput({
  field,
  fallback,
  onFallbackChange,
  document,
  dispatch,
  disabled,
}: {
  field: ComputedFieldV1;
  fallback: unknown;
  onFallbackChange: ((next: unknown) => void) | undefined;
  document: SystemDocumentV1 | undefined;
  dispatch: Dispatch<DocumentAction> | undefined;
  disabled: boolean | undefined;
}) {
  // Ephemeral edit buffer: commits go through `commitComputedSource` when
  // document + dispatch are available (preserving the stored source), and
  // to onFallbackChange otherwise, so the document keeps the source of truth.
  const commitFallback = (next: unknown) => {
    const entry =
      document !== undefined && field.expressionId !== ""
        ? document.expressions?.find((candidate) => candidate.id === field.expressionId)
        : undefined;
    if (document !== undefined && dispatch !== undefined && entry !== undefined) {
      commitComputedSource(document, dispatch, entry.id, entry.source, next);
    } else {
      onFallbackChange?.(next);
    }
  };
  const [draft, setDraft] = useState<string>(() => fallbackToDraft(fallback, field.valueType));
  useEffect(() => {
    setDraft(fallbackToDraft(fallback, field.valueType));
  }, [fallback, field.valueType]);
  if (field.valueType === "boolean") {
    return (
      <select
        id={`computed-field-fallback-${field.id}`}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          commitFallback(e.target.value === "true");
        }}
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
        onBlur={(e) => commitFallback(parseFallback(e.target.value, field.valueType))}
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
      onBlur={(e) => commitFallback(parseFallback(e.target.value, field.valueType))}
      data-testid={`computed-field-fallback-${field.id}`}
      disabled={disabled}
    />
  );
}
