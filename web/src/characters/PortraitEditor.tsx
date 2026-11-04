import { useEffect, useRef, useState } from "react";
import { ApiError } from "../api/client.js";
import { t } from "../i18n/index.js";
import { Button } from "../ui/Button.js";
import { ImageFileFields } from "../ui/ImageFileFields.js";
import { Dialog } from "../ui/Dialog.js";
import { randomUUID } from "../utils/uuid.js";
import {
  portraitUrl,
  type CharacterImagesApi,
  type PortraitState,
  type SetPortraitBody,
  type RemovePortraitBody,
} from "./imageApi.js";
import styles from "./PortraitEditor.module.css";

type Attempt =
  | { kind: "set"; body: SetPortraitBody }
  | { kind: "remove"; body: RemovePortraitBody };
type Props = {
  api: CharacterImagesApi;
  characterId: string;
  characterRevision: number;
  online: boolean;
  canEdit: boolean;
  onRefresh?: (() => Promise<void>) | undefined;
};

/** Mounted with the actor/character lifetime; never enters the sheet command queue. */
export function PortraitEditor({
  api,
  characterId,
  characterRevision,
  online,
  canEdit,
  onRefresh,
}: Props) {
  const [state, setState] = useState<PortraitState | null>(null);
  const [selected, setSelected] = useState<{
    dataBase64: string;
    contentType: SetPortraitBody["contentType"];
    preview: string;
  } | null>(null);
  const [description, setDescription] = useState("");
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const lifetime = useRef(0);
  const [resetKey, setResetKey] = useState(0);
  useEffect(() => {
    const generation = ++lifetime.current;
    setState(null);
    setSelected(null);
    setAttempt(null);
    setDescription("");
    setError(null);
    setBusy(false);
    setViewing(false);
    if (online)
      void api.open(characterId).then(
        (value) => {
          if (lifetime.current === generation) setState(value);
        },
        (cause) => {
          if (lifetime.current === generation)
            setError(
              cause instanceof Error ? cause.message : t("portrait.error"),
            );
        },
      );
    return () => {
      ++lifetime.current;
    };
  }, [api, characterId, online, refresh]);
  function clearSelection() {
    setSelected(null);
    setAttempt(null);
    setDescription("");
    setResetKey(value => value + 1);
  }
  async function send(request: Attempt) {
    if (!online || busy || !canEdit) return;
    const generation = lifetime.current;
    setAttempt(request);
    setBusy(true);
    setError(null);
    try {
      const value =
        request.kind === "set"
          ? await api.set(characterId, request.body)
          : await api.remove(characterId, request.body);
      if (generation === lifetime.current) {
        setState(value);
        clearSelection();
      }
    } catch (cause) {
      if (generation === lifetime.current) {
        setError(cause instanceof Error ? cause.message : t("portrait.error"));
        if (
          cause instanceof ApiError &&
          [401, 403, 404].includes(cause.status)
        ) {
          setState(null);
          setViewing(false);
        }
      }
    } finally {
      if (generation === lifetime.current) setBusy(false);
    }
  }
  const disabled = !online || !canEdit || state === null || busy;
  const portrait = online ? state?.portrait : null;
  return (
    <section
      className={styles.panel}
      aria-label={t("portrait.title")}
      aria-busy={busy}
    >
      <h2>{t("portrait.title")}</h2>
      {portrait ? (
        <button
          type="button"
          className={styles.previewButton}
          onClick={() => setViewing(true)}
          aria-label={t("portrait.view")}
        >
          <img
            className={styles.thumbnail}
            src={portraitUrl(characterId, portrait.fileId)}
            alt={portrait.description}
            onError={(event) => {
              event.currentTarget.hidden = true;
              setError(t("portrait.missing"));
            }}
          />
        </button>
      ) : (
        <p role="status">
          {t(
            online
              ? state === null
                ? error
                  ? "portrait.missing"
                  : "portrait.loading"
                : "portrait.empty"
              : "portrait.offline",
          )}
        </p>
      )}
      {canEdit ? (
        <>
          <ImageFileFields labels="portrait" selected={selected} description={description} onSelect={setSelected} onDescription={setDescription} onError={setError} disabled={disabled || attempt !== null} resetKey={resetKey} />
          <div className={styles.actions}>
            {selected && !attempt ? (
              <Button
                disabled={disabled || !description.trim()}
                onClick={() =>
                  void send({
                    kind: "set",
                    body: {
                      expectedCharacterRevision: characterRevision,
                      expectedPortraitRevision: state!.revision,
                      description: description.trim(),
                      contentType: selected.contentType,
                      dataBase64: selected.dataBase64,
                      idempotencyKey: randomUUID(),
                    },
                  })
                }
              >
                {t(portrait ? "portrait.replace" : "portrait.upload")}
              </Button>
            ) : null}
            {portrait && !attempt && !selected ? (
              <Button
                variant="secondary"
                disabled={disabled}
                onClick={() =>
                  void send({
                    kind: "remove",
                    body: {
                      expectedCharacterRevision: characterRevision,
                      expectedPortraitRevision: state!.revision,
                      idempotencyKey: randomUUID(),
                    },
                  })
                }
              >
                {t("portrait.remove")}
              </Button>
            ) : null}
            {attempt ? (
              <Button disabled={disabled} onClick={() => void send(attempt)}>
                {t("portrait.retry")}
              </Button>
            ) : null}
            {selected || attempt ? (
              <Button
                variant="secondary"
                disabled={busy}
                onClick={clearSelection}
              >
                {t("portrait.discard")}
              </Button>
            ) : null}
          </div>
        </>
      ) : null}
      {busy ? <p role="status">{t("portrait.saving")}</p> : null}
      {error ? (
        <>
          <p role="alert">{error}</p>
          <Button
            variant="secondary"
            disabled={!online || busy}
            onClick={() => {
              void Promise.resolve(onRefresh?.()).then(
                () => setRefresh((value) => value + 1),
                () => setError(t("portrait.error")),
              );
            }}
          >
            {t("portrait.refresh")}
          </Button>
        </>
      ) : null}
      <Dialog
        title={t("portrait.title")}
        description={portrait?.description}
        open={viewing && !!portrait}
        onOpenChange={setViewing}
      >
        {portrait ? (
          <img
            className={styles.full}
            src={portraitUrl(characterId, portrait.fileId, false)}
            alt={portrait.description}
            onError={() => {
              setError(t("portrait.missing"));
              setViewing(false);
            }}
          />
        ) : null}
      </Dialog>
    </section>
  );
}

export function PortraitThumbnail({
  characterId,
  name,
  online = true,
}: {
  characterId: string;
  name: string;
  online?: boolean;
}) {
  const [missing, setMissing] = useState(false);
  return online && !missing ? (
    <img
      className={styles.listThumbnail}
      src={portraitUrl(characterId)}
      alt={t("portrait.thumbnail", { name })}
      loading="lazy"
      onError={() => setMissing(true)}
    />
  ) : (
    <span role="img" className={styles.placeholder} aria-label={t("portrait.empty")} />
  );
}
