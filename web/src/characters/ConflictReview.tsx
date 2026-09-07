import { useEffect, useId, useRef, useState } from "react";

import { t } from "../i18n/index.js";
import { captureOpener, focusFirst, restoreOpener, trapTabKey } from "./dialogTrap.js";
import type { CharacterSnapshot } from "./session.js";
import type { OnlineAttempt } from "./store.js";
import type { EditIntent } from "./types.js";
import styles from "./characters.module.css";

export type ConflictReviewProps = {
  snapshot: CharacterSnapshot;
  onResolve(input: { mode: "discard" | "reapply"; selectedIds: string[]; correctedIntents?: Record<string, EditIntent> }): Promise<void>;
  onClose(): void;
  /** Explicit unknown-outcome review for one retained expired online attempt. */
  onReviewExpiredAttempt?(input: { attemptId: string; acknowledgeUnknownOutcome: boolean }): Promise<void>;
  /** Injected clock (ms since epoch) for expiry checks; defaults to Date.now. */
  now?: number;
};

type PendingMode = "discard" | "reapply" | null;

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function isExpiredEntry(entry: CharacterSnapshot["entries"][number], now: number): boolean {
  const timestamp = entry.attempt?.firstAttemptAt ?? entry.createdAt;
  return Date.parse(timestamp) < now - THIRTY_DAYS_MS;
}

function isReviewableOnlineAttempt(attempt: OnlineAttempt, now: number): boolean {
  if (attempt.replayExpired === true) return true;
  const timestamp = attempt.createdAt || attempt.request.firstAttemptAt;
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

type ProjectedFieldConstraints = {
  fieldKind?: string;
  constraints?: { min?: unknown; max?: unknown; minLength?: unknown; maxLength?: unknown };
  options?: unknown;
};

function projectedField(snapshot: CharacterSnapshot, fieldId: string): ProjectedFieldConstraints | undefined {
  const sheets = snapshot.confirmed?.projection.sheets as
    | Array<{ sections?: Array<{ elements?: Array<Record<string, unknown>> }> }>
    | undefined;
  const elements: Array<Record<string, unknown>> = [];
  for (const sheet of sheets ?? []) {
    for (const section of sheet.sections ?? []) {
      for (const element of section.elements ?? []) elements.push(element);
    }
  }
  const completion = snapshot.confirmed?.projection.completionFields as Array<Record<string, unknown>> | undefined;
  for (const field of completion ?? []) elements.push(field);
  return elements.find((element) => element["kind"] === "field" && element["fieldId"] === fieldId) as
    | ProjectedFieldConstraints
    | undefined;
}

function scalarText(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function optionValues(field: ProjectedFieldConstraints): string[] {
  const options = field.options;
  if (!Array.isArray(options)) return [];
  return options.flatMap((option) => {
    if (typeof option === "string") return [option];
    if (option !== null && typeof option === "object") {
      const record = option as Record<string, unknown>;
      const value = record["value"];
      return typeof value === "string" ? [value] : [];
    }
    return [];
  });
}

/**
 * Validate a typed correction against the projected supported field
 * constraints. Returns the parsed replacement value, or a localized reason
 * when the draft violates the projection.
 */
function validateCorrection(
  snapshot: CharacterSnapshot,
  entry: CharacterSnapshot["entries"][number],
  draft: string,
): { ok: true; value: unknown } | { ok: false; reason: string } {
  if (entry.intent.kind === "bumpResource") {
    if (draft !== "up" && draft !== "down") return { ok: false, reason: "direction" };
    return { ok: true, value: draft };
  }
  if (entry.intent.kind !== "setField") return { ok: false, reason: "kind" };
  const field = projectedField(snapshot, entry.intent.fieldId);
  const allowed = field ? optionValues(field) : [];
  if (allowed.length > 0 && !allowed.includes(draft)) {
    return { ok: false, reason: "option" };
  }
  const kind = field?.fieldKind;
  if (kind === "integer" || kind === "decimal") {
    if (draft.trim() === "") return { ok: false, reason: "required" };
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) return { ok: false, reason: "number" };
    if (kind === "integer" && !Number.isInteger(parsed)) return { ok: false, reason: "integer" };
    const min = numberOrNull(field?.constraints?.min);
    const max = numberOrNull(field?.constraints?.max);
    if ((min !== null && parsed < min) || (max !== null && parsed > max)) return { ok: false, reason: "range" };
    return { ok: true, value: parsed };
  }
  const minLength = numberOrNull(field?.constraints?.minLength);
  const maxLength = numberOrNull(field?.constraints?.maxLength);
  if (minLength !== null && draft.length < minLength) return { ok: false, reason: "length" };
  if (maxLength !== null && draft.length > maxLength) return { ok: false, reason: "length" };
  if (field === undefined && typeof entry.intent.value === "number") {
    if (draft.trim() === "") return { ok: false, reason: "required" };
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) return { ok: false, reason: "number" };
    return { ok: true, value: parsed };
  }
  return { ok: true, value: draft };
}

