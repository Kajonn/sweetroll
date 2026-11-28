import type { PoolClient } from "pg";

import {
  checkTemplateBaseChange,
  checkVersionChange,
  type PublishedPackageLoader,
  type VersionChangeDirection,
  type VersionChangeReport,
} from "../systems/templates.js";
import type { VersionChangeBlocker } from "../systems/implementation/runtime/version-change.js";
import type { EffectivePackageLoader } from "../systems/implementation/runtime/composition-loader.js";
import { canonicalComposition, sameComposition, type Composition, type ExtensionRef, type RuntimeStateV1 } from "../systems/runtime.js";
import { compositionActivityKind, type CompositionChange } from "../systems/composition-change.js";
import type { CampaignTemplateView, TemplateContent } from "./templates.js";
import type { createTemplateRepository } from "./templatePersistence.js";
import { CHARACTER_EXTENSIONS_COLUMN, repinEntryImages, sortExtensionRefs, writeCharacterExtensions } from "../characters/persistence.js";
import { extensionUsage, loadCampaignExtensions } from "../characters/campaign-extensions.js";

/**
 * Design 6.7/6.8 campaign path (version plan stage 3, extensions plan E5). A
 * campaign, its attached characters and its system-based templates share one
 * composition and move together: one blocker anywhere blocks the whole
 * change. The plan is computed inside the caller's transaction from rows it
 * locks, so the commit writes exactly what was verified.
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
  change: CompositionChange;
  fromVersionId: string;
  toVersionId: string;
  from: Composition;
  to: Composition;
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
  extensions_json: ExtensionRef[];
};

type AddedBy = "campaign" | "character";

/** The campaign's current composition; `addedBy` keeps each extension's origin (X7). */
export async function loadCampaignComposition(
  client: PoolClient,
  campaign: { campaignId: string; systemVersionId: string },
): Promise<{ composition: Composition; addedBy: Map<string, AddedBy> }> {
  const extensions = await loadCampaignExtensions(client, campaign.campaignId);
  return {
    composition: canonicalComposition({ systemVersionId: campaign.systemVersionId, extensions }),
    addedBy: new Map(extensions.map((extension) => [extension.extensionId, extension.addedBy])),
  };
}

/** Design 6.7/6.8: the composition recorded before the campaign's most recent change. */
export async function loadPreviousCampaignComposition(
  client: PoolClient,
  campaignId: string,
): Promise<{ composition: Composition; addedBy: Map<string, AddedBy> } | null> {
  const result = await client.query<{ previous_system_version_id: string | null }>(
    `SELECT previous_system_version_id FROM campaigns WHERE id = $1`,
    [campaignId],
  );
  const previous = result.rows[0]?.previous_system_version_id ?? null;
  if (previous === null) return null;
  const extensions = await client.query<{ extension_id: string; extension_version_id: string; added_by: AddedBy }>(
    `SELECT extension_id, extension_version_id, added_by FROM campaign_previous_extensions
      WHERE campaign_id = $1 ORDER BY extension_id`,
    [campaignId],
  );
  return {
    composition: canonicalComposition({
      systemVersionId: previous,
      extensions: extensions.rows.map((row) => ({ extensionId: row.extension_id, versionId: row.extension_version_id })),
    }),
    addedBy: new Map(extensions.rows.map((row) => [row.extension_id, row.added_by])),
  };
}

/**
 * Records `current` as the campaign's revert target. Every composition
 * change calls this, including the E4 add and remove extension commands, so
 * a revert always undoes the most recent change.
 */
export async function recordPreviousCampaignComposition(
  client: PoolClient,
  campaignId: string,
  current: { composition: Composition; addedBy: Map<string, AddedBy> } | null,
): Promise<void> {
  await client.query("DELETE FROM campaign_previous_extensions WHERE campaign_id = $1", [campaignId]);
  await client.query("UPDATE campaigns SET previous_system_version_id = $2 WHERE id = $1", [
    campaignId,
    current?.composition.systemVersionId ?? null,
  ]);
  for (const ref of current?.composition.extensions ?? []) {
    await client.query(
      `INSERT INTO campaign_previous_extensions (campaign_id, extension_id, extension_version_id, added_by)
       VALUES ($1, $2, $3, $4)`,
      [campaignId, ref.extensionId, ref.versionId, current!.addedBy.get(ref.extensionId) ?? "campaign"],
    );
  }
}

