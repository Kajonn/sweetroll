import { AlertTriangle, X } from "lucide-react";

import { t } from "../i18n/index.js";
import styles from "./ConflictBanner.module.css";

export type ConflictBannerProps = {
  latestRevision: number;
  onAcceptTheirs: () => void;
  onKeepMine: () => void;
  onMergeIntoServer: () => void;
  onDismiss: () => void;
};

export function ConflictBanner({
  latestRevision,
  onAcceptTheirs,
  onKeepMine,
  onMergeIntoServer,
  onDismiss,
}: ConflictBannerProps) {
  return (
    <aside
      role="alert"
      aria-live="assertive"
      className={styles.banner}
      data-testid="conflict-banner"
    >
      <div className={styles.icon} aria-hidden>
        <AlertTriangle size={20} />
      </div>
      <div className={styles.body}>
        <p className={styles.message}>{t("editor.conflict.message", { latestRevision })}</p>
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.primary}
            onClick={onAcceptTheirs}
            data-testid="conflict-banner-accept-theirs"
          >
            {t("editor.conflict.reloadTheirs")}
          </button>
          <button
            type="button"
            className={styles.destructive}
            onClick={onKeepMine}
            data-testid="conflict-banner-keep-mine"
          >
            {t("editor.conflict.keepMine")}
          </button>
          <button
            type="button"
            className={styles.secondary}
            onClick={onMergeIntoServer}
            data-testid="conflict-banner-merge"
          >
            {t("editor.conflict.mergeIntoServer")}
          </button>
        </div>
      </div>
      <button
        type="button"
        aria-label={t("editor.conflict.dismiss")}
        className={styles.close}
        onClick={onDismiss}
        data-testid="conflict-banner-dismiss"
      >
        <X aria-hidden size={16} />
      </button>
    </aside>
  );
}
