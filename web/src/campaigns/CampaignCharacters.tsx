// Characters tab body: ownership/editability indicators, claiming with
// caller-minted idempotency keys, and minimal campaign character creation.
// Task 3's minimal list moved here (enriched); CampaignDetail imports the
// tab from this module. Sheet opens reuse the shared character renderer
// through onOpenCharacter: this file never renders a character sheet.
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import type { CreationOptions } from "../characters/types.js";
import { t } from "../i18n/index.js";
import { Button, Dialog, EmptyState, FormField, Panel, Select } from "../ui/index.js";
import type { CampaignsApi } from "./api.js";
import {
  campaignCharactersKey,
  campaignClaimableCharactersKey,
  useClaimableCharacters,
} from "./campaignQueries.js";
import type { CampaignCharacterSummary, ClaimableCharacterSummary } from "./types.js";

/** Minimal creation-options metadata loader (reuses the characters seam). */
export type CampaignCharacterMetadataApi = {
  creationOptions(versionId: string): Promise<CreationOptions>;
};

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

export type CampaignCharactersViewProps = {
  api: Pick<CampaignsApi, "claimCharacter" | "createCampaignCharacter">;
  campaignId: string;
  campaignRevision: number;
  actorId?: string | null | undefined;
  characters: CampaignCharacterSummary[];
  characterRevisionById?: Record<string, number>;
  claimable: ClaimableCharacterSummary[];
  claimableStatus: "pending" | "error" | "success";
  claimableHasMore?: boolean;
  onLoadMoreClaimable?: () => void;
  onRetryClaimable?: () => void;
  online?: boolean;
  /** GMs may open every roster sheet; players only sheets they control. */
  isGm?: boolean;
  onOpenCharacter: (characterId: string) => void;
  /** Reload the list (and campaign revision) after a mutation outcome. */
  onChanged?: () => void;
  metadataApi?: CampaignCharacterMetadataApi | undefined;
};

function isControlled(character: CampaignCharacterSummary, actorId: string | null | undefined): boolean {
  return actorId !== undefined && actorId !== null && character.controllers.includes(actorId);
}

