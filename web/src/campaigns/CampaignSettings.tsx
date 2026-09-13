// GM campaign settings panel: edit title/description, archive/recover behind
// confirmations, and export readiness. Mounted by the Members tab only when
// the actor's own role is owner or co_gm (Task 7 owns that gate).
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import type { CharactersApi } from "../characters/api.js";
import { flattenCatalogPages, useVersionCatalog } from "../characters/versionCatalog.js";
import { t } from "../i18n/index.js";
import { Button, Dialog, FormField, Panel } from "../ui/index.js";
import type { CampaignsApi } from "./api.js";
import { campaignCharactersPrefix, campaignDetailKey } from "./campaignQueries.js";
import type { CampaignView, CommitUpgradeResponse } from "./types.js";
import { UpgradeDialog } from "./UpgradeDialog.js";

function isConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as { code?: unknown; status?: unknown };
  return record.status === 409 || record.code === "conflict";
}

function describeError(cause: unknown, fallback: string): string {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "message" in cause &&
    typeof cause.message === "string" &&
    cause.message !== ""
  ) {
    return cause.message;
  }
  return fallback;
}

export function CampaignSettingsView(props: {
  api: Pick<
    CampaignsApi,
    "updateCampaign" | "archiveCampaign" | "recoverCampaign" | "exportCampaign" | "previewUpgrade" | "commitUpgrade"
  >;
  /** Creation-versions catalog handle; the upgrade dialog stays shut without it. */
  versionsApi?: Pick<CharactersApi, "listCreationVersions"> | undefined;
  campaign: CampaignView;
  actorId?: string | null;
  generation?: number;
  online?: boolean;
  /** GM surfacing gate from the Settings tab's existing role (server stays authoritative). */
  isGm?: boolean;
  onChanged?: () => void;
}) {
  const [title, setTitle] = useState(props.campaign.title);
  const [description, setDescription] = useState(props.campaign.description ?? "");
  const [savePending, setSavePending] = useState(false);
  const [saveConflict, setSaveConflict] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [archivePhase, setArchivePhase] = useState<"idle" | "confirming" | "working">("idle");
  const [recoverPhase, setRecoverPhase] = useState<"idle" | "confirming" | "working">("idle");
  const [exportPending, setExportPending] = useState(false);
  const [exportDone, setExportDone] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const queryClient = useQueryClient();

  const online = props.online ?? true;
  const actorId = props.actorId ?? null;
  const generation = props.generation ?? 0;
  const showUpgrade = props.isGm === true;

  // Resolve the pin's owning system + semver from the creation-versions
  // catalog so the dialog can list newer same-system targets. The query never
  // fires without a catalog handle (enabled guard); a link-only pin outside
  // the catalog resolves to "" and the dialog degrades to exact-ID-only mode.
  const catalog = useVersionCatalog(
    (props.versionsApi ?? { listCreationVersions: () => Promise.reject(new Error("missing")) }) as CharactersApi,
    actorId,
    generation,
    { enabled: showUpgrade && props.versionsApi !== undefined, online },
  );
  const pinEntry = flattenCatalogPages(catalog.data).find(
    (entry) => entry.versionId === props.campaign.systemVersionId,
  );

  const handleCommitted = (_result: CommitUpgradeResponse): void => {
    // Task 4 invalidation set: every actor/generation-scoped read under this
    // campaign reloads and the detail view re-reads the moved pin.
    void queryClient.invalidateQueries({ queryKey: campaignCharactersPrefix(props.campaign.campaignId) });
    void queryClient.invalidateQueries({ queryKey: ["campaigns", "content", props.campaign.campaignId] });
    void queryClient.invalidateQueries({ queryKey: ["campaigns", "activity", props.campaign.campaignId] });
    void queryClient.invalidateQueries({ queryKey: ["campaigns", "session", props.campaign.campaignId] });
    void queryClient.invalidateQueries({ queryKey: campaignDetailKey(props.campaign.campaignId) });
    props.onChanged?.();
  };

  const attemptSave = async (): Promise<void> => {
    const trimmedTitle = title.trim();
    if (savePending || trimmedTitle === "") return;
    setSavePending(true);
    setSaveError(null);
    setSaveConflict(false);
    setSaved(false);
    // Caller-minted idempotency key, fresh on every attempt.
    const idempotencyKey = crypto.randomUUID();
    try {
      await props.api.updateCampaign(props.campaign.campaignId, {
        title: trimmedTitle,
        description: description.trim(),
        expectedCampaignRevision: props.campaign.revision,
        idempotencyKey,
      });
      setSaved(true);
      props.onChanged?.();
    } catch (cause) {
      if (isConflict(cause)) {
        // 409 → re-read first, then offer a retry with a fresh key. Never "Merge".
        setSaveConflict(true);
        props.onChanged?.();
      } else {
        setSaveError(describeError(cause, t("campaign.manage.settings.error")));
      }
    } finally {
      setSavePending(false);
    }
  };

  const attemptArchive = async (): Promise<void> => {
    if (archivePhase !== "confirming") return;
    setArchivePhase("working");
    // Caller-minted idempotency key, fresh on every attempt.
    const idempotencyKey = crypto.randomUUID();
    try {
      await props.api.archiveCampaign(props.campaign.campaignId, {
        expectedCampaignRevision: props.campaign.revision,
        idempotencyKey,
      });
      setArchivePhase("idle");
      props.onChanged?.();
    } catch (cause) {
      if (isConflict(cause)) {
        setSaveConflict(true);
        setArchivePhase("idle");
        props.onChanged?.();
      } else {
        setSaveError(describeError(cause, t("campaign.manage.settings.error")));
        setArchivePhase("idle");
      }
    }
  };

  const attemptRecover = async (): Promise<void> => {
    if (recoverPhase !== "confirming") return;
    setRecoverPhase("working");
    // Caller-minted idempotency key, fresh on every attempt.
    const idempotencyKey = crypto.randomUUID();
    try {
      await props.api.recoverCampaign(props.campaign.campaignId, {
        expectedCampaignRevision: props.campaign.revision,
        idempotencyKey,
      });
      setRecoverPhase("idle");
      props.onChanged?.();
    } catch (cause) {
      if (isConflict(cause)) {
        setSaveConflict(true);
        setRecoverPhase("idle");
        props.onChanged?.();
      } else {
        setSaveError(describeError(cause, t("campaign.manage.settings.error")));
        setRecoverPhase("idle");
      }
    }
  };

  const attemptExport = async (): Promise<void> => {
    if (exportPending) return;
    setExportPending(true);
    setExportError(null);
    setExportDone(false);
    // Caller-minted idempotency key, fresh on every attempt.
    const idempotencyKey = crypto.randomUUID();
    try {
      await props.api.exportCampaign(props.campaign.campaignId, { idempotencyKey });
      setExportDone(true);
    } catch (cause) {
      if (isConflict(cause)) {
        // 409 → re-read first, then offer a retry with a fresh key. Never "Merge".
        setSaveConflict(true);
        props.onChanged?.();
      } else {
        setExportError(describeError(cause, t("campaign.manage.settings.error")));
      }
    } finally {
      setExportPending(false);
    }
  };

  return (
    <div>
      <Panel title={t("campaign.manage.settings.title")}>
        <FormField label={t("campaign.manage.settings.titleLabel")}>
          <input type="text" value={title} onChange={(event) => setTitle(event.target.value)} />
        </FormField>
        <FormField label={t("campaign.manage.settings.descriptionLabel")}>
          <input type="text" value={description} onChange={(event) => setDescription(event.target.value)} />
        </FormField>
        <p>
          {t("campaign.manage.settings.version.label")}: <span>{props.campaign.systemVersionId}</span>
        </p>
        {saveConflict ? <p role="alert">{t("campaign.manage.settings.conflict")}</p> : null}
        {saveError !== null ? <p role="alert">{saveError}</p> : null}
        {saved ? <p role="status">{t("campaign.manage.settings.saved")}</p> : null}
        <Button
          variant="primary"
          pending={savePending}
          pendingText={t("campaign.manage.settings.saving")}
          disabled={title.trim() === ""}
          onClick={() => void attemptSave()}
        >
          {t("campaign.manage.settings.save")}
        </Button>{" "}
        {props.campaign.status === "active" ? (
          <Button variant="secondary" onClick={() => setArchivePhase("confirming")}>
            {t("campaign.manage.settings.archive")}
          </Button>
        ) : (
          <Button variant="secondary" onClick={() => setRecoverPhase("confirming")}>
            {t("campaign.manage.settings.recover")}
          </Button>
        )}{" "}
        <Button
          variant="secondary"
          pending={exportPending}
          pendingText={t("campaign.manage.settings.export.exporting")}
          onClick={() => void attemptExport()}
        >
          {t("campaign.manage.settings.export")}
        </Button>
        {exportDone ? <p role="status">{t("campaign.manage.settings.export.done")}</p> : null}
        {exportError !== null ? <p role="alert">{exportError}</p> : null}
      </Panel>
      {showUpgrade ? (
        <Panel title={t("campaign.detail.upgrade.title")}>
          <Button variant="secondary" disabled={!online || props.versionsApi === undefined} onClick={() => setUpgradeOpen(true)}>
            {t("campaign.detail.upgrade.title")}
          </Button>
          {!online ? <p role="status">{t("campaign.detail.upgrade.commit.offline")}</p> : null}
        </Panel>
      ) : null}
      {upgradeOpen && props.versionsApi !== undefined ? (
        <UpgradeDialog
          api={props.api}
          versionsApi={props.versionsApi}
          campaignId={props.campaign.campaignId}
          actorId={actorId}
          generation={generation}
          target={null}
          systemId={pinEntry?.systemId ?? ""}
          sourceSemanticVersion={pinEntry?.semanticVersion ?? ""}
          online={online}
          onClose={() => setUpgradeOpen(false)}
          onCommitted={handleCommitted}
        />
      ) : null}
      <Dialog
        open={archivePhase !== "idle"}
        onOpenChange={(open) => {
          if (!open) setArchivePhase("idle");
        }}
        title={t("campaign.manage.settings.archive.confirm.title")}
        description={t("campaign.manage.settings.archive.confirm.description")}
        actions={
          <Button variant="primary" pending={archivePhase === "working"} onClick={() => void attemptArchive()}>
            {t("campaign.manage.settings.archive.confirm.confirm")}
          </Button>
        }
      >
        <p>{props.campaign.title}</p>
      </Dialog>
      <Dialog
        open={recoverPhase !== "idle"}
        onOpenChange={(open) => {
          if (!open) setRecoverPhase("idle");
        }}
        title={t("campaign.manage.settings.recover.confirm.title")}
        actions={
          <Button variant="primary" pending={recoverPhase === "working"} onClick={() => void attemptRecover()}>
            {t("campaign.manage.settings.recover.confirm.confirm")}
          </Button>
        }
      >
        <p>{props.campaign.title}</p>
      </Dialog>
    </div>
  );
}
