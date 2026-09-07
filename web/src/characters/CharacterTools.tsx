import { useEffect, useRef, useState } from "react";

import { t } from "../i18n/index.js";
import type { CharactersApi } from "./api.js";
import { captureOpener, focusFirst, restoreOpener, trapTabKey } from "./dialogTrap.js";
import type { CharacterSession } from "./session.js";
import type { ActivityEvent, MigrationPreview } from "./types.js";
import styles from "./characters.module.css";

export type CharacterToolsProps = {
  characterId: string;
  api: CharactersApi;
  session: CharacterSession;
  now?: () => string;
};

type DialogKind = "activity" | "archive" | "recover" | "export" | "migration" | null;

function useSnapshot(session: CharacterSession) {
  const [snapshot, setSnapshot] = useState(() => session.getSnapshot());
  useEffect(() => session.subscribe(setSnapshot), [session]);
  return snapshot;
}

/**
 * Secondary character management panels. Activity reads go through the
 * session's durable account/character cache; migration preview and export
 * documents are read-only API calls. Every mutation goes through the
 * session so queue sequencing, refresh-before-freeze and durable online
 * attempts are never bypassed. Management buttons stay disabled while
 * edits are pending, an online outcome is uncertain, the tab is read-only
 * or the session is offline/not ready.
 */
export function CharacterTools({ characterId, api, session, now = () => new Date().toISOString() }: CharacterToolsProps) {
  const snapshot = useSnapshot(session);
  const blocked = snapshot.entries.length > 0 || snapshot.phase !== "ready";
  const uncertain = snapshot.pendingOnlineAttempts.length > 0;
  const readOnly = !snapshot.editing.owned;
  const offline = !snapshot.connected;
  const manageBlocked = blocked || uncertain || readOnly || offline;
  const lifecycle = snapshot.confirmed?.lifecycle ?? "active";
  const [dialog, setDialog] = useState<DialogKind>(null);
  const openerRef = useRef<Element | null>(null);

  const openDialog = (kind: Exclude<DialogKind, null>) => {
    openerRef.current = captureOpener();
    setDialog(kind);
  };
  const closeDialog = () => {
    setDialog(null);
    restoreOpener(openerRef.current);
  };

  return (
    <section aria-label={t("character.tools.title")}>
      <button type="button" className={styles.toolButton} onClick={() => openDialog("activity")}>
        {t("character.tools.activity")}
      </button>
      <button type="button" className={styles.toolButton} disabled={manageBlocked || lifecycle === "archived"} onClick={() => openDialog("archive")}>
        {t("character.tools.archive")}
      </button>
      <button type="button" className={styles.toolButton} disabled={manageBlocked || lifecycle !== "archived"} onClick={() => openDialog("recover")}>
        {t("character.tools.recover")}
      </button>
      <button type="button" className={styles.toolButton} disabled={blocked} onClick={() => openDialog("export")}>
        {t("character.tools.export")}
      </button>
      <button type="button" className={styles.toolButton} onClick={() => openDialog("migration")}>
        {t("character.tools.migration")}
      </button>
      {lifecycle === "archived" ? <p>{t("character.tools.archivedReadOnly")}</p> : null}
      {dialog === "activity" ? (
        <ActivityDialog characterId={characterId} session={session} onClose={closeDialog} />
      ) : null}
      {dialog === "archive" ? (
        <ConfirmDialog
          title={t("character.tools.archiveTitle")}
          confirmLabel={t("character.tools.confirmArchive")}
          onConfirm={async () => {
            if (snapshot.entries.length > 0 || snapshot.phase !== "ready") return;
            // Refresh and freeze before initiating the online-only operation.
            await session.archive();
          }}
          onClose={closeDialog}
        />
      ) : null}
      {dialog === "recover" ? (
        <ConfirmDialog
          title={t("character.tools.recoverTitle")}
          confirmLabel={t("character.tools.confirmRecover")}
          onConfirm={async () => {
            if (snapshot.entries.length > 0 || snapshot.phase !== "ready") return;
            // Refresh and freeze before initiating the online-only operation.
            await session.recover();
          }}
          onClose={closeDialog}
        />
      ) : null}
      {dialog === "export" ? (
        <ExportDialog characterId={characterId} api={api} session={session} onClose={closeDialog} />
      ) : null}
      {dialog === "migration" ? (
        <MigrationDialog characterId={characterId} api={api} session={session} now={now} onClose={closeDialog} />
      ) : null}
    </section>
  );
}

