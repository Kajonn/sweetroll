// Campaign detail shell: openCampaign on mount, tabbed Characters /
// Content / Activity bodies, and the self-leave flow. The Characters tab
// body lives in CampaignCharacters.tsx (claiming, creation, indicators).
import { useCallback, useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { t } from "../i18n/index.js";
import { Button, Dialog, EmptyState, PageHeader, Panel, Tabs } from "../ui/index.js";
import type { CampaignsApi } from "./api.js";
import { CampaignActivityTab, campaignActivityKey } from "./CampaignActivity.js";
import { CampaignCharactersTab, type CampaignCharacterMetadataApi } from "./CampaignCharacters.js";
import { CampaignContentTab, campaignContentKey } from "./CampaignContent.js";
import { campaignCharactersKey, campaignDetailKey } from "./campaignQueries.js";
import type { CampaignView } from "./types.js";

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

type LeavePhase = "idle" | "confirming" | "leaving" | "conflict" | "error";

export function CampaignDetail(props: {
  api: CampaignsApi;
  campaignId: string;
  actorId: string;
  onLeft: () => void;
  navigation?: { onOpenCharacter: (characterId: string) => void };
  metadataApi?: CampaignCharacterMetadataApi;
}) {
  const queryClient = useQueryClient();
  const detail = useQuery({
    queryKey: campaignDetailKey(props.campaignId),
    queryFn: () => props.api.openCampaign(props.campaignId),
  });
  const [leavePhase, setLeavePhase] = useState<LeavePhase>("idle");
  const [leaveError, setLeaveError] = useState<string | null>(null);
  const [accessChanged, setAccessChanged] = useState(false);

  // Revocation purge: a not_found for a previously-readable campaign (or its
  // content/activity feed) drops every query scoped to that campaign key and
  // surfaces an "access changed" notice with a way back. The account list is
  // invalidated (not purged) so it reloads without the revoked campaign. The
  // sign-out path already purges via AppShell and is untouched here.
  const handleAccessRevoked = useCallback((): void => {
    queryClient.removeQueries({ queryKey: campaignDetailKey(props.campaignId) });
    queryClient.removeQueries({ queryKey: campaignCharactersKey(props.campaignId) });
    queryClient.removeQueries({ queryKey: campaignContentKey(props.campaignId) });
    queryClient.removeQueries({ queryKey: campaignActivityKey(props.campaignId) });
    void queryClient.invalidateQueries({ queryKey: ["campaigns", "list"] });
    setAccessChanged(true);
  }, [queryClient, props.campaignId]);

  useEffect(() => {
    if (detail.status === "error" && isNotFound(detail.error) && !accessChanged) {
      handleAccessRevoked();
    }
  }, [detail.status, detail.error, accessChanged, handleAccessRevoked]);

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

  if (accessChanged) {
    return (
      <section aria-label={t("campaign.detail.title")}>
        <PageHeader title={t("campaign.detail.title")} />
        <EmptyState
          title={t("campaign.detail.unavailable.title")}
          description={t("campaign.detail.unavailable.description")}
          action={<a href="/campaigns">{t("campaign.detail.backToList")}</a>}
        />
        <p role="status">{t("campaign.detail.accessChanged.notice")}</p>
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
  // Sheet opens reuse the shared character renderer: the router supplies
  // SPA navigation, and the plain-href fallback keeps deep links working.
  const onOpenCharacter =
    props.navigation?.onOpenCharacter ??
    ((characterId: string) => {
      window.location.href = `/characters/${characterId}`;
    });
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
            content: (
              <CampaignCharactersTab
                api={props.api}
                campaignId={props.campaignId}
                actorId={props.actorId}
                campaignRevision={campaign.revision}
                onOpenCharacter={onOpenCharacter}
                onCampaignStale={() => void detail.refetch()}
                metadataApi={props.metadataApi}
              />
            ),
          },
          {
            id: "content",
            label: t("campaign.detail.tabs.content"),
            content: (
              <CampaignContentTab
                api={props.api}
                campaignId={props.campaignId}
                onAccessRevoked={handleAccessRevoked}
              />
            ),
          },
          {
            id: "activity",
            label: t("campaign.detail.tabs.activity"),
            content: (
              <CampaignActivityTab
                api={props.api}
                campaignId={props.campaignId}
                onAccessRevoked={handleAccessRevoked}
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
