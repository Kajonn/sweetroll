import type { InputHTMLAttributes, ReactNode } from "react";
import { useId } from "react";

import styles from "./fields.module.css";

export type CheckboxProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "children"> & {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
};

/** Native checkbox with a full-row label target, hint, and validation text. */
export function Checkbox({ label, hint, error, id: idProp, disabled = false, ...rest }: CheckboxProps) {
  const generated = useId();
  const id = idProp ?? `ui-checkbox-${generated.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter((part): part is string => Boolean(part)).join(" ") || undefined;

  return (
    <div className={styles.field}>
      <label className={styles.checkboxRow} htmlFor={id}>
        <input
          {...rest}
          id={id}
          type="checkbox"
          className={styles.checkboxInput}
          disabled={disabled}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
        />
        <span className={styles.checkboxText}>
          <span>{label}</span>
          {hint && !error ? (
            <span id={hintId} className={styles.hint}>
              {hint}
            </span>
          ) : null}
        </span>
      </label>
      {error ? (
        <p id={errorId} role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
