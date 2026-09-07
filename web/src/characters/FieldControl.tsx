import { useEffect, useId, useRef, useState } from "react";

import { t } from "../i18n/index.js";
import type { CharacterView } from "./types.js";
import styles from "./characters.module.css";

export type ProjectedField = Extract<
  CharacterView["projection"]["sheets"][number]["sections"][number]["elements"][number],
  { kind: "field" }
>;

export type FieldControlProps = {
  field: ProjectedField;
  tentativeValue: unknown | null;
  disabled: boolean;
  pending: boolean;
  onCommit(fieldId: string, value: unknown): void | Promise<void>;
};

function Diagnostics({ field }: { field: ProjectedField }) {
  return field.validations.length > 0 ? <ul className={styles.validationList}>{field.validations.map(validation => <li key={validation.validationId} data-severity={validation.severity}>{validation.message}</li>)}</ul> : null;
}

function scalarText(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function isValidNumber(value: string, field: ProjectedField): number | null {
  if (value.trim() === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  if (field.fieldKind === "integer" && !Number.isInteger(number)) return null;
  if (field.constraints.min !== undefined && number < field.constraints.min) return null;
  if (field.constraints.max !== undefined && number > field.constraints.max) return null;
  return number;
}

export function FieldControl({ field, tentativeValue, disabled, pending, onCommit }: FieldControlProps) {
  const generatedId = useId();
  const inputId = `field-${field.id}-${generatedId}`;
  const errorId = `${inputId}-errors`;
  const displayed = tentativeValue ?? field.value;
  const [draft, setDraft] = useState(() => scalarText(displayed));
  const submittedOnEnter = useRef<string | null>(null);

  useEffect(() => {
    setDraft(scalarText(displayed));
  }, [displayed]);

  const commitDraft = (): boolean => {
    if (field.fieldKind === "integer" || field.fieldKind === "decimal") {
      const value = isValidNumber(draft, field);
      if (value === null) return false;
      onCommit(field.fieldId, value);
      return true;
    }
    onCommit(field.fieldId, draft);
    return true;
  };
  const describedBy = field.validations.length > 0 ? errorId : undefined;

  if (field.fieldKind === "computed") {
    return <div className={styles.field}><div className={styles.readOnlyField}><span>{field.label}</span><span>{scalarText(field.value)}</span></div><Diagnostics field={field} /></div>;
  }
  if (field.fieldKind === "image") {
    return <div className={styles.field}><div className={styles.imageUnavailable}><span>{field.label}</span><span>{t("character.image.unavailable")}</span></div><Diagnostics field={field} /></div>;
  }
  if (!field.editable) {
    return <div className={styles.field}><div className={styles.readOnlyField}><span>{field.label}</span><span>{scalarText(field.value)}</span></div><Diagnostics field={field} /></div>;
  }

  return (
    <div className={styles.field} data-pending={pending || undefined}>
      {field.fieldKind === "boolean" ? (
        <label className={styles.checkboxLabel} htmlFor={inputId}>
          <input id={inputId} type="checkbox" checked={displayed === true} disabled={disabled} onChange={(event) => onCommit(field.fieldId, event.target.checked)} aria-describedby={describedBy} />
          {field.label}
        </label>
      ) : field.fieldKind === "singleChoice" ? (
        <>
          <label htmlFor={inputId}>{field.label}</label>
          <select id={inputId} value={typeof displayed === "string" ? displayed : ""} disabled={disabled} required={field.constraints.required} onChange={(event) => onCommit(field.fieldId, event.target.value)} aria-describedby={describedBy}>
            {!field.constraints.required ? <option value="">{t("character.choice.empty")}</option> : null}
            {field.constraints.options?.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>
        </>
      ) : field.fieldKind === "multiChoice" ? (
        <fieldset className={styles.choiceList} aria-describedby={describedBy}>
          <legend>{field.label}</legend>
          {field.constraints.options?.map((option) => {
            const selected = Array.isArray(displayed) && displayed.includes(option.id);
            return <label key={option.id}><input type="checkbox" checked={selected} disabled={disabled} onChange={() => {
              const values = Array.isArray(displayed) ? displayed.filter((value): value is string => typeof value === "string") : [];
              onCommit(field.fieldId, selected ? values.filter(value => value !== option.id) : [...values, option.id]);
            }} />{option.label}</label>;
          })}
        </fieldset>
      ) : (
        <>
          <label htmlFor={inputId}>{field.label}</label>
          <input
            id={inputId}
            type={field.fieldKind === "integer" || field.fieldKind === "decimal" ? "number" : "text"}
            value={draft}
            disabled={disabled}
            required={field.constraints.required}
            min={field.constraints.min}
            max={field.constraints.max}
            step={field.constraints.step ?? (field.fieldKind === "integer" ? 1 : "any")}
            minLength={field.constraints.minLength}
            maxLength={field.constraints.maxLength}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => {
              if (submittedOnEnter.current === draft) { submittedOnEnter.current = null; return; }
              commitDraft();
            }}
            onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); if (commitDraft()) submittedOnEnter.current = draft; } }}
            aria-describedby={describedBy}
          />
        </>
      )}
      {field.validations.length > 0 ? <ul id={errorId} className={styles.validationList}>{field.validations.map(validation => <li key={validation.validationId} data-severity={validation.severity}>{validation.message}</li>)}</ul> : null}
    </div>
  );
}
