import type { Pool } from "pg";
import type { RequestContext } from "../systems/authoring.js";
import type { CampaignResult } from "./index.js";
import type { CampaignPersistenceRepository } from "./persistence.js";
import type { MediaFileView } from "./media.js";
import { canManageCampaign } from "./policy.js";
export type SceneLibraryQuery = { campaignId: string; limit?: number; cursor?: string | null };
export type SceneSummary = { sceneId: string; backgroundFileId: string; revision: number };
export interface SceneLibraryCommands {
  listSceneImages(ctx: RequestContext, input: SceneLibraryQuery): Promise<CampaignResult<{ images: MediaFileView[]; nextCursor: string | null }>>;
  listScenes(ctx: RequestContext, input: SceneLibraryQuery): Promise<CampaignResult<{ scenes: SceneSummary[]; nextCursor: string | null }>>;
}
export function createSceneLibraryCommands(pool: Pool, repo: CampaignPersistenceRepository): SceneLibraryCommands {
  async function list<T>(ctx: RequestContext, input: SceneLibraryQuery, kind: "images" | "scenes"): Promise<CampaignResult<{ rows: T[]; nextCursor: string | null }>> {
    const limit = input.limit ?? 25, cursor = input.cursor ?? null;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50 || (cursor !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(cursor))) return { ok: false, error: { code: "bad_request", message: "Choose a page size from 1 to 50 and a valid catalog cursor." } };
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const campaign = await repo.lockCampaign(client, input.campaignId), membership = campaign ? await repo.loadMembership(client, input.campaignId, ctx.actorId) : null;
      if (!campaign || !canManageCampaign(campaign, membership)) { await client.query("ROLLBACK"); return { ok: false, error: { code: "not_found", message: "The requested campaign does not exist." } }; }
      const rows = kind === "images" ? await repo.listSceneImageMetadata(client, input.campaignId, limit + 1, cursor) : await repo.listSceneMetadata(client, input.campaignId, limit + 1, cursor);
      const page = rows.slice(0, limit), last = page.at(-1);
      const nextCursor = rows.length > limit && last ? "fileId" in last ? last.fileId : last.sceneId : null;
      await client.query("COMMIT"); return { ok: true, value: { rows: page as T[], nextCursor } };
    } catch { await client.query("ROLLBACK"); return { ok: false, error: { code: "internal", message: "The scene library could not be loaded." } }; }
    finally { client.release(); }
  }
  return {
    async listSceneImages(ctx, input) { const result = await list<MediaFileView>(ctx, input, "images"); return result.ok ? { ok: true, value: { images: result.value.rows, nextCursor: result.value.nextCursor } } : result; },
    async listScenes(ctx, input) { const result = await list<SceneSummary>(ctx, input, "scenes"); return result.ok ? { ok: true, value: { scenes: result.value.rows, nextCursor: result.value.nextCursor } } : result; },
  };
}
