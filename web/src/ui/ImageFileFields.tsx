import { useEffect, useRef } from "react";
import { t } from "../i18n/index.js";
import type { ImageUpload } from "./imageEditorApi.js";
import styles from "./ImageAttachmentEditor.module.css";
export type SelectedImage = Pick<ImageUpload, "contentType" | "dataBase64"> & { preview: string };
export function ImageFileFields({ selected, description, onSelect, onDescription, onError, disabled, resetKey, labels = "artwork", descriptionMaxLength = 500, fileLabel }: {
  selected: SelectedImage | null; description: string; onSelect(value: SelectedImage | null): void; onDescription(value: string): void; onError(value: string | null): void; disabled: boolean; resetKey: number; labels?: "artwork" | "portrait"; descriptionMaxLength?: number; fileLabel?: string | undefined;
}) {
  const sequence = useRef(0), input = useRef<HTMLInputElement>(null);
  useEffect(() => { ++sequence.current; if (input.current) input.current.value = ""; return () => { ++sequence.current; }; }, [resetKey]);
  function choose(file?: File) {
    const generation = ++sequence.current;
    onSelect(null); onDescription(""); onError(null);
    if (!file) return;
    if (file.size > 5 * 1024 * 1024 || !["image/png", "image/jpeg", "image/webp"].includes(file.type)) { onError(t(`${labels}.fileLimits`)); return; }
    const reader = new FileReader();
    reader.onload = () => { if (sequence.current !== generation) return; const preview = String(reader.result); onSelect({ preview, dataBase64: preview.slice(preview.indexOf(",") + 1), contentType: file.type as SelectedImage["contentType"] }); };
    reader.onerror = () => { if (sequence.current === generation) onError(t(`${labels}.error`)); };
    reader.readAsDataURL(file);
  }
  return <div className={styles.fields}>
    <p>{t(`${labels}.fileLimits`)}</p>
    <label>{fileLabel ?? t(`${labels}.file`)}<input ref={input} type="file" accept="image/png,image/jpeg,image/webp" disabled={disabled} onChange={e => choose(e.target.files?.[0])} /></label>
    {selected ? <><img className={styles.thumbnail} src={selected.preview} alt={t(`${labels}.selected`)} /><label>{t(`${labels}.description`)}<input maxLength={descriptionMaxLength} value={description} disabled={disabled} onChange={e => onDescription(e.target.value)} /></label></> : null}
  </div>;
}