function defaultDraft(entry: CharacterSnapshot["entries"][number]): string {
  if (entry.intent.kind === "setField") return scalarText(entry.intent.value);
  if (entry.intent.kind === "bumpResource") return entry.intent.direction;
  return "";
}

/**
 * Explicit conflict recovery. Lists queued intentions with a server-versus-
 * local comparison, requires checkbox selection plus a confirmation dialog,
 * and submits the selected queue IDs to `resolveConflict`. Invalid values
 * can be corrected inline: corrections travel as Task 2 atomic replacement
 * intents with new keys, never as in-place edits. Stateless across repeated
 * conflicts: a new snapshot simply re-renders.
 *
 * Uncertain online attempts are never part of ordinary discard/reapply: any
 * retained attempt disables those controls until replay or explicit
 * unknown-outcome review resolves it.
 */
export function ConflictReview({ snapshot, onResolve, onClose, now: nowProp, onReviewExpiredAttempt }: ConflictReviewProps) {
  const [selected, setSelected] = useState<string[]>([]);
  const [corrections, setCorrections] = useState<Record<string, string>>({});
  const [pendingMode, setPendingMode] = useState<PendingMode>(null);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [correctionError, setCorrectionError] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const openerRef = useRef<Element | null>(null);
  const confirmDialogRef = useRef<HTMLDivElement | null>(null);
  const dialogId = useId();
  const now = nowProp ?? Date.now();

  const expired = snapshot.entries.some((entry) => isExpiredEntry(entry, now)) || snapshot.error?.kind === "expired-attempt";
  const isInvalid = snapshot.error?.kind === "invalid";
  const invalidDetails = isInvalid
    ? (snapshot.error?.details as { diagnostics?: Array<{ message: string }> } | undefined)?.diagnostics ?? []
    : [];

  // Uncertain online outcomes block ordinary recovery until replay or
  // explicit expired-outcome review resolves the local decision.
  const blockedByOnline = snapshot.pendingOnlineAttempts.length > 0;
  const reviewableAttempt = (() => {
    if (snapshot.error?.kind !== "expired-attempt") return null;
    const attemptId = (snapshot.error?.details as { attemptId?: unknown } | undefined)?.attemptId;
    if (typeof attemptId !== "string" || attemptId.length === 0) return null;
    const attempt = snapshot.pendingOnlineAttempts.find((candidate) => candidate.id === attemptId) ?? null;
    if (attempt === null || !isReviewableOnlineAttempt(attempt, now)) return null;
    return attempt;
  })();

  // Drop selection (and drafts) for entries that disappeared when a new snapshot arrives.
  useEffect(() => {
    const ids = new Set(snapshot.entries.map((entry) => entry.id));
    setSelected((current) =>
      current.every((id) => ids.has(id)) ? current : current.filter((id) => ids.has(id)),
    );
    setCorrections((current) => {
      const next: Record<string, string> = {};
      for (const [id, draft] of Object.entries(current)) {
        if (ids.has(id)) next[id] = draft;
      }
      return next;
    });
  }, [snapshot.entries]);

  // Queued entries after the selection that a discard/reapply would reorder.
  const selectedSet = new Set(selected);
  const firstSelectedIndex = snapshot.entries.findIndex((entry) => selectedSet.has(entry.id));
  const dependents =
    firstSelectedIndex === -1
      ? []
      : snapshot.entries.slice(firstSelectedIndex + 1).filter((entry) => !selectedSet.has(entry.id));

  useEffect(() => {
    if (pendingMode !== null) {
      openerRef.current = captureOpener();
      const confirm = confirmDialogRef.current?.querySelector<HTMLElement>(
        "button:not([disabled]), input:not([disabled])",
      );
      if (confirm) confirm.focus();
      else focusFirst(confirmDialogRef.current);
    }
  }, [pendingMode]);

  const closeDialog = () => {
    setPendingMode(null);
    setCorrectionError(null);
    restoreOpener(openerRef.current);
  };

  const toggle = (id: string) => {
    setSelected((current) => (current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]));
  };

  const draftFor = (entry: CharacterSnapshot["entries"][number]): string =>
    corrections[entry.id] ?? defaultDraft(entry);

  const confirm = async () => {
    if (pendingMode === null || selected.length === 0) return;
    setBusy(true);
    setSubmitError(null);
    setCorrectionError(null);
    try {
      const correctedIntents: Record<string, EditIntent> = {};
      if (pendingMode === "reapply") {
        for (const entry of snapshot.entries) {
          if (!selectedSet.has(entry.id)) continue;
          if (entry.intent.kind !== "setField" && entry.intent.kind !== "bumpResource") continue;
          const draft = draftFor(entry);
          const original = defaultDraft(entry);
          if (draft === "") continue;
          const validated = validateCorrection(snapshot, entry, draft);
          if (!validated.ok) {
            const fieldId = entry.intent.kind === "setField" ? entry.intent.fieldId : entry.intent.resourceId;
            setCorrectionError(t("character.conflict.correctionInvalid", { field: fieldId, reason: validated.reason }));
            setBusy(false);
            return;
          }
          // In an invalid pause the selected draft must satisfy the
          // projected constraints even when unchanged: resending a value
          // the projection already rejects would only fail again.
          if (!isInvalid && draft === original) continue;
          if (entry.intent.kind === "setField") {
            correctedIntents[entry.id] = { kind: "setField", fieldId: entry.intent.fieldId, value: validated.value };
          } else {
            correctedIntents[entry.id] = {
              kind: "bumpResource",
              resourceId: entry.intent.resourceId,
              direction: validated.value as "up" | "down",
            };
          }
        }
      }
      await onResolve({
        mode: pendingMode,
        selectedIds: selected,
        ...(Object.keys(correctedIntents).length > 0 ? { correctedIntents } : {}),
      });
      setSelected([]);
      setCorrections({});
      setPendingMode(null);
      restoreOpener(openerRef.current);
    } catch (error) {
      setSubmitError(error instanceof Error && error.message ? error.message : t("character.conflict.reviewFailed"));
    } finally {
      setBusy(false);
    }
  };

  const reviewExpired = async () => {
    if (reviewableAttempt === null || !acknowledged || onReviewExpiredAttempt === undefined) return;
    setReviewBusy(true);
    setReviewError(null);
    try {
      await onReviewExpiredAttempt({ attemptId: reviewableAttempt.id, acknowledgeUnknownOutcome: true });
      setAcknowledged(false);
    } catch (error) {
      setReviewError(error instanceof Error && error.message ? error.message : t("character.conflict.reviewFailed"));
    } finally {
      setReviewBusy(false);
    }
  };

  const ordinaryDisabled = selected.length === 0 || blockedByOnline;
  const reapplyDisabled = ordinaryDisabled;

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
      {isInvalid ? <p>{t("character.conflict.invalidHint")}</p> : null}
      {blockedByOnline ? <p role="alert">{t("character.conflict.uncertainBlocked")}</p> : null}
      {reviewableAttempt !== null ? (
        <section aria-label={t("character.conflict.expiredReviewTitle")}>
          <h3>{t("character.conflict.expiredReviewTitle")}</h3>
          <p role="alert">{t("character.conflict.expiredReviewWarning")}</p>
          {onReviewExpiredAttempt === undefined ? null : (
            <>
              <label className={styles.checkboxLabel}>
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(event) => setAcknowledged(event.target.checked)}
                />
                <span>{t("character.conflict.acknowledgeUnknown")}</span>
              </label>
              {reviewError !== null ? <p role="alert">{reviewError}</p> : null}
              <button
                type="button"
                className={styles.dialogButton}
                disabled={!acknowledged || reviewBusy}
                onClick={() => void reviewExpired()}
              >
                {t("character.conflict.retireExpired")}
              </button>
            </>
          )}
        </section>
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
          const correctable = entry.intent.kind === "setField" || entry.intent.kind === "bumpResource";
          const fieldId = entry.intent.kind === "setField" ? entry.intent.fieldId : entry.intent.kind === "bumpResource" ? entry.intent.resourceId : "";
          const field = entry.intent.kind === "setField" ? projectedField(snapshot, entry.intent.fieldId) : undefined;
          const allowed = field ? optionValues(field) : [];
          return (
            <li key={entry.id}>
              <label className={styles.checkRow}>
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
              {isInvalid && correctable ? (
                entry.intent.kind === "bumpResource" ? (
                  <label>
                    <span>{t("character.conflict.correctValue", { field: fieldId })}</span>
                    <select
                      aria-label={t("character.conflict.correctValue", { field: fieldId })}
                      className={styles.dialogField}
                      value={draftFor(entry)}
                      onChange={(event) => setCorrections((current) => ({ ...current, [entry.id]: event.target.value }))}
                    >
                      <option value="up">up</option>
                      <option value="down">down</option>
                    </select>
                  </label>
                ) : allowed.length > 0 ? (
                  <label>
                    <span>{t("character.conflict.correctValue", { field: fieldId })}</span>
                    <select
                      aria-label={t("character.conflict.correctValue", { field: fieldId })}
                      className={styles.dialogField}
                      value={draftFor(entry)}
                      onChange={(event) => setCorrections((current) => ({ ...current, [entry.id]: event.target.value }))}
                    >
                      {allowed.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <label>
                    <span>{t("character.conflict.correctValue", { field: fieldId })}</span>
                    <input
                      type="text"
                      aria-label={t("character.conflict.correctValue", { field: fieldId })}
                      className={styles.dialogField}
                      value={draftFor(entry)}
                      onChange={(event) => setCorrections((current) => ({ ...current, [entry.id]: event.target.value }))}
                    />
                  </label>
                )
              ) : null}
            </li>
          );
        })}
      </ul>
      {submitError !== null ? <p role="alert">{submitError}</p> : null}
      <div>
        <button type="button" className={styles.dialogButton} disabled={ordinaryDisabled} onClick={() => setPendingMode("discard")}>
          {t("character.conflict.discard")}
        </button>
        <button
          type="button"
          className={styles.dialogButton}
          disabled={reapplyDisabled}
          onClick={() => setPendingMode("reapply")}
        >
          {t("character.conflict.reapply")}
        </button>
        <button type="button" className={styles.dialogButton} onClick={onClose}>
          {t("character.conflict.close")}
        </button>
      </div>
      {pendingMode !== null ? (
        <div
          ref={confirmDialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={`${dialogId}-confirm`}
          onKeyDown={(event) => {
            if (event.key === "Escape") closeDialog();
            trapTabKey(event, confirmDialogRef.current);
          }}
        >
          <h3 id={`${dialogId}-confirm`}>
            {pendingMode === "discard" ? t("character.conflict.confirmDiscard") : t("character.conflict.confirmReapply")}
          </h3>
          <p>{t("character.conflict.confirmDetail")}</p>
          {dependents.length > 0 ? (
            <p>
              {t("character.conflict.confirmDependents", {
                count: dependents.length,
                ids: dependents.map((entry) => entry.id).join(", "),
              })}
            </p>
          ) : null}
          {correctionError !== null ? <p role="alert">{correctionError}</p> : null}
          <button type="button" className={styles.dialogButton} disabled={busy} onClick={() => void confirm()}>
            {pendingMode === "discard" ? t("character.conflict.confirmDiscardButton") : t("character.conflict.confirmReapplyButton")}
          </button>
          <button type="button" className={styles.dialogButton} disabled={busy} onClick={closeDialog}>
            {t("character.conflict.cancel")}
          </button>
        </div>
      ) : null}
    </section>
  );
}
