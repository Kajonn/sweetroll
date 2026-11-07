import type { Campaigns } from "../../../campaigns/index.js";
import type { RequestContext } from "../../../systems/authoring.js";
import * as c from "./campaign-schemas.js";
import { imageBodyLimit, map, wire, type Result, type Route } from "./router.js";

const missingCampaign = { ok: false as const, error: { code: "not_found" as const, message: "The requested campaign does not exist." } };

export function registerSceneRoutes(route: Route, { campaigns }: { campaigns: Campaigns }) {
  /** The file must belong to the campaign in the URL before any read or write. */
  async function openMedia(ctx: RequestContext, campaignId: string, fileId: string, thumbnail = false) {
    const opened = await campaigns.openImage(ctx, { fileId, thumbnail });
    if (!opened.ok) return opened;
    return opened.value.file.campaignId === campaignId ? opened : missingCampaign;
  }

  route({
    method: "GET", path: "/campaigns/:campaignId/images", id: "listCampaignImages",
    description: "List scanned campaign images for scene backgrounds and tokens. GM only.",
    scope: "campaigns:read", input: { params: c.campaignId, querystring: c.sceneLibraryQuery }, output: "MediaPage",
  }, (ctx, { params, query }) => campaigns.listSceneImages(ctx, { ...params, ...query }));

  route({
    method: "POST", path: "/campaigns/:campaignId/images", id: "uploadCampaignImage",
    description: "Upload a PNG, JPEG or WebP image up to 5 MiB. It is scanned and counted against the campaign quota.",
    scope: "campaigns:write", input: { params: c.campaignId, body: c.uploadMedia }, output: "Media", created: true,
    bodyLimit: imageBodyLimit, bucket: "upload",
  }, (ctx, { params, body }) => campaigns.uploadImage(ctx, { ...params, ...body }));

  route({
    method: "DELETE", path: "/campaigns/:campaignId/images/:fileId", id: "deleteCampaignImage",
    description: "Delete an unused campaign image at its revision.",
    scope: "campaigns:write", input: { params: c.mediaParams, body: c.deleteMedia }, output: "Media",
  }, async (ctx, { params, body }) => {
    const scoped = await openMedia(ctx, params.campaignId, params.fileId);
    if (!scoped.ok) return scoped;
    return campaigns.deleteImage(ctx, { fileId: params.fileId, ...body });
  });

  for (const [suffix, thumbnail] of [["original", false], ["thumbnail", true]] as const) {
    route({
      method: "GET", path: `/campaigns/:campaignId/images/:fileId/${suffix}`,
      id: thumbnail ? "downloadCampaignImageThumbnail" : "downloadCampaignImage",
      description: thumbnail ? "Download a WebP thumbnail of a campaign image. GM only." : "Download the original campaign image. GM only.",
      scope: "campaigns:read", input: { params: c.mediaParams }, output: "binary",
    }, async (ctx, { params }) => map(await openMedia(ctx, params.campaignId, params.fileId, thumbnail),
      ({ contentType, bytes }) => ({ contentType: thumbnail ? "image/webp" : contentType, bytes })));
  }

  route({
    method: "GET", path: "/campaigns/:campaignId/scenes", id: "listScenes", description: "List the campaign scene library. GM only.",
    scope: "campaigns:read", input: { params: c.campaignId, querystring: c.sceneLibraryQuery }, output: "ScenePage",
  }, (ctx, { params, query }) => campaigns.listScenes(ctx, { ...params, ...query }));

  route({
    method: "POST", path: "/campaigns/:campaignId/scenes", id: "createScene",
    description: "Create a fully fogged scene on an uploaded campaign image.",
    scope: "campaigns:write", input: { params: c.campaignId, body: c.createScene }, output: "Scene", created: true,
  }, (ctx, { params, body }) => campaigns.createScene(ctx, { ...params, ...body }));

  route({
    method: "GET", path: "/scenes/:sceneId", id: "readScene", description: "Read a scene with fog and every token, including hidden ones. GM only.",
    scope: "campaigns:read", input: { params: c.sceneId }, output: "Scene",
  }, (ctx, { params }) => campaigns.openScene(ctx, params));

  route({
    method: "PATCH", path: "/scenes/:sceneId", id: "replaceSceneBackground",
    description: "Replace the scene background. Fog and tokens are kept; paired displays update.",
    scope: "campaigns:write", input: { params: c.sceneId, body: c.updateScene }, output: "Scene",
  }, (ctx, { params, body }) => campaigns.updateScene(ctx, { ...params, ...body }));

  route({
    method: "POST", path: "/scenes/:sceneId/fog-edits", id: "editSceneFog",
    description: "Apply one revision-checked fog batch of up to 512 reveal or conceal runs in normalized coordinates.",
    scope: "campaigns:write", input: { params: c.sceneId, body: c.fogEdit }, output: "Scene",
    example: {
      op: { mode: "reveal", runs: [{ x: 0.5, y: 0.5, r: 0.1 }] }, expectedSceneRevision: 1,
      idempotencyKey: "4c2f1f9e-7a5d-4b8e-9c1a-2f3e4d5c6b7a",
    },
  }, (ctx, { params, body }) => campaigns.applyFogEdit(ctx, { ...params, ...body }));

  route({
    method: "POST", path: "/scenes/:sceneId/tokens", id: "placeSceneToken",
    description: "Place a token. Hidden tokens never reach paired displays.",
    scope: "campaigns:write", input: { params: c.sceneId, body: c.placeToken }, output: "Scene",
  }, (ctx, { params, body }) => campaigns.placeToken(ctx, { ...params, ...body }));

  route({
    method: "PATCH", path: "/scenes/:sceneId/tokens/:tokenId", id: "moveSceneToken", description: "Move a token.",
    scope: "campaigns:write", input: { params: c.tokenParams, body: c.moveToken }, output: "Scene",
  }, (ctx, { params, body }) => campaigns.moveToken(ctx, { ...params, ...body }));

  route({
    method: "DELETE", path: "/scenes/:sceneId/tokens/:tokenId", id: "removeSceneToken", description: "Remove a token.",
    scope: "campaigns:write", input: { params: c.tokenParams, body: c.sceneCommand }, output: "Scene",
  }, (ctx, { params, body }) => campaigns.removeToken(ctx, { ...params, ...body }));

  route({
    method: "POST", path: "/campaigns/:campaignId/display-codes", id: "createDisplayCode",
    description: "Mint a short-lived, single-use code to pair a table display. The display redeems it in its own browser.",
    scope: "campaigns:write", input: { params: c.campaignId }, output: "DisplayCode", created: true,
  }, async (ctx, { params }) => map(await campaigns.pairDisplay(ctx, params), ({ code }) => ({ code })));

  route({
    method: "GET", path: "/campaigns/:campaignId/display-credentials", id: "listDisplayCredentials",
    description: "List paired displays. Secrets are never returned.",
    scope: "campaigns:read", input: { params: c.campaignId }, output: "DisplayCredentials",
  }, async (ctx, { params }) => map(await campaigns.listDisplayCredentials(ctx, params), (displays) => wire({ displays })));

  route({
    method: "POST", path: "/campaigns/:campaignId/displays/:displayId/revoke", id: "revokeDisplay",
    description: "Revoke a paired display. Its open scene streams end.",
    scope: "campaigns:write", input: { params: c.displayParams }, output: "RevokedDisplay",
  }, async (ctx, { params }): Promise<Result<unknown>> => {
    const listed = await campaigns.listDisplayCredentials(ctx, { campaignId: params.campaignId });
    if (!listed.ok) return listed;
    // Revocation cannot be undone, so a credential under another campaign
    // collapses to not_found before anything changes.
    if (!listed.value.some((display) => display.displayId === params.displayId)) return missingCampaign;
    return map(await campaigns.revokeDisplay(ctx, { displayId: params.displayId }), (revoked) => revoked);
  });

}
