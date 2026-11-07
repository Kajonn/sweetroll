import type { PoolClient } from "pg";

import type { EffectivePackageLoader } from "../systems/implementation/runtime/composition-loader.js";
import type { ExtensionRef } from "../systems/runtime.js";
import { sortExtensionRefs, writeCharacterExtensions } from "./persistence.js";

// System extensions, stage E4 (design 6.8, decisions X7–X10). A campaign's
// composition is stored in `campaign_extensions`; every attached character's
// `character_extensions` equals that set, so character reads and the runtime
// need no campaign lookup. All writes run inside the caller's transaction,
// after the campaign row is locked.

export const MAX_EXTENSIONS = 16;

export type CampaignExtension = ExtensionRef & {
  addedBy: "campaign" | "character";
  addedByCharacterId: string | null;
  addedAt: Date;
};

export async function loadCampaignExtensions(client: PoolClient, campaignId: string): Promise<CampaignExtension[]> {
  const result = await client.query<{
    extension_id: string;
    extension_version_id: string;
    added_by: "campaign" | "character";
    added_by_character_id: string | null;
    added_at: Date;
  }>(
    `SELECT extension_id, extension_version_id, added_by, added_by_character_id, added_at
       FROM campaign_extensions WHERE campaign_id = $1 ORDER BY extension_id`,
    [campaignId],
  );
  return result.rows.map((row) => ({
    extensionId: row.extension_id,
    versionId: row.extension_version_id,
    addedBy: row.added_by,
    addedByCharacterId: row.added_by_character_id,
    addedAt: row.added_at,
  }));
}

export async function loadCharacterExtensions(client: PoolClient, characterId: string): Promise<ExtensionRef[]> {
  const result = await client.query<{ extension_id: string; extension_version_id: string }>(
    "SELECT extension_id, extension_version_id FROM character_extensions WHERE character_id = $1 ORDER BY extension_id",
    [characterId],
  );
  return result.rows.map((row) => ({ extensionId: row.extension_id, versionId: row.extension_version_id }));
}

export type MergedExtensions =
  | { ok: true; merged: ExtensionRef[]; added: ExtensionRef[] }
  | { ok: false; conflict: ExtensionRef };

/**
 * Decision X8: a character may bring extensions the campaign lacks, but never
 * a different version of one the campaign already has.
 */
export function mergeExtensionSets(campaign: readonly ExtensionRef[], incoming: readonly ExtensionRef[]): MergedExtensions {
  const byId = new Map(campaign.map((ref) => [ref.extensionId, ref.versionId]));
  const added: ExtensionRef[] = [];
  for (const ref of incoming) {
    const existing = byId.get(ref.extensionId);
    if (existing === undefined) {
      byId.set(ref.extensionId, ref.versionId);
      added.push({ extensionId: ref.extensionId, versionId: ref.versionId });
    } else if (existing !== ref.versionId) {
      return { ok: false, conflict: ref };
    }
  }
  return {
    ok: true,
    merged: sortExtensionRefs([...byId].map(([extensionId, versionId]) => ({ extensionId, versionId }))),
    added: sortExtensionRefs(added),
  };
}

/** Returns a reason when the composition does not fit the base version, else null. */
export async function compositionProblem(
  loader: EffectivePackageLoader,
  client: PoolClient,
  systemVersionId: string,
  extensions: readonly ExtensionRef[],
): Promise<string | null> {
  if (extensions.length > MAX_EXTENSIONS) return `A campaign may use at most ${MAX_EXTENSIONS} extensions.`;
  const loaded = await loader(systemVersionId, extensions, client);
  return loaded.ok ? null : loaded.error.message;
}

export async function insertCampaignExtension(
  client: PoolClient,
  campaignId: string,
  ref: ExtensionRef,
  addedBy: "campaign" | "character",
  addedByCharacterId: string | null,
): Promise<void> {
  await client.query(
    `INSERT INTO campaign_extensions (campaign_id, extension_id, extension_version_id, added_by, added_by_character_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [campaignId, ref.extensionId, ref.versionId, addedBy, addedByCharacterId],
  );
}

/** Writes `extensions` to every character attached to the campaign. */
export async function syncAttachedCharacterExtensions(
  client: PoolClient,
  campaignId: string,
  extensions: readonly ExtensionRef[],
): Promise<void> {
  const attached = await client.query<{ id: string }>(
    "SELECT id FROM characters WHERE campaign_id = $1 ORDER BY id FOR UPDATE",
    [campaignId],
  );
  for (const row of attached.rows) await writeCharacterExtensions(client, row.id, extensions);
}

/**
 * Decision X9: an extension is in use while an attached character has an
 * entry from it or a campaign template is based on one of its templates.
 */
export async function extensionUsage(
  client: PoolClient,
  campaignId: string,
  extensionId: string,
): Promise<{ characterIds: string[]; templateIds: string[] }> {
  const characters = await client.query<{ id: string }>(
    `SELECT c.id FROM characters c
      WHERE c.campaign_id = $1
        AND EXISTS (
          SELECT 1 FROM jsonb_each(COALESCE(c.state_json->'entries', '{}'::jsonb)) AS e(key, value)
           WHERE e.value->>'extensionId' = $2
              OR e.value->'snapshot'->'base'->>'extensionId' = $2)
      ORDER BY c.id`,
    [campaignId, extensionId],
  );
  const templates = await client.query<{ id: string }>(
    `SELECT t.id FROM campaign_item_templates t
       JOIN campaign_item_template_revisions r ON r.template_id = t.id AND r.content_revision = t.content_revision
      WHERE t.campaign_id = $1 AND r.content_json->'base'->>'extensionId' = $2
      ORDER BY t.id`,
    [campaignId, extensionId],
  );
  return { characterIds: characters.rows.map((row) => row.id), templateIds: templates.rows.map((row) => row.id) };
}
