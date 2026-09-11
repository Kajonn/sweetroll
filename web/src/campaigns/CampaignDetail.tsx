// Campaign detail shell: openCampaign on mount, tabbed Characters /
// Content / Activity bodies, and the self-leave flow. The Characters tab
// body stays small and importable: Task 4 extracts it (enriched) into
// CampaignCharacters.tsx.
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { t } from "../i18n/index.js";
import { Button, Dialog, EmptyState, PageHeader, Panel, Tabs } from "../ui/index.js";
import type { CampaignsApi } from "./api.js";
import type { CampaignCharacterSummary, CampaignView } from "./types.js";

export function campaignDetailKey(campaignId: string): string[] {
  return ["campaigns", "detail", campaignId];
}

export function campaignCharactersKey(campaignId: string): string[] {
  return ["campaigns", "characters", campaignId];
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as { code?: unknown; status?: unknown };
  return record.status === 404 || record.code === "not_found";
}

function isConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as { code?: unknown; status?: unknown };
  return record.status === 409 || record.code === "conflict";
}

/** Minimal real characters list: fetch + rows + open links. */
export function CampaignCharactersTab(props: { api: CampaignsApi; campaignId: string }) {
  const characters = useQuery({
    queryKey: campaignCharactersKey(props.campaignId),
    queryFn: () => props.api.listCampaignCharacters(props.campaignId),
  });

  if (characters.status === "pending") {
    return <p role="status">{t("campaign.detail.characters.loading")}</p>;
  }

  if (characters.status === "error") {
    return (
      <EmptyState
        title={t("campaign.detail.characters.loadFailed")}
        action={
          <Button variant="primary" onClick={() => void characters.refetch()}>
            {t("campaign.detail.retry")}
          </Button>
        }
      />
    );
  }

  const rows: CampaignCharacterSummary[] = characters.data.characters;
  if (rows.length === 0) {
    return (
      <EmptyState
        title={t("campaign.detail.characters.empty.title")}
        description={t("campaign.detail.characters.empty.description")}
      />
    );
  }

  return (
    <ul aria-label={t("campaign.detail.characters.listAriaLabel")}>
      {rows.map((character) => (
        <li key={character.characterId}>
          <a href={`/characters/${character.characterId}`}>{character.name}</a>
        </li>
      ))}
    </ul>
  );
}

type LeavePhase = "idle" | "confirming" | "leaving" | "conflict" | "error";

export function CampaignDetail(props: {
  api: CampaignsApi;
  campaignId: string;
  actorId: string;
  onLeft: () => void;
}) {
  const queryClient = useQueryClient();
  const detail = useQuery({
    queryKey: campaignDetailKey(props.campaignId),
    queryFn: () => props.api.openCampaign(props.campaignId),
  });
  const [leavePhase, setLeavePhase] = useState<LeavePhase>("idle");
  const [leaveError, setLeaveError] = useState<string | null>(null);

  const attemptLeave = async (campaign: CampaignView): Promise<void> => {
    setLeavePhase("leaving");
    setLeaveError(null);
    // Caller-minted idempotency key, fresh on every attempt: a 409 re-reads
    // first and the retry mints a new key rather than reusing this one.
    const idempotencyKey = crypto.randomUUID();
    try {
      await props.api.leaveCampaign(props.campaignId, props.actorId, {
        expectedCampaignRevision: campaign.revision,
        idempotencyKey,
      });
      queryClient.removeQueries({ queryKey: campaignDetailKey(props.campaignId) });
      queryClient.removeQueries({ queryKey: campaignCharactersKey(props.campaignId) });
      props.onLeft();
    } catch (cause) {
      if (isConflict(cause)) {
        // 409 → re-read, then offer a retry with a fresh key. Never "Merge".
        await detail.refetch();
        setLeavePhase("conflict");
      } else {
        setLeaveError(
          typeof cause === "object" && cause !== null && "message" in cause && typeof cause.message === "string"
            ? cause.message
            : t("campaign.detail.leave.error"),
        );
        setLeavePhase("error");
      }
    }
  };

  if (detail.status === "pending") {
    return (
      <section aria-label={t("campaign.detail.title")}>
        <PageHeader title={t("campaign.detail.title")} />
        <p role="status">{t("campaign.detail.loading")}</p>
      </section>
    );
  }

  if (detail.status === "error") {
    if (isNotFound(detail.error)) {
      return (
        <section aria-label={t("campaign.detail.title")}>
          <PageHeader title={t("campaign.detail.title")} />
          <EmptyState
            title={t("campaign.detail.unavailable.title")}
            description={t("campaign.detail.unavailable.description")}
            action={<a href="/campaigns">{t("campaign.detail.backToList")}</a>}
          />
        </section>
      );
    }
    return (
      <section aria-label={t("campaign.detail.title")}>
        <PageHeader title={t("campaign.detail.title")} />
        <EmptyState
          title={t("campaign.detail.loadFailed")}
          action={
            <Button variant="primary" onClick={() => void detail.refetch()}>
              {t("campaign.detail.retry")}
            </Button>
          }
        />
      </section>
    );
  }

  const campaign = detail.data.campaign;
  return (
    <section aria-label={campaign.title}>
      <PageHeader
        title={campaign.title}
        actions={
          <Button variant="secondary" onClick={() => setLeavePhase("confirming")}>
            {t("campaign.detail.leave.button")}
          </Button>
        }
      />
      {leavePhase === "conflict" ? (
        <EmptyState
          title={t("campaign.detail.leave.conflict.title")}
          description={t("campaign.detail.leave.conflict.description")}
          action={
            <Button variant="primary" onClick={() => void attemptLeave(campaign)}>
              {t("campaign.detail.leave.conflict.retry")}
            </Button>
          }
        />
      ) : null}
      {leavePhase === "error" ? <p role="alert">{leaveError}</p> : null}
      <Tabs
        ariaLabel={t("campaign.detail.tabsAriaLabel")}
        tabs={[
          {
            id: "characters",
            label: t("campaign.detail.tabs.characters"),
            content: <CampaignCharactersTab api={props.api} campaignId={props.campaignId} />,
          },
          {
            id: "content",
            label: t("campaign.detail.tabs.content"),
            content: (
              <EmptyState
                title={t("campaign.detail.content.empty.title")}
                description={t("campaign.detail.content.empty.description")}
              />
            ),
          },
          {
            id: "activity",
            label: t("campaign.detail.tabs.activity"),
            content: (
              <EmptyState
                title={t("campaign.detail.activity.empty.title")}
                description={t("campaign.detail.activity.empty.description")}
              />
            ),
          },
        ]}
      />
      <Dialog
        open={leavePhase === "confirming" || leavePhase === "leaving"}
        onOpenChange={(open) => {
          if (!open) setLeavePhase("idle");
        }}
        title={t("campaign.detail.leave.confirm.title")}
        description={t("campaign.detail.leave.confirm.description", { title: campaign.title })}
        actions={
          <Button
            variant="danger"
            pending={leavePhase === "leaving"}
            pendingText={t("campaign.detail.leave.leaving")}
            onClick={() => void attemptLeave(campaign)}
          >
            {t("campaign.detail.leave.confirm.confirm")}
          </Button>
        }
      >
        <Panel title={campaign.title}>
          <p>{t("campaign.detail.leave.confirm.hint")}</p>
        </Panel>
      </Dialog>
    </section>
  );
}
