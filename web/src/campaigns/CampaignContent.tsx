// Content tab body: permitted-content list with persistent audience marks,
// detail opens via openContent, and revocation handling (404 on open →
// "unavailable" EmptyState + list invalidation; revoked ids never mount).
// Error paths never render server payloads or secrets: only the generic
// unavailable strings below reach the page.
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { t } from "../i18n/index.js";
import { Button, Dialog, EmptyState, Panel } from "../ui/index.js";
import type { CampaignsApi } from "./api.js";
import { ContentEditor } from "./ContentEditor.js";
import type { CampaignMember, ContentSummary, ContentView } from "./types.js";

export type ContentAudience = ContentSummary["audience"];

export function campaignContentKey(campaignId: string): string[] {
  return ["campaigns", "content", campaignId];
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
  api: Pick<
    CampaignsApi,
    | "listContent"
    | "openContent"
    | "createContent"
    | "updateContent"
    | "deleteContent"
    | "recoverContent"
    | "replaceContentGrants"
  >;
  campaignId: string;
  /** Campaign-level revocation: the list itself is not_found for a previously-readable campaign. */
  onAccessRevoked?: () => void;
  campaignRevision?: number;
  actorId?: string | null;
  generation?: number;
  online?: boolean;
  isGm?: boolean;
  members?: CampaignMember[];
  onChanged?: () => void;
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
  // GM authoring state. Per-item Edit/Delete fetch the full view via
  // openContent first: list summaries carry no body, grants, or revision.
  // Recover is offered inside the editor for deleted views it can still read.
  const [editing, setEditing] = useState<ContentView | null>(null);
  const [deleting, setDeleting] = useState<ContentView | null>(null);
  const [viewPendingId, setViewPendingId] = useState<string | null>(null);
  const [viewFailed, setViewFailed] = useState(false);
  const [mutationPending, setMutationPending] = useState(false);
  const [mutationConflict, setMutationConflict] = useState(false);
  const [mutationFailed, setMutationFailed] = useState(false);
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

  const reload = (): void => {
    void queryClient.invalidateQueries({ queryKey: campaignContentKey(props.campaignId) });
    props.onChanged?.();
  };

  const fetchView = async (contentId: string, assign: (view: ContentView) => void): Promise<void> => {
    if (viewPendingId !== null) return;
    setViewPendingId(contentId);
    setViewFailed(false);
    try {
      const res = await props.api.openContent(contentId);
      assign(res.content);
    } catch {
      setViewFailed(true);
    } finally {
      setViewPendingId(null);
    }
  };

  const attemptDeleteTarget = async (): Promise<void> => {
    if (deleting === null || mutationPending) return;
    setMutationPending(true);
    setMutationFailed(false);
    setMutationConflict(false);
    // Caller-minted idempotency key, fresh on every attempt.
    try {
      await props.api.deleteContent(deleting.contentId, {
        expectedContentRevision: deleting.revision,
        idempotencyKey: crypto.randomUUID(),
      });
      setDeleting(null);
      reload();
    } catch (cause) {
      if (isConflict(cause)) {
        // 409 → re-read first, then offer a retry with a fresh key. Never "Merge".
        setDeleting(null);
        setMutationConflict(true);
        reload();
      } else {
        setMutationFailed(true);
      }
    } finally {
      setMutationPending(false);
    }
  };

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
  if (props.isGm === true) {
    const members = props.members ?? [];
    const visible = items.filter((item) => !revokedIds.has(item.contentId));
    return (
      <div>
        <ContentEditor
          api={props.api}
          campaignId={props.campaignId}
          members={members}
          onSaved={reload}
          onDeleted={reload}
        />
        {editing !== null ? (
          <ContentEditor
            key={editing.contentId}
            api={props.api}
            campaignId={props.campaignId}
            members={members}
            initial={editing}
            onSaved={() => {
              setEditing(null);
              reload();
            }}
            onDeleted={() => {
              setEditing(null);
              reload();
            }}
          />
        ) : null}
        {viewFailed ? <p role="alert">{t("campaign.detail.content.edit.error")}</p> : null}
        {mutationConflict ? <p role="alert">{t("campaign.detail.content.edit.conflict")}</p> : null}
        {mutationFailed ? <p role="alert">{t("campaign.detail.content.edit.error")}</p> : null}
        {visible.length === 0 ? (
          <EmptyState
            title={t("campaign.detail.content.empty.title")}
            description={t("campaign.detail.content.empty.description")}
          />
        ) : (
          <ul aria-label={t("campaign.detail.content.listAriaLabel")}>
            {visible.map((item) => (
              <li key={item.contentId}>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setUnavailable(false);
                    setSelectedId(item.contentId);
                  }}
                >
                  {t("campaign.detail.content.open", { title: item.title })}
                </Button>{" "}
                <span>{audienceLabel(item.audience)}</span>{" "}
                <Button
                  variant="secondary"
                  pending={viewPendingId === item.contentId}
                  onClick={() => void fetchView(item.contentId, setEditing)}
                >
                  {t("campaign.detail.content.edit.editItem", { title: item.title })}
                </Button>{" "}
                <Button
                  variant="secondary"
                  pending={viewPendingId === item.contentId}
                  onClick={() => void fetchView(item.contentId, setDeleting)}
                >
                  {t("campaign.detail.content.edit.delete", { title: item.title })}
                </Button>
              </li>
            ))}
          </ul>
        )}
        <Dialog
          open={deleting !== null}
          onOpenChange={(open) => {
            if (!open) setDeleting(null);
          }}
          title={t("campaign.detail.content.edit.delete.confirm.title")}
          description={t("campaign.detail.content.edit.delete.confirm.description")}
          actions={
            <Button variant="danger" pending={mutationPending} onClick={() => void attemptDeleteTarget()}>
              {t("campaign.detail.content.edit.delete.confirm.confirm")}
            </Button>
          }
        >
          <p>{deleting?.title ?? ""}</p>
        </Dialog>
      </div>
    );
  }
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
