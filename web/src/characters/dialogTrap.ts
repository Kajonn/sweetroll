import type { KeyboardEvent } from "react";

/**
 * Minimal Tab containment for modal dialogs. Cycles focus between the first
 * and last focusable element so keyboard users cannot tab out while the
 * dialog is open. Call from the dialog's `onKeyDown` alongside Escape.
 */
export function trapTabKey(event: KeyboardEvent, container: HTMLElement | null): void {
  if (event.key !== "Tab" || container === null) return;
  const focusables = focusableElements(container);
  if (focusables.length === 0) return;
  const first = focusables[0]!;
  const last = focusables[focusables.length - 1]!;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

/** Visible, enabled focus targets inside a dialog, in tab order. */
export function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
}

/**
 * The element to return focus to when a dialog closes. This is whatever had
 * focus when the dialog opened, including focus that started outside the
 * dialog (the opener button) or on `document.body` when nothing was focused.
 */
export function captureOpener(): Element | null {
  return document.activeElement;
}

/** Move initial focus into an opened dialog: its first focusable, if any. */
export function focusFirst(container: HTMLElement | null): void {
  if (container === null) return;
  focusableElements(container)[0]?.focus();
}

/** Return focus after a dialog closes; parks focus on the body when the opener is gone. */
export function restoreOpener(opener: Element | null): void {
  if (opener instanceof HTMLElement) {
    opener.focus();
    return;
  }
  if (document.activeElement !== document.body && typeof document.body.focus === "function") {
    document.body.focus();
  }
}
