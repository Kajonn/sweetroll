import type { ReactNode } from "react";
import { useId } from "react";

import styles from "./surfaces.module.css";

export type PanelProps = {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
};

export function Panel({ title, actions, children, className }: PanelProps) {
  const generated = useId();
  const titleId = `ui-panel-${generated.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const classes = [styles.panel, className].filter((part): part is string => Boolean(part)).join(" ");
  return (
    <section className={classes} aria-labelledby={title ? titleId : undefined}>
      {title || actions ? (
        <div className={styles.panelHeader}>
          {title ? (
            <h2 id={titleId} className={styles.panelTitle}>
              {title}
            </h2>
          ) : null}
          {actions ? <div className={styles.panelActions}>{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}
