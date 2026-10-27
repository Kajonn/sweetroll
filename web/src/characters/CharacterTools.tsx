import {RollBreakdown} from "../rolls/RollBreakdown.js";
import { useEffect, useRef, useState } from "react";

import { t } from "../i18n/index.js";
import { Button } from "../ui/Button.js";
import type { CharactersApi } from "./api.js";
import { captureOpener, focusFirst, restoreOpener, trapTabKey } from "./dialogTrap.js";
import type { CharacterSession } from "./session.js";
import type { ActivityEvent } from "./types.js";
import styles from "./characters.module.css";

export type CharacterToolsProps = {
  characterId: string;
  api: CharactersApi;
  session: CharacterSession;
};

type DialogKind = "activity" | "archive" | "recover" | "export" | null;

function useSnapshot(session: CharacterSession) {
  const [snapshot, setSnapshot] = useState(() => session.getSnapshot());
  useEffect(() => session.subscribe(setSnapshot), [session]);
  return snapshot;
}

/**
 * Secondary character management panels. Activity reads go through the
 * session's durable account/character cache; export documents are read-only
 * API calls. Every mutation goes through the
 * session so queue sequencing, refresh-before-freeze and durable online
 * attempts are never bypassed. Management buttons stay disabled while
 * edits are pending, an online outcome is uncertain, the tab is read-only
 * or the session is offline/not ready.
 */
export function CharacterTools({ characterId, api, session }: CharacterToolsProps) {
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
    <section aria-label={t("character.tools.title")} className={styles.toolGroup}>
      <Button type="button" variant="primary" onClick={() => openDialog("activity")}>
        {t("character.tools.activity")}
      </Button>
      <Button type="button" variant="primary" disabled={manageBlocked || lifecycle === "archived"} onClick={() => openDialog("archive")}>
        {t("character.tools.archive")}
      </Button>
      <Button type="button" variant="primary" disabled={manageBlocked || lifecycle !== "archived"} onClick={() => openDialog("recover")}>
        {t("character.tools.recover")}
      </Button>
      <Button type="button" variant="primary" disabled={blocked} onClick={() => openDialog("export")}>
        {t("character.tools.export")}
      </Button>
      {lifecycle === "archived" ? <p>{t("character.tools.archivedReadOnly")}</p> : null}
      {dialog === "activity" ? (
        <ActivityDialog characterId={characterId} session={session} onClose={closeDialog} />
      ) : null}
      {dialog === "archive" ? (
        <ConfirmDialog
          title={t("character.tools.archiveTitle")}
          confirmLabel={t("character.tools.confirmArchive")}
          onConfirm={async () => {
            if (snapshot.entries.length > 0 || snapshot.phase !== "ready") {
              throw new Error(t("character.tools.confirmFailed"));
            }
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
            if (snapshot.entries.length > 0 || snapshot.phase !== "ready") {
              throw new Error(t("character.tools.confirmFailed"));
            }
            // Refresh and freeze before initiating the online-only operation.
            await session.recover();
          }}
          onClose={closeDialog}
        />
      ) : null}
      {dialog === "export" ? (
        <ExportDialog characterId={characterId} api={api} session={session} onClose={closeDialog} />
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
      className={styles.dialog}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
        trapTabKey(event, dialogRef.current);
      }}
    >
      <h2>{title}</h2>
      {error !== null ? <p role="alert">{error}</p> : null}
      <div className={styles.dialogActions}>
      <Button
        ref={confirmRef}
        type="button"
        variant="primary"
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
      </Button>
      <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>
        {t("character.conflict.cancel")}
      </Button>
      </div>
    </div>
  );
}

function ActivityRow({ event }: { event: ActivityEvent }) {
  const knownKinds = new Set([
    "character_created", "character_duplicated", "character_field_set", "character_resource_bumped",
    "character_action_executed", "character_renamed", "character_archived", "character_recovered",
    "character_exported", "character_campaign_created", "character_adopted",
    "character_controllers_assigned", "character_claimed", "character_ownership_transferred",
    "entry_added", "entry_removed", "entry_updated",
  ]);
  const label = knownKinds.has(event.kind)
    ? t(`character.activity.${event.kind}`)
    : event.kind.replace(/^character[_-]/, "").replace(/[_-]/g, " ").replace(/^./, letter => letter.toUpperCase());
  const date = new Date(event.occurredAt);
  const formattedDate = Number.isNaN(date.getTime()) ? event.occurredAt : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
  return (
    <li>
      <span>{label}</span>{" · "}
      <time dateTime={event.occurredAt}>{formattedDate}</time>
      {event.roll===undefined?null:<RollBreakdown roll={event.roll}/>}
    </li>
  );
}

function ActivityDialog({ characterId, session, onClose }: { characterId: string; session: CharacterSession; onClose(): void }) {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Start busy before choosing the initial focus target. Focusing Refresh
  // and disabling it immediately afterwards drops keyboard focus to body.
  const [loading, setLoading] = useState(true);
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
      className={styles.dialog}
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
      <div className={styles.dialogActions}>
      {cursor !== null ? (
        <Button type="button" variant="primary" disabled={loading} onClick={() => void load(cursor, true)}>
          {t("character.tools.activityLoadMore")}
        </Button>
      ) : null}
      <Button type="button" variant="secondary" disabled={loading} onClick={() => void load(null, false)}>
        {t("character.tools.activityRefresh")}
      </Button>
      <Button type="button" variant="secondary" onClick={onClose}>
        {t("character.tools.close")}
      </Button>
      </div>
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
      className={styles.dialog}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
        trapTabKey(event, dialogRef.current);
      }}
    >
      <h2>{t("character.tools.exportTitle")}</h2>
      {error !== null ? <p ref={errorRef} tabIndex={-1} role="alert">{error}</p> : null}
      {blockReason !== null ? <p>{blockReason}</p> : null}
      <div className={styles.dialogActions}>
      <Button type="button" variant="primary" disabled={blocked || busy} onClick={() => void download()}>
        {t("character.tools.exportDownload")}
      </Button>
      <Button type="button" variant="secondary" onClick={onClose}>
        {t("character.tools.close")}
      </Button>
      </div>
    </div>
  );
}
