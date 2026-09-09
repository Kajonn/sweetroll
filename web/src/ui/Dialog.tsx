import * as RadixDialog from "@radix-ui/react-dialog";
import type { ReactNode } from "react";

import { Button } from "./Button.js";
import styles from "./Dialog.module.css";

export type DialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  closeLabel?: string;
  /** Sheet slides in from the side; dialog centers. Both use the same Radix focus management. */
  variant?: "dialog" | "sheet";
};

/**
 * Thin wrapper over @radix-ui/react-dialog. Radix owns focus trapping,
 * Escape handling, and aria modality; this wrapper only applies shared
 * surfaces, titles, and action rows from current primitives.
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  actions,
  closeLabel = "Close",
  variant = "dialog",
}: DialogProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={styles.overlay} />
        <RadixDialog.Content
          className={variant === "sheet" ? styles.sheet : styles.content}
        >
          <RadixDialog.Title className={styles.title}>{title}</RadixDialog.Title>
          {description ? (
            <RadixDialog.Description className={styles.description}>{description}</RadixDialog.Description>
          ) : null}
          <div className={styles.body}>{children}</div>
          <div className={styles.actions}>
            {actions}
            <RadixDialog.Close asChild>
              <Button variant="secondary">{closeLabel}</Button>
            </RadixDialog.Close>
          </div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
