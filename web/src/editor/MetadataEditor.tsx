import { useCallback, useEffect, useReducer, useRef } from "react";

import { t } from "../i18n/index.js";
import {
  documentReducer,
  type SystemDocumentV1,
  type SystemMetadataV1,
} from "../state/documentReducer.js";
import styles from "./MetadataEditor.module.css";

export function MetadataEditor({
  document,
  onChange,
}: {
  document: SystemDocumentV1;
  onChange?: (document: SystemDocumentV1) => void;
}) {
  const [state, dispatch] = useReducer(documentReducer, document);
  const dirtyRef = useRef(false);

  // Follow the working document: adopt a refreshed server document in the
  // visible inputs when clean. Unflushed local edits are preserved; the
  // parent adopts server refreshes only when clean, so a dirty editor never
  // has its keystrokes swapped out from under it here.
  useEffect(() => {
    if (dirtyRef.current) return;
    dispatch({ type: "replace", document });
  }, [document]);

  const field = useCallback(
    <K extends keyof SystemMetadataV1>(key: K, value: SystemMetadataV1[K]) => {
      dirtyRef.current = true;
      dispatch({ type: "setMetadata", patch: { [key]: value } as Partial<SystemMetadataV1> });
    },
    [],
  );

  const flush = useCallback(() => {
    if (!dirtyRef.current) return;
    dirtyRef.current = false;
    onChange?.(state);
  }, [onChange, state]);

  const meta = state.metadata;

  return (
    <form
      className={styles.form}
      onSubmit={(e) => {
        e.preventDefault();
        flush();
      }}
      onBlur={flush}
      data-testid="metadata-editor"
    >
      <label className={styles.field}>
        <span className={styles.label}>{t("editor.metadata.name")}</span>
        <input
          type="text"
          className={styles.input}
          value={meta.name}
          maxLength={120}
          onChange={(e) => field("name", e.target.value)}
          data-testid="metadata-name"
        />
      </label>
      <label className={styles.field}>
        <span className={styles.label}>{t("editor.metadata.description")}</span>
        <textarea
          className={styles.textarea}
          value={meta.description}
          maxLength={2_000}
          rows={4}
          onChange={(e) => field("description", e.target.value)}
          data-testid="metadata-description"
        />
      </label>
      <div className={styles.settingsRow} data-testid="metadata-settings-row">
        <label className={styles.field}>
          <span className={styles.label}>{t("editor.metadata.language")}</span>
          <input
            type="text"
            className={styles.input}
            value={meta.language}
            maxLength={10_000}
            onChange={(e) => field("language", e.target.value)}
            data-testid="metadata-language"
          />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>{t("editor.metadata.defaultDice")}</span>
          <input
            type="text"
            className={styles.input}
            value={meta.defaultDice}
            maxLength={10_000}
            onChange={(e) => field("defaultDice", e.target.value)}
            data-testid="metadata-default-dice"
          />
        </label>
      </div>
    </form>
  );
}
