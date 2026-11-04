import { useEffect, useMemo, useRef, useState } from "react";
import { t } from "../i18n/index.js";
import { Button } from "./Button.js";
import { Dialog } from "./Dialog.js";
import { ImageAttachmentEditor } from "./ImageAttachmentEditor.js";
import type { ImageEditorApi } from "./imageEditorApi.js";
/** Lazily mounts private metadata and bounded thumbnails. Parent scope owns its lifetime. */
export function ItemArtwork({ createApi, resourceId, online, canEdit, parentRevision, onChanged, modal = false }: {
  createApi(resourceId: string): ImageEditorApi; resourceId: string; online: boolean; canEdit: boolean; parentRevision?: number; onChanged?: () => void | Promise<void>; modal?: boolean;
}) {
  const api = useMemo(() => createApi(resourceId), [createApi, resourceId]);
  const [visible, setVisible] = useState(false), [editing, setEditing] = useState(false), [pending, setPending] = useState(false), [refresh, setRefresh] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!root.current || typeof IntersectionObserver === "undefined") { setVisible(true); return; }
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); } });
    observer.observe(root.current); return () => observer.disconnect();
  }, []);
  const editorProps = { api, online, canEdit, ...(parentRevision === undefined ? {} : { parentRevision }), ...(onChanged ? { onChanged: async () => { await onChanged(); setRefresh(v => v + 1); } } : {}) };
  return <div ref={root}>
    {visible && (!editing || modal) ? <ImageAttachmentEditor key={refresh} api={api} online={online} canEdit={false} /> : null}
    {canEdit && !editing ? <Button variant="secondary" disabled={!online} onClick={() => setEditing(true)}>{t("artwork.manage")}</Button> : null}
    {editing && !modal ? <ImageAttachmentEditor {...editorProps} onPending={setPending} /> : null}
    {editing && !modal ? <Button variant="secondary" disabled={pending} onClick={() => { setEditing(false); setRefresh(v => v + 1); }}>{t("artwork.close")}</Button> : null}
    {modal ? <Dialog open={editing} onOpenChange={open => { if (!pending) setEditing(open); }} title={t("artwork.title")} description={t("artwork.fileLimits")}><ImageAttachmentEditor {...editorProps} onPending={setPending} /></Dialog> : null}
  </div>;
}
