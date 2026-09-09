import type { SelectHTMLAttributes } from "react";

import { FormField } from "./FormField.js";
import styles from "./fields.module.css";

export type SelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
};

export type SelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, "children"> & {
  label: string;
  options: ReadonlyArray<SelectOption>;
  hint?: string;
  error?: string;
  optional?: boolean;
  placeholder?: string;
  pending?: boolean;
};

/** Native select wrapped with label, hint, and validation text. */
export function Select({
  label,
  options,
  hint,
  error,
  optional = false,
  placeholder,
  pending = false,
  disabled = false,
  id: idProp,
  value,
  defaultValue,
  onChange,
  required,
  name,
  ...rest
}: SelectProps) {
  const isDisabled = disabled || pending;
  return (
    <FormField label={label} id={idProp} hint={pending ? "Saving…" : hint} error={error} optional={optional}>
      <select
        className={styles.select}
        disabled={isDisabled}
        aria-busy={pending || undefined}
        value={value}
        defaultValue={defaultValue}
        onChange={onChange}
        required={required}
        name={name}
        {...rest}
      >
        {placeholder !== undefined ? (
          <option value="" disabled={required !== false}>
            {placeholder}
          </option>
        ) : null}
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
    </FormField>
  );
}
