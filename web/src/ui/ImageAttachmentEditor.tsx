import { useEffect, useRef, useState } from "react";
import { ApiError } from "../api/client.js";
import { t } from "../i18n/index.js";
import { randomUUID } from "../utils/uuid.js";
import { Button } from "./Button.js";
import { Dialog } from "./Dialog.js";
import { ImageFileFields, type SelectedImage } from "./ImageFileFields.js";
import { checkedImageState, type ImageCommand, type ImageEditorApi, type ImageState, type ImageUpload } from "./imageEditorApi.js";
import styles from "./ImageAttachmentEditor.module.css";
type Attempt = { kind: "upload"; body: ImageUpload } | { kind: "remove"; body: ImageCommand };
export function ImageAttachmentEditor({ api, online, canEdit, parentRevision, onChanged, onPending }: {
  api: ImageEditorApi; online: boolean; canEdit: boolean; parentRevision?: number; onChanged?: () => void | Promise<void>; onPending?: (pending: boolean) => void;
}) {
  const [state, setState] = useState<ImageState | null>(null), [selected, setSelected] = useState<SelectedImage | null>(null), [description, setDescription] = useState("");
  const [attempt, setAttempt] = useState<Attempt | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [viewing, setViewing] = useState(false), [refresh, setRefresh] = useState(0), [resetKey, setResetKey] = useState(0);
  const lifetime = useRef(0);
  useEffect(() => {
    setSelected(null); setDescription(""); setAttempt(null); setError(null); setResetKey(v => v + 1);
  }, [api, refresh]);
  useEffect(() => {
    const generation = ++lifetime.current;
    setState(null); setBusy(false); setViewing(false);
    if (online) void api.read().then(value => { if (generation === lifetime.current) setState(checkedImageState(value)); }).catch(cause => { if (generation === lifetime.current) setError(cause instanceof Error ? cause.message : t("artwork.error")); });
    return () => { ++lifetime.current; };
  }, [api, online, refresh]);
  useEffect(() => { onPending?.(busy || attempt !== null); }, [busy, attempt, onPending]);
  function clear() { setSelected(null); setAttempt(null); setDescription(""); setResetKey(v => v + 1); }
  async function send(request: Attempt) {
    if (!online || busy || !canEdit) return;
    const generation = lifetime.current;
    setAttempt(request); setBusy(true); setError(null);
    try {
      const value = checkedImageState(await (request.kind === "upload" ? api.upload(request.body) : api.remove(request.body)));
      if (value.revision !== request.body.expectedImageRevision + 1 || (request.kind === "upload" ? !value.image : value.image !== null)) throw new Error(t("artwork.uncertain"));
      if (generation !== lifetime.current) return;
      await onChanged?.();
      if (generation === lifetime.current) { setState(value); clear(); }
    } catch (cause) {
      if (generation === lifetime.current) {
        setError(cause instanceof Error ? cause.message : t("artwork.error"));
        if (cause instanceof ApiError && [401, 403, 404].includes(cause.status)) { setState(null); setViewing(false); }
      }
    } finally { if (generation === lifetime.current) setBusy(false); }
  }
  const image = online ? state?.image : null, disabled = !online || !canEdit || !state || busy;
  const command = (): ImageCommand => ({ expectedImageRevision: state!.revision, ...(parentRevision === undefined ? state?.parentRevision === undefined ? {} : { expectedParentRevision: state.parentRevision } : { expectedParentRevision: parentRevision }), idempotencyKey: randomUUID() });
  return <div className={styles.panel} aria-busy={busy}>
    {image ? <button type="button" className={styles.preview} onClick={() => setViewing(true)} aria-label={t("artwork.view")}><img key={image.fileId} className={styles.thumbnail} loading="lazy" src={api.imageUrl(image.fileId)} alt={image.description} onError={e => { e.currentTarget.hidden = true; setError(t("artwork.missing")); }} /></button> : <p role="status">{t(!online ? "artwork.offline" : !state ? error ? "artwork.missing" : "artwork.loading" : "artwork.empty")}</p>}
    {canEdit ? <>
      <ImageFileFields selected={selected} description={description} onSelect={setSelected} onDescription={setDescription} onError={setError} disabled={disabled || attempt !== null} resetKey={resetKey} />
      <div className={styles.actions}>
        {selected && !attempt ? <Button disabled={disabled || !description.trim()} onClick={() => void send({ kind: "upload", body: { ...command(), description: description.trim(), contentType: selected.contentType, dataBase64: selected.dataBase64 } })}>{t(image ? "artwork.replace" : "artwork.upload")}</Button> : null}
        {image && !selected && !attempt ? <Button variant="secondary" disabled={disabled} onClick={() => void send({ kind: "remove", body: command() })}>{t("artwork.remove")}</Button> : null}
        {attempt ? <Button disabled={disabled} onClick={() => void send(attempt)}>{t("artwork.retry")}</Button> : null}
        {selected || attempt ? <Button variant="secondary" disabled={busy} onClick={clear}>{t("artwork.discard")}</Button> : null}
      </div>
    </> : null}
    {busy ? <p role="status">{t("artwork.saving")}</p> : null}
    {error ? <><p role="alert">{error}</p><Button variant="secondary" disabled={!online || busy} onClick={() => setRefresh(v => v + 1)}>{t("artwork.refresh")}</Button></> : null}
    <Dialog open={viewing && !!image} onOpenChange={setViewing} title={t("artwork.title")} description={image?.description}>{image ? <img className={styles.full} src={api.imageUrl(image.fileId, false)} alt={image.description} onError={() => { setViewing(false); setError(t("artwork.missing")); }} /> : null}</Dialog>
  </div>;
}
