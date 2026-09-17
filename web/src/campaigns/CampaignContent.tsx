// Content tab body: permitted-content list with persistent audience marks,
// detail opens via openContent, and revocation handling (404 on open →
// "unavailable" EmptyState + list invalidation; revoked ids never mount).
// Error paths never render server payloads or secrets: only the generic
// unavailable strings below reach the page.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";

import { t } from "../i18n/index.js";
import { Button, Dialog, EmptyState, Panel, Select } from "../ui/index.js";
import type { CampaignsApi } from "./api.js";
import { campaignContentPreviewKey } from "./campaignQueries.js";
import { ContentEditor } from "./ContentEditor.js";
import type { CampaignMember, ContentSummary, ContentView, PreviewContentResponse } from "./types.js";

export type ContentAudience = ContentSummary["audience"];

export function campaignContentKey(
  campaignId: string,
  actorId?: string | null,
  generation?: number,
  status?: "active" | "deleted",
): (string | number | null)[] {
  // Same ["campaigns", "content", campaignId] prefix family as before, so
  // the revocation purges in CampaignDetail.handleAccessRevoked (which
  // remove by that prefix) still match these scoped keys.
  return ["campaigns", "content", campaignId, actorId ?? null, generation ?? 0, status ?? "active"];
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

/** Narrow the preview union to its list rows (the item variant carries no cursor). */
function previewListRows(response: PreviewContentResponse): ContentListItem[] {
  if (!("nextCursor" in response)) return [];
  return response.content;
}

/** Narrow the preview union to its reader item (the list variant carries a cursor). */
function previewItemContent(response: PreviewContentResponse): ContentView | null {
  if ("nextCursor" in response) return null;
  return response.content;
}

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

/**
 * Read-only projection of one member's content view. Mounted only while a GM
 * previews that target, so preview queries (under the preview cache family)
 * exist solely inside preview mode; unmount purges the target's keys and no
 * authoring control mounts here by construction.
 */
function CampaignContentPreview(props: {
  api: Pick<CampaignsApi, "previewContent">;
  campaignId: string;
  targetUserId: string;
  online: boolean;
  actorId: string | null;
  onExit: () => void;
}) {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const listKey = campaignContentPreviewKey(props.campaignId, props.targetUserId);
  const list = useQuery({
    queryKey: listKey,
    queryFn: () => props.api.previewContent(props.campaignId, { targetUserId: props.targetUserId }),
    enabled: props.online && props.actorId !== null && !failed,
    staleTime: 0,
  });
  const detail = useQuery({
    queryKey: [...listKey, "item", selectedId ?? "none"],
    queryFn: () =>
      props.api.previewContent(props.campaignId, {
        targetUserId: props.targetUserId,
        contentId: selectedId ?? "",
      }),
    enabled: props.online && props.actorId !== null && selectedId !== null && !failed,
    staleTime: 0,
  });

  // The projection is ephemeral: unmount (exit or tab teardown) purges the
  // target's keys so preview data never survives for a later reader. Deps
  // are the stable scalars (listKey is rebuilt per render), so the cleanup
  // runs only on unmount — never on re-render.
  useEffect(() => {
    return () => {
      queryClient.removeQueries({
        queryKey: campaignContentPreviewKey(props.campaignId, props.targetUserId),
      });
    };
  }, [queryClient, props.campaignId, props.targetUserId]);

  // Any preview fetch failure (e.g. the target removed mid-preview) surfaces
  // an error state; the flag disables the queries first so the purge below
  // cannot refetch-loop.
  useEffect(() => {
    if (!failed && (list.status === "error" || detail.status === "error")) {
      setFailed(true);
    }
  }, [failed, list.status, detail.status]);

  useEffect(() => {
    if (failed) {
      queryClient.removeQueries({
        queryKey: campaignContentPreviewKey(props.campaignId, props.targetUserId),
      });
    }
  }, [failed, queryClient, props.campaignId, props.targetUserId]);

  let body: ReactNode = <p role="status">{t("campaign.detail.content.loading")}</p>;
  if (failed || list.status === "error" || detail.status === "error") {
    body = <EmptyState title={t("campaign.detail.content.preview.error")} />;
  } else if (selectedId !== null) {
    if (detail.status === "success") {
      const item = previewItemContent(detail.data);
      body =
        item === null ? (
          <EmptyState title={t("campaign.detail.content.preview.error")} />
        ) : (
          <CampaignContentReader content={item} onBack={() => setSelectedId(null)} />
        );
    }
  } else if (list.status === "success") {
    body = (
      <CampaignContentView
        items={previewListRows(list.data)}
        revokedIds={new Set<string>()}
        onOpenContent={(contentId) => setSelectedId(contentId)}
      />
    );
  }
  return (
    <div>
      <p role="status">{t("campaign.detail.content.preview.banner", { name: props.targetUserId })}</p>
      <Button variant="secondary" onClick={props.onExit}>
        {t("campaign.detail.content.preview.exit")}
      </Button>
      {body}
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
    | "previewContent"
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
  // Online + identity gating mirrors useCampaignMembers: no fetch while
  // offline or before the actor is known. Authoring mutations below are
  // likewise disabled while offline (same discipline as the board's
  // bump/Execute buttons).
  const online = props.online ?? true;
  const actorId = props.actorId ?? null;
  const generation = props.generation ?? 0;
  const isGm = props.isGm === true;
  const listKey = campaignContentKey(props.campaignId, actorId, generation, "active");
  const list = useQuery({
    queryKey: listKey,
    queryFn: () => props.api.listContent(props.campaignId),
    enabled: online && actorId !== null,
  });
  const deletedKey = campaignContentKey(props.campaignId, actorId, generation, "deleted");
  const deleted = useInfiniteQuery({
    queryKey: deletedKey,
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      props.api.listContent(props.campaignId, { cursor: pageParam, limit: 25, status: "deleted" }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: online && actorId !== null && isGm,
  });
  const [view, setView] = useState<"active" | "hidden">("active");
  const [recoveringId, setRecoveringId] = useState<string | null>(null);
  const [recoverError, setRecoverError] = useState<string | null>(null);
  const [recoveredTitle, setRecoveredTitle] = useState<string | null>(null);
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
    queryKey: [...listKey, "item", selectedId ?? "none"],
    queryFn: () => props.api.openContent(selectedId ?? ""),
    enabled: selectedId !== null && online && actorId !== null,
    // Authorization revalidation must not wait out the shared 30s stale
    // budget: reopening, focus, and reconnect always re-read the note, so a
    // narrowed grant cannot survive behind a fresh cache entry.
    staleTime: 0,
  });

  // Preview-as-member (GM-only, ephemeral UI state — never a route). The
  // picker offers active members regardless of role; the preview panel below
  // renders list + reader from preview queries under the preview cache
  // family, and every mutating control stays unmounted while previewing.
  const [previewTargetId, setPreviewTargetId] = useState<string | null>(null);

  const enterPreview = (targetUserId: string): void => {
    setPreviewTargetId(targetUserId);
  };

  const exitPreview = (): void => {
    // The preview panel's unmount cleanup purges the retired keys.
    setPreviewTargetId(null);
  };

  useEffect(() => {
    if (list.status === "error" && isNotFound(list.error) && !revocationNotified.current) {
      revocationNotified.current = true;
      props.onAccessRevoked?.();
    }
  }, [list.status, list.error, props]);

  useEffect(() => {
    if (selectedId !== null && detail.status === "error" && isNotFound(detail.error)) {
      // A single note narrowed or removed after the list rendered: hide its
      // row from now on, drop its cached body (a retained entry would
      // outlive the revocation), show the generic unavailable state (never
      // the server payload), and reload the list fresh.
      const revokedId = selectedId;
      setRevokedIds((prev) => {
        if (prev.has(revokedId)) return prev;
        const next = new Set(prev);
        next.add(revokedId);
        return next;
      });
      queryClient.removeQueries({ queryKey: [...listKey, "item", revokedId] });
      setSelectedId(null);
      setUnavailable(true);
      void queryClient.invalidateQueries({ queryKey: listKey });
    }
  }, [selectedId, detail.status, detail.error, queryClient, listKey]);

  useEffect(() => {
    if (
      selectedId !== null &&
      list.status === "success" &&
      !revokedIds.has(selectedId) &&
      !list.data.content.some((item) => item.contentId === selectedId)
    ) {
      // The list reloaded without the open note (narrowed audience, hidden
      // note) while its reader stayed mounted: route through the same
      // revoked path as a 404 read rather than leaving the stale body up.
      const revokedId = selectedId;
      setRevokedIds((prev) => {
        if (prev.has(revokedId)) return prev;
        const next = new Set(prev);
        next.add(revokedId);
        return next;
      });
      queryClient.removeQueries({ queryKey: [...listKey, "item", revokedId] });
      setSelectedId(null);
      setUnavailable(true);
    }
  }, [selectedId, list, revokedIds, queryClient, listKey]);

  const reload = (): void => {
    void queryClient.invalidateQueries({ queryKey: listKey });
    if (isGm) void queryClient.invalidateQueries({ queryKey: deletedKey });
    props.onChanged?.();
  };

  const attemptRecover = async (contentId: string, title: string, revision: number): Promise<void> => {
    if (recoveringId !== null || !online) return;
    setRecoveringId(contentId);
    setRecoverError(null);
    setRecoveredTitle(null);
    try {
      await props.api.recoverContent(contentId, {
        expectedContentRevision: revision,
        idempotencyKey: crypto.randomUUID(),
      });
      setRecoveredTitle(title);
      reload();
    } catch (cause) {
      if (isConflict(cause)) {
        setRecoverError(t("campaign.detail.content.hidden.conflict", { title }));
        void queryClient.invalidateQueries({ queryKey: deletedKey });
      } else if (isNotFound(cause)) {
        setRecoverError(t("campaign.detail.content.hidden.unavailable", { title }));
        void queryClient.invalidateQueries({ queryKey: deletedKey });
      } else {
        setRecoverError(t("campaign.detail.content.edit.error"));
      }
    } finally {
      setRecoveringId(null);
    }
  };

  const fetchView = async (contentId: string, assign: (view: ContentView) => void): Promise<void> => {
    if (viewPendingId !== null || !online) return;
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

  // List-level Hide intentionally diverges from the editor delete path:
  // it invalidates and reloads the list without retaining a deleted view,
  // so no in-session Recover is offered here (the editor path keeps its
  // deleted view mounted with a working Recover button). The dialog closes
  // and the row simply disappears on the next load.
  const attemptDeleteTarget = async (): Promise<void> => {
    if (deleting === null || mutationPending || !online) return;
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
    if (previewTargetId !== null) {
      return (
        <CampaignContentPreview
          api={props.api}
          campaignId={props.campaignId}
          targetUserId={previewTargetId}
          online={online}
          actorId={actorId}
          onExit={exitPreview}
        />
      );
    }
    const members = props.members ?? [];
    // The roster carries userIds only: the picker offers every active member
    // regardless of role and labels options by userId. Never invent names.
    const previewRoster = members.filter((member) => member.status === "active");
    const visible = items.filter((item) => !revokedIds.has(item.contentId));
    const hiddenRows = (deleted.data?.pages.flatMap((page) => page.content) ?? []).filter(
      (row) => !revokedIds.has(row.contentId),
    );
    return (
      <div>
        {previewRoster.length > 0 ? (
          <Select
            label={t("campaign.detail.content.preview.label")}
            placeholder={t("campaign.detail.content.preview.placeholder")}
            options={previewRoster.map((member) => ({ value: member.userId, label: member.userId }))}
            value=""
            required
            onChange={(event) => {
              if (event.target.value !== "") enterPreview(event.target.value);
            }}
          />
        ) : null}
        <div role="group" aria-label={t("campaign.detail.content.listAriaLabel")}>
          <Button variant={view === "active" ? "primary" : "secondary"} onClick={() => setView("active")}>
            {t("campaign.detail.content.view.active")}
          </Button>{" "}
          <Button variant={view === "hidden" ? "primary" : "secondary"} onClick={() => setView("hidden")}>
            {t("campaign.detail.content.view.hidden")}
          </Button>
        </div>
        {view === "hidden" ? (
          <section aria-label={t("campaign.detail.content.view.hidden")}>
            <p>{t("campaign.detail.content.hidden.description")}</p>
            {recoverError !== null ? <p role="alert">{recoverError}</p> : null}
            {recoveredTitle !== null ? (
              <p role="status">{t("campaign.detail.content.hidden.recovered", { title: recoveredTitle })}</p>
            ) : null}
            {deleted.status === "pending" ? (
              <p role="status">{t("campaign.detail.content.loading")}</p>
            ) : null}
            {deleted.status === "error" ? (
              <EmptyState
                title={t("campaign.detail.content.loadFailed")}
                action={
                  <Button variant="primary" onClick={() => void deleted.refetch()}>
                    {t("campaign.detail.retry")}
                  </Button>
                }
              />
            ) : null}
            {deleted.status === "success" && hiddenRows.length === 0 ? (
              <p role="status">{t("campaign.detail.content.hidden.empty")}</p>
            ) : null}
            {deleted.status === "success" && hiddenRows.length > 0 ? (
              <ul aria-label={t("campaign.detail.content.view.hidden")}>
                {hiddenRows.map((row) => (
                  <li key={row.contentId}>
                    <span>{row.title}</span> <span>{audienceLabel(row.audience)}</span>{" "}
                    <span>{row.status}</span>{" "}
                    <Button
                      variant="primary"
                      pending={recoveringId === row.contentId}
                      disabled={!online || recoveringId !== null}
                      onClick={() => void attemptRecover(row.contentId, row.title, row.revision)}
                    >
                      {t("campaign.detail.content.hidden.recover", { title: row.title })}
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}
            {deleted.hasNextPage === true ? (
              <Button variant="secondary" disabled={!online} onClick={() => void deleted.fetchNextPage()}>
                {t("campaign.detail.content.hidden.more")}
              </Button>
            ) : null}
          </section>
        ) : null}
        {view === "active" ? (
        <>
        <ContentEditor
          api={props.api}
          campaignId={props.campaignId}
          members={members}
          onSaved={reload}
          onDeleted={reload}
          onConflicted={reload}
          online={online}
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
              // Keep the editor mounted: it now shows the deleted view with
              // its working Recover button. The list still reloads.
              reload();
            }}
            onConflicted={reload}
            online={online}
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
                  disabled={!online}
                  onClick={() => void fetchView(item.contentId, setEditing)}
                >
                  {t("campaign.detail.content.edit.editItem", { title: item.title })}
                </Button>{" "}
                <Button
                  variant="secondary"
                  pending={viewPendingId === item.contentId}
                  disabled={!online}
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
            <Button
              variant="danger"
              pending={mutationPending}
              disabled={!online}
              onClick={() => void attemptDeleteTarget()}
            >
              {t("campaign.detail.content.edit.delete.confirm.confirm")}
            </Button>
          }
        >
          <p>{deleting?.title ?? ""}</p>
        </Dialog>
        </>
        ) : null}
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
