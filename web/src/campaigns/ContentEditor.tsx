// GM content authoring: create form plus edit/delete/recover with audience
// grants. Error paths never render server payloads or secrets: only the
// generic strings below reach the page.
import { useState } from "react";

import { t } from "../i18n/index.js";
import { Button, Checkbox, Dialog, FormField, Panel, Select } from "../ui/index.js";
import type { CampaignsApi } from "./api.js";
import { audienceLabel, type ContentAudience } from "./CampaignContent.js";
import type { CampaignMember, ContentView, CreateContentBody, UpdateContentBody } from "./types.js";
import { randomUUID } from "../utils/uuid";

const AUDIENCES: ContentAudience[] = ["gm_only", "all_players", "selected_players", "owner_only"];

function isConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as { code?: unknown; status?: unknown };
  return record.status === 409 || record.code === "conflict";
}

function parseTags(text: string): string[] {
  return text
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

function sameTagList(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((tag, index) => tag === right[index]);
}

function sameIdSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((id) => rightSet.has(id));
}

/**
 * Narrow the delete receipt to its deleted view. Never assume the payload
 * shape: anything unparseable (or a view for another row / status) yields
 * null and the caller falls back to the re-read paths.
 */
function deletedViewFromReceipt(receipt: unknown, contentId: string): ContentView | null {
  if (typeof receipt !== "object" || receipt === null) return null;
  const content = (receipt as { content?: unknown }).content;
  if (typeof content !== "object" || content === null) return null;
  const view = content as Partial<ContentView>;
  if (view.contentId !== contentId || view.status !== "deleted" || typeof view.revision !== "number") {
    return null;
  }
  return view as ContentView;
}

