// Design 6.7: GM rules-version panel. Lists the revert target and later
// versions, runs the server dry run for every attached character and
// system-based campaign template, and only then offers the change. The
// campaign moves with all of them or not at all; the server stays
// authoritative and rechecks under lock.
import { useEffect, useState } from "react";

import { t } from "../i18n/index.js";
import { Button, Dialog, Panel } from "../ui/index.js";
import { VersionReportSummary, versionLabel } from "../characters/VersionReport.js";
import type { CampaignsApi } from "./api.js";
import type { CampaignVersionCheck, CampaignVersionOptionsResponse, CampaignView } from "./types.js";
import { randomUUID } from "../utils/uuid";
import styles from "../characters/characters.module.css";

type VersionApi = Required<Pick<CampaignsApi, "campaignVersionOptions" | "campaignVersionCheck" | "changeCampaignVersion">>;

function message(cause: unknown, fallback: string): string {
  return typeof cause === "object" && cause !== null && "message" in cause && typeof cause.message === "string" && cause.message !== ""
    ? cause.message
    : fallback;
}

export function CampaignVersionSection(props: {
  api: VersionApi;
  campaign: CampaignView;
  online: boolean;
  onChanged?: (() => void) | undefined;
}) {
  const { campaignId, revision, status } = props.campaign;
  const [options, setOptions] = useState<CampaignVersionOptionsResponse["options"] | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [check, setCheck] = useState<CampaignVersionCheck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!props.online) return;
    let active = true;
    props.api.campaignVersionOptions(campaignId).then(
      (response) => { if (active) setOptions(response.options); },
      (cause: unknown) => { if (active) setError(message(cause, t("version.loadFailed"))); },
    );
    return () => { active = false; };
    // The campaign revision changes after a version change; reload then.
  }, [props.api, campaignId, revision, props.online]);

  const choose = async (versionId: string) => {
    setTarget(versionId);
    setCheck(null);
    setError(null);
    setDone(false);
    setBusy(true);
    try {
      setCheck((await props.api.campaignVersionCheck(campaignId, versionId)).check);
    } catch (cause) {
      setError(message(cause, t("version.checkFailed")));
    } finally {
      setBusy(false);
    }
  };

  const change = async () => {
    if (target === null || check === null || !check.ok) return;
    setBusy(true);
    setError(null);
    try {
      await props.api.changeCampaignVersion(campaignId, {
        targetVersionId: target,
        expectedCampaignRevision: revision,
        idempotencyKey: randomUUID(),
      });
      setConfirming(false);
      setCheck(null);
      setTarget(null);
      setDone(true);
      props.onChanged?.();
    } catch (cause) {
      setConfirming(false);
      setError(message(cause, t("version.changeFailed")));
      props.onChanged?.();
    } finally {
      setBusy(false);
    }
  };

  const choices = options === null ? [] : [
    ...(options.revertTo === null ? [] : [{ choice: options.revertTo, revert: true }]),
    ...options.upgrades.map((choice) => ({ choice, revert: false })),
  ];
  const blockedTemplates = check?.templates.filter((template) => !template.ok) ?? [];
  const disabled = !props.online || status !== "active" || busy;

  return (
    <Panel title={t("version.title")}>
      {options === null ? null : <p>{t("version.current", { version: versionLabel(options.current) })}</p>}
      <p>{t("campaign.version.explain")}</p>
      {!props.online ? <p role="status">{t("campaign.version.offline")}</p> : null}
      {status !== "active" ? <p role="status">{t("campaign.version.archived")}</p> : null}
      {error !== null ? <p role="alert">{error}</p> : null}
      {done ? <p role="status">{t("campaign.version.done")}</p> : null}
      {options !== null && choices.length === 0 ? <p>{t("version.none")}</p> : null}
      {choices.length > 0 ? (
        <fieldset>
          <legend>{t("version.choose")}</legend>
          {choices.map(({ choice, revert }) => (
            <label key={choice.versionId} className={styles.versionChoice}>
              <input
                type="radio"
                name={`campaign-version-${campaignId}`}
                value={choice.versionId}
                checked={target === choice.versionId}
                disabled={disabled}
                onChange={() => void choose(choice.versionId)}
              />
              {t(revert ? "version.revertTo" : "version.upgradeTo", { version: versionLabel(choice) })}
              {choice.releaseNotes.length > 0 ? <span className={styles.versionNotes}>{choice.releaseNotes}</span> : null}
            </label>
          ))}
        </fieldset>
      ) : null}
      {check === null ? null : (
        <section aria-label={t("version.report.title")}>
          <p role="status">
            {t(check.ok ? "campaign.version.ready" : "campaign.version.blocked", {
              characters: check.characters.length,
              templates: check.templates.length,
            })}
          </p>
          {blockedTemplates.length > 0 ? (
            <ul aria-label={t("campaign.version.templates")}>
              {blockedTemplates.map((template) => (
                <li key={template.templateId}>
                  {template.name}: {template.blockers.map((blocker) => blocker.message).join(" ")}
                </li>
              ))}
            </ul>
          ) : null}
          {check.characters.map((character) => (
            <VersionReportSummary key={character.characterId} heading={character.name} report={character.report} />
          ))}
          <Button variant="primary" disabled={disabled || !check.ok} onClick={() => setConfirming(true)}>
            {t(check.direction === "revert" ? "version.confirmRevert" : "version.confirmUpgrade")}
          </Button>
        </section>
      )}
      <Dialog
        open={confirming}
        onOpenChange={(open) => { if (!open) setConfirming(false); }}
        title={t(check?.direction === "revert" ? "campaign.version.confirmRevertTitle" : "campaign.version.confirmUpgradeTitle")}
        description={t("campaign.version.confirmDescription", { characters: check?.characters.length ?? 0 })}
        actions={
          <Button variant="primary" pending={busy} disabled={disabled && !busy} onClick={() => void change()}>
            {t(check?.direction === "revert" ? "version.confirmRevert" : "version.confirmUpgrade")}
          </Button>
        }
      >
        <p>{props.campaign.title}</p>
      </Dialog>
    </Panel>
  );
}
