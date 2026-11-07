import { useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { t } from "../i18n/index.js";
import { Button, Dialog, Panel } from "../ui/index.js";
import { ImageFileFields, type SelectedImage } from "../ui/ImageFileFields.js";
import { randomUUID } from "../utils/uuid.js";
import type { SceneLibraryApi } from "./api.js";
import type { SceneView, UploadImageBody, DeleteImageBody, CreateSceneBody, UpdateSceneBody } from "./types.js";
import styles from "./SceneLibrary.module.css";
type ImageRow = Awaited<ReturnType<SceneLibraryApi["listImages"]>>["images"][number];
type Attempt = { kind: "upload"; body: UploadImageBody } | { kind: "delete"; fileId: string; body: DeleteImageBody } | { kind: "create"; body: CreateSceneBody } | { kind: "replace"; sceneId: string; body: UpdateSceneBody };
type Props = { selection?: { fileId: string | null; onSelect(fileId: string | null): void } | undefined; api: SceneLibraryApi; campaignId: string; actorId: string | null; generation: number; online: boolean; scene?: SceneView | undefined; onChanged(): void | Promise<void>; onOpenScene(sceneId: string): void; };
export function SceneLibrary(props: Props) {
  return <SceneLibraryScope key={`${props.actorId}:${props.generation}:${props.campaignId}`} {...props} />;
}
function SceneLibraryScope({ api, campaignId, actorId, generation, online, scene, onChanged, onOpenScene, selection }: Props) {
  const client = useQueryClient(), lifetime = useRef(0);
  const key = useMemo(() => ["campaigns", "scene-library", campaignId, actorId, generation, selection ? "tokens" : "backgrounds"], [campaignId, actorId, generation, Boolean(selection)]);
  const enabled = online && actorId !== null;
  const images = useInfiniteQuery({ queryKey: [...key, "images"], initialPageParam: null as string | null, enabled, queryFn: async ({ pageParam, signal }) => { const value = await api.listImages(campaignId, { cursor: pageParam }); if (signal.aborted) throw Error("Discarded image library response"); return value; }, getNextPageParam: page => page.nextCursor ?? undefined });
  const scenes = useInfiniteQuery({ queryKey: [...key, "scenes"], initialPageParam: null as string | null, enabled: enabled && !selection, queryFn: async ({ pageParam, signal }) => { const value = await api.listScenes(campaignId, { cursor: pageParam }); if (signal.aborted) throw Error("Discarded scene library response"); return value; }, getNextPageParam: page => page.nextCursor ?? undefined });
  const [denied, setDenied] = useState(false);
  const [selected, setSelected] = useState<SelectedImage | null>(null), [description, setDescription] = useState("");
  const [attempt, setAttempt] = useState<Attempt | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [conflict, setConflict] = useState(false), [resetKey, setResetKey] = useState(0);
  const [target, setTarget] = useState<{ kind: "replace" | "delete"; file: ImageRow; scene?: SceneView } | null>(null), [viewing, setViewing] = useState<ImageRow | null>(null);
  useEffect(() => { ++lifetime.current; return () => { ++lifetime.current; void client.cancelQueries({ queryKey: key }); client.removeQueries({ queryKey: key }); }; }, [client, key]);
  useEffect(() => { ++lifetime.current; setBusy(false); setViewing(null); return () => { ++lifetime.current; }; }, [online]);
  const rows = online && !denied && !images.isError && (!scenes.isError || selection) ? images.data?.pages.flatMap(page => page.images) ?? [] : [];
  const ready = enabled && !denied && images.isSuccess && (selection !== undefined || scenes.isSuccess), disabled = !ready || busy || attempt !== null || conflict;
  const path = (file: ImageRow, thumbnail = true) => `/api/campaigns/${encodeURIComponent(campaignId)}/images/${encodeURIComponent(file.fileId)}/${thumbnail ? "thumbnail" : "original"}`;
  async function refresh() { await Promise.all([client.invalidateQueries({ queryKey: key.slice(0, 5) }), images.refetch(), ...(selection ? [] : [scenes.refetch(), onChanged()])]); }
  async function send(request: Attempt) {
    if (!enabled || busy) return;
    const epoch = lifetime.current; setAttempt(request); setBusy(true); setError(null);
    try {
      let open: string | undefined; let uploadedFileId: string | undefined;
      if (request.kind === "upload" || request.kind === "delete") {
        const value = request.kind === "upload" ? await api.uploadImage(campaignId, request.body) : await api.deleteImage(campaignId, request.fileId, request.body);
        if (!value?.image?.fileId || (request.kind === "delete" && value.image.fileId !== request.fileId)) throw Error(t("artwork.uncertain"));
        if (request.kind === "upload") uploadedFileId = value.image.fileId;
      } else {
        const value = request.kind === "create" ? await api.createScene(campaignId, request.body) : await api.updateScene(request.sceneId, request.body);
        if (!value?.scene?.sceneId || value.scene.backgroundFileId !== request.body.backgroundFileId || value.scene.revision !== (request.kind === "create" ? 1 : request.body.expectedSceneRevision + 1) || value.scene.fog.length || value.scene.tokens.length) throw Error(t("artwork.uncertain"));
        if (request.kind === "create") open = value.scene.sceneId;
      }
      if (epoch !== lifetime.current) return;
      await refresh(); if (epoch !== lifetime.current) return;
      setAttempt(null); setTarget(null); setSelected(null); setDescription(""); setResetKey(v => v + 1);
      if (uploadedFileId && selection) selection.onSelect(uploadedFileId);
      if (request.kind === "delete" && selection?.fileId === request.fileId) selection.onSelect(null);
      if (open) onOpenScene(open);
    } catch (cause) {
      if (epoch !== lifetime.current) return;
      if (typeof cause === "object" && cause && "status" in cause && [401, 403, 404].includes(Number(cause.status))) {
        setDenied(true); setSelected(null); setTarget(null); setViewing(null); setAttempt(null);
        void client.cancelQueries({ queryKey: key }); client.removeQueries({ queryKey: key });
      }
      setError(cause instanceof Error ? cause.message : typeof cause === "object" && cause && "message" in cause ? String(cause.message) : t("scene.library.error"));
      if (typeof cause === "object" && cause && "status" in cause && cause.status === 409) { setAttempt(null); setConflict(true); }
    } finally { if (epoch === lifetime.current) setBusy(false); }
  }
  const feedback = <>{error ? <p role="alert">{error}</p> : null}{busy ? <p role="status">{t("artwork.saving")}</p> : null}
    {attempt ? <Button disabled={!enabled || busy} onClick={() => void send(attempt)}>{t("artwork.retry")}</Button> : null}
    {attempt ? <Button variant="secondary" disabled={busy} onClick={() => { setAttempt(null); setTarget(null); }}>{t("artwork.discard")}</Button> : null}
    {conflict ? <Button disabled={!enabled || busy} onClick={() => { void refresh().then(() => { setConflict(false); setTarget(null); setError(null); }); }}>{t("scene.library.refresh")}</Button> : null}</>;
  return <Panel title={t(selection ? "scene.tokens.library" : "scene.library.title")}>
    {!online ? <p role="status">{t("campaign.detail.scenes.offline")}</p> : denied || images.isError || (!selection && scenes.isError) ? <p role="alert">{t("scene.library.unavailable")}</p> : !ready ? <p role="status">{t("campaign.detail.scenes.loading")}</p> : null}
    <ImageFileFields selected={online ? selected : null} description={description} onSelect={setSelected} onDescription={setDescription} onError={setError} disabled={disabled} resetKey={resetKey} descriptionMaxLength={200} fileLabel={selection ? t("scene.tokens.file") : undefined} />
    {selected ? <Button disabled={disabled || !description.trim() || description.length > 200} onClick={() => void send({ kind: "upload", body: { name: description.trim(), contentType: selected.contentType, dataBase64: selected.dataBase64, idempotencyKey: randomUUID() } })}>{t(selection ? "scene.tokens.upload" : "scene.library.upload")}</Button> : null}
    {!target ? feedback : null}
    <ul className={styles.images}>{rows.map(file => <li key={file.fileId}>
      <button type="button" className={styles.preview} aria-label={t("scene.library.view", { name: file.name })} onClick={() => setViewing(file)}><img className={styles.thumbnail} src={path(file)} alt={file.name} loading="lazy" onError={e => { e.currentTarget.hidden = true; setError(t("artwork.missing")); }} /></button>
      <p>{file.name}</p><div className={styles.actions}>
        <Button disabled={disabled || (selection ? file.fileId === selection.fileId : file.fileId === scene?.backgroundFileId)} onClick={() => { setError(null); if (selection) selection.onSelect(file.fileId); else if (scene) setTarget({ kind: "replace", file, scene: structuredClone(scene) }); else void send({ kind: "create", body: { backgroundFileId: file.fileId, idempotencyKey: randomUUID() } }); }}>{t(selection ? "scene.tokens.select" : scene ? "scene.library.use" : "scene.library.create")}</Button>
        <Button variant="secondary" disabled={disabled || file.fileId === scene?.backgroundFileId} onClick={() => { setError(null); setTarget({ kind: "delete", file }); }}>{t("scene.library.delete")}</Button>
      </div>
    </li>)}</ul>
    {online && images.hasNextPage ? <Button disabled={images.isFetchingNextPage} onClick={() => void images.fetchNextPage()}>{t("scene.library.moreImages")}</Button> : null}
    {online && ready && !selection ? <ul>{scenes.data?.pages.flatMap(page => page.scenes).map((item, i) => <li key={item.sceneId}><Button variant="secondary" disabled={busy || attempt !== null} onClick={() => onOpenScene(item.sceneId)}>{t("scene.library.open", { name: rows.find(file => file.fileId === item.backgroundFileId)?.name ?? t("scene.library.number", { number: i + 1 }) })}</Button></li>)}</ul> : null}
    {online && !selection && scenes.hasNextPage ? <Button disabled={scenes.isFetchingNextPage} onClick={() => void scenes.fetchNextPage()}>{t("scene.library.moreScenes")}</Button> : null}
    <Dialog open={target !== null} onOpenChange={open => { if (!open && !busy && !attempt) { setTarget(null); setConflict(false); setError(null); } }} title={t(target?.kind === "delete" ? "scene.library.delete" : "scene.library.replace")} description={t(target?.kind === "delete" ? "scene.library.deleteNotice" : "scene.library.replaceNotice")}>
      {target ? <><p>{target.file.name}</p><img className={styles.thumbnail} src={path(target.file)} alt={target.file.name} />{feedback}
        {!attempt && !conflict ? <Button variant={target.kind === "delete" ? "danger" : "primary"} disabled={!ready || busy} onClick={() => void send(target.kind === "delete" ? { kind: "delete", fileId: target.file.fileId, body: { expectedRevision: target.file.revision, idempotencyKey: randomUUID() } } : { kind: "replace", sceneId: target.scene!.sceneId, body: { backgroundFileId: target.file.fileId, expectedSceneRevision: target.scene!.revision, idempotencyKey: randomUUID() } })}>{t(target.kind === "delete" ? "scene.library.delete" : "scene.library.confirm")}</Button> : null}
      </> : null}
    </Dialog>
    <Dialog open={viewing !== null && online} onOpenChange={open => { if (!open) setViewing(null); }} title={t("scene.library.preview")} description={viewing?.name}>{viewing && online ? <img className={styles.full} src={path(viewing, false)} alt={viewing.name} onError={() => { setViewing(null); setError(t("artwork.missing")); }} /> : null}</Dialog>
  </Panel>;
}
