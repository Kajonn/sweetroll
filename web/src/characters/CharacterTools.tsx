import { useEffect, useRef, useState } from "react";

import { t } from "../i18n/index.js";
import type { CharactersApi } from "./api.js";
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

function DialogShell({ title, onClose, children }: { title: string; onClose(): void; children: React.ReactNode }) {
  const firstRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    firstRef.current?.focus();
  }, []);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <h2>{title}</h2>
      {children}
      <button ref={firstRef} type="button" onClick={onClose}>
        {title}
      </button>
    </div>
  );
}

function ConfirmDialog({ title, confirmLabel, onConfirm, onClose }: { title: string; confirmLabel: string; onConfirm(): Promise<void>; onClose(): void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    confirmRef.current?.focus();
  }, []);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
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
              setError(err instanceof Error ? err.message : "Request failed.");
            } finally {
              setBusy(false);
            }
          })()
        }
      >
        {confirmLabel}
      </button>
      <button type="button" disabled={busy} onClick={onClose}>
        {title}
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
      setError(err instanceof Error ? err.message : "Activity unavailable offline.");
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
      role="dialog"
      aria-modal="true"
      aria-label="Activity"
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <h2>Activity</h2>
      {stale ? <p>Stale — showing the last fetched activity offline.</p> : null}
      {error !== null ? <p role="alert">{error}</p> : null}
      <ul>
        {events.map((event) => (
          <li key={event.id}>{event.id}</li>
        ))}
      </ul>
      {cursor !== null ? (
        <button type="button" disabled={loading} onClick={() => void load(cursor, true)}>
          Load more
        </button>
      ) : null}
      <button type="button" disabled={loading} onClick={() => void load(null, false)}>
        Refresh activity
      </button>
      <button type="button" onClick={onClose}>
        Close
      </button>
    </div>
  );
}

function ExportDialog({ characterId, api, blocked, onClose }: { characterId: string; api: CharactersApi; blocked: boolean; onClose(): void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
        anchor.click();
      } finally {
        URL.revokeObjectURL(url);
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Export"
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <h2>Export</h2>
      {error !== null ? <p role="alert">{error}</p> : null}
      <button type="button" disabled={blocked || busy} onClick={() => void download()}>
        Download export
      </button>
      <button type="button" onClick={onClose}>
        Close
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

  const expired = preview !== null && Date.parse(preview.expiresAt) < Date.parse(now());

  const loadPreview = async () => {
    setBusy(true);
    setPreviewError(null);
    try {
      const response = await api.previewMigration(characterId, { targetVersionId });
      setPreview(response.preview);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : "Preview failed.");
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    if (preview === null || expired || blocked) return;
    // Refresh and freeze before initiating the online-only operation.
    setBusy(true);
    setOpError(null);
    try {
      await session.commitMigration(preview.previewId);
      onClose();
    } catch (err) {
      setOpError(err instanceof Error ? err.message : "Commit failed. Re-preview the migration and try again.");
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
      setOpError(err instanceof Error ? err.message : "Rollback failed. This migration may be past its rollback limit.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Migration"
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <h2>Migration</h2>
      {previewError !== null ? <p role="alert">{previewError}</p> : null}
      {opError !== null ? <p role="alert">{opError}</p> : null}
      <label htmlFor="migration-target">Target version</label>
      <input id="migration-target" value={targetVersionId} onChange={(event) => setTargetVersionId(event.target.value)} />
      <button type="button" disabled={busy || targetVersionId.trim() === ""} onClick={() => void loadPreview()}>
        Preview migration
      </button>
      {preview !== null ? (
        <section aria-label="Migration preview">
          <ul>
            {preview.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
          {expired ? <p role="alert">This preview expired. Re-preview the migration before committing.</p> : null}
          <button type="button" disabled={busy || expired || blocked} onClick={() => void commit()}>
            Commit migration
          </button>
        </section>
      ) : null}
      <label htmlFor="migration-id">Migration ID</label>
      <input id="migration-id" value={migrationId} onChange={(event) => setMigrationId(event.target.value)} />
      <button type="button" disabled={busy || migrationId.trim() === "" || blocked} onClick={() => void rollback()}>
        Roll back migration
      </button>
      <button type="button" onClick={onClose}>
        Close
      </button>
    </div>
  );
}
