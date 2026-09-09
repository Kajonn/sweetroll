import { Button } from "./Button.js";
import styles from "./SaveStatus.module.css";

export type SaveStatusState = "idle" | "pending" | "saving" | "conflict" | "offline" | "error";

const STATUS_TEXT: Record<SaveStatusState, string> = {
  idle: "Saved",
  pending: "Unsaved changes",
  saving: "Saving…",
  conflict: "Conflict — review needed",
  offline: "Offline — changes will sync when reconnected",
  error: "Save failed",
};

export type SaveStatusProps = {
  status: SaveStatusState;
  /** Extra detail, e.g. revision summary or retry hint. Rendered as text. */
  detail?: string;
  onRetry?: () => void;
  retryLabel?: string;
};

/**
 * Save/sync state with meaningful text (never color alone).
 * Conflict and error use role="alert"; other states use role="status".
 */
export function SaveStatus({ status, detail, onRetry, retryLabel = "Retry" }: SaveStatusProps) {
  const urgent = status === "conflict" || status === "error";
  const showRetry = onRetry !== undefined && (status === "error" || status === "conflict" || status === "offline");
  return (
    <div className={styles.status} data-status={status} role={urgent ? "alert" : "status"}>
      <span className={styles.text}>{STATUS_TEXT[status]}</span>
      {detail ? <span className={styles.detail}>{detail}</span> : null}
      {showRetry ? (
        <Button variant="secondary" onClick={onRetry}>
          {retryLabel}
        </Button>
      ) : null}
    </div>
  );
}