export function ContentEditor(props: {
  api: Pick<
    CampaignsApi,
    | "createContent"
    | "updateContent"
    | "deleteContent"
    | "recoverContent"
    | "replaceContentGrants"
    | "openContent"
  >;
  campaignId: string;
  members: CampaignMember[];
  initial?: ContentView;
  onSaved: () => void;
  onDeleted: () => void;
  /** 409 reload signal: refresh the parent list without unmounting this editor. */
  onConflicted: () => void;
  /** Online gate (mirrors the bump/Execute convention): mutations disabled while offline. */
  online?: boolean;
}) {
  const initial = props.initial;
  // After a successful Hide the editor stays mounted on the deleted view
  // (refetched for its fresh revision) so Recover stays reachable in-session.
  const [deletedView, setDeletedView] = useState<ContentView | null>(null);
  const effective = deletedView ?? initial;
  // While the effective view is deleted no updateContent may issue: the
  // backend rejects writes against a deleted revision, so Save and the edit
  // controls stay out of reach until Recover clears the deleted view.
  const isDeleted = effective?.status === "deleted";
  const online = props.online ?? true;
  const [title, setTitle] = useState(initial?.title ?? "");
  const [bodyText, setBodyText] = useState(initial?.body ?? "");
  const [tagsText, setTagsText] = useState((initial?.tags ?? []).join(", "));
  const [audience, setAudience] = useState<ContentAudience>(initial?.audience ?? "gm_only");
  const [checked, setChecked] = useState<string[]>(() => [...(initial?.grantedUserIds ?? [])]);
  const [pending, setPending] = useState<"save" | "delete" | "recover" | null>(null);
  const [conflict, setConflict] = useState(false);
  const [failed, setFailed] = useState(false);
  const [saved, setSaved] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [recoverOpen, setRecoverOpen] = useState(false);

  // The roster carries userIds only: label grant checkboxes by the short id
  // with the full id as the accessible description. Never invent names.
  const roster = props.members.filter((member) => member.status === "active");

  const toggleGrant = (userId: string): void => {
    setChecked((prev) =>
      prev.includes(userId) ? prev.filter((id) => id !== userId) : [...prev, userId],
    );
  };

  const attemptSave = async (): Promise<void> => {
    if (pending !== null || title.trim() === "" || isDeleted || !online) return;
    setPending("save");
    setFailed(false);
    setConflict(false);
    setSaved(false);
    try {
      if (effective === undefined) {
        // Caller-minted idempotency key, fresh on every attempt.
        const body: CreateContentBody = {
          title: title.trim(),
          body: bodyText,
          audience,
          idempotencyKey: randomUUID(),
        };
        const tags = parseTags(tagsText);
        if (tags.length > 0) body.tags = tags;
        if (audience === "selected_players" && checked.length > 0) body.grantedUserIds = [...checked];
        await props.api.createContent(props.campaignId, body);
        // Clear the create form after a successful save so a second Save
        // cannot accidentally persist a duplicate note.
        setTitle("");
        setBodyText("");
        setTagsText("");
        setAudience("gm_only");
        setChecked([]);
      } else {
        // Content fields: send only what changed. Grants: atomic full-set
        // replacement of the complete checked set, never deltas.
        let revision = effective.revision;
        const patch: UpdateContentBody = {
          expectedContentRevision: revision,
          idempotencyKey: randomUUID(),
        };
        let dirty = false;
        const trimmedTitle = title.trim();
        if (trimmedTitle !== effective.title) {
          patch.title = trimmedTitle;
          dirty = true;
        }
        if (bodyText !== effective.body) {
          patch.body = bodyText;
          dirty = true;
        }
        const tags = parseTags(tagsText);
        if (!sameTagList(tags, effective.tags)) {
          patch.tags = tags;
          dirty = true;
        }
        if (audience !== effective.audience) {
          patch.audience = audience;
          dirty = true;
        }
        if (dirty) {
          const updated = await props.api.updateContent(effective.contentId, patch);
          revision = updated.content.revision;
        }
        const grantsDirty =
          audience === "selected_players" &&
          (audience !== effective.audience || !sameIdSet(checked, effective.grantedUserIds ?? []));
        if (grantsDirty) {
          // Caller-minted idempotency key, fresh on every attempt.
          await props.api.replaceContentGrants(effective.contentId, {
            grantedUserIds: [...checked],
            expectedContentRevision: revision,
            idempotencyKey: randomUUID(),
          });
        }
      }
      setSaved(true);
      props.onSaved();
    } catch (cause) {
      if (isConflict(cause)) {
        // 409 → reload the parent list (without unmounting), then offer a
        // retry with a fresh key. Never "Merge".
        setConflict(true);
        props.onConflicted();
      } else {
        setFailed(true);
      }
    } finally {
      setPending(null);
    }
  };

  const attemptDelete = async (): Promise<void> => {
    if (effective === undefined || pending !== null || !online) return;
    setPending("delete");
    setFailed(false);
    setConflict(false);
    // Caller-minted idempotency key, fresh on every attempt.
    try {
      const receipt = await props.api.deleteContent(effective.contentId, {
        expectedContentRevision: effective.revision,
        idempotencyKey: randomUUID(),
      });
      setDeleteOpen(false);
      // Stay mounted on the deleted view so Recover remains reachable
      // in-session; the parent list still reloads via onDeleted. Prefer the
      // delete receipt's view: it carries the fresh post-delete revision,
      // while openContent 404s on deleted rows by contract (so the re-read
      // below only ever succeeds for rows that were already recovered).
      // The stale-revision fallback covers a receipt that cannot be parsed
      // (then Recover is best-effort against the last known revision).
      const receiptView = deletedViewFromReceipt(receipt, effective.contentId);
      if (receiptView !== null) {
        setDeletedView(receiptView);
      } else {
        try {
          const res = await props.api.openContent(effective.contentId);
          setDeletedView(res.content);
        } catch {
          setDeletedView({ ...effective, status: "deleted" });
        }
      }
      props.onDeleted();
    } catch (cause) {
      if (isConflict(cause)) {
        // 409 → reload the parent list (without unmounting), then offer a
        // retry with a fresh key. Never "Merge".
        setDeleteOpen(false);
        setConflict(true);
        props.onConflicted();
      } else {
        setFailed(true);
      }
    } finally {
      setPending(null);
    }
  };

  const attemptRecover = async (): Promise<void> => {
    if (effective === undefined || pending !== null || !online) return;
    setPending("recover");
    setFailed(false);
    setConflict(false);
    // Caller-minted idempotency key, fresh on every attempt.
    try {
      await props.api.recoverContent(effective.contentId, {
        expectedContentRevision: effective.revision,
        idempotencyKey: randomUUID(),
      });
      setRecoverOpen(false);
      // The row is active again: drop the retained deleted view so the
      // editor returns to the live revision instead of a stale deleted one.
      setDeletedView(null);
      props.onSaved();
    } catch (cause) {
      if (isConflict(cause)) {
        // 409 → reload the parent list (without unmounting), then offer a
        // retry with a fresh key. Never "Merge".
        setRecoverOpen(false);
        setConflict(true);
        props.onConflicted();
      } else {
        setFailed(true);
      }
    } finally {
      setPending(null);
    }
  };

  return (
    <div>
      <Panel title={effective?.title ?? t("campaign.detail.content.edit.createTitle")}>
        {isDeleted ? null : (
          <>
            <FormField label={t("campaign.detail.content.edit.titleLabel")}>
              <input type="text" value={title} onChange={(event) => setTitle(event.target.value)} />
            </FormField>
            <FormField label={t("campaign.detail.content.edit.bodyLabel")}>
              <textarea value={bodyText} onChange={(event) => setBodyText(event.target.value)} />
            </FormField>
            <FormField label={t("campaign.detail.content.edit.tagsLabel")}>
              <input type="text" value={tagsText} onChange={(event) => setTagsText(event.target.value)} />
            </FormField>
            <Select
              label={t("campaign.detail.content.edit.audienceLabel")}
              options={AUDIENCES.map((value) => ({ value, label: audienceLabel(value) }))}
              value={audience}
              onChange={(event) => setAudience(event.target.value as ContentAudience)}
            />
            {audience === "selected_players" ? (
              <fieldset>
                <legend>{t("campaign.detail.content.edit.grantsLabel")}</legend>
                {roster.map((member) => (
                  <Checkbox
                    key={member.userId}
                    label={member.userId.slice(0, 8)}
                    hint={member.userId}
                    checked={checked.includes(member.userId)}
                    onChange={() => toggleGrant(member.userId)}
                  />
                ))}
              </fieldset>
            ) : null}
          </>
        )}
        {conflict ? <p role="alert">{t("campaign.detail.content.edit.conflict")}</p> : null}
        {failed ? <p role="alert">{t("campaign.detail.content.edit.error")}</p> : null}
        {saved ? <p role="status">{t("campaign.detail.content.edit.saved")}</p> : null}
        <Button
          variant="primary"
          pending={pending === "save"}
          pendingText={t("campaign.detail.content.edit.saving")}
          disabled={title.trim() === "" || isDeleted === true || !online}
          onClick={() => void attemptSave()}
        >
          {t("campaign.detail.content.edit.save")}
        </Button>{" "}
        {effective !== undefined && effective.status !== "deleted" ? (
          <Button variant="danger" disabled={!online} onClick={() => setDeleteOpen(true)}>
            {t("campaign.detail.content.edit.delete", { title: effective.title })}
          </Button>
        ) : null}{" "}
        {effective !== undefined && effective.status === "deleted" ? (
          <Button variant="secondary" disabled={!online} onClick={() => setRecoverOpen(true)}>
            {t("campaign.detail.content.edit.recover", { title: effective.title })}
          </Button>
        ) : null}
      </Panel>
      {effective !== undefined ? (
        <Dialog
          open={deleteOpen}
          onOpenChange={(open) => {
            if (!open) setDeleteOpen(false);
          }}
          title={t("campaign.detail.content.edit.delete.confirm.title")}
          description={t("campaign.detail.content.edit.delete.confirm.description")}
          actions={
            <Button
              variant="danger"
              pending={pending === "delete"}
              disabled={!online}
              onClick={() => void attemptDelete()}
            >
              {t("campaign.detail.content.edit.delete.confirm.confirm")}
            </Button>
          }
        >
          <p>{effective.title}</p>
        </Dialog>
      ) : null}
      {effective !== undefined ? (
        <Dialog
          open={recoverOpen}
          onOpenChange={(open) => {
            if (!open) setRecoverOpen(false);
          }}
          title={t("campaign.detail.content.edit.recover.confirm.title")}
          actions={
            <Button
              variant="primary"
              pending={pending === "recover"}
              disabled={!online}
              onClick={() => void attemptRecover()}
            >
              {t("campaign.detail.content.edit.recover.confirm.confirm")}
            </Button>
          }
        >
          <p>{effective.title}</p>
        </Dialog>
      ) : null}
    </div>
  );
}
