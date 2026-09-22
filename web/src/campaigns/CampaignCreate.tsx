// web/src/campaigns/CampaignCreate.tsx
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import type { CharactersApi } from "../characters/api.js";
import { t } from "../i18n/index.js";
import { Button, EmptyState, FormField, PageHeader, Panel } from "../ui/index.js";
import type { CampaignsApi } from "./api.js";
import { randomUUID } from "../utils/uuid";

export function campaignCreateViewKey(actor: string | null, generation: number): string {
  return `${actor ?? "signed-out"}:${generation}`;
}

function isConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as { code?: unknown; status?: unknown };
  return record.status === 409 || record.code === "conflict";
}

function describeError(cause: unknown, fallback: string): string {
  if (typeof cause === "object" && cause !== null && "message" in cause
    && typeof cause.message === "string" && cause.message !== "") {
    return cause.message;
  }
  return fallback;
}

export function CampaignCreate(props: {
  api: Pick<CampaignsApi, "createCampaign">;
  versionsApi: Pick<CharactersApi, "listCreationVersions">;
  actorId: string | null;
  online: boolean;
  navigation: { onCreated: (campaignId: string) => void };
}) {
  const queryClient = useQueryClient();
  const catalog = useQuery({
    queryKey: ["campaigns", "create", "versions", props.actorId],
    queryFn: () => props.versionsApi.listCreationVersions({ limit: 25 }),
    enabled: props.actorId !== null && props.online,
    staleTime: 30_000,
  });
  const [versionId, setVersionId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [pending, setPending] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (props.actorId === null) {
    return (
      <section aria-label={t("campaign.create.title")}>
        <PageHeader title={t("campaign.create.title")} />
        <p role="status">{t("campaign.create.signIn")}</p>
      </section>
    );
  }
  if (!props.online) {
    return (
      <section aria-label={t("campaign.create.title")}>
        <PageHeader title={t("campaign.create.title")} description={t("campaign.create.description")} />
        <p role="status">{t("campaign.create.offline")}</p>
      </section>
    );
  }

  const submit = async (): Promise<void> => {
    const trimmedTitle = title.trim();
    if (pending || versionId === null || trimmedTitle === "") return;
    setPending(true);
    setError(null);
    setConflict(false);
    // Caller-minted idempotency key, fresh on every attempt.
    const idempotencyKey = randomUUID();
    try {
      const response = await props.api.createCampaign({
        systemVersionId: versionId,
        title: trimmedTitle,
        ...(description.trim() === "" ? {} : { description: description.trim() }),
        idempotencyKey,
      });
      void queryClient.invalidateQueries({ queryKey: ["campaigns", "list"] });
      props.navigation.onCreated(response.campaign.campaignId);
    } catch (cause) {
      if (isConflict(cause)) {
        // 409 → reload the catalog, then offer a retry with a fresh key. Never "Merge".
        await catalog.refetch();
        setConflict(true);
      } else {
        setError(describeError(cause, t("campaign.create.error")));
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <section aria-label={t("campaign.create.title")}>
      <PageHeader title={t("campaign.create.title")} description={t("campaign.create.description")} />
      {conflict ? <p role="status">{t("campaign.create.conflict")}</p> : null}
      {error !== null ? <p role="alert">{error}</p> : null}
      {catalog.status === "pending" ? <p role="status">{t("campaign.create.version.loading")}</p> : null}
      {catalog.status === "error" ? (
        <EmptyState
          title={t("campaign.create.version.loadFailed")}
          action={
            <Button variant="primary" onClick={() => void catalog.refetch()}>
              {t("campaign.create.version.retry")}
            </Button>
          }
        />
      ) : null}
      {catalog.status === "success" ? (
        catalog.data.data.versions.length === 0 ? (
          <EmptyState title={t("campaign.create.version.empty")} />
        ) : (
          <Panel title={t("campaign.create.version.label")}>
            <ul>
              {catalog.data.data.versions.map((entry) => (
                <li key={entry.versionId}>
                  <Button
                    variant="secondary"
                    aria-pressed={versionId === entry.versionId}
                    onClick={() => setVersionId(entry.versionId)}
                  >
                    {`${entry.systemName} ${entry.semanticVersion} · ${new Date(entry.createdAt).toLocaleDateString()} · ${entry.versionId.slice(0, 8)}`}
                  </Button>
                </li>
              ))}
            </ul>
          </Panel>
        )
      ) : null}
      <FormField label={t("campaign.create.title.label")}>
        <input type="text" value={title} onChange={(event) => setTitle(event.target.value)} />
      </FormField>
      <FormField label={t("campaign.create.description.label")}>
        <input type="text" value={description} onChange={(event) => setDescription(event.target.value)} />
      </FormField>
      <Button variant="primary" pending={pending} pendingText={t("campaign.create.creating")} onClick={() => void submit()}>
        {t("campaign.create.submit")}
      </Button>
    </section>
  );
}