export async function planCampaignVersionChange(
  client: PoolClient,
  input: {
    campaign: { campaignId: string; systemVersionId: string; revision: number };
    current: Composition;
    target: Composition;
    change: CompositionChange;
    direction: VersionChangeDirection;
    loadPackage: PublishedPackageLoader;
    loadEffective: EffectivePackageLoader;
    catalog: ReturnType<typeof createTemplateRepository>;
    /** Lock attached characters and templates (campaign row already locked by the caller). */
    lock: boolean;
  },
): Promise<CampaignVersionPlan | { problem: string } | null> {
  const { campaign, current, target, change, direction } = input;
  const fromEffective = await input.loadEffective(current.systemVersionId, current.extensions, client);
  if (!fromEffective.ok) return null;
  // A target that does not fit (an extension built for another system, or
  // that no longer validates against the base) is reported, not an error.
  const toEffective = await input.loadEffective(target.systemVersionId, target.extensions, client);
  if (!toEffective.ok) return toEffective.error.code === "internal" ? null : { problem: toEffective.error.message };
  const from = fromEffective.value;
  const to = toEffective.value;
  if (from.systemId !== to.systemId) return { problem: "The target rules belong to a different system." };
  const forUpdate = input.lock ? " FOR UPDATE" : "";

  const characters: CampaignVersionPlan["characters"] = [];
  const characterChecks: CampaignCharacterVersionCheck[] = [];
  const attached = await client.query<AttachedRow>(
    `SELECT id, name, system_version_id, entity_definition_id, state_json, ${CHARACTER_EXTENSIONS_COLUMN}
       FROM characters WHERE campaign_id = $1 ORDER BY id${forUpdate}`,
    [campaign.campaignId],
  );
  for (const row of attached.rows) {
    const pinned = sameComposition({ systemVersionId: row.system_version_id, extensions: row.extensions_json }, current);
    const report = pinned
      ? checkVersionChange({ from, to, entityId: row.entity_definition_id, state: row.state_json, direction, sameComposition: false })
      : mismatchedPin(campaign.systemVersionId, target.systemVersionId, direction);
    const { nextState, ...summary } = report;
    characterChecks.push({ characterId: row.id, name: row.name, ok: report.ok, report: summary });
    if (report.ok && nextState !== null) characters.push({ characterId: row.id, nextState, report });
  }

  const templates: CampaignVersionPlan["templates"] = [];
  const templateChecks: CampaignTemplateVersionCheck[] = [];
  // X9: campaign templates based on a removed extension block the change.
  const removed = current.extensions.filter((ref) => !target.extensions.some((other) => other.extensionId === ref.extensionId));
  for (const ref of removed) {
    const usage = await extensionUsage(client, campaign.campaignId, ref.extensionId);
    for (const templateId of usage.templateIds) {
      templateChecks.push({
        templateId,
        name: templateId,
        ok: false,
        blockers: [{ code: "entry_template_missing", message: "The template is based on an extension the target rules do not include." }],
      });
    }
  }
  // Base templates follow the base version only; extension changes leave them alone.
  const baseFrom = current.systemVersionId === target.systemVersionId ? null : await input.loadPackage(current.systemVersionId, client);
  const baseTo = current.systemVersionId === target.systemVersionId ? null : await input.loadPackage(target.systemVersionId, client);
  const templateIds = baseFrom === null || baseTo === null
    ? { rows: [] as Array<{ id: string }> }
    : await client.query<{ id: string }>(
      `SELECT id FROM campaign_item_templates WHERE campaign_id = $1 ORDER BY id${forUpdate}`,
      [campaign.campaignId],
    );
  for (const { id } of templateIds.rows) {
    const view = await input.catalog.read(client, { campaignId: campaign.campaignId, templateId: id });
    const base = view?.content.base;
    if (view === null || base === undefined || baseFrom === null || baseTo === null) continue;
    const pinned = base.versionId === campaign.systemVersionId;
    const templateChange = pinned
      ? checkTemplateBaseChange({ from: baseFrom, to: baseTo, kind: view.kind, base, defaultValues: view.content.defaultValues ?? {}, direction })
      : {
          ok: false,
          blockers: [{ code: "current_state_invalid" as const, message: "The template base is not pinned to the campaign version." }],
          next: null,
        };
    templateChecks.push({ templateId: id, name: view.content.name, ok: templateChange.ok, blockers: templateChange.blockers });
    if (templateChange.next !== null) {
      templates.push({ view, content: { ...view.content, base: templateChange.next.base, defaultValues: templateChange.next.defaultValues } });
    }
  }

  return {
    check: {
      revision: campaign.revision,
      direction,
      change,
      fromVersionId: current.systemVersionId,
      toVersionId: target.systemVersionId,
      from: current,
      to: target,
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
  const { direction, fromVersionId, toVersionId, from, to, change } = plan.check;
  const previous = direction === "upgrade" ? from : null;
  const kind = compositionActivityKind(change);
  for (const character of plan.characters) {
    const updated = await client.query<{ revision: number }>(
      `UPDATE characters
          SET system_version_id = $2, previous_system_version_id = $3, state_json = $4::jsonb,
              revision = revision + 1, updated_at = now()
        WHERE id = $1 AND campaign_id = $5 AND system_version_id = $6
        RETURNING revision`,
      [character.characterId, toVersionId, previous?.systemVersionId ?? null, JSON.stringify(character.nextState), input.campaignId, fromVersionId],
    );
    const revision = updated.rows[0]?.revision;
    if (revision === undefined) throw new Error("applyCampaignVersionPlan: character changed under lock");
    await writeCharacterExtensions(client, character.characterId, sortExtensionRefs(to.extensions));
    await client.query("DELETE FROM character_previous_extensions WHERE character_id = $1", [character.characterId]);
    for (const ref of previous?.extensions ?? []) {
      await client.query(
        "INSERT INTO character_previous_extensions (character_id, extension_id, extension_version_id) VALUES ($1, $2, $3)",
        [character.characterId, ref.extensionId, ref.versionId],
      );
    }
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
          from,
          to,
          change,
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
      [character.characterId, input.actorId, kind, "Rules changed with the campaign", input.requestId],
    );
  }
  for (const template of plan.templates) {
    await input.catalog.update(client, template.view, template.content, input.actorId);
  }
}

/**
 * Writes the campaign's new extension set (the caller moves the base pin and
 * revision). Kept and upgraded extensions keep their origin; added ones are
 * the campaign's own; a revert restores the recorded origins.
 */
export async function writeCampaignExtensions(
  client: PoolClient,
  campaignId: string,
  target: Composition,
  origins: Map<string, AddedBy>,
): Promise<void> {
  const stored = await loadCampaignExtensions(client, campaignId);
  for (const extension of stored) {
    const next = target.extensions.find((ref) => ref.extensionId === extension.extensionId);
    if (next === undefined) {
      await client.query("DELETE FROM campaign_extensions WHERE campaign_id = $1 AND extension_id = $2", [campaignId, extension.extensionId]);
    } else if (next.versionId !== extension.versionId) {
      await client.query(
        "UPDATE campaign_extensions SET extension_version_id = $3 WHERE campaign_id = $1 AND extension_id = $2",
        [campaignId, extension.extensionId, next.versionId],
      );
    }
  }
  for (const ref of sortExtensionRefs(target.extensions)) {
    if (stored.some((extension) => extension.extensionId === ref.extensionId)) continue;
    await client.query(
      `INSERT INTO campaign_extensions (campaign_id, extension_id, extension_version_id, added_by, added_by_character_id)
       VALUES ($1, $2, $3, $4, NULL)`,
      [campaignId, ref.extensionId, ref.versionId, origins.get(ref.extensionId) ?? "campaign"],
    );
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
