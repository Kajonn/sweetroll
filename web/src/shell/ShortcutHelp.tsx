import * as Dialog from "@radix-ui/react-dialog";

import { t } from "../i18n/index.js";
import styles from "./ShortcutHelp.module.css";

type Entry = { combo: string; label: string };

const registry = new Map<string, Entry>();

export function registerShortcut(combo: string, label: string): () => void {
  const id = `${combo}::${label}`;
  registry.set(id, { combo, label });
  return () => {
    registry.delete(id);
  };
}

export function listShortcuts(): ReadonlyArray<Entry> {
  return Array.from(registry.values()).sort((a, b) => a.combo.localeCompare(b.combo));
}

export function ShortcutHelp({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (b: boolean) => void;
}) {
  const items = listShortcuts();
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content className={styles.content} aria-describedby={undefined}>
          <Dialog.Title className={styles.title}>{t("shortcutHelp.title")}</Dialog.Title>
          <ul className={styles.list}>
            {items.map(({ combo, label }) => (
              <li key={`${combo}-${label}`} className={styles.item}>
                <kbd className={styles.combo}>{combo}</kbd>
                <span>{label}</span>
              </li>
            ))}
          </ul>
          <Dialog.Close className={styles.close}>{t("shortcutHelp.close")}</Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}