import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";

import { useCreateDraft, type CreateDraftInput } from "../api/createDraft.js";
import type { ApiClient } from "../api/client.js";
import { t } from "../i18n/index.js";

import styles from "./CreateDraftDialog.module.css";

type SourceKind = "blank" | "clone" | "import";

const KINDS: ReadonlyArray<SourceKind> = ["blank", "clone", "import"];

export function CreateDraftDialog({
  client,
  open,
  onOpenChange,
}: {
  client: ApiClient;
  open: boolean;
  onOpenChange: (next: boolean) => void;
}) {
  const [kind, setKind] = useState<SourceKind>("blank");
  const [name, setName] = useState(t("createDraft.name.placeholder"));
  const [versionId, setVersionId] = useState("");
  const [content, setContent] = useState("");
  const mutation = useCreateDraft(client);

  const submit = async () => {
    const source: CreateDraftInput["source"] =
      kind === "blank"
        ? { kind: "blank", name }
        : kind === "clone"
          ? { kind: "clone", versionId }
          : { kind: "import", content };
    const out = await mutation.mutateAsync({ source, idempotencyKey: crypto.randomUUID() });
    onOpenChange(false);
    location.assign(`/systems/${out.system.systemId}`);
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content className={styles.content} aria-describedby={undefined}>
          <Dialog.Title className={styles.title}>{t("createDraft.title")}</Dialog.Title>
          <fieldset className={styles.source}>
            <legend className={styles.legend}>{t("createDraft.source")}</legend>
            <div className={styles.options}>
              {KINDS.map((k) => (
                <label key={k} className={styles.option}>
                  <input
                    type="radio"
                    name="kind"
                    checked={kind === k}
                    onChange={() => setKind(k)}
                    data-testid={`create-draft-kind-${k}`}
                  />
                  {t(`createDraft.source.${k}`)}
                </label>
              ))}
            </div>
          </fieldset>
          {kind === "blank" && (
            <label className={styles.field}>
              {t("createDraft.name")}
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                data-testid="create-draft-name"
              />
            </label>
          )}
          {kind === "clone" && (
            <label className={styles.field}>
              {t("createDraft.versionId")}
              <input
                value={versionId}
                onChange={(e) => setVersionId(e.target.value)}
                data-testid="create-draft-version-id"
              />
            </label>
          )}
          {kind === "import" && (
            <label className={styles.field}>
              {t("createDraft.import.content")}
              <textarea
                rows={8}
                value={content}
                onChange={(e) => setContent(e.target.value)}
                data-testid="create-draft-content"
              />
            </label>
          )}
          <div className={styles.actions}>
            <button
              type="button"
              onClick={submit}
              disabled={mutation.isPending}
              data-testid="create-draft-submit"
              className={styles.submit}
            >
              {mutation.isPending ? t("createDraft.submitting") : t("createDraft.submit")}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}