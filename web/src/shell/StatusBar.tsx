import styles from "./StatusBar.module.css";

export function StatusBar({ requestId, online }: { requestId?: string; online: boolean }) {
  return (
    <footer role="contentinfo" className={styles.bar} data-testid="status-bar">
      <span className={`${styles.indicator} ${online ? "" : styles.offline}`} aria-hidden />
      <span>{online ? "Online" : "Offline"}</span>
      <span className={styles.spacer} />
      {requestId !== undefined && <span data-testid="request-id">{requestId}</span>}
      <kbd>?</kbd><span>Shortcuts</span>
    </footer>
  );
}