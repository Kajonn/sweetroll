// Campaign upgrade dialog: target selection, upgrade preview, explicit
// confirmation gate, and guarded commit dispatch. Mounted by the campaign
// detail upgrade entry point (Task 6); this module owns the whole flow and
// reports the committed result through onCommitted.
import { useState } from "react";
import type { ReactNode } from "react";

import type { CharactersApi } from "../characters/api.js";
import { flattenCatalogPages, useVersionCatalog } from "../characters/versionCatalog.js";
import { t } from "../i18n/index.js";
import { Button, Checkbox, Dialog, EmptyState, FormField, Panel } from "../ui/index.js";
import type { CampaignsApi } from "./api.js";
import { useUpgradePreview } from "./campaignQueries.js";
import type { CommitUpgradeResponse } from "./types.js";
import { randomUUID } from "../utils/uuid";

export type UpgradeDialogProps = {
  api: Pick<CampaignsApi, "previewUpgrade" | "commitUpgrade">;
  versionsApi: Pick<CharactersApi, "listCreationVersions">;
  campaignId: string;
  actorId: string | null;
  generation: number;
  /** Initial target version ID, or null when the GM has not picked one yet. */
  target: string | null;
  /** Owning system: the catalog picker only lists newer versions of this system. */
  systemId: string;
  /** Current pin display (the "before" half of the before/after pin). */
  sourceSemanticVersion: string;
  online: boolean;
  onClose: () => void;
  onCommitted: (result: CommitUpgradeResponse) => void;
};

type CommitPhase = "ready" | "committing" | "conflict" | "terminal" | "unavailable" | "committed";

const VERSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseSemver(value: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Strictly-greater numeric semver compare; unparseable inputs never qualify. */
export function isGreaterSemanticVersion(candidate: string, baseline: string): boolean {
  const parsedCandidate = parseSemver(candidate);
  const parsedBaseline = parseSemver(baseline);
  if (parsedCandidate === null || parsedBaseline === null) return false;
  for (let index = 0; index < 3; index += 1) {
    if (parsedCandidate[index] !== parsedBaseline[index]) {
      return parsedCandidate[index]! > parsedBaseline[index]!;
    }
  }
  return false;
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

function serverMessage(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const record = error as { message?: unknown };
  if (typeof record.message === "string" && record.message !== "") return record.message;
  return null;
}

function describeError(cause: unknown, fallback: string): string {
  return serverMessage(cause) ?? fallback;
}

export function UpgradeDialog(props: UpgradeDialogProps) {
  const [selectedTarget, setSelectedTarget] = useState<string | null>(props.target);
  const [exactId, setExactId] = useState("");
  const [exactError, setExactError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [phase, setPhase] = useState<CommitPhase>("ready");
  const [terminalMessage, setTerminalMessage] = useState<string | null>(null);
  const [commitError, setCommitError] = useState<string | null>(null);

  const catalog = useVersionCatalog(props.versionsApi as CharactersApi, props.actorId, props.generation, {
    enabled: true,
    online: props.online,
  });
  const preview = useUpgradePreview(props.api as CampaignsApi, props.campaignId, props.actorId, props.generation, selectedTarget, {
    enabled: true,
    online: props.online,
  });

  const selectTarget = (versionId: string): void => {
    setSelectedTarget(versionId);
    setConfirmed(false);
    setPhase("ready");
    setCommitError(null);
  };

  const applyExactId = (): void => {
    const trimmed = exactId.trim();
    if (!VERSION_ID_PATTERN.test(trimmed)) {
      // Definite input error (G1 pattern): no request leaves the dialog.
      setExactError(t("campaign.detail.upgrade.target.exactInvalid"));
      return;
    }
    setExactError(null);
    selectTarget(trimmed);
  };

  const commit = async (): Promise<void> => {
    const current = preview.data;
    if (!props.online || phase === "committing" || !confirmed || current === null || current === undefined) return;
    setPhase("committing");
    setCommitError(null);
    // Caller-minted idempotency key, fresh on every attempt: a 409 refetches
    // the preview first and the retry mints a new key rather than reusing
    // this one or guessing revision + 1.
    const idempotencyKey = randomUUID();
    try {
      const result = await props.api.commitUpgrade(props.campaignId, {
        targetVersionId: current.targetVersionId,
        expectedCampaignRevision: current.campaignRevision,
        idempotencyKey,
      });
      setPhase("committed");
      props.onCommitted(result);
    } catch (cause) {
      if (isNotFound(cause)) {
        // Server-driven unavailability: the campaign (or target) is gone.
        setPhase("unavailable");
      } else if (isConflict(cause) && (serverMessage(cause) ?? "").match(/archiv/i) !== null) {
        // Terminal: an archived campaign cannot accept upgrades — explain
        // and offer no retry. The text is the server's, never decided here.
        setTerminalMessage(serverMessage(cause) ?? t("campaign.detail.upgrade.commit.terminal"));
        setPhase("terminal");
      } else if (isConflict(cause)) {
        // Retryable revision race: re-read the preview first (fresh
        // campaignRevision), renew the confirmation gate, and let the next
        // attempt mint its own key.
        setConfirmed(false);
        setPhase("conflict");
        await preview.refetch();
      } else {
        setPhase("ready");
        setCommitError(describeError(cause, t("campaign.detail.upgrade.commit.error")));
      }
    }
  };

  const dialogShell = (body: ReactNode): ReactNode => (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
      title={t("campaign.detail.upgrade.title")}
      description={t("campaign.detail.upgrade.description")}
      closeLabel={t("campaign.detail.upgrade.close")}
    >
      {body}
    </Dialog>
  );

  if (phase === "unavailable") {
    return dialogShell(<p role="status">{t("campaign.detail.upgrade.unavailable")}</p>);
  }
  if (phase === "terminal") {
    return dialogShell(<p role="alert">{terminalMessage}</p>);
  }
  if (phase === "committed") {
    return dialogShell(
      <p role="status">
        {t("campaign.detail.upgrade.success", {
          version: preview.data?.targetSemanticVersion ?? "",
        })}
      </p>,
    );
  }

  const candidates = flattenCatalogPages(catalog.data).filter(
    (entry) => entry.systemId === props.systemId && isGreaterSemanticVersion(entry.semanticVersion, props.sourceSemanticVersion),
  );
  const previewData = preview.data ?? null;
  const canCommit =
    props.online && confirmed && previewData !== null && (phase === "ready" || phase === "conflict");

  return dialogShell(
    <div>
      {!props.online ? <p role="status">{t("campaign.detail.upgrade.commit.offline")}</p> : null}
      <Panel title={t("campaign.detail.upgrade.target.label")}>
        {props.online && catalog.status === "pending" ? (
          <p role="status">{t("campaign.detail.upgrade.target.loading")}</p>
        ) : null}
        {props.online && catalog.status === "error" ? (
          <EmptyState
            title={t("campaign.detail.upgrade.target.loadFailed")}
            action={
              <Button variant="primary" onClick={() => void catalog.refetch()}>
                {t("campaign.detail.upgrade.target.retry")}
              </Button>
            }
          />
        ) : null}
        {props.online && catalog.status === "success" && candidates.length === 0 ? (
          <p role="status">{t("campaign.detail.upgrade.target.empty")}</p>
        ) : null}
        {props.online && catalog.status === "success" && candidates.length > 0 ? (
          <ul>
            {candidates.map((entry) => (
              <li key={entry.versionId}>
                <Button
                  variant="secondary"
                  aria-pressed={selectedTarget === entry.versionId}
                  onClick={() => selectTarget(entry.versionId)}
                >
                  {`${entry.systemName} ${entry.semanticVersion}`}
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        <FormField
          label={t("campaign.detail.upgrade.target.exactLabel")}
          hint={t("campaign.detail.upgrade.target.exactHint")}
          error={exactError}
        >
          <input
            type="text"
            value={exactId}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setExactId(event.target.value)}
          />
        </FormField>
        <Button variant="secondary" disabled={exactId.trim() === ""} onClick={applyExactId}>
          {t("campaign.detail.upgrade.target.exactApply")}
        </Button>
      </Panel>
      {selectedTarget === null ? <p role="status">{t("campaign.detail.upgrade.target.none")}</p> : null}
      {selectedTarget !== null && preview.status === "pending" ? (
        <p role="status">{t("campaign.detail.upgrade.preview.loading")}</p>
      ) : null}
      {selectedTarget !== null && preview.status === "error" ? (
        <EmptyState
          title={t("campaign.detail.upgrade.preview.error")}
          action={
            <Button variant="primary" onClick={() => void preview.refetch()}>
              {t("campaign.detail.upgrade.preview.retry")}
            </Button>
          }
        />
      ) : null}
      {previewData !== null ? (
        <Panel title={t("campaign.detail.upgrade.preview.characters")}>
          <p>
            {t("campaign.detail.upgrade.preview.pin", {
              source: props.sourceSemanticVersion,
              target: previewData.targetSemanticVersion,
            })}
          </p>
          {previewData.characters.length === 0 ? (
            <p role="status">{t("campaign.detail.upgrade.preview.charactersEmpty")}</p>
          ) : (
            <ul>
              {previewData.characters.map((entry) => (
                <li key={entry.characterId}>
                  <span>{entry.name}</span>{" "}
                  {entry.requiresMapping ? (
                    <span>{t("campaign.detail.upgrade.preview.requiresMapping")}</span>
                  ) : null}{" "}
                  {entry.warnings.length > 0 ? (
                    <ul>
                      {entry.warnings.map((warning) => (
                        <li key={warning}>{warning}</li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      ) : null}
      {previewData !== null ? (
        <Checkbox
          label={t("campaign.detail.upgrade.confirm.label")}
          checked={confirmed}
          disabled={!props.online || phase === "committing"}
          onChange={(event) => setConfirmed(event.target.checked)}
        />
      ) : null}
      {phase === "conflict" ? <p role="alert">{t("campaign.detail.upgrade.commit.conflict")}</p> : null}
      {commitError !== null ? <p role="alert">{commitError}</p> : null}
      {previewData !== null ? (
        <Button
          variant="primary"
          pending={phase === "committing"}
          pendingText={t("campaign.detail.upgrade.commit.committing")}
          disabled={!canCommit}
          onClick={() => void commit()}
        >
          {t("campaign.detail.upgrade.commit.button")}
        </Button>
      ) : null}
    </div>,
  );
}
