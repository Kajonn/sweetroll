// GM content authoring: create form plus edit/delete/recover with audience
// grants. Error paths never render server payloads or secrets: only the
// generic strings below reach the page.
import { useState } from "react";

import { t } from "../i18n/index.js";
import { Button, Checkbox, Dialog, FormField, Panel, Select } from "../ui/index.js";
import type { CampaignsApi } from "./api.js";
import { audienceLabel, type ContentAudience } from "./CampaignContent.js";
import type { CampaignMember, ContentView, CreateContentBody, UpdateContentBody } from "./types.js";

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

export function ContentEditor(props: {
  api: Pick<
    CampaignsApi,
    "createContent" | "updateContent" | "deleteContent" | "recoverContent" | "replaceContentGrants"
  >;
  campaignId: string;
  members: CampaignMember[];
  initial?: ContentView;
  onSaved: () => void;
  onDeleted: () => void;
}) {
  const initial = props.initial;
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
    if (pending !== null || title.trim() === "") return;
    setPending("save");
    setFailed(false);
    setConflict(false);
    setSaved(false);
    try {
      if (initial === undefined) {
        // Caller-minted idempotency key, fresh on every attempt.
        const body: CreateContentBody = {
          title: title.trim(),
          body: bodyText,
          audience,
          idempotencyKey: crypto.randomUUID(),
        };
        const tags = parseTags(tagsText);
        if (tags.length > 0) body.tags = tags;
        if (audience === "selected_players" && checked.length > 0) body.grantedUserIds = [...checked];
        await props.api.createContent(props.campaignId, body);
      } else {
        // Content fields: send only what changed. Grants: atomic full-set
        // replacement of the complete checked set, never deltas.
        let revision = initial.revision;
        const patch: UpdateContentBody = {
          expectedContentRevision: revision,
          idempotencyKey: crypto.randomUUID(),
        };
        let dirty = false;
        const trimmedTitle = title.trim();
        if (trimmedTitle !== initial.title) {
          patch.title = trimmedTitle;
          dirty = true;
        }
        if (bodyText !== initial.body) {
          patch.body = bodyText;
          dirty = true;
        }
        const tags = parseTags(tagsText);
        if (!sameTagList(tags, initial.tags)) {
          patch.tags = tags;
          dirty = true;
        }
        if (audience !== initial.audience) {
          patch.audience = audience;
          dirty = true;
        }
        if (dirty) {
          const updated = await props.api.updateContent(initial.contentId, patch);
          revision = updated.content.revision;
        }
        const grantsDirty =
          audience === "selected_players" &&
          (audience !== initial.audience || !sameIdSet(checked, initial.grantedUserIds ?? []));
        if (grantsDirty) {
          // Caller-minted idempotency key, fresh on every attempt.
          await props.api.replaceContentGrants(initial.contentId, {
            grantedUserIds: [...checked],
            expectedContentRevision: revision,
            idempotencyKey: crypto.randomUUID(),
          });
        }
      }
      setSaved(true);
      props.onSaved();
    } catch (cause) {
      if (isConflict(cause)) {
        // 409 → re-read first, then offer a retry with a fresh key. Never "Merge".
        setConflict(true);
        props.onSaved();
      } else {
        setFailed(true);
      }
    } finally {
      setPending(null);
    }
  };

  const attemptDelete = async (): Promise<void> => {
    if (initial === undefined || pending !== null) return;
    setPending("delete");
    setFailed(false);
    setConflict(false);
    // Caller-minted idempotency key, fresh on every attempt.
    try {
      await props.api.deleteContent(initial.contentId, {
        expectedContentRevision: initial.revision,
        idempotencyKey: crypto.randomUUID(),
      });
      setDeleteOpen(false);
      props.onDeleted();
    } catch (cause) {
      if (isConflict(cause)) {
        // 409 → re-read first, then offer a retry with a fresh key. Never "Merge".
        setDeleteOpen(false);
        setConflict(true);
        props.onDeleted();
      } else {
        setFailed(true);
      }
    } finally {
      setPending(null);
    }
  };

  const attemptRecover = async (): Promise<void> => {
    if (initial === undefined || pending !== null) return;
    setPending("recover");
    setFailed(false);
    setConflict(false);
    // Caller-minted idempotency key, fresh on every attempt.
    try {
      await props.api.recoverContent(initial.contentId, {
        expectedContentRevision: initial.revision,
        idempotencyKey: crypto.randomUUID(),
      });
      setRecoverOpen(false);
      props.onSaved();
    } catch (cause) {
      if (isConflict(cause)) {
        // 409 → re-read first, then offer a retry with a fresh key. Never "Merge".
        setRecoverOpen(false);
        setConflict(true);
        props.onSaved();
      } else {
        setFailed(true);
      }
    } finally {
      setPending(null);
    }
  };

  return (
    <div>
      <Panel title={initial?.title ?? t("campaign.detail.content.edit.createTitle")}>
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
        {conflict ? <p role="alert">{t("campaign.detail.content.edit.conflict")}</p> : null}
        {failed ? <p role="alert">{t("campaign.detail.content.edit.error")}</p> : null}
        {saved ? <p role="status">{t("campaign.detail.content.edit.saved")}</p> : null}
        <Button
          variant="primary"
          pending={pending === "save"}
          pendingText={t("campaign.detail.content.edit.saving")}
          disabled={title.trim() === ""}
          onClick={() => void attemptSave()}
        >
          {t("campaign.detail.content.edit.save")}
        </Button>{" "}
        {initial !== undefined && initial.status !== "deleted" ? (
          <Button variant="danger" onClick={() => setDeleteOpen(true)}>
            {t("campaign.detail.content.edit.delete", { title: initial.title })}
          </Button>
        ) : null}{" "}
        {initial !== undefined && initial.status === "deleted" ? (
          <Button variant="secondary" onClick={() => setRecoverOpen(true)}>
            {t("campaign.detail.content.edit.recover", { title: initial.title })}
          </Button>
        ) : null}
      </Panel>
      {initial !== undefined ? (
        <Dialog
          open={deleteOpen}
          onOpenChange={(open) => {
            if (!open) setDeleteOpen(false);
          }}
          title={t("campaign.detail.content.edit.delete.confirm.title")}
          description={t("campaign.detail.content.edit.delete.confirm.description")}
          actions={
            <Button variant="danger" pending={pending === "delete"} onClick={() => void attemptDelete()}>
              {t("campaign.detail.content.edit.delete.confirm.confirm")}
            </Button>
          }
        >
          <p>{initial.title}</p>
        </Dialog>
      ) : null}
      {initial !== undefined ? (
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
              onClick={() => void attemptRecover()}
            >
              {t("campaign.detail.content.edit.recover.confirm.confirm")}
            </Button>
          }
        >
          <p>{initial.title}</p>
        </Dialog>
      ) : null}
    </div>
  );
}