function ConfirmDialog({ title, confirmLabel, onConfirm, onClose }: { title: string; confirmLabel: string; onConfirm(): Promise<void>; onClose(): void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    focusFirst(dialogRef.current);
  }, []);
  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
        trapTabKey(event, dialogRef.current);
      }}
    >
      <h2>{title}</h2>
      {error !== null ? <p role="alert">{error}</p> : null}
      <button
        ref={confirmRef}
        type="button"
        className={styles.dialogButton}
        disabled={busy}
        onClick={() =>
          void (async () => {
            setBusy(true);
            setError(null);
            try {
              await onConfirm();
              onClose();
            } catch (err) {
              setError(err instanceof Error && err.message ? err.message : t("character.tools.confirmFailed"));
            } finally {
              setBusy(false);
            }
          })()
        }
      >
        {confirmLabel}
      </button>
      <button type="button" className={styles.dialogButton} disabled={busy} onClick={onClose}>
        {t("character.conflict.cancel")}
      </button>
    </div>
  );
}

function ActivityRow({ event }: { event: ActivityEvent }) {
  return (
    <li>
      <span>{event.kind}</span>{" "}
      <span>{t("character.tools.activitySummary", { revision: event.characterRevision, time: event.occurredAt })}</span>{" "}
      <time dateTime={event.occurredAt}>{event.occurredAt}</time>
    </li>
  );
}

function ActivityDialog({ characterId, session, onClose }: { characterId: string; session: CharacterSession; onClose(): void }) {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const errorRef = useRef<HTMLParagraphElement | null>(null);

  const load = async (next: string | null, append: boolean) => {
    setLoading(true);
    setError(null);
    try {
      // The session serves the durable account/character cache while
      // offline and caches fresh server pages (keyed by server cursor)
      // when online. Overlapping pages are merged without duplicates.
      const page = await session.fetchActivityPage(next);
      setEvents((current) => {
        if (!append) return page.events;
        const known = new Set(current.map((event) => event.id));
        return [...current, ...page.events.filter((event) => !known.has(event.id))];
      });
      setCursor(page.nextCursor);
      setStale(page.stale);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t("character.tools.activityFailed"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    focusFirst(dialogRef.current);
    void load(null, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [characterId]);

  useEffect(() => {
    if (error !== null) errorRef.current?.focus();
  }, [error]);

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={t("character.tools.activityTitle")}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
        trapTabKey(event, dialogRef.current);
      }}
    >
      <h2>{t("character.tools.activityTitle")}</h2>
      {stale ? <p>{t("character.tools.activityStale")}</p> : null}
      {error !== null ? <p ref={errorRef} tabIndex={-1} role="alert">{error}</p> : null}
      <ul>
        {events.map((event) => (
          <ActivityRow key={event.id} event={event} />
        ))}
      </ul>
      {cursor !== null ? (
        <button type="button" className={styles.dialogButton} disabled={loading} onClick={() => void load(cursor, true)}>
          {t("character.tools.activityLoadMore")}
        </button>
      ) : null}
      <button type="button" className={styles.dialogButton} disabled={loading} onClick={() => void load(null, false)}>
        {t("character.tools.activityRefresh")}
      </button>
      <button type="button" className={styles.dialogButton} onClick={onClose}>
        {t("character.tools.close")}
      </button>
    </div>
  );
}

