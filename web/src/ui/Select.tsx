import type { SelectHTMLAttributes } from "react";

import { FormField } from "./FormField.js";
import styles from "./fields.module.css";

export type SelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
  /** Options sharing a group are rendered in one labelled `<optgroup>`, in first-seen order. */
  group?: string;
};

function renderOption(option: SelectOption) {
  return (
    <option key={option.value} value={option.value} disabled={option.disabled}>
      {option.label}
    </option>
  );
}

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
        {options.some((option) => option.group !== undefined)
          ? groupOptions(options).map(({ group, items }, index) => group === undefined
            ? items.map(renderOption)
            : <optgroup key={`${group}-${index}`} label={group}>{items.map(renderOption)}</optgroup>)
          : options.map(renderOption)}
      </select>
    </FormField>
  );
}

/** Consecutive runs of options with the same group (ungrouped options stay where they are). */
function groupOptions(options: ReadonlyArray<SelectOption>): Array<{ group: string | undefined; items: SelectOption[] }> {
  const runs: Array<{ group: string | undefined; items: SelectOption[] }> = [];
  for (const option of options) {
    const last = runs[runs.length - 1];
    if (last !== undefined && last.group === option.group) last.items.push(option);
    else runs.push({ group: option.group, items: [option] });
  }
  return runs;
}
