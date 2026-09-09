import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

import styles from "./Button.module.css";

export type ButtonVariant = "primary" | "secondary" | "danger";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  /** Pending state: disables the button and replaces the label with pendingText. */
  pending?: boolean;
  pendingText?: string;
};

const VARIANT_CLASS: Record<ButtonVariant, string | undefined> = {
  primary: styles.buttonPrimary,
  secondary: styles.buttonSecondary,
  danger: styles.buttonDanger,
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "primary",
    pending = false,
    pendingText = "Loading…",
    disabled = false,
    type = "button",
    className,
    children,
    ...rest
  },
  ref,
) {
  const isDisabled = disabled || pending;
  const classes = [styles.button, VARIANT_CLASS[variant], className]
    .filter((part): part is string => Boolean(part))
    .join(" ");
  return (
    <button
      ref={ref}
      type={type}
      disabled={isDisabled}
      aria-busy={pending || undefined}
      className={classes}
      {...rest}
    >
      {pending ? pendingText : children}
    </button>
  );
});

export type IconButtonProps = {
  /** Accessible name. Required: icon-only buttons must expose a text label. */
  label: string;
  title?: string;
  variant?: ButtonVariant;
  disabled?: boolean;
  pending?: boolean;
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  children: ReactNode;
  className?: string;
  testId?: string;
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    label,
    title,
    variant = "secondary",
    disabled = false,
    pending = false,
    onClick,
    children,
    className,
    testId,
  },
  ref,
) {
  const isDisabled = disabled || pending;
  const classes = [styles.iconButton, VARIANT_CLASS[variant], className]
    .filter((part): part is string => Boolean(part))
    .join(" ");
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={title ?? label}
      disabled={isDisabled}
      aria-busy={pending || undefined}
      onClick={onClick}
      data-testid={testId}
      className={classes}
    >
      <span aria-hidden="true" className={styles.iconGlyph}>
        {children}
      </span>
    </button>
  );
});
