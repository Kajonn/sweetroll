import { useEffect, useId, useRef, useState } from "react";

import { Button } from "./Button.js";
import styles from "./Menu.module.css";

export type MenuItem = {
  id: string;
  label: string;
  disabled?: boolean;
  onSelect: () => void;
};

export type MenuProps = {
  /** Accessible name for the trigger button and the menu. */
  label: string;
  items: ReadonlyArray<MenuItem>;
  align?: "start" | "center" | "end";
};

/**
 * Native disclosure menu (no Radix popover: @radix-ui/react-popover content
 * saturates the event loop in this repo's jsdom, stalling every async test
 * utility while mounted — see the G2-2 report). The trigger and items are
 * native buttons: Tab reaches them, Escape closes and returns focus to the
 * trigger, and outside pointerdown closes. No focus trap is recreated; a
 * non-modal menu needs none.
 *
 * Deliberately a disclosure pattern (aria-expanded/aria-controls + plain
 * buttons), NOT menu/menuitem roles: APG menu semantics require arrow-key /
 * Home/End roving tabindex, which would recreate the custom focus management
 * this wrapper exists to avoid. Items stay Tab-reachable, so disclosure
 * semantics describe the actual keyboard behavior honestly.
 */
export function Menu({ label, items, align = "end" }: MenuProps) {
  const generated = useId();
  const base = `ui-menu-${generated.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const menuId = `${base}-menu`;
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open ]);

  const closeAndRefocus = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  return (
    <div className={styles.menuWrap}>
      <Button
        ref={triggerRef}
        variant="secondary"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
      >
        {label}
      </Button>
      {open ? (
        <div
          ref={menuRef}
          id={menuId}
          data-align={align}
          className={styles.content}
        >
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              disabled={item.disabled}
              onClick={() => {
                item.onSelect();
                closeAndRefocus();
              }}
              className={styles.item}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
