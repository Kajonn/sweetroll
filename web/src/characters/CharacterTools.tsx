import { useEffect, useRef, useState } from "react";

import { t } from "../i18n/index.js";
import type { CharactersApi } from "./api.js";
import { trapTabKey } from "./dialogTrap.js";
import type { CharacterSession } from "./session.js";
import type { ActivityEvent, MigrationPreview } from "./types.js";

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
 * Secondary character management panels. Reads (activity, migration preview,
 * export document) go through the Characters API directly; every mutation
 * goes through the session so queue sequencing, refresh-before-freeze and
 * durable online attempts are never bypassed. Management buttons stay
 * disabled while edits are pending or the session is not ready.
 */
export function CharacterTools({ characterId, api, session, now = () => new Date().toISOString() }: CharacterToolsProps) {
  const snapshot = useSnapshot(session);
  const blocked = snapshot.entries.length > 0 || snapshot.phase !== "ready";
  const lifecycle = snapshot.confirmed?.lifecycle ?? "active";
  const [dialog, setDialog] = useState<DialogKind>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  const openDialog = (kind: Exclude<DialogKind, null>) => {
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setDialog(kind);
  };
  const closeDialog = () => {
    setDialog(null);
    openerRef.current?.focus();
  };

  return (
    <section aria-label={t("character.tools.title")}>
      <button type="button" onClick={() => openDialog("activity")}>
        {t("character.tools.activity")}
      </button>
      <button type="button" disabled={blocked || lifecycle === "archived"} onClick={() => openDialog("archive")}>
        {t("character.tools.archive")}
      </button>
      <button type="button" disabled={blocked || lifecycle !== "archived"} onClick={() => openDialog("recover")}>
        {t("character.tools.recover")}
      </button>
      <button type="button" disabled={blocked} onClick={() => openDialog("export")}>
        {t("character.tools.export")}
      </button>
      <button type="button" onClick={() => openDialog("migration")}>
        {t("character.tools.migration")}
      </button>
      {lifecycle === "archived" ? <p>{t("character.tools.archivedReadOnly")}</p> : null}
      {dialog === "activity" ? (
        <ActivityDialog characterId={characterId} api={api} onClose={closeDialog} />
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
        <ExportDialog characterId={characterId} api={api} blocked={blocked} onClose={closeDialog} />
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
    confirmRef.current?.focus();
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
        disabled={busy}
        onClick={() =>
          void (async () => {
            setBusy(true);
            setError(null);
            try {
              await onConfirm();
              onClose();
            } catch (err) {
              setError(err instanceof Error ? err.message : t("character.tools.confirmFailed"));
            } finally {
              setBusy(false);
            }
          })()
        }
      >
        {confirmLabel}
      </button>
      <button type="button" disabled={busy} onClick={onClose}>
        {t("character.conflict.cancel")}
      </button>
    </div>
  );
}

function ActivityDialog({ characterId, api, onClose }: { characterId: string; api: CharactersApi; onClose(): void }) {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  const load = async (next: string | null, append: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const page = await api.activity(characterId, next);
      setEvents((current) => (append ? [...current, ...page.events] : page.events));
      setCursor(page.nextCursor);
      setStale(false);
    } catch (err) {
      setStale(true);
      setError(err instanceof Error ? err.message : t("character.tools.activityUnavailable"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(null, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [characterId]);

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
      {error !== null ? <p role="alert">{error}</p> : null}
      <ul>
        {events.map((event) => (
          <li key={event.id}>{event.id}</li>
        ))}
      </ul>
      {cursor !== null ? (
        <button type="button" disabled={loading} onClick={() => void load(cursor, true)}>
          {t("character.tools.activityLoadMore")}
        </button>
      ) : null}
      <button type="button" disabled={loading} onClick={() => void load(null, false)}>
        {t("character.tools.activityRefresh")}
      </button>
      <button type="button" onClick={onClose}>
        {t("character.tools.close")}
      </button>
    </div>
  );
}

function ExportDialog({ characterId, api, blocked, onClose }: { characterId: string; api: CharactersApi; blocked: boolean; onClose(): void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  const download = async () => {
    if (blocked) return;
    setBusy(true);
    setError(null);
    try {
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
      setError(err instanceof Error ? err.message : t("character.tools.exportFailed"));
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
      {error !== null ? <p role="alert">{error}</p> : null}
      {blocked ? <p>{t("character.tools.exportBlocked")}</p> : null}
      <button type="button" disabled={blocked || busy} onClick={() => void download()}>
        {t("character.tools.exportDownload")}
      </button>
      <button type="button" onClick={onClose}>
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
  const blocked = snapshot.entries.length > 0 || snapshot.phase !== "ready";
  const [targetVersionId, setTargetVersionId] = useState("");
  const [preview, setPreview] = useState<MigrationPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [migrationId, setMigrationId] = useState("");
  const [opError, setOpError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  const expired = preview !== null && Date.parse(preview.expiresAt) < Date.parse(now());
  const confirmedRevision = snapshot.confirmed?.reconciliation.revision;
  const staleRevision =
    preview !== null && confirmedRevision !== undefined && preview.sourceRevision !== confirmedRevision;
  const candidateValues = preview !== null ? Object.entries(preview.candidateState.values as Record<string, unknown>) : [];

  const loadPreview = async () => {
    setBusy(true);
    setPreviewError(null);
    try {
      const response = await api.previewMigration(characterId, { targetVersionId });
      setPreview(response.preview);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : t("character.tools.migrationPreviewFailed"));
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    if (preview === null || expired || staleRevision || blocked) return;
    // Refresh and freeze before initiating the online-only operation.
    setBusy(true);
    setOpError(null);
    try {
      await session.commitMigration(preview.previewId);
      onClose();
    } catch (err) {
      setOpError(err instanceof Error ? err.message : t("character.tools.migrationCommitFailed"));
    } finally {
      setBusy(false);
    }
  };

  const rollback = async () => {
    if (migrationId.trim() === "" || blocked) return;
    // Refresh and freeze before initiating the online-only operation.
    setBusy(true);
    setOpError(null);
    try {
      await session.rollbackMigration(migrationId.trim());
      onClose();
    } catch (err) {
      setOpError(err instanceof Error ? err.message : t("character.tools.migrationRollbackFailed"));
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
      <label htmlFor="migration-target">{t("character.tools.migrationTargetVersion")}</label>
      <input id="migration-target" value={targetVersionId} onChange={(event) => setTargetVersionId(event.target.value)} />
      <button type="button" disabled={busy || targetVersionId.trim() === ""} onClick={() => void loadPreview()}>
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
          <button type="button" disabled={busy || expired || staleRevision || blocked} onClick={() => void commit()}>
            {t("character.tools.migrationCommit")}
          </button>
        </section>
      ) : null}
      <label htmlFor="migration-id">{t("character.tools.migrationIdLabel")}</label>
      <input id="migration-id" value={migrationId} onChange={(event) => setMigrationId(event.target.value)} />
      <button type="button" disabled={busy || migrationId.trim() === "" || blocked} onClick={() => void rollback()}>
        {t("character.tools.migrationRollback")}
      </button>
      <button type="button" onClick={onClose}>
        {t("character.tools.close")}
      </button>
    </div>
  );
}
