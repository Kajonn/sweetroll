// Presentational core for the campaign list; the router view owns the
// useCampaignList hook (lifetime key below) and navigation callbacks.
import { useQueryClient } from "@tanstack/react-query";

import { t } from "../i18n/index.js";
import { AppLink } from "../ui/AppLink.js";
import { Button, EmptyState, PageHeader, Panel } from "../ui/index.js";
import type { CampaignsApi } from "./api.js";
import { campaignListKey, useCampaignList } from "./campaignQueries.js";
import type { CampaignSummary } from "./types.js";

/**
 * Account-lifetime key for the library view: the infinite-query cache is
 * already lifetime scoped (see campaignListKey), and the route remounts on
 * lifetime change so list/pagination state never leaks across accounts.
 */
export function campaignLibraryViewKey(actor: string | null, generation: number): string {
  return `${actor ?? "signed-out"}:${generation}`;
}

export type CampaignLibraryViewProps = {
  campaigns: CampaignSummary[];
  hasNextPage: boolean;
  onLoadMore: () => void;
  onEnterToken: () => void;
  onCreateCampaign: () => void;
};

export function CampaignLibraryView(props: CampaignLibraryViewProps) {
  return (
    <section aria-label={t("campaign.library.title")}>
      <PageHeader
        title={t("campaign.library.title")}
        description={t("campaign.library.description")}
        actions={
          <>
            <a
              href="/campaigns/new"
              onClick={(event) => {
                event.preventDefault();
                props.onCreateCampaign();
              }}
            >
              {t("campaign.library.new")}
            </a>{" "}
            <a
              href="/invitations"
              onClick={(event) => {
                event.preventDefault();
                props.onEnterToken();
              }}
            >
              {t("campaign.library.join")}
            </a>
          </>
        }
      />
      {props.campaigns.length === 0 ? (
        <EmptyState
          title={t("campaign.library.empty.title")}
          description={t("campaign.library.empty.description")}
          action={<AppLink href="/invitations">{t("campaign.library.join")}</AppLink>}
        />
      ) : (
        <Panel title={t("campaign.library.listHeading")}>
          <ul aria-label={t("campaign.library.listAriaLabel")}>
            {props.campaigns.map((campaign) => (
              <li key={campaign.campaignId}>
                <AppLink href={`/campaigns/${campaign.campaignId}`}>{campaign.title}</AppLink>
              </li>
            ))}
          </ul>
          {props.hasNextPage ? (
            <Button variant="secondary" onClick={props.onLoadMore}>
              {t("campaign.library.loadMore")}
            </Button>
          ) : null}
        </Panel>
      )}
    </section>
  );
}

export type CampaignLibraryNavigation = {
  onEnterToken: () => void;
  onCreateCampaign: () => void;
};

export function CampaignLibrary(props: {
  api: CampaignsApi;
  actorId: string | null;
  generation: number;
  online: boolean;
  navigation: CampaignLibraryNavigation;
}) {
  const queryClient = useQueryClient();
  const list = useCampaignList(props.api, props.actorId, props.generation, {
    enabled: true,
    online: props.online,
  });

  if (props.actorId === null) {
    return (
      <section aria-label={t("campaign.library.title")}>
        <PageHeader title={t("campaign.library.title")} />
        <p role="status">{t("campaign.library.signIn")}</p>
      </section>
    );
  }

  if (list.status === "pending") {
    return (
      <section aria-label={t("campaign.library.title")}>
        <PageHeader title={t("campaign.library.title")} />
        <p role="status">{t("campaign.library.loading")}</p>
      </section>
    );
  }

  if (list.status === "error") {
    // Retry refetches only this account-lifetime list key, never unrelated
    // character/campaign queries.
    const actorId: string = props.actorId;
    return (
      <section aria-label={t("campaign.library.title")}>
        <PageHeader title={t("campaign.library.title")} />
        <EmptyState
          title={t("campaign.library.loadFailed")}
          action={
            <Button
              variant="primary"
              onClick={() => {
                void queryClient.invalidateQueries({
                  queryKey: campaignListKey(actorId, props.generation),
                });
              }}
            >
              {t("campaign.library.retry")}
            </Button>
          }
        />
      </section>
    );
  }

  const campaigns = list.data.pages.flatMap((page) => page.campaigns);
  return (
    <CampaignLibraryView
      campaigns={campaigns}
      hasNextPage={list.hasNextPage}
      onLoadMore={() => {
        void list.fetchNextPage();
      }}
      onEnterToken={props.navigation.onEnterToken}
      onCreateCampaign={props.navigation.onCreateCampaign}
    />
  );
}
