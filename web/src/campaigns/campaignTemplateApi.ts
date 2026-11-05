import { createImageEditorApi, type ImageEditorApi } from "../ui/imageEditorApi.js";
import type { ApiClient } from "../api/client.js";
import type { operations } from "../api/schema.js";
export type CampaignTemplate =
  operations["get_campaigns_id_item_templates_templateId"]["responses"]["200"]["content"]["application/json"]["template"];
export type TemplateCreateBody = NonNullable<
  operations["post_campaigns_id_item_templates"]["requestBody"]
>["content"]["application/json"];
export type TemplateEditBody = NonNullable<
  operations["patch_campaigns_id_item_templates_templateId"]["requestBody"]
>["content"]["application/json"];
export type TemplateLifecycleBody = NonNullable<
  operations["post_campaigns_id_item_templates_templateId_archive"]["requestBody"]
>["content"]["application/json"];
export type TemplateSharingBody=NonNullable<operations["post_campaigns_id_item_templates_templateId_sharing"]["requestBody"]>["content"]["application/json"];
export type TemplateBase = operations["get_campaigns_id_item_templates_bases"]["responses"]["200"]["content"]["application/json"]["templates"][number];
export type CampaignTemplatesApi = {
  images?: (campaignId: string, resourceId: string) => ImageEditorApi;
  share(campaignId:string,templateId:string,body:TemplateSharingBody):Promise<{template:CampaignTemplate}>;
  preview(campaignId:string,input:{targetUserId:string;cursor?:string}):Promise<{templates:CampaignTemplate[];nextCursor:string|null}>;
  bases(campaignId:string):Promise<{templates:TemplateBase[]}>;
  list(
    campaignId: string,
    input?: { status?: "active" | "archived"; cursor?: string | null },
  ): Promise<{ templates: CampaignTemplate[]; nextCursor: string | null }>;
  create(
    campaignId: string,
    body: TemplateCreateBody,
  ): Promise<{ template: CampaignTemplate }>;
  edit(
    campaignId: string,
    templateId: string,
    body: TemplateEditBody,
  ): Promise<{ template: CampaignTemplate }>;
  archive(
    campaignId: string,
    templateId: string,
    body: TemplateLifecycleBody,
  ): Promise<{ template: CampaignTemplate }>;
  recover(
    campaignId: string,
    templateId: string,
    body: TemplateLifecycleBody,
  ): Promise<{ template: CampaignTemplate }>;
};
export function createCampaignTemplatesApi(
  client: ApiClient,
): CampaignTemplatesApi {
  const path = (campaignId: string) =>
    `/campaigns/${campaignId}/item-templates`;
  return {
    images: (id, resourceId) => createImageEditorApi(client, `/campaigns/${encodeURIComponent(id)}/item-templates/${encodeURIComponent(resourceId)}/image`, "template"),
    share:(campaignId,templateId,body)=>client.fetch('POST',`${path(campaignId)}/${templateId}/sharing`,{body}),
    preview:(campaignId,body)=>client.fetch('POST',`/campaigns/${campaignId}/item-template-preview`,{body}),
    bases:(campaignId)=>client.fetch("GET",`${path(campaignId)}/bases`),
    list: (campaignId, input) =>
      client.fetch("GET", path(campaignId), {
        query: {
          status: input?.status ?? "active",
          cursor: input?.cursor ?? undefined,
          limit: 25,
        },
      }),
    create: (campaignId, body) =>
      client.fetch("POST", path(campaignId), { body }),
    edit: (campaignId, templateId, body) =>
      client.fetch("PATCH", `${path(campaignId)}/${templateId}`, { body }),
    archive: (campaignId, templateId, body) =>
      client.fetch("POST", `${path(campaignId)}/${templateId}/archive`, {
        body,
      }),
    recover: (campaignId, templateId, body) =>
      client.fetch("POST", `${path(campaignId)}/${templateId}/recover`, {
        body,
      }),
  };
}
