import { useEffect, useId, useRef, useState } from "react";

import { t } from "../i18n/index.js";
import type { CharacterSnapshot } from "./session.js";
import styles from "./characters.module.css";

export type ConflictReviewProps = {
  snapshot: CharacterSnapshot;
  onResolve(input: { mode: "discard" | "reapply"; selectedIds: string[] }): Promise<void>;
  onClose(): void;
};

type PendingMode = "discard" | "reapply" | null;

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function isExpiredEntry(entry: CharacterSnapshot["entries"][number], now: number): boolean {
  const timestamp = entry.attempt?.firstAttemptAt ?? entry.createdAt;
  return Date.parse(timestamp) < now - THIRTY_DAYS_MS;
}

function serverValue(snapshot: CharacterSnapshot, fieldId: string): string {
  const values = snapshot.confirmed?.state.values as Record<string, unknown> | undefined;
  const value = values?.[fieldId];
  return value === undefined || value === null ? "—" : String(value);
}

function entryLabel(entry: CharacterSnapshot["entries"][number]): string {
  if (entry.intent.kind === "setField") return `${entry.intent.fieldId} → ${String(entry.intent.value)}`;
  if (entry.intent.kind === "bumpResource") return `${entry.intent.resourceId} ${entry.intent.direction}`;
  return `${entry.intent.actionId}`;
}

/**
 * Explicit conflict recovery. Lists queued intentions with a server-versus-
 * local comparison, requires checkbox selection plus a confirmation dialog,
 * and submits the selected queue IDs to `resolveConflict`. Stateless across
 * repeated conflicts: a new snapshot simply re-renders.
 */
export function ConflictReview({ snapshot, onResolve, onClose }: ConflictReviewProps) {
  const [selected, setSelected] = useState<string[]>([]);
  const [pendingMode, setPendingMode] = useState<PendingMode>(null);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const openerRef = useRef<Element | null>(null);
  const confirmButtonRef = useRef<HTMLButtonElement | null>(null);
  const dialogId = useId();
  const now = Date.now();

  const expired = snapshot.entries.some((entry) => isExpiredEntry(entry, now)) || snapshot.error?.kind === "expired-attempt";
  const invalidDetails = snapshot.error?.kind === "invalid"
    ? (snapshot.error.details as { diagnostics?: Array<{ message: string }> } | undefined)?.diagnostics ?? []
    : [];

  useEffect(() => {
    if (pendingMode !== null) {
      openerRef.current = document.activeElement;
      confirmButtonRef.current?.focus();
    }
  }, [pendingMode]);

  const closeDialog = () => {
    setPendingMode(null);
    if (openerRef.current instanceof HTMLElement) openerRef.current.focus();
  };

  const toggle = (id: string) => {
    setSelected((current) => (current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]));
  };

  const confirm = async () => {
    if (pendingMode === null || selected.length === 0) return;
    setBusy(true);
    setSubmitError(null);
    try {
      await onResolve({ mode: pendingMode, selectedIds: selected });
      setSelected([]);
      setPendingMode(null);
      if (openerRef.current instanceof HTMLElement) openerRef.current.focus();
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Review failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={styles.sheet} aria-labelledby={`${dialogId}-title`}>
      <h2 id={`${dialogId}-title`}>{t("character.conflict.title")}</h2>
      <p>{snapshot.error?.message ?? t("character.conflict.message")}</p>
      {expired ? <p role="alert">{t("character.conflict.expired")}</p> : null}
      {snapshot.error?.kind === "invalid" && invalidDetails.length > 0 ? (
        <ul>
          {invalidDetails.map((diagnostic, index) => (
            <li key={index}>{diagnostic.message}</li>
          ))}
        </ul>
      ) : null}
      <ul>
        {snapshot.entries.map((entry) => {
          const label = entryLabel(entry);
          const server =
            entry.intent.kind === "setField"
              ? serverValue(snapshot, entry.intent.fieldId)
              : entry.intent.kind === "bumpResource"
                ? serverValue(snapshot, entry.intent.resourceId)
                : "—";
          return (
            <li key={entry.id}>
              <label>
                <input
                  type="checkbox"
                  checked={selected.includes(entry.id)}
                  onChange={() => toggle(entry.id)}
                  aria-label={`${label} (server ${server})`}
                />
                <span>
                  {label} — {t("character.conflict.server")}: {server}
                </span>
              </label>
              {isExpiredEntry(entry, now) ? <span> ({t("character.conflict.uncertain")})</span> : null}
            </li>
          );
        })}
      </ul>
      {submitError !== null ? <p role="alert">{submitError}</p> : null}
      <div>
        <button type="button" disabled={selected.length === 0} onClick={() => setPendingMode("discard")}>
          {t("character.conflict.discard")}
        </button>
        <button type="button" disabled={selected.length === 0} onClick={() => setPendingMode("reapply")}>
          {t("character.conflict.reapply")}
        </button>
        <button type="button" onClick={onClose}>
          {t("character.conflict.close")}
        </button>
      </div>
      {pendingMode !== null ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby={`${dialogId}-confirm`}
          onKeyDown={(event) => {
            if (event.key === "Escape") closeDialog();
          }}
        >
          <h3 id={`${dialogId}-confirm`}>
            {pendingMode === "discard" ? t("character.conflict.confirmDiscard") : t("character.conflict.confirmReapply")}
          </h3>
          <p>{t("character.conflict.confirmDetail")}</p>
          <button ref={confirmButtonRef} type="button" disabled={busy} onClick={() => void confirm()}>
            {pendingMode === "discard" ? t("character.conflict.confirmDiscardButton") : t("character.conflict.confirmReapplyButton")}
          </button>
          <button type="button" disabled={busy} onClick={closeDialog}>
            {t("character.conflict.cancel")}
          </button>
        </div>
      ) : null}
    </section>
  );
}