export function CampaignCharactersView(props: CampaignCharactersViewProps) {
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [claimingId, setClaimingId] = useState<string | null>(null);
  const [evictedIds, setEvictedIds] = useState<Record<string, boolean>>({});
  const [conflictIds, setConflictIds] = useState<Record<string, boolean>>({});
  const [claimedIds, setClaimedIds] = useState<Record<string, boolean>>({});
  const [claimErrors, setClaimErrors] = useState<Record<string, string | null>>({});
  const online = props.online ?? true;

  const [name, setName] = useState("");
  const [systemVersionId, setSystemVersionId] = useState("");
  const [entityDefinitionId, setEntityDefinitionId] = useState("");
  const [entityOptions, setEntityOptions] = useState<{ id: string; label: string }[] | null>(null);
  const [loadingOptions, setLoadingOptions] = useState(false);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [createPending, setCreatePending] = useState(false);
  const [createConflict, setCreateConflict] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const attemptClaim = async (character: ClaimableCharacterSummary): Promise<void> => {
    if (claimingId !== null || !online) return;
    setClaimingId(character.characterId);
    setClaimErrors((prev) => ({ ...prev, [character.characterId]: null }));
    // Caller-minted idempotency key, fresh on every attempt: a 409 re-reads
    // first and the retry mints a new key rather than reusing this one.
    const idempotencyKey = crypto.randomUUID();
    try {
      await props.api.claimCharacter(props.campaignId, character.characterId, {
        expectedCampaignRevision: props.campaignRevision,
        expectedCharacterRevision: character.revision,
        idempotencyKey,
      });
      setClaimedIds((prev) => ({ ...prev, [character.characterId]: true }));
      setConflictIds((prev) => ({ ...prev, [character.characterId]: false }));
      setConfirmingId(null);
      props.onChanged?.();
    } catch (cause) {
      if (isConflict(cause)) {
        // 409 → re-read first, then offer a retry with a fresh key. Never "Merge".
        setConflictIds((prev) => ({ ...prev, [character.characterId]: true }));
        setConfirmingId(null);
        props.onChanged?.();
      } else if (isNotFound(cause)) {
        // 404 means the designation is gone: evict the discovery row
        // without relabelling it view-only, then reload fresh.
        setEvictedIds((prev) => ({ ...prev, [character.characterId]: true }));
        setConfirmingId(null);
        props.onChanged?.();
      } else {
        setClaimErrors((prev) => ({
          ...prev,
          [character.characterId]: describeError(cause, t("campaign.detail.characters.claim.error")),
        }));
      }
    } finally {
      setClaimingId(null);
    }
  };

  const loadEntityOptions = async (): Promise<void> => {
    if (props.metadataApi === undefined || systemVersionId.trim() === "" || loadingOptions) return;
    setLoadingOptions(true);
    setOptionsError(null);
    try {
      const options = await props.metadataApi.creationOptions(systemVersionId.trim());
      setEntityOptions(options.data.entities);
    } catch (cause) {
      setOptionsError(describeError(cause, t("campaign.detail.characters.create.error")));
    } finally {
      setLoadingOptions(false);
    }
  };

  const submitCreate = async (): Promise<void> => {
    const trimmedName = name.trim();
    const trimmedEntity = entityDefinitionId.trim();
    if (createPending || trimmedName === "" || trimmedEntity === "") return;
    setCreatePending(true);
    setCreateError(null);
    setCreateConflict(false);
    // Caller-minted idempotency key, fresh on every attempt.
    const idempotencyKey = crypto.randomUUID();
    try {
      const response = await props.api.createCampaignCharacter(props.campaignId, {
        name: trimmedName,
        entityDefinitionId: trimmedEntity,
        expectedCampaignRevision: props.campaignRevision,
        idempotencyKey,
      });
      setName("");
      props.onChanged?.();
      props.onOpenCharacter(response.character.characterId);
    } catch (cause) {
      if (isConflict(cause)) {
        // 409 → re-read first, then offer a retry with a fresh key. Never "Merge".
        setCreateConflict(true);
        props.onChanged?.();
      } else {
        setCreateError(describeError(cause, t("campaign.detail.characters.create.error")));
      }
    } finally {
      setCreatePending(false);
    }
  };

  const visibleClaimable = props.claimable.filter((row) => evictedIds[row.characterId] !== true);
  const confirming = visibleClaimable.find((row) => row.characterId === confirmingId) ?? null;

  const claimSection = (
    <section aria-label={t("campaign.detail.characters.claimDiscovery.title")}>
      <h3>{t("campaign.detail.characters.claimDiscovery.title")}</h3>
      <p>{t("campaign.detail.characters.claimDiscovery.description")}</p>
      {!online ? <p role="status">{t("campaign.detail.characters.claimDiscovery.offline")}</p> : null}
      {props.claimableStatus === "pending" ? (
        <p role="status">{t("campaign.detail.characters.claimDiscovery.loading")}</p>
      ) : null}
      {props.claimableStatus === "error" ? (
        <EmptyState
          title={t("campaign.detail.characters.claimDiscovery.loadFailed")}
          action={
            <Button variant="primary" onClick={() => props.onRetryClaimable?.()}>
              {t("campaign.detail.retry")}
            </Button>
          }
        />
      ) : null}
      {props.claimableStatus === "success" && visibleClaimable.length === 0 ? (
        <p role="status">{t("campaign.detail.characters.claimDiscovery.empty")}</p>
      ) : null}
      {props.claimableStatus === "success" && visibleClaimable.length > 0 ? (
        <ul aria-label={t("campaign.detail.characters.claimDiscovery.title")}>
          {visibleClaimable.map((row) => (
            <li key={row.characterId}>
              <span>{row.name}</span> <span>{row.lifecycle}</span>{" "}
              {row.lifecycle === "archived" ? (
                <span>{t("campaign.detail.characters.claimDiscovery.archived", { name: row.name })}</span>
              ) : claimedIds[row.characterId] === true ? (
                <span role="status">{t("campaign.detail.characters.claim.claimed", { name: row.name })}</span>
              ) : (
                <Button
                  variant="primary"
                  disabled={!online || claimingId !== null}
                  onClick={() => setConfirmingId(row.characterId)}
                >
                  {t("campaign.detail.characters.claim.button", { name: row.name })}
                </Button>
              )}
              {conflictIds[row.characterId] === true ? (
                <p role="alert">
                  {t("campaign.detail.characters.claim.conflict", { name: row.name })}
                  <Button
                    variant="secondary"
                    disabled={!online}
                    onClick={() => setConfirmingId(row.characterId)}
                  >
                    {t("campaign.detail.characters.claim.conflict.retry", { name: row.name })}
                  </Button>
                </p>
              ) : null}
              {claimErrors[row.characterId] ? <p role="alert">{claimErrors[row.characterId]}</p> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {props.claimableHasMore === true ? (
        <Button variant="secondary" disabled={!online} onClick={() => props.onLoadMoreClaimable?.()}>
          {t("campaign.detail.characters.claimDiscovery.more")}
        </Button>
      ) : null}
    </section>
  );

  return (
    <div>
      {claimSection}
      {props.characters.length === 0 ? (
        <EmptyState
          title={t("campaign.detail.characters.empty.title")}
          description={t("campaign.detail.characters.empty.description")}
        />
      ) : (
        <ul aria-label={t("campaign.detail.characters.listAriaLabel")}>
          {props.characters.map((character) => {
            const controlled = isControlled(character, props.actorId);
            const openable = controlled || props.isGm === true;
            const indicator = controlled
              ? t("campaign.detail.characters.indicator.controlled")
              : t("campaign.detail.characters.indicator.viewOnly");
            return (
              <li key={character.characterId}>
                <span>{character.name}</span>{" "}
                <span>{t("campaign.detail.characters.controllers", { count: character.controllers.length })}</span>{" "}
                <span>{character.lifecycle}</span>{" "}
                <span>{indicator}</span>{" "}
                {openable ? (
                  <Button variant="secondary" onClick={() => props.onOpenCharacter(character.characterId)}>
                    {t("campaign.detail.characters.open", { name: character.name })}
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <Dialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmingId(null);
        }}
        title={confirming === null ? "" : t("campaign.detail.characters.claim.confirm.title", { name: confirming.name })}
        description={
          confirming === null
            ? undefined
            : t("campaign.detail.characters.claim.confirm.description", { name: confirming.name })
        }
        actions={
          confirming === null ? undefined : (
            <Button
              variant="primary"
              pending={claimingId === confirming.characterId}
              pendingText={t("campaign.detail.characters.claim.claiming")}
              disabled={!online}
              onClick={() => void attemptClaim(confirming)}
            >
              {t("campaign.detail.characters.claim.confirm.confirm")}
            </Button>
          )
        }
      >
        <Panel title={confirming?.name ?? ""}>
          <p>{t("campaign.detail.characters.claimDiscovery.description")}</p>
        </Panel>
      </Dialog>
      <Panel title={t("campaign.detail.characters.create.title")}>
        <FormField label={t("campaign.detail.characters.create.name.label")}>
          <input type="text" value={name} onChange={(event) => setName(event.target.value)} />
        </FormField>
        {props.metadataApi !== undefined ? (
          <FormField
            label={t("campaign.detail.characters.create.version.label")}
            hint={t("campaign.detail.characters.create.version.hint")}
            error={optionsError}
          >
            <input
              type="text"
              value={systemVersionId}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setSystemVersionId(event.target.value)}
            />
          </FormField>
        ) : null}
        {props.metadataApi !== undefined ? (
          <Button
            variant="secondary"
            pending={loadingOptions}
            pendingText={t("campaign.detail.characters.create.version.loading")}
            disabled={systemVersionId.trim() === ""}
            onClick={() => void loadEntityOptions()}
          >
            {t("campaign.detail.characters.create.version.load")}
          </Button>
        ) : null}
        {entityOptions !== null ? (
          <Select
            label={t("campaign.detail.characters.create.entity.label")}
            options={entityOptions.map((entity) => ({ value: entity.id, label: entity.label }))}
            placeholder={t("campaign.detail.characters.create.entity.label")}
            value={entityDefinitionId}
            onChange={(event) => setEntityDefinitionId(event.target.value)}
          />
        ) : (
          <FormField label={t("campaign.detail.characters.create.entity.label")}>
            <input
              type="text"
              value={entityDefinitionId}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setEntityDefinitionId(event.target.value)}
            />
          </FormField>
        )}
        {createConflict ? <p role="alert">{t("campaign.detail.characters.create.conflict")}</p> : null}
        {createError !== null ? <p role="alert">{createError}</p> : null}
        <Button
          variant="primary"
          pending={createPending}
          pendingText={t("campaign.detail.characters.create.creating")}
          disabled={name.trim() === "" || entityDefinitionId.trim() === ""}
          onClick={() => void submitCreate()}
        >
          {t("campaign.detail.characters.create.submit")}
        </Button>
      </Panel>
    </div>
  );
}

export function CampaignCharactersTab(props: {
  api: CampaignsApi;
  campaignId: string;
  actorId?: string | null;
  campaignRevision: number;
  generation?: number;
  online?: boolean;
  isGm?: boolean;
  onOpenCharacter: (characterId: string) => void;
  /** Re-read the campaign so claim/create retries use a fresh revision. */
  onCampaignStale?: () => void;
  metadataApi?: CampaignCharacterMetadataApi | undefined;
}) {
  const queryClient = useQueryClient();
  const generation = props.generation ?? 0;
  const online = props.online ?? true;
  const characters = useQuery({
    queryKey: campaignCharactersKey(props.campaignId, props.actorId ?? null, generation),
    queryFn: () => props.api.listCampaignCharacters(props.campaignId),
    enabled: props.actorId !== null && props.actorId !== undefined,
  });
  const claimable = useClaimableCharacters(
    props.api,
    props.campaignId,
    props.actorId ?? null,
    generation,
    { enabled: props.actorId !== null && props.actorId !== undefined, online },
  );

  if (characters.status === "pending") {
    return <p role="status">{t("campaign.detail.characters.loading")}</p>;
  }

  if (characters.status === "error") {
    return (
      <EmptyState
        title={t("campaign.detail.characters.loadFailed")}
        action={
          <Button variant="primary" onClick={() => void characters.refetch()}>
            {t("campaign.detail.retry")}
          </Button>
        }
      />
    );
  }

  const rows: CampaignCharacterSummary[] = characters.data.characters;
  const claimRows: ClaimableCharacterSummary[] =
    claimable.data?.pages.flatMap((page) => page.characters) ?? [];
  const refresh = (): void => {
    void queryClient.invalidateQueries({
      queryKey: campaignCharactersKey(props.campaignId, props.actorId ?? null, generation),
    });
    void queryClient.invalidateQueries({
      queryKey: campaignClaimableCharactersKey(props.campaignId, props.actorId ?? null, generation),
    });
    props.onCampaignStale?.();
  };
  return (
    <CampaignCharactersView
      api={props.api}
      campaignId={props.campaignId}
      campaignRevision={props.campaignRevision}
      actorId={props.actorId}
      characters={rows}
      characterRevisionById={Object.fromEntries(rows.map((row) => [row.characterId, row.revision]))}
      claimable={claimRows}
      claimableStatus={claimable.status}
      claimableHasMore={claimable.hasNextPage}
      onLoadMoreClaimable={() => void claimable.fetchNextPage()}
      onRetryClaimable={() => void claimable.refetch()}
      online={online}
      isGm={props.isGm ?? false}
      onOpenCharacter={props.onOpenCharacter}
      onChanged={refresh}
      metadataApi={props.metadataApi}
    />
  );
}
