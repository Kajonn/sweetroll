import {
  cloneElement,
  isValidElement,
  useId,
  type ReactElement,
  type ReactNode,
} from "react";

import styles from "./fields.module.css";

export type FormFieldProps = {
  label: ReactNode;
  id?: string | undefined;
  hint?: ReactNode;
  error?: ReactNode;
  optional?: boolean;
  children: ReactNode;
};

/**
 * Accessible label/hint/error wrapper for a single native control.
 * Clones the child control to attach id, aria-describedby, and aria-invalid.
 */
export function FormField({ label, id: idProp, hint, error, optional = false, children }: FormFieldProps) {
  const generated = useId();
  const fallbackId = idProp ?? `ui-field-${generated.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  // The caller may pass its own id directly on the control child. The label
  // must follow the control's actual id or the association breaks.
  const childId =
    isValidElement(children) &&
    typeof (children as ReactElement<{ id?: unknown }>).props.id === "string"
      ? ((children as ReactElement<{ id?: string }>).props.id as string)
      : undefined;
  const id = childId && childId !== "" ? childId : fallbackId;
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;

  let control = children;
  if (isValidElement(children)) {
    const element = children as ReactElement<{
      id?: string | undefined;
      "aria-describedby"?: string | undefined;
      "aria-invalid"?: boolean | "true" | "false" | undefined;
    }>;
    const describedByValue = [element.props["aria-describedby"], hintId, errorId]
      .filter((part): part is string => Boolean(part))
      .join(" ");
    const extraProps: {
      id?: string;
      "aria-describedby"?: string;
      "aria-invalid"?: boolean;
    } = { id: element.props.id ?? id };
    if (describedByValue !== "") extraProps["aria-describedby"] = describedByValue;
    if (error) extraProps["aria-invalid"] = true;
    control = cloneElement(element, extraProps);
  }

  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        {label}
        {optional ? <span className={styles.optional}> (optional)</span> : null}
      </label>
      {control}
      {hint && !error ? (
        <p id={hintId} className={styles.hint}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
