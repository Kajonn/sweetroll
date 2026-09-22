// Activity tab body: campaign events (kind + actor + timestamp). Events
// carry no secret payloads server-side, and this view renders nothing
// beyond those three fields.
import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";

import { t } from "../i18n/index.js";
import { Button, EmptyState } from "../ui/index.js";
import type { CampaignsApi } from "./api.js";
import type { CampaignActivityEvent } from "./types.js";

export function campaignActivityKey(campaignId: string): string[] {
  return ["campaigns", "activity", campaignId];
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as { code?: unknown; status?: unknown };
  return record.status === 404 || record.code === "not_found";
}

export function activityKindLabel(kind: CampaignActivityEvent["kind"]): string {
  switch (kind) {
    case "content_created":
      return t("campaign.detail.activity.kind.content_created");
    case "content_updated":
      return t("campaign.detail.activity.kind.content_updated");
    case "content_deleted":
      return t("campaign.detail.activity.kind.content_deleted");
    case "content_recovered":
      return t("campaign.detail.activity.kind.content_recovered");
    case "content_grants_replaced":
      return t("campaign.detail.activity.kind.content_grants_replaced");
    case "roll_executed":
      return t("campaign.detail.activity.kind.roll_executed");
  }
}

export type ActivityListItem = Pick<
  CampaignActivityEvent,
  "eventId" | "kind" | "actorId" | "occurredAt"
>;

export function CampaignActivityLine(props: { event: ActivityListItem; actorId?: string | null | undefined }) {
  const { event, actorId } = props;
  const date = new Date(event.occurredAt);
  const formatted = Number.isNaN(date.getTime()) ? event.occurredAt
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
  const actor = actorId === event.actorId
    ? t("campaign.detail.activity.actor.you")
    : t("campaign.detail.activity.actor.member", { id: event.actorId.slice(0, 8) });
  return <>
    <span>{activityKindLabel(event.kind)}</span>{" "}
    <span title={event.actorId}>{actor}</span>{" "}
    <time dateTime={event.occurredAt}>{formatted}</time>
  </>;
}

export function CampaignActivityView(props: { events: ActivityListItem[]; actorId?: string | null | undefined }) {
  if (props.events.length === 0) {
    return (
      <EmptyState
        title={t("campaign.detail.activity.empty.title")}
        description={t("campaign.detail.activity.empty.description")}
      />
    );
  }
  return (
    <ul aria-label={t("campaign.detail.activity.listAriaLabel")}>
      {props.events.map((event) => (
        <li key={event.eventId}>
          <CampaignActivityLine event={event} actorId={props.actorId} />
        </li>
      ))}
    </ul>
  );
}

export function CampaignActivityTab(props: {
  api: Pick<CampaignsApi, "listActivity">;
  campaignId: string;
  actorId?: string | null;
  /** Campaign-level revocation: the feed is not_found for a previously-readable campaign. */
  onAccessRevoked?: () => void;
}) {
  const feed = useQuery({
    queryKey: campaignActivityKey(props.campaignId),
    queryFn: () => props.api.listActivity(props.campaignId),
  });
  const revocationNotified = useRef(false);

  useEffect(() => {
    if (feed.status === "error" && isNotFound(feed.error) && !revocationNotified.current) {
      revocationNotified.current = true;
      props.onAccessRevoked?.();
    }
  }, [feed.status, feed.error, props]);

  if (feed.status === "pending") {
    return <p role="status">{t("campaign.detail.activity.loading")}</p>;
  }

  if (feed.status === "error") {
    if (isNotFound(feed.error)) {
      return <p role="status">{t("campaign.detail.activity.loading")}</p>;
    }
    return (
      <EmptyState
        title={t("campaign.detail.activity.loadFailed")}
        action={
          <Button variant="primary" onClick={() => void feed.refetch()}>
            {t("campaign.detail.retry")}
          </Button>
        }
      />
    );
  }

  const events: ActivityListItem[] = feed.data.events;
  return <CampaignActivityView events={events} actorId={props.actorId} />;
}
