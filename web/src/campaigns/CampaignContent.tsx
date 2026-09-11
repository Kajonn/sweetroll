// Content tab body: permitted-content list with persistent audience marks,
// detail opens via openContent, and revocation handling (404 on open →
// "unavailable" EmptyState + list invalidation; revoked ids never mount).
// Error paths never render server payloads or secrets: only the generic
// unavailable strings below reach the page.
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { t } from "../i18n/index.js";
import { Button, EmptyState, Panel } from "../ui/index.js";
import type { CampaignsApi } from "./api.js";
import type { ContentSummary, ContentView } from "./types.js";

export type ContentAudience = ContentSummary["audience"];

export function campaignContentKey(campaignId: string): string[] {
  return ["campaigns", "content", campaignId];
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as { code?: unknown; status?: unknown };
  return record.status === 404 || record.code === "not_found";
}

/** Plain-language audience marking, persisted on every row and the reader. */
export function audienceLabel(audience: ContentAudience): string {
  switch (audience) {
    case "gm_only":
      return t("campaign.detail.content.audience.gm_only");
    case "all_players":
      return t("campaign.detail.content.audience.all_players");
    case "selected_players":
      return t("campaign.detail.content.audience.selected_players");
    case "owner_only":
      return t("campaign.detail.content.audience.owner_only");
  }
}

export type ContentListItem = Pick<ContentSummary, "contentId" | "title" | "audience">;

export function CampaignContentView(props: {
  items: ContentListItem[];
  revokedIds: Set<string>;
  onOpenContent: (contentId: string) => void;
}) {
  // Revoked/inaccessible ids are excluded from render (never mounted), so a
  // narrowed audience cannot leak through a stale list row.
  const visible = props.items.filter((item) => !props.revokedIds.has(item.contentId));
  if (visible.length === 0) {
    return (
      <EmptyState
        title={t("campaign.detail.content.empty.title")}
        description={t("campaign.detail.content.empty.description")}
      />
    );
  }
  return (
    <ul aria-label={t("campaign.detail.content.listAriaLabel")}>
      {visible.map((item) => (
        <li key={item.contentId}>
          <Button variant="secondary" onClick={() => props.onOpenContent(item.contentId)}>
            {t("campaign.detail.content.open", { title: item.title })}
          </Button>{" "}
          <span>{audienceLabel(item.audience)}</span>
        </li>
      ))}
    </ul>
  );
}

function CampaignContentReader(props: { content: ContentView; onBack: () => void }) {
  return (
    <div>
      <Button variant="secondary" onClick={props.onBack}>
        {t("campaign.detail.content.backToList")}
      </Button>
      <Panel title={props.content.title}>
        <p>{audienceLabel(props.content.audience)}</p>
        <p>{props.content.body}</p>
      </Panel>
    </div>
  );
}

export function CampaignContentTab(props: {
  api: Pick<CampaignsApi, "listContent" | "openContent">;
  campaignId: string;
  /** Campaign-level revocation: the list itself is not_found for a previously-readable campaign. */
  onAccessRevoked?: () => void;
}) {
  const queryClient = useQueryClient();
  const list = useQuery({
    queryKey: campaignContentKey(props.campaignId),
    queryFn: () => props.api.listContent(props.campaignId),
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [revokedIds, setRevokedIds] = useState<Set<string>>(() => new Set());
  const [unavailable, setUnavailable] = useState(false);
  const revocationNotified = useRef(false);
  const detail = useQuery({
    queryKey: [...campaignContentKey(props.campaignId), "item", selectedId ?? "none"],
    queryFn: () => props.api.openContent(selectedId ?? ""),
    enabled: selectedId !== null,
  });

  useEffect(() => {
    if (list.status === "error" && isNotFound(list.error) && !revocationNotified.current) {
      revocationNotified.current = true;
      props.onAccessRevoked?.();
    }
  }, [list.status, list.error, props]);

  useEffect(() => {
    if (selectedId !== null && detail.status === "error" && isNotFound(detail.error)) {
      // A single note narrowed or removed after the list rendered: hide its
      // row from now on, show the generic unavailable state (never the
      // server payload), and reload the list fresh.
      const revokedId = selectedId;
      setRevokedIds((prev) => {
        if (prev.has(revokedId)) return prev;
        const next = new Set(prev);
        next.add(revokedId);
        return next;
      });
      setSelectedId(null);
      setUnavailable(true);
      void queryClient.invalidateQueries({ queryKey: campaignContentKey(props.campaignId) });
    }
  }, [selectedId, detail.status, detail.error, queryClient, props.campaignId]);

  if (list.status === "pending") {
    return <p role="status">{t("campaign.detail.content.loading")}</p>;
  }

  if (list.status === "error") {
    if (isNotFound(list.error)) {
      return <p role="status">{t("campaign.detail.content.loading")}</p>;
    }
    return (
      <EmptyState
        title={t("campaign.detail.content.loadFailed")}
        action={
          <Button variant="primary" onClick={() => void list.refetch()}>
            {t("campaign.detail.retry")}
          </Button>
        }
      />
    );
  }

  if (unavailable) {
    return (
      <EmptyState
        title={t("campaign.detail.content.unavailable.title")}
        description={t("campaign.detail.content.unavailable.description")}
        action={
          <Button variant="secondary" onClick={() => setUnavailable(false)}>
            {t("campaign.detail.content.backToList")}
          </Button>
        }
      />
    );
  }

  if (selectedId !== null) {
    if (detail.status === "pending") {
      return <p role="status">{t("campaign.detail.content.loading")}</p>;
    }
    if (detail.status === "error") {
      if (!isNotFound(detail.error)) {
        return (
          <EmptyState
            title={t("campaign.detail.content.loadFailed")}
            action={
              <Button variant="primary" onClick={() => void detail.refetch()}>
                {t("campaign.detail.retry")}
              </Button>
            }
          />
        );
      }
      return <p role="status">{t("campaign.detail.content.loading")}</p>;
    }
    return <CampaignContentReader content={detail.data.content} onBack={() => setSelectedId(null)} />;
  }

  const items: ContentListItem[] = list.data.content;
  return (
    <CampaignContentView
      items={items}
      revokedIds={revokedIds}
      onOpenContent={(contentId) => {
        setUnavailable(false);
        setSelectedId(contentId);
      }}
    />
  );
}
