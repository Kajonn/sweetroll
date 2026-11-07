import type { PoolClient } from "pg";

import {
  checkTemplateBaseChange,
  checkVersionChange,
  type PublishedPackageLoader,
  type VersionChangeDirection,
  type VersionChangeReport,
} from "../systems/templates.js";
import type { VersionChangeBlocker } from "../systems/implementation/runtime/version-change.js";
import type { RuntimeStateV1 } from "../systems/runtime.js";
import type { CampaignTemplateView, TemplateContent } from "./templates.js";
import type { createTemplateRepository } from "./templatePersistence.js";
import { repinEntryImages } from "../characters/persistence.js";

/**
 * Design 6.7 campaign path (plan stage 3). A campaign, its attached characters
 * and its system-based templates share one rules version and move together:
 * one blocker anywhere blocks the whole change. The plan is computed inside
 * the caller's transaction from rows it locks, so the commit writes exactly
 * what was verified.
 */
export type CampaignCharacterVersionCheck = {
  characterId: string;
  name: string;
  ok: boolean;
  report: Omit<VersionChangeReport, "nextState">;
};

export type CampaignTemplateVersionCheck = {
  templateId: string;
  name: string;
  ok: boolean;
  blockers: VersionChangeBlocker[];
};

export type CampaignVersionCheck = {
  revision: number;
  direction: VersionChangeDirection;
  fromVersionId: string;
  toVersionId: string;
  ok: boolean;
  characters: CampaignCharacterVersionCheck[];
  templates: CampaignTemplateVersionCheck[];
};

export type CampaignVersionPlan = {
  check: CampaignVersionCheck;
  characters: Array<{ characterId: string; nextState: RuntimeStateV1; report: VersionChangeReport }>;
  templates: Array<{ view: CampaignTemplateView; content: TemplateContent }>;
};

type AttachedRow = {
  id: string;
  name: string;
  system_version_id: string;
  entity_definition_id: string;
  state_json: unknown;
};

export async function loadPreviousCampaignVersion(client: PoolClient, campaignId: string): Promise<string | null> {
  const result = await client.query<{ previous_system_version_id: string | null }>(
    `SELECT previous_system_version_id FROM campaigns WHERE id = $1`,
    [campaignId],
  );
  return result.rows[0]?.previous_system_version_id ?? null;
}

export async function planCampaignVersionChange(
  client: PoolClient,
  input: {
    campaign: { campaignId: string; systemVersionId: string; revision: number };
    targetVersionId: string;
    direction: VersionChangeDirection;
    loadPackage: PublishedPackageLoader;
    catalog: ReturnType<typeof createTemplateRepository>;
    /** Lock attached characters and templates (campaign row already locked by the caller). */
    lock: boolean;
  },
): Promise<CampaignVersionPlan | null> {
  const { campaign, targetVersionId, direction } = input;
  const from = await input.loadPackage(campaign.systemVersionId, client);
  const to = await input.loadPackage(targetVersionId, client);
  if (from === null || to === null || from.systemId !== to.systemId) return null;
  const forUpdate = input.lock ? " FOR UPDATE" : "";

  const characters: CampaignVersionPlan["characters"] = [];
  const characterChecks: CampaignCharacterVersionCheck[] = [];
  const attached = await client.query<AttachedRow>(
    `SELECT id, name, system_version_id, entity_definition_id, state_json
       FROM characters WHERE campaign_id = $1 ORDER BY id${forUpdate}`,
    [campaign.campaignId],
  );
  for (const row of attached.rows) {
    const report = row.system_version_id === campaign.systemVersionId
      ? checkVersionChange({ from, to, entityId: row.entity_definition_id, state: row.state_json, direction })
      : mismatchedPin(campaign.systemVersionId, targetVersionId, direction);
    const { nextState, ...summary } = report;
    characterChecks.push({ characterId: row.id, name: row.name, ok: report.ok, report: summary });
    if (report.ok && nextState !== null) characters.push({ characterId: row.id, nextState, report });
  }

  const templates: CampaignVersionPlan["templates"] = [];
  const templateChecks: CampaignTemplateVersionCheck[] = [];
  const templateIds = await client.query<{ id: string }>(
    `SELECT id FROM campaign_item_templates WHERE campaign_id = $1 ORDER BY id${forUpdate}`,
    [campaign.campaignId],
  );
  for (const { id } of templateIds.rows) {
    const view = await input.catalog.read(client, { campaignId: campaign.campaignId, templateId: id });
    const base = view?.content.base;
    if (view === null || base === undefined) continue;
    const pinned = base.versionId === campaign.systemVersionId;
    const change = pinned
      ? checkTemplateBaseChange({ from, to, kind: view.kind, base, defaultValues: view.content.defaultValues ?? {}, direction })
      : {
          ok: false,
          blockers: [{ code: "current_state_invalid" as const, message: "The template base is not pinned to the campaign version." }],
          next: null,
        };
    templateChecks.push({ templateId: id, name: view.content.name, ok: change.ok, blockers: change.blockers });
    if (change.next !== null) {
      templates.push({ view, content: { ...view.content, base: change.next.base, defaultValues: change.next.defaultValues } });
    }
  }

  return {
    check: {
      revision: campaign.revision,
      direction,
      fromVersionId: campaign.systemVersionId,
      toVersionId: targetVersionId,
      ok: characterChecks.every((c) => c.ok) && templateChecks.every((t) => t.ok),
      characters: characterChecks,
      templates: templateChecks,
    },
    characters,
    templates,
  };
}

