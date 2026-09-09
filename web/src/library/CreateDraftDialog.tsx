import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";

import { useCreateDraft, type CreateDraftInput } from "../api/createDraft.js";
import type { ApiClient } from "../api/client.js";
import { t } from "../i18n/index.js";
import { Button, FormField } from "../ui/index.js";

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
  const navigate = useNavigate();

  const submit = async () => {
    const source: CreateDraftInput["source"] =
      kind === "blank"
        ? { kind: "blank", name }
        : kind === "clone"
          ? { kind: "clone", versionId }
          : { kind: "import", content };
    const out = await mutation.mutateAsync({ source, idempotencyKey: crypto.randomUUID() });
    onOpenChange(false);
    await navigate({ to: "/systems/$systemId", params: { systemId: out.system.systemId } });
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
            <FormField label={t("createDraft.name")}>
              <input
                id="create-draft-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                data-testid="create-draft-name"
              />
            </FormField>
          )}
          {kind === "clone" && (
            <FormField label={t("createDraft.versionId")}>
              <input
                id="create-draft-version-id"
                value={versionId}
                onChange={(e) => setVersionId(e.target.value)}
                data-testid="create-draft-version-id"
              />
            </FormField>
          )}
          {kind === "import" && (
            <FormField label={t("createDraft.import.content")}>
              <textarea
                id="create-draft-content"
                rows={8}
                value={content}
                onChange={(e) => setContent(e.target.value)}
                data-testid="create-draft-content"
              />
            </FormField>
          )}
          <div className={styles.actions}>
            <Button
              variant="primary"
              onClick={submit}
              disabled={mutation.isPending}
              pending={mutation.isPending}
              pendingText={t("createDraft.submitting")}
              data-testid="create-draft-submit"
            >
              {t("createDraft.submit")}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}