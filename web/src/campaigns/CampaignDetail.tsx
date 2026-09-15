// Campaign detail shell: openCampaign on mount, tabbed Characters /
// Content / Activity bodies, and the self-leave flow. The Characters tab
// body lives in CampaignCharacters.tsx (claiming, creation, indicators).
import { useCallback, useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { t } from "../i18n/index.js";
import { AppLink } from "../ui/AppLink.js";
import { Button, Dialog, EmptyState, PageHeader, Panel, Tabs } from "../ui/index.js";
import type { CharactersApi } from "../characters/api.js";
import type { CampaignsApi } from "./api.js";
import { CampaignActivityTab, campaignActivityKey } from "./CampaignActivity.js";
import { CampaignCharactersTab, type CampaignCharacterMetadataApi } from "./CampaignCharacters.js";
import { CampaignContentTab } from "./CampaignContent.js";
import { CampaignMembersTab, ownRole } from "./CampaignMembers.js";
import { CampaignSettingsView } from "./CampaignSettings.js";
import { InvitationManager } from "./InvitationManager.js";
import { SessionBoard, type SessionBoardProps } from "./SessionBoard.js";
import { campaignCharactersPrefix, campaignDetailKey, useCampaignMembers } from "./campaignQueries.js";
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

/**
 * Runtime guard for the session board's character surface. The router
 * supplies the real CharactersApi; anything else (a metadata-only handle
 * or the campaigns api) must never reach SessionBoard as a silent cast —
 * the tab renders the generic unavailable state instead.
 */
function hasSessionCharacterSurface(value: unknown): value is SessionBoardProps["charactersApi"] {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.open === "function" &&
    typeof record.bumpCharacterResource === "function" &&
    typeof record.executeCharacterAction === "function"
  );
}

function MembersManageSection(props: {
  api: CampaignsApi;
  versionsApi?: Pick<CharactersApi, "listCreationVersions"> | undefined;
  campaignId: string;
  actorId: string;
  campaign: CampaignView;
  generation: number;
  online: boolean;
  isGm: boolean;
  onChanged: () => void;
  onAccessRevoked: () => void;
}) {
  return (
    <>
      <CampaignMembersTab
        api={props.api}
        campaignId={props.campaignId}
        actorId={props.actorId}
        campaignRevision={props.campaign.revision}
        generation={props.generation}
        online={props.online}
        onChanged={props.onChanged}
        onAccessRevoked={props.onAccessRevoked}
      />
      {props.isGm ? (
        <>
          <CampaignSettingsView
            api={props.api}
            versionsApi={props.versionsApi}
            campaign={props.campaign}
            actorId={props.actorId}
            generation={props.generation}
            online={props.online}
            isGm={props.isGm}
            onChanged={props.onChanged}
          />
          <InvitationManager
            api={props.api}
            campaignId={props.campaignId}
            campaignRevision={props.campaign.revision}
            actorId={props.actorId}
            generation={props.generation}
            online={props.online}
            onChanged={props.onChanged}
          />
        </>
      ) : null}
    </>
  );
}