function ExportDialog({ characterId, api, session, onClose }: { characterId: string; api: CharactersApi; session: CharacterSession; onClose(): void }) {
  const snapshot = useSnapshot(session);
  const queued = snapshot.entries.length > 0 || snapshot.phase !== "ready";
  const uncertain = snapshot.pendingOnlineAttempts.length > 0;
  const offline = !snapshot.connected;
  const readOnly = !snapshot.editing.owned;
  const blocked = queued || uncertain || offline || readOnly;
  const blockReason = uncertain
    ? t("character.tools.exportBlockedAttempts")
    : offline
      ? t("character.tools.exportBlockedOffline")
      : readOnly
        ? t("character.tools.exportBlockedOwner")
        : queued
          ? t("character.tools.exportBlocked")
          : null;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const errorRef = useRef<HTMLParagraphElement | null>(null);

  useEffect(() => {
    focusFirst(dialogRef.current);
  }, []);

  useEffect(() => {
    if (error !== null) errorRef.current?.focus();
  }, [error]);

  const download = async () => {
    if (blocked) return;
    setBusy(true);
    setError(null);
    try {
      // The downloaded JSON is the authoritative server document verbatim,
      // never a tentative overlay: gates above block export while pending
      // edits or uncertain online outcomes exist.
      const exported = await api.export(characterId);
      const blob = new Blob([JSON.stringify(exported)], { type: "application/vnd.sweetroll.character+json;version=1" });
      const url = URL.createObjectURL(blob);
      try {
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `character-${characterId}.json`;
        document.body.appendChild(anchor);
        try {
          anchor.click();
        } finally {
          anchor.remove();
        }
      } finally {
        URL.revokeObjectURL(url);
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t("character.tools.exportFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={t("character.tools.exportTitle")}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
        trapTabKey(event, dialogRef.current);
      }}
    >
      <h2>{t("character.tools.exportTitle")}</h2>
      {error !== null ? <p ref={errorRef} tabIndex={-1} role="alert">{error}</p> : null}
      {blockReason !== null ? <p>{blockReason}</p> : null}
      <button type="button" className={styles.dialogButton} disabled={blocked || busy} onClick={() => void download()}>
        {t("character.tools.exportDownload")}
      </button>
      <button type="button" className={styles.dialogButton} onClick={onClose}>
        {t("character.tools.close")}
      </button>
    </div>
  );
}

function MigrationDialog({
  characterId,
  api,
  session,
  now,
  onClose,
}: {
  characterId: string;
  api: CharactersApi;
  session: CharacterSession;
  now: () => string;
  onClose(): void;
}) {
  const snapshot = useSnapshot(session);
  const queued = snapshot.entries.length > 0 || snapshot.phase !== "ready";
  const uncertain = snapshot.pendingOnlineAttempts.length > 0;
  const offline = !snapshot.connected;
  const readOnly = !snapshot.editing.owned;
  const manageBlocked = queued || uncertain || offline || readOnly;
  const [targetVersionId, setTargetVersionId] = useState("");
  const [preview, setPreview] = useState<MigrationPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [confirmedPreview, setConfirmedPreview] = useState(false);
  const [migrationId, setMigrationId] = useState("");
  const [opError, setOpError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    focusFirst(dialogRef.current);
  }, []);

  const expired = preview !== null && Date.parse(preview.expiresAt) < Date.parse(now());
  const confirmedRevision = snapshot.confirmed?.reconciliation.revision;
  const staleRevision =
    preview !== null && confirmedRevision !== undefined && preview.sourceRevision !== confirmedRevision;
  const candidateValues = preview !== null ? Object.entries(preview.candidateState.values as Record<string, unknown>) : [];
  const lastMigrationId =
    snapshot.lastMigration === null
      ? null
      : snapshot.lastMigration.operation === "commit"
        ? snapshot.lastMigration.previewId
        : snapshot.lastMigration.migrationId;

  const previewBlockReason = offline
    ? t("character.tools.migrationPreviewOffline")
    : uncertain
      ? t("character.tools.migrationPreviewUncertain")
      : queued || readOnly
        ? t("character.tools.migrationPreviewQueued")
        : null;

  const loadPreview = async () => {
    if (manageBlocked || targetVersionId.trim() === "") return;
    setBusy(true);
    setPreviewError(null);
    try {
      const response = await api.previewMigration(characterId, { targetVersionId });
      setPreview(response.preview);
      // Every fresh preview renews the explicit confirmation requirement.
      setConfirmedPreview(false);
    } catch (err) {
      setPreviewError(err instanceof Error && err.message ? err.message : t("character.tools.migrationPreviewFailed"));
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    if (preview === null || expired || staleRevision || manageBlocked || !confirmedPreview) return;
    // Refresh and freeze before initiating the online-only operation.
    setBusy(true);
    setOpError(null);
    try {
      await session.commitMigration(preview.previewId);
      onClose();
    } catch (err) {
      setOpError(err instanceof Error && err.message ? err.message : t("character.tools.migrationCommitFailed"));
    } finally {
      setBusy(false);
    }
  };

  const rollback = async () => {
    if (migrationId.trim() === "" || manageBlocked) return;
    // Refresh and freeze before initiating the online-only operation.
    setBusy(true);
    setOpError(null);
    try {
      await session.rollbackMigration(migrationId.trim());
      onClose();
    } catch (err) {
      setOpError(err instanceof Error && err.message ? err.message : t("character.tools.migrationRollbackFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={t("character.tools.migrationTitle")}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
        trapTabKey(event, dialogRef.current);
      }}
    >
      <h2>{t("character.tools.migrationTitle")}</h2>
      {previewError !== null ? <p role="alert">{previewError}</p> : null}
      {opError !== null ? <p role="alert">{opError}</p> : null}
      {previewBlockReason !== null ? <p>{previewBlockReason}</p> : null}
      <label htmlFor="migration-target">{t("character.tools.migrationTargetVersion")}</label>
      <input id="migration-target" className={styles.dialogField} value={targetVersionId} onChange={(event) => setTargetVersionId(event.target.value)} />
      <button type="button" className={styles.dialogButton} disabled={busy || targetVersionId.trim() === "" || manageBlocked} onClick={() => void loadPreview()}>
        {t("character.tools.migrationPreviewAction")}
      </button>
      {preview !== null ? (
        <section aria-label="Migration preview">
          <h3>{t("character.tools.migrationCandidateTitle")}</h3>
          <p>
            {t("character.tools.migrationTargetVersion")}: {preview.targetVersionId}
          </p>
          {candidateValues.length > 0 ? (
            <ul>
              {candidateValues.map(([definitionId, value]) => (
                <li key={definitionId}>
                  {definitionId}: {typeof value === "string" ? value : JSON.stringify(value)}
                </li>
              ))}
            </ul>
          ) : (
            <p>{t("character.tools.migrationCandidateEmpty")}</p>
          )}
          <ul>
            {preview.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
          {expired ? <p role="alert">{t("character.tools.migrationExpired")}</p> : null}
          {staleRevision ? <p role="alert">{t("character.tools.migrationStale")}</p> : null}
          <label className={styles.checkRow}>
            <input
              type="checkbox"
              checked={confirmedPreview}
              onChange={(event) => setConfirmedPreview(event.target.checked)}
            />
            <span>{t("character.tools.migrationConfirm")}</span>
          </label>
          <button
            type="button"
            className={styles.dialogButton}
            disabled={busy || expired || staleRevision || manageBlocked || !confirmedPreview}
            onClick={() => void commit()}
          >
            {t("character.tools.migrationCommit")}
          </button>
        </section>
      ) : null}
      {lastMigrationId !== null ? (
        <p>
          {t("character.tools.migrationLastId", { id: lastMigrationId })}{" "}
          <button type="button" className={styles.dialogButton} onClick={() => setMigrationId(lastMigrationId)}>
            {t("character.tools.migrationUseLast")}
          </button>
        </p>
      ) : null}
      <label htmlFor="migration-id">{t("character.tools.migrationIdLabel")}</label>
      <input id="migration-id" className={styles.dialogField} value={migrationId} onChange={(event) => setMigrationId(event.target.value)} />
      <button type="button" className={styles.dialogButton} disabled={busy || migrationId.trim() === "" || manageBlocked} onClick={() => void rollback()}>
        {t("character.tools.migrationRollback")}
      </button>
      <button type="button" className={styles.dialogButton} onClick={onClose}>
        {t("character.tools.close")}
      </button>
    </div>
  );
}
