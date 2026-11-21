// Design 6.8 (extensions plan E6): a system's extensions in the library.
// Lists the owned and public extensions with their latest version and lets
// the system's owner create one on top of a published base version.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import type { ApiClient } from "../api/client.js";
import { t } from "../i18n/index.js";
import { AppLink } from "../ui/AppLink.js";
import { Button, Dialog, FormField, Select } from "../ui/index.js";
import { randomUUID } from "../utils/uuid";
import { createExtension, listBaseVersions, listExtensions } from "./api.js";

function message(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message !== "" ? cause.message : fallback;
}

export function ExtensionsPanel({ client, systemId, systemName }: { client: ApiClient; systemId: string; systemName: string }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const extensions = useQuery({
    queryKey: ["extensions", "list", systemId],
    queryFn: () => listExtensions(client, systemId),
  });
  const versions = useQuery({
    queryKey: ["extensions", "base-versions", systemId],
    queryFn: () => listBaseVersions(client, systemId),
  });
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [baseVersionId, setBaseVersionId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const baseChoices = versions.data?.data.versions ?? [];

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const created = await createExtension(client, systemId, {
        baseVersionId: baseVersionId || baseChoices[0]!.versionId,
        name: name.trim(),
        idempotencyKey: randomUUID(),
      });
      await queryClient.invalidateQueries({ queryKey: ["extensions", "list", systemId] });
      setOpen(false);
      await navigate({ to: "/extensions/$extensionId", params: { extensionId: created.workspace.extension.extensionId } });
    } catch (cause) {
      setError(message(cause, t("extensions.createFailed")));
    } finally {
      setBusy(false);
    }
  };

  const items = extensions.data?.extensions ?? [];
  return (
    <section aria-label={t("extensions.listLabel", { system: systemName })} data-testid={`extensions-${systemId}`}>
      <h3>{t("extensions.title")}</h3>
      {extensions.isError ? <p role="alert">{t("extensions.loadFailed")}</p> : null}
      {extensions.isSuccess && items.length === 0 ? <p>{t("extensions.empty")}</p> : null}
      {items.length > 0 ? (
        <ul>
          {items.map((extension) => (
            <li key={extension.extensionId}>
              {extension.owned
                ? <AppLink href={`/extensions/${extension.extensionId}`}>{extension.name}</AppLink>
                : <span>{extension.name}</span>}
              {" "}
              <span>{extension.latestVersion === null ? t("extensions.unpublished") : extension.latestVersion.semanticVersion}</span>
              {extension.owned ? null : <span> · {t("extensions.shared")}</span>}
            </li>
          ))}
        </ul>
      ) : null}
      <Button
        variant="secondary"
        disabled={baseChoices.length === 0}
        onClick={() => { setName(""); setBaseVersionId(baseChoices[0]?.versionId ?? ""); setError(null); setOpen(true); }}
        data-testid={`extensions-create-${systemId}`}
      >
        {t("extensions.create")}
      </Button>
      {versions.isSuccess && baseChoices.length === 0 ? <p>{t("extensions.needsPublished")}</p> : null}
      <Dialog
        open={open}
        onOpenChange={(next) => { if (!busy) setOpen(next); }}
        title={t("extensions.createTitle")}
        description={t("extensions.createDescription", { system: systemName })}
        closeLabel={t("extensions.cancel")}
        actions={(
          <Button variant="primary" pending={busy} disabled={busy || name.trim() === ""} onClick={() => void create()}>
            {t("extensions.createConfirm")}
          </Button>
        )}
      >
        <FormField label={t("extensions.name")}>
          <input id={`extension-name-${systemId}`} value={name} onChange={(event) => setName(event.target.value)} />
        </FormField>
        <Select
          label={t("extensions.baseVersion")}
          value={baseVersionId}
          onChange={(event) => setBaseVersionId(event.target.value)}
          options={baseChoices.map((choice) => ({ value: choice.versionId, label: choice.semanticVersion }))}
        />
        {error !== null ? <p role="alert">{error}</p> : null}
      </Dialog>
    </section>
  );
}