export function CampaignDetail(props: {
  api: CampaignsApi;
  campaignId: string;
  actorId: string;
  onLeft: () => void;
  navigation?: { onOpenCharacter: (characterId: string) => void };
  metadataApi?: CampaignCharacterMetadataApi;
  charactersApi?: SessionBoardProps["charactersApi"];
  /** Creation-versions catalog handle threaded to the GM Upgrade section. */
  versionsApi?: Pick<CharactersApi, "listCreationVersions">;
  generation?: number;
  online?: boolean;
}) {
  const queryClient = useQueryClient();
  const detail = useQuery({
    queryKey: campaignDetailKey(props.campaignId),
    queryFn: () => props.api.openCampaign(props.campaignId),
  });
  const [leavePhase, setLeavePhase] = useState<LeavePhase>("idle");
  const [leaveError, setLeaveError] = useState<string | null>(null);
  const [accessChanged, setAccessChanged] = useState(false);

  // Hoisted roster read: same params as the former inline section call, so
  // the query key matches and the request stays deduped. Enabled only once
  // the detail itself resolved (the section only ever mounted past that
  // point, preserving the Phase 1 fetch shape).
  const generation = props.generation ?? 0;
  const online = props.online ?? true;
  const roster = useCampaignMembers(props.api, props.campaignId, props.actorId, generation, {
    enabled: detail.status === "success",
    online,
  });
  const members = roster.data?.pages.flatMap((page) => page.members) ?? [];
  const role = ownRole(members, props.actorId);
  const isGm = role === "owner" || role === "co_gm";

  // Revocation purge: a not_found for a previously-readable campaign (or its
  // content/activity feed) drops every query scoped to that campaign key and
  // surfaces an "access changed" notice with a way back. The account list is
  // invalidated (not purged) so it reloads without the revoked campaign. The
  // sign-out path already purges via AppShell and is untouched here.
  const handleAccessRevoked = useCallback((): void => {
    queryClient.removeQueries({ queryKey: campaignDetailKey(props.campaignId) });
    queryClient.removeQueries({ queryKey: campaignCharactersPrefix(props.campaignId) });
    queryClient.removeQueries({ queryKey: ["campaigns", "claimable-characters", props.campaignId] });
    // Literal 3-element prefix (not campaignContentKey(campaignId), which
    // evaluates to ["campaigns","content",id,null,0]): TanStack prefix
    // matching would otherwise miss every actor/generation-scoped content
    // key (e.g. ["campaigns","content",id,actor,gen] and detail item keys
    // [...listKey,"item",...]), leaving stale content after revocation.
    queryClient.removeQueries({ queryKey: ["campaigns", "content", props.campaignId] });
    queryClient.removeQueries({ queryKey: campaignActivityKey(props.campaignId) });
    queryClient.removeQueries({ queryKey: ["campaigns", "members", props.campaignId] });
    queryClient.removeQueries({ queryKey: ["campaigns", "session", props.campaignId] });
    queryClient.removeQueries({ queryKey: ["campaigns", "invitations", props.campaignId] });
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
      queryClient.removeQueries({ queryKey: campaignCharactersPrefix(props.campaignId) });
      queryClient.removeQueries({ queryKey: ["campaigns", "claimable-characters", props.campaignId] });
      // Same literal-prefix rationale as handleAccessRevoked above: drop
      // all actor/generation-scoped content keys on leave, plus the session,
      // member, and invitation families (an open reader or session board
      // unmounts on leave, and nothing may survive for a later reader).
      queryClient.removeQueries({ queryKey: ["campaigns", "content", props.campaignId] });
      queryClient.removeQueries({ queryKey: campaignActivityKey(props.campaignId) });
      queryClient.removeQueries({ queryKey: ["campaigns", "members", props.campaignId] });
      queryClient.removeQueries({ queryKey: ["campaigns", "session", props.campaignId] });
      queryClient.removeQueries({ queryKey: ["campaigns", "invitations", props.campaignId] });
      // Like the revocation path above: the account list is invalidated (not
      // purged) so it reloads without the left campaign.
      void queryClient.invalidateQueries({ queryKey: ["campaigns", "list"] });
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
          action={<AppLink href="/campaigns">{t("campaign.detail.backToList")}</AppLink>}
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
            action={<AppLink href="/campaigns">{t("campaign.detail.backToList")}</AppLink>}
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
                generation={generation}
                online={online}
                isGm={isGm}
                onOpenCharacter={onOpenCharacter}
                onCampaignStale={() => void detail.refetch()}
                metadataApi={props.metadataApi}
              />
            ),
          },
          {
            id: "members",
            label: t("campaign.detail.tabs.members"),
            content: (
              <MembersManageSection
                api={props.api}
                versionsApi={props.versionsApi}
                campaignId={props.campaignId}
                actorId={props.actorId}
                campaign={campaign}
                generation={generation}
                online={online}
                isGm={isGm}
                onChanged={() => void detail.refetch()}
                onAccessRevoked={handleAccessRevoked}
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
                campaignRevision={campaign.revision}
                actorId={props.actorId}
                generation={generation}
                online={online}
                isGm={isGm}
                members={members}
                onChanged={() => void detail.refetch()}
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
          ...(isGm
            ? [
                {
                  id: "session",
                  label: t("campaign.detail.tabs.session"),
                  content: hasSessionCharacterSurface(props.charactersApi) ? (
                    <SessionBoard
                      campaignsApi={props.api}
                      charactersApi={props.charactersApi}
                      campaignId={props.campaignId}
                      actorId={props.actorId}
                      generation={generation}
                      online={online}
                      onOpenCharacter={onOpenCharacter}
                      onAccessRevoked={handleAccessRevoked}
                    />
                  ) : (
                    <EmptyState title={t("campaign.detail.session.loadFailed")} />
                  ),
                },
              ]
            : []),
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
