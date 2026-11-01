import type {TemplateAudience,TemplateGrant,TemplateReadScope} from "./templatePolicy.js";
import type { Pool, PoolClient } from "pg";
import type {
  CampaignTemplateView,
  TemplateContent,
  TemplateLocation,
  ListTemplates,
  TemplatePage,
} from "./templates.js";
import type { TemplateKind } from "../systems/implementation/package/schema/index.js";

const SELECT = `SELECT t.id AS "templateId", t.campaign_id AS "campaignId", t.creator_id AS "creatorId", t.kind,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('userId',g.user_id,'generation',g.membership_generation) ORDER BY g.user_id) FROM campaign_item_template_grants g WHERE g.template_id=t.id),'[]'::jsonb) AS grants,
  t.audience, t.status, t.revision, t.content_revision AS "contentRevision", r.content_json AS content,
  t.created_at AS "createdAt", t.updated_at AS "updatedAt"
  FROM campaign_item_templates t JOIN campaign_item_template_revisions r ON r.template_id = t.id AND r.content_revision = t.content_revision`;
function view(row: CampaignTemplateView): CampaignTemplateView {
  return {
    ...row,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}
/** All calls can use the caller's transaction client; immutable content belongs to Campaigns. */
export function createTemplateRepository(pool: Pool) {
  async function read(
    client: Pool | PoolClient,
    location: TemplateLocation,
  ): Promise<CampaignTemplateView | null> {
    const r = await client.query<CampaignTemplateView>(
      `${SELECT} WHERE t.campaign_id=$1 AND t.id=$2`,
      [location.campaignId, location.templateId],
    );
    return r.rows[0] ? view(r.rows[0]) : null;
  }
  return {
    read,
    async setSharing(client:PoolClient, location:TemplateLocation, audience:TemplateAudience, grants:TemplateGrant[], bump=true) {
      await client.query('DELETE FROM campaign_item_template_grants WHERE template_id=$1',[location.templateId]);
      for(const grant of grants) await client.query('INSERT INTO campaign_item_template_grants(template_id,user_id,membership_generation) VALUES($1,$2,$3)',[location.templateId,grant.userId,grant.generation]);
      await client.query('UPDATE campaign_item_templates SET audience=$2,revision=revision+$3,updated_at=now() WHERE id=$1',[location.templateId,audience,bump?1:0]);
      return (await read(client,location))!;
    },
    async count(client: PoolClient, campaignId: string): Promise<number> {
      return (
        await client.query(
          `SELECT count(*)::int AS n FROM campaign_item_templates WHERE campaign_id=$1`,
          [campaignId],
        )
      ).rows[0].n;
    },
    async create(
      client: PoolClient,
      input: TemplateLocation & {
        creatorId: string;
        kind: TemplateKind;
        content: TemplateContent;
      },
    ): Promise<CampaignTemplateView> {
      await client.query(
        `INSERT INTO campaign_item_templates(id,campaign_id,creator_id,kind) VALUES($1,$2,$3,$4)`,
        [input.templateId, input.campaignId, input.creatorId, input.kind],
      );
      await client.query(
        `INSERT INTO campaign_item_template_revisions(template_id,content_revision,author_id,content_json) VALUES($1,1,$2,$3)`,
        [input.templateId, input.creatorId, input.content],
      );
      return (await read(client, input))!;
    },
    async update(
      client: PoolClient,
      current: CampaignTemplateView,
      content: TemplateContent,
      actorId: string,
    ): Promise<CampaignTemplateView> {
      await client.query(
        `INSERT INTO campaign_item_template_revisions(template_id,content_revision,author_id,content_json) VALUES($1,$2,$3,$4)`,
        [current.templateId, current.contentRevision + 1, actorId, content],
      );
      await client.query(
        `UPDATE campaign_item_templates SET revision=revision+1,content_revision=content_revision+1,updated_at=now() WHERE id=$1`,
        [current.templateId],
      );
      return (await read(client, current))!;
    },
    async setStatus(
      client: PoolClient,
      current: CampaignTemplateView,
      status: "active" | "archived",
    ): Promise<CampaignTemplateView> {
      await client.query(
        `UPDATE campaign_item_templates SET status=$2,revision=revision+1,updated_at=now(),archived_at=CASE WHEN $2='archived' THEN now() ELSE NULL END WHERE id=$1`,
        [current.templateId, status],
      );
      return (await read(client, current))!;
    },
    async page(
      client: Pool | PoolClient,
      input: ListTemplates & {scope:TemplateReadScope},
    ): Promise<TemplatePage> {
      const limit = input.limit ?? 50;
      if (
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        (input.status !== undefined &&
          !["active", "archived"].includes(input.status)) ||
        (input.kind !== undefined &&
          !["item", "spell", "talent", "effect"].includes(input.kind))
      )
        throw Object.assign(new Error("Invalid template page."), {
          code: "bad_request",
        });
      let anchor: string | null = null;
      if (input.cursor) {
        try {
          const c = JSON.parse(
            Buffer.from(input.cursor, "base64url").toString(),
          );
          if (
            c.campaignId !== input.campaignId ||
            c.status !== (input.status ?? "active") ||
            c.kind !== (input.kind ?? null) ||
            JSON.stringify(c.scope) !== JSON.stringify(input.scope) ||
            typeof c.id !== "string" ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
              c.id,
            )
          )
            throw new Error();
          anchor = c.id;
        } catch {
          throw Object.assign(new Error("Invalid template cursor."), {
            code: "bad_request",
          });
        }
      }
      const result = await client.query<CampaignTemplateView>(
        `${SELECT} WHERE t.campaign_id=$1 AND t.status=$2 AND ($3::text IS NULL OR t.kind=$3) AND ($4::uuid IS NULL OR t.id > $4)
          AND ($6::text='gm' OR t.audience='all_players' OR ($6::text='member' AND t.status='active' AND t.audience='selected_players' AND EXISTS(SELECT 1 FROM campaign_item_template_grants g WHERE g.template_id=t.id AND g.user_id=$7 AND g.membership_generation=$8))) ORDER BY t.id LIMIT $5`,
        [
          input.campaignId,
          input.status ?? "active",
          input.kind ?? null,
          anchor,
          limit + 1,
          input.scope.mode,input.scope.userId ?? null,input.scope.generation ?? null,
        ],
      );
      const rows = result.rows.slice(0, limit).map(view);
      const last = rows.at(-1);
      return {
        templates: rows,
        nextCursor:
          result.rows.length > limit && last
            ? Buffer.from(
                JSON.stringify({
                  campaignId: input.campaignId,
                  status: input.status ?? "active",
                  kind: input.kind ?? null,
                  scope:input.scope,
                  id: last.templateId,
                }),
              ).toString("base64url")
            : null,
      };
    },
    /** Called after campaign/character authorization; commit revalidation runs on the locked campaign transaction. */
    async selected(
      location: TemplateLocation,
      revision: number,
      contentRevision: number,
    ): Promise<CampaignTemplateView | null> {
      const row = await read(pool, location);
      return row?.audience === "all_players" && row.status === "active" &&
        row.revision === revision &&
        row.contentRevision === contentRevision
        ? row
        : null;
    },
  };
}