/** Writes a verified plan; the caller holds the campaign lock and rechecked its revision. */
export async function applyCampaignVersionPlan(
  client: PoolClient,
  input: {
    plan: CampaignVersionPlan;
    campaignId: string;
    actorId: string;
    requestId: string;
    catalog: ReturnType<typeof createTemplateRepository>;
  },
): Promise<void> {
  const { plan } = input;
  const { direction, fromVersionId, toVersionId } = plan.check;
  const previous = direction === "upgrade" ? fromVersionId : null;
  const kind = direction === "upgrade" ? "system_version_upgraded" : "system_version_reverted";
  for (const character of plan.characters) {
    const updated = await client.query<{ revision: number }>(
      `UPDATE characters
          SET system_version_id = $2, previous_system_version_id = $3, state_json = $4::jsonb,
              revision = revision + 1, updated_at = now()
        WHERE id = $1 AND campaign_id = $5 AND system_version_id = $6
        RETURNING revision`,
      [character.characterId, toVersionId, previous, JSON.stringify(character.nextState), input.campaignId, fromVersionId],
    );
    const revision = updated.rows[0]?.revision;
    if (revision === undefined) throw new Error("applyCampaignVersionPlan: character changed under lock");
    await repinEntryImages(
      client,
      character.characterId,
      character.nextState.entries ?? {},
      character.report.changedEntries.filter((entry) => entry.imageUpdated).map((entry) => entry.entryId),
    );
    await client.query(
      `INSERT INTO character_activity_events (character_id, character_revision, kind, payload_json, request_id, scope_campaign_id)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
      [
        character.characterId,
        revision,
        kind,
        JSON.stringify({
          fromVersionId,
          toVersionId,
          direction,
          updatedEntries: character.report.changedEntries.length,
          addedFields: character.report.addedFields,
          droppedFields: character.report.droppedFields,
        }),
        input.requestId,
        input.campaignId,
      ],
    );
    await client.query(
      `INSERT INTO character_audit_records (character_id, actor_id, kind, summary, request_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [character.characterId, input.actorId, kind, "System version changed with its campaign", input.requestId],
    );
  }
  for (const template of plan.templates) {
    await input.catalog.update(client, template.view, template.content, input.actorId);
  }
}

function mismatchedPin(fromVersionId: string, toVersionId: string, direction: VersionChangeDirection): VersionChangeReport {
  return {
    ok: false,
    direction,
    fromVersionId,
    toVersionId,
    packageFindings: [],
    blockers: [{ code: "current_state_invalid", message: "The character is not pinned to the campaign version." }],
    addedFields: [],
    droppedFields: [],
    changedEntries: [],
    validations: [],
    nextState: null,
  };
}
