import { useId, useRef } from "react";

import styles from "./fields.module.css";

export type NumberInputProps = {
  label: string;
  id?: string;
  testId?: string;
  value?: number;
  defaultValue?: number;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  pending?: boolean;
  hint?: string;
  error?: string;
  optional?: boolean;
  decrementLabel?: string;
  incrementLabel?: string;
  onChange?: (value: number | null) => void;
};

/**
 * Native number input with step buttons. onChange receives null when
 * empty/invalid. The label binds directly to the native input; hint and
 * error text are linked via aria-describedby. Error text supersedes hint
 * text so screen readers hear one message.
 */
export function NumberInput({
  label,
  id: idProp,
  testId,
  value,
  defaultValue,
  min,
  max,
  step,
  disabled = false,
  pending = false,
  hint,
  error,
  optional = false,
  decrementLabel = "Decrease value",
  incrementLabel = "Increase value",
  onChange,
}: NumberInputProps) {
  const generated = useId();
  const id = idProp ?? `ui-number-${generated.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const inputRef = useRef<HTMLInputElement>(null);
  const isDisabled = disabled || pending;
  const shownHint = pending ? "Saving…" : hint;

  const emit = (raw: string) => {
    if (!onChange) return;
    if (raw.trim() === "") {
      onChange(null);
      return;
    }
    const parsed = Number(raw);
    onChange(Number.isFinite(parsed) ? parsed : null);
  };

  const nudge = (direction: 1 | -1) => {
    const input = inputRef.current;
    if (!input || isDisabled) return;
    if (direction === 1) input.stepUp();
    else input.stepDown();
    emit(input.value);
  };

  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        {label}
        {optional ? <span className={styles.optional}> (optional)</span> : null}
      </label>
      <div className={styles.numberWrap}>
        <button
          type="button"
          aria-label={decrementLabel}
          aria-controls={id}
          disabled={isDisabled}
          onClick={() => nudge(-1)}
          className={styles.stepButton}
          data-testid={`${id}-decrement`}
        >
          <span aria-hidden="true">−</span>
        </button>
        <input
          ref={inputRef}
          id={id}
          type="number"
          data-testid={testId}
          className={styles.input}
          value={value}
          defaultValue={value === undefined ? defaultValue : undefined}
          min={min}
          max={max}
          step={step}
          disabled={isDisabled}
          aria-busy={pending || undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={[shownHint && !error ? hintId : null, error ? errorId : null]
            .filter((part): part is string => part !== null)
            .join(" ") || undefined}
          onChange={(event) => emit(event.target.value)}
        />
        <button
          type="button"
          aria-label={incrementLabel}
          aria-controls={id}
          disabled={isDisabled}
          onClick={() => nudge(1)}
          className={styles.stepButton}
          data-testid={`${id}-increment`}
        >
          <span aria-hidden="true">+</span>
        </button>
      </div>
      {shownHint && !error ? (
        <p id={hintId} className={styles.hint}>
          {shownHint}
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
