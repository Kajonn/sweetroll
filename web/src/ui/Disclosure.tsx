import type { ReactNode } from "react";
import styles from "./Disclosure.module.css";

/** Native disclosure keeps mounted editor values intact when collapsed. */
export function Disclosure({ label, children, defaultOpen = false }: { label: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  return <details className={styles.disclosure} open={defaultOpen || undefined}>
    <summary>{label}</summary>
    <div className={styles.body}>{children}</div>
  </details>;
}
