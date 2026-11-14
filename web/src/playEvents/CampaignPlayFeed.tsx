import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { CampaignsApi } from "../campaigns/api.js";
import { memberLabel } from "../campaigns/memberLabels.js";
import type { CampaignActivityResponse } from "../campaigns/types.js";
import { t } from "../i18n/index.js";
import { rollText, type PlayEvents } from "./PlayEvents.js";
import { FRESH_MS, type PlayEvent } from "./stack.js";

const PAGE_SIZE = 20;
const PAGE_BUDGET = 4;
const POLL_MS = 3000;

export const campaignPlayFeedKey = (campaignId: string) => ["campaigns", "play-feed", campaignId];

export type CampaignPlayFeed = ReturnType<typeof useCampaignPlayFeed>;

function subscribeVisibility(onChange: () => void) {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

function isForeground() {
  return document.visibilityState !== "hidden";
}

type Activity = CampaignActivityResponse["events"][number];

function popupEvent(event: Activity, actorId: string): PlayEvent | undefined {
  const { summary } = event;
  if (!summary) return undefined;
  if (summary.kind === "content") {
    return {
      id: `event:${event.eventId}`,
      text: t("playEvents.content", { kind: t(`campaign.detail.activity.kind.${event.kind}`), title: summary.title }),
      watch: true,
    };
  }
  if (!event.sourceRollId) return undefined;
  const actor = event.actorId === actorId ? t("campaign.detail.activity.actor.you")
    : memberLabel({ userId: event.actorId, displayName: event.actorName ?? null });
  return {
    id: `roll:${event.sourceRollId}`,
    text: rollText(actor, summary.kind, summary.audience, summary.kind === "draw" ? summary.cards.join(", ") : summary.total),
    watch: true,
  };
}

function denied(error: unknown) {
  if (typeof error !== "object" || error === null) return false;
  const { status, code } = error as { status?: number; code?: string };
  return status === 401 || status === 403 || status === 404 || code === "not_found";
}

export function useCampaignPlayFeed({
  api, campaignId, actorId, generation, online, events, onAccessRevoked,
}: {
  api: Pick<CampaignsApi, "listActivity"> | undefined;
  campaignId: string | null;
  actorId: string;
  generation: number;
  online: boolean;
  events: PlayEvents;
  onAccessRevoked?: (() => void) | undefined;
}) {
  const foreground = useSyncExternalStore(subscribeVisibility, isForeground, () => true);
  const enabled = !!api && campaignId !== null && online && foreground && events.target !== null;
  // A new foreground/online lifetime always starts from a fresh baseline,
  // even if the shared query still holds a previous view's response.
  const lifetime = useMemo(() => ({ seen: new Map<string, number>(), seeded: false }), [actorId, campaignId, enabled, generation]);
  const { publish, clear, retainAuthorized, watched } = events;
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => [...campaignPlayFeedKey(campaignId ?? ""), actorId, generation], [campaignId, actorId, generation]);
  const previous = useRef<object>();
  const priorEnabled = useRef(enabled);

  const query = useQuery({
    queryKey,
    enabled,
    refetchInterval: enabled ? POLL_MS : false,
    refetchIntervalInBackground: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    staleTime: 0,
    gcTime: 0,
    queryFn: async ({ signal }) => {
      if (!api || campaignId === null) throw new Error("Campaign activity is unavailable.");
      const checked = watched(Date.now());
      const first = await api.listActivity(campaignId, {
        limit: PAGE_SIZE, signal, ...(checked.length ? { watch: checked.join(",") } : {}),
      });
      const serverTime = Date.parse(first.serverTime ?? "");
      const fresh = (event: Activity) => Date.parse(event.occurredAt) >= serverTime - FRESH_MS;
      const all = [...first.events];
      let page = first;
      for (let count = 1; lifetime.seeded && count < PAGE_BUDGET && page.nextCursor &&
        page.events.length > 0 && page.events.every(event => fresh(event) && !lifetime.seen.has(event.eventId)); count += 1) {
        page = await api.listActivity(campaignId, { limit: PAGE_SIZE, cursor: page.nextCursor, signal });
        all.push(...page.events);
      }
      return { first, all, checked, serverTime, lifetime };
    },
    structuralSharing: false,
  });

  useEffect(() => {
    const foregroundChanged = priorEnabled.current !== enabled;
    priorEnabled.current = enabled;
    if (!foregroundChanged || enabled) return;
    if (campaignId !== null) void queryClient.cancelQueries({ queryKey, exact: true });
    clear();
  }, [campaignId, clear, enabled, queryClient, queryKey]);

  useEffect(() => {
    if (!enabled || !query.isError || !denied(query.error)) return;
    clear();
    onAccessRevoked?.();
  }, [clear, enabled, onAccessRevoked, query.error, query.isError]);

  useEffect(() => {
    const data = query.data;
    if (!enabled || !data || data.lifetime !== lifetime || previous.current === data) return;
    previous.current = data;
    const { first, all, checked, serverTime } = data;
    if (first.visibleWatch) retainAuthorized(first.visibleWatch, checked);
    const cutoff = serverTime - FRESH_MS;
    for (const [id, time] of lifetime.seen) {
      if (time < cutoff) lifetime.seen.delete(id);
    }
    const incoming: PlayEvent[] = [];
    for (const event of all.slice().reverse()) {
      const time = Date.parse(event.occurredAt);
      if (lifetime.seen.has(event.eventId) || !(time >= cutoff)) continue;
      lifetime.seen.set(event.eventId, time);
      if (!lifetime.seeded) continue;
      const popup = popupEvent(event, actorId);
      if (popup) incoming.push(popup);
    }
    lifetime.seeded = true;
    publish(incoming);
  }, [actorId, enabled, lifetime, publish, query.data, retainAuthorized]);

  if (query.isSuccess) return { ...query, data: query.data.first };
  return { ...query, data: undefined };
}

export function CampaignPlayListener(props: Parameters<typeof useCampaignPlayFeed>[0]) {
  useCampaignPlayFeed(props);
  return null;
}
