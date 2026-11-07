import type { Campaigns } from "../../../campaigns/index.js";
import { prepareCampaignCharacter } from "../../../characters/campaignPlacement.js";
import type { Characters } from "../../../characters/index.js";
import type { Identity } from "../../../identity/index.js";
import type { RequestContext } from "../../../systems/authoring.js";
import type { SystemRuntime } from "../../../systems/runtime.js";
import * as c from "./campaign-schemas.js";
import { map, ok, wire, type Result, type Route } from "./router.js";
import { characterSheet } from "./views.js";

type Dependencies = {
  campaigns: Campaigns;
  characters: Characters;
  runtime: SystemRuntime;
  identity: Pick<Identity, "getDisplayNames">;
};

const asWire = <T>(result: Result<T>) => map(result, wire);
const page = (query: { limit?: number; cursor?: string }) => ({ limit: query.limit ?? 25, cursor: query.cursor ?? null });
const campaignWrite = ["campaigns:write"] as const;
const placementScopes = ["campaigns:write", "characters:write"] as const;

export function registerCampaignRoutes(route: Route, { campaigns, characters, runtime, identity }: Dependencies) {
  /**
   * A placement transaction has committed when this runs. The sheet read
   * applies current policy; a commit-then-revoke race reads as
   * result_unavailable, never as a leak.
   */
  async function placedSheet(ctx: RequestContext, characterId: string): Promise<Result<unknown>> {
    const opened = await characters.open(ctx, characterId);
    if (!opened.ok) {
      return { ok: false, error: { code: "result_unavailable", message: "The placement committed, but its result is no longer available." } };
    }
    return ok(wire(characterSheet(opened.value)));
  }

  // -------------------------------------------------------------------------
  // Lifecycle, membership and invitations (B3)
  // -------------------------------------------------------------------------

  route({
    method: "GET", path: "/campaigns", id: "listCampaigns", description: "List campaigns where the caller is an active member.",
    scope: "campaigns:read", input: { querystring: c.pageQuery }, output: "CampaignPage",
  }, async (ctx, { query }) => asWire(await campaigns.list(ctx, page(query))));

  route({
    method: "POST", path: "/campaigns", id: "createCampaign",
    description: "Create a campaign owned by the caller and pinned to a usable published system version.",
    scope: "campaigns:write", input: { body: c.createCampaign }, output: "Campaign", created: true,
    example: { systemVersionId: "00000000-0000-4000-8000-000000000001", title: "Night Road", idempotencyKey: "campaign-1" },
  }, async (ctx, { body }) => asWire(await campaigns.create(ctx, body)));

  route({
    method: "GET", path: "/campaigns/:campaignId", id: "readCampaign", description: "Read a campaign the caller belongs to.",
    scope: "campaigns:read", input: { params: c.campaignId }, output: "Campaign",
  }, async (ctx, { params }) => asWire(await campaigns.open(ctx, params)));

  route({
    method: "PATCH", path: "/campaigns/:campaignId", id: "updateCampaign", description: "Edit the title or description at the expected campaign revision.",
    scope: "campaigns:write", input: { params: c.campaignId, body: c.updateCampaign }, output: "Campaign",
  }, async (ctx, { params, body }) => asWire(await campaigns.update(ctx, { ...params, ...body })));

  for (const command of ["archive", "recover"] as const) {
    route({
      method: "POST", path: `/campaigns/:campaignId/${command}`, id: `${command}Campaign`,
      description: command === "archive" ? "Archive a campaign. Archived campaigns reject play and content changes." : "Recover an archived campaign.",
      scope: "campaigns:write", input: { params: c.campaignId, body: c.campaignCommand }, output: "Campaign",
    }, async (ctx, { params, body }) => asWire(await campaigns[command](ctx, { ...params, ...body })));
  }

  route({
    method: "GET", path: "/campaigns/:campaignId/members", id: "listCampaignMembers",
    description: "List campaign members with display labels for active members.",
    scope: "campaigns:read", input: { params: c.campaignId, querystring: c.pageQuery }, output: "MemberPage",
  }, async (ctx, { params, query }) => {
    const listed = await campaigns.listMembers(ctx, { ...params, ...page(query) });
    if (!listed.ok) return listed;
    // Labels are requested only after Campaigns authorized the page.
    const labels = await identity.getDisplayNames(listed.value.members
      .filter((member) => member.status === "active").map((member) => member.userId));
    if (!labels.ok) return { ok: false, error: { code: "temporarily_unavailable", message: "Member names are unavailable." } };
    const names = new Map(labels.value.map((label) => [label.userId, label.displayName]));
    return ok(wire({
      members: listed.value.members.map((member) => ({ ...member, displayName: names.get(member.userId) ?? null })),
      nextCursor: listed.value.nextCursor,
    }));
  });

  route({
    method: "PATCH", path: "/campaigns/:campaignId/members/:userId", id: "changeMemberRole",
    description: "Change a member between player and co-GM.",
    scope: "campaigns:write", input: { params: c.memberParams, body: c.changeRole }, output: "Member",
  }, async (ctx, { params, body }) => asWire(await campaigns.changeRole(ctx, { ...params, ...body })));

  route({
    method: "DELETE", path: "/campaigns/:campaignId/members/:userId", id: "removeMember",
    description: "Remove a member, or leave when the user ID is the caller. Adopted characters return to their original owner.",
    scope: "campaigns:write", input: { params: c.memberParams, body: c.campaignCommand }, output: "Member",
  }, async (ctx, { params, body }) => asWire(await campaigns.removeMember(ctx, { ...params, ...body })));

  route({
    method: "GET", path: "/campaigns/:campaignId/invitations", id: "listInvitations",
    description: "List invitation metadata. Tokens are never listed.",
    scope: "campaigns:read", input: { params: c.campaignId, querystring: c.pageQuery }, output: "InvitationPage",
  }, async (ctx, { params, query }) => asWire(await campaigns.listInvitations(ctx, { ...params, ...page(query) })));

  route({
    method: "POST", path: "/campaigns/:campaignId/invitations", id: "issueInvitation",
    description: "Issue an invitation. The token appears once in this response; a same-key replay returns tokenUnavailable.",
    scope: "campaigns:write", input: { params: c.campaignId, body: c.issueInvitation }, output: "IssuedInvitation", created: true,
  }, async (ctx, { params, body }) => asWire(await campaigns.issueInvitation(ctx, { ...params, ...body })));

  route({
    method: "POST", path: "/campaigns/:campaignId/invitations/:invitationId/rotate", id: "rotateInvitation",
    description: "Replace an invitation token. The previous token stops working.",
    scope: "campaigns:write", input: { params: c.invitationParams, body: c.rotateInvitation }, output: "IssuedInvitation",
  }, async (ctx, { params, body }) => asWire(await campaigns.rotateInvitation(ctx, { ...params, ...body })));

  route({
    method: "POST", path: "/campaigns/:campaignId/invitations/:invitationId/revoke", id: "revokeInvitation",
    description: "Revoke a pending invitation.",
    scope: "campaigns:write", input: { params: c.invitationParams, body: c.revokeInvitation }, output: "IssuedInvitation",
  }, async (ctx, { params, body }) => asWire(await campaigns.revokeInvitation(ctx, { ...params, ...body })));

  route({
    method: "POST", path: "/invitations/review", id: "reviewInvitation",
    description: "Review the campaign and role offered by an invitation token before accepting it.",
    scope: "campaigns:read", input: { body: c.reviewInvitation }, output: "InvitationReview",
  }, async (ctx, { body }) => asWire(await campaigns.reviewInvitation(ctx, body)));

  for (const command of ["accept", "decline"] as const) {
    route({
      method: "POST", path: `/invitations/${command}`, id: `${command}Invitation`,
      description: `${command === "accept" ? "Join" : "Decline"} the reviewed campaign with the invitation token and the revisions from the review.`,
      scope: "campaigns:write", input: { body: c.consumeInvitation },
      output: command === "accept" ? "InvitationAcceptance" : "InvitationDeclination",
    }, async (ctx, { body }) => command === "accept"
      ? asWire(await campaigns.acceptInvitation(ctx, body))
      : asWire(await campaigns.declineInvitation(ctx, body)));
  }

  route({
    method: "GET", path: "/campaigns/:campaignId/activity", id: "listCampaignActivity",
    description: "Read the campaign activity feed, filtered to what the caller may see.",
    scope: "campaigns:read", input: { params: c.campaignId, querystring: c.pageQuery }, output: "CampaignActivity",
  }, async (ctx, { params, query }) => asWire(await campaigns.listActivity(ctx, { ...params, ...page(query) })));

  route({
    method: "POST", path: "/campaigns/:campaignId/exports", id: "exportCampaign",
    description: "Export the campaign records as a GM or co-GM, filtered by the same audience rules as the browser export.",
    scope: "campaigns:read", input: { params: c.campaignId, body: c.exportCampaign }, output: "CampaignExport",
  }, async (ctx, { params, body }) => asWire(await campaigns.exportCampaign(ctx, { ...params, ...body })));

  // -------------------------------------------------------------------------
  // Characters, content, templates and proposals (B4)
  // -------------------------------------------------------------------------

  route({
    method: "GET", path: "/campaigns/:campaignId/characters", id: "listCampaignCharacters",
    description: "List attached characters. GMs see every sheet; players see sheets they control.",
    scope: "campaigns:read", input: { params: c.campaignId, querystring: c.pageQuery }, output: "CampaignCharacterPage",
  }, async (ctx, { params, query }) => asWire(await campaigns.listCharacters(ctx, { ...params, ...page(query) })));

  route({
    method: "POST", path: "/campaigns/:campaignId/characters", id: "createCampaignCharacter",
    description: "Create a character in campaign custody on the campaign's pinned version, optionally with controllers.",
    scope: placementScopes, input: { params: c.campaignId, body: c.createCampaignCharacter }, output: "CharacterSheet", created: true,
    fieldErrorPath: "initialValues",
  }, async (ctx, { params, body }) => {
    const opened = await campaigns.open(ctx, params);
    if (!opened.ok) return opened;
    const prepared = await prepareCampaignCharacter(runtime, {
      systemVersionId: opened.value.systemVersionId, entityDefinitionId: body.entityDefinitionId,
      ...(body.initialValues === undefined ? {} : { initialValues: body.initialValues }),
    });
    if (!prepared.ok) return prepared;
    const placed = await campaigns.createCampaignCharacter(ctx, {
      campaignId: params.campaignId, expectedCampaignRevision: body.expectedCampaignRevision,
      idempotencyKey: body.idempotencyKey, name: body.name, entityDefinitionId: body.entityDefinitionId,
      prepared: prepared.value,
      ...(body.controllerUserIds === undefined ? {} : { controllerUserIds: body.controllerUserIds }),
    });
    return placed.ok ? placedSheet(ctx, placed.value.characterId) : placed;
  });

  route({
    method: "GET", path: "/campaigns/:campaignId/claimable-characters", id: "listClaimableCharacters",
    description: "List characters a GM designated for the caller to claim.",
    scope: "campaigns:read", input: { params: c.campaignId, querystring: c.pageQuery }, output: "ClaimableCharacterPage",
  }, async (ctx, { params, query }) => asWire(await campaigns.listClaimableCharacters(ctx, { ...params, ...page(query) })));

  route({
    method: "POST", path: "/campaigns/:campaignId/characters/:characterId/assign", id: "assignCampaignCharacter",
    description: "Set the controllers of an attached character and optionally designate claimants.",
    scope: placementScopes, input: { params: c.campaignCharacterParams, body: c.assignControllers }, output: "CharacterSheet",
  }, async (ctx, { params, body }) => {
    const placed = await campaigns.assignCampaignControllers(ctx, { ...params, ...body });
    return placed.ok ? placedSheet(ctx, placed.value.characterId) : placed;
  });

  route({
    method: "POST", path: "/campaigns/:campaignId/characters/:characterId/claim", id: "claimCampaignCharacter",
    description: "Claim a character the GM designated for the caller.",
    scope: placementScopes, input: { params: c.campaignCharacterParams, body: c.claimCharacter }, output: "CharacterSheet",
  }, async (ctx, { params, body }) => {
    const placed = await campaigns.claimCampaignCharacter(ctx, { ...params, ...body });
    return placed.ok ? placedSheet(ctx, placed.value.characterId) : placed;
  });

  route({
    method: "POST", path: "/campaigns/:campaignId/characters/:characterId/adopt", id: "adoptCampaignCharacter",
    description: "Bring an owned standalone character on the campaign's exact version into the campaign.",
    scope: placementScopes, input: { params: c.campaignCharacterParams, body: c.adoptCharacter }, output: "CharacterSheet",
  }, async (ctx, { params, body }) => {
    const placed = await campaigns.adoptCampaignCharacter(ctx, { ...params, ...body });
    return placed.ok ? placedSheet(ctx, placed.value.characterId) : placed;
  });

  route({
    method: "GET", path: "/campaigns/:campaignId/content", id: "listCampaignContent",
    description: "List readable notes. status=deleted lists hidden notes the caller may recover.",
    scope: "campaigns:read", input: { params: c.campaignId, querystring: c.contentQuery }, output: "ContentPage",
  }, async (ctx, { params, query }) => asWire(await campaigns.listContent(ctx, {
    ...params, ...page(query), ...(query.status === undefined ? {} : { status: query.status }),
  })));

  route({
    method: "POST", path: "/campaigns/:campaignId/content", id: "createCampaignContent",
    description: "Create a note. GMs choose any audience; players create owner-only notes.",
    scope: "campaigns:write", input: { params: c.campaignId, body: c.createContent }, output: "Content", created: true,
  }, async (ctx, { params, body }) => asWire(await campaigns.createContent(ctx, { ...params, ...body })));

  route({
    method: "POST", path: "/campaigns/:campaignId/content-preview", id: "previewCampaignContent",
    description: "GM-only read-only view of the notes, or one note, that a member can read.",
    scope: "campaigns:read", input: { params: c.campaignId, body: c.previewContent }, output: "ContentPreview",
  }, async (ctx, { params, body }) => map(await campaigns.previewContent(ctx, { ...params, ...body }),
    (preview) => wire({ content: preview.kind === "list" ? preview.content : preview.content })));

  route({
    method: "GET", path: "/content/:contentId", id: "readCampaignContent", description: "Read an active note the caller may read.",
    scope: "campaigns:read", input: { params: c.contentId }, output: "Content",
  }, async (ctx, { params }) => asWire(await campaigns.openContent(ctx, params)));

  route({
    method: "PATCH", path: "/content/:contentId", id: "updateCampaignContent", description: "Edit a note at the expected content revision.",
    scope: "campaigns:write", input: { params: c.contentId, body: c.updateContent }, output: "Content",
  }, async (ctx, { params, body }) => asWire(await campaigns.updateContent(ctx, { ...params, ...body })));

  route({
    method: "DELETE", path: "/content/:contentId", id: "hideCampaignContent", description: "Hide (soft-delete) a note. It can be recovered.",
    scope: "campaigns:write", input: { params: c.contentId, body: c.contentCommand }, output: "Content",
  }, async (ctx, { params, body }) => asWire(await campaigns.deleteContent(ctx, { ...params, ...body })));

  route({
    method: "POST", path: "/content/:contentId/grants", id: "replaceContentGrants", description: "Replace the selected readers of a note.",
    scope: "campaigns:write", input: { params: c.contentId, body: c.replaceGrants }, output: "Content",
  }, async (ctx, { params, body }) => asWire(await campaigns.replaceGrants(ctx, { ...params, ...body })));

  route({
    method: "POST", path: "/content/:contentId/recover", id: "recoverCampaignContent", description: "Recover a hidden note.",
    scope: "campaigns:write", input: { params: c.contentId, body: c.contentCommand }, output: "Content",
  }, async (ctx, { params, body }) => asWire(await campaigns.recoverContent(ctx, { ...params, ...body })));

  route({
    method: "GET", path: "/campaigns/:campaignId/item-templates", id: "listCampaignTemplates",
    description: "List campaign item templates visible to the caller.",
    scope: "campaigns:read", input: { params: c.campaignId, querystring: c.templateQuery }, output: "CampaignTemplatePage",
  }, async (ctx, { params, query }) => asWire(await campaigns.listTemplates(ctx, { ...params, ...query })));

  route({
    method: "POST", path: "/campaigns/:campaignId/item-templates", id: "createCampaignTemplate",
    description: "Create a campaign item template, optionally derived from a system template and restricted to an audience.",
    scope: "campaigns:write", input: { params: c.campaignId, body: c.createTemplate }, output: "CampaignTemplate", created: true,
  }, async (ctx, { params, body }) => asWire(await campaigns.createTemplate(ctx, { ...params, ...body, expectedTemplateRevision: 0 })));

  route({
    method: "GET", path: "/campaigns/:campaignId/item-templates/bases", id: "listCampaignTemplateBases",
    description: "List the pinned system templates a GM can derive campaign templates from.",
    scope: "campaigns:read", input: { params: c.campaignId }, output: "TemplateBases",
  }, async (ctx, { params }) => map(await campaigns.listTemplateBases(ctx, params), (templates) => ({ templates })));

  route({
    method: "POST", path: "/campaigns/:campaignId/item-template-preview", id: "previewCampaignTemplates",
    description: "GM-only read-only view of the templates a member can see.",
    scope: "campaigns:read", input: { params: c.campaignId, body: c.previewTemplates }, output: "CampaignTemplatePage",
  }, async (ctx, { params, body }) => asWire(await campaigns.previewTemplates(ctx, { ...params, ...body })));

  route({
    method: "GET", path: "/campaigns/:campaignId/item-templates/:templateId", id: "readCampaignTemplate",
    description: "Read a campaign template visible to the caller.",
    scope: "campaigns:read", input: { params: c.templateParams }, output: "CampaignTemplate",
  }, async (ctx, { params }) => asWire(await campaigns.openTemplate(ctx, params)));

  route({
    method: "PATCH", path: "/campaigns/:campaignId/item-templates/:templateId", id: "updateCampaignTemplate",
    description: "Replace template content at the expected template revision. Placed entries keep their snapshots.",
    scope: "campaigns:write", input: { params: c.templateParams, body: c.updateTemplate }, output: "CampaignTemplate",
  }, async (ctx, { params, body }) => asWire(await campaigns.updateTemplate(ctx, { ...params, ...body })));

  for (const command of ["archive", "recover"] as const) {
    route({
      method: "POST", path: `/campaigns/:campaignId/item-templates/:templateId/${command}`, id: `${command}CampaignTemplate`,
      description: `${command === "archive" ? "Archive" : "Recover"} a campaign template.`,
      scope: "campaigns:write", input: { params: c.templateParams, body: c.templateCommand }, output: "CampaignTemplate",
    }, async (ctx, { params, body }) => asWire(command === "archive"
      ? await campaigns.archiveTemplate(ctx, { ...params, ...body })
      : await campaigns.recoverTemplate(ctx, { ...params, ...body })));
  }

  route({
    method: "POST", path: "/campaigns/:campaignId/item-templates/:templateId/sharing", id: "shareCampaignTemplate",
    description: "Set a template's audience and, for selected players, the membership grants.",
    scope: "campaigns:write", input: { params: c.templateParams, body: c.shareTemplate }, output: "CampaignTemplate",
  }, async (ctx, { params, body }) => asWire(await campaigns.shareTemplate(ctx, { ...params, ...body })));

  route({
    method: "GET", path: "/campaigns/:campaignId/item-proposals", id: "listItemProposals",
    description: "List item proposals. GMs see all; players see their own.",
    scope: "campaigns:read", input: { params: c.campaignId, querystring: c.proposalQuery }, output: "ProposalPage",
  }, async (ctx, { params, query }) => asWire(await campaigns.listProposals(ctx, { ...params, ...query })));

  route({
    method: "POST", path: "/campaigns/:campaignId/item-proposals", id: "submitItemProposal",
    description: "Suggest a new campaign item template as a player.",
    scope: "campaigns:write", input: { params: c.campaignId, body: c.submitProposal }, output: "Proposal", created: true,
  }, async (ctx, { params, body }) => map(await campaigns.submitProposal(ctx, { ...params, ...body, expectedProposalRevision: 0 }),
    (submitted) => wire(submitted.proposal)));

  route({
    method: "GET", path: "/campaigns/:campaignId/item-proposals/:proposalId", id: "readItemProposal",
    description: "Read an item proposal, including GM approval eligibility.",
    scope: "campaigns:read", input: { params: c.proposalParams }, output: "Proposal",
  }, async (ctx, { params }) => asWire(await campaigns.openProposal(ctx, params)));

  route({
    method: "POST", path: "/campaigns/:campaignId/item-proposals/:proposalId/approve", id: "approveItemProposal",
    description: "Approve a pending proposal as a GM. The response includes the created template.",
    scope: "campaigns:write", input: { params: c.proposalParams, body: c.approveProposal }, output: "ProposalDecision",
  }, async (ctx, { params, body }) => map(await campaigns.approveProposal(ctx, { ...params, ...body }),
    (decision) => wire({ proposal: decision.proposal, template: decision.template ?? null })));

  route({
    method: "POST", path: "/campaigns/:campaignId/item-proposals/:proposalId/reject", id: "rejectItemProposal",
    description: "Reject a pending proposal as a GM with an optional reason.",
    scope: "campaigns:write", input: { params: c.proposalParams, body: c.rejectProposal }, output: "ProposalDecision",
  }, async (ctx, { params, body }) => map(await campaigns.rejectProposal(ctx, { ...params, ...body }),
    (decision) => wire({ proposal: decision.proposal, template: decision.template ?? null })));

  const templateImage = "/campaigns/:campaignId/item-templates/:templateId/image";
  route({
    method: "GET", path: templateImage, id: "readCampaignTemplateImage", description: "Read template art metadata.",
    scope: "campaigns:read", input: { params: c.templateParams }, output: "CampaignImageState",
  }, (ctx, { params }) => campaigns.openTemplateImage(ctx, params));
  route({
    method: "PUT", path: templateImage, id: "setCampaignTemplateImage", description: "Upload or replace template art.",
    scope: campaignWrite, input: { params: c.templateParams, body: c.setTemplateImage }, output: "CampaignImageState",
    bodyLimit: 8 * 1024 * 1024, bucket: "upload",
  }, (ctx, { params, body }) => campaigns.setTemplateImage(ctx, { ...params, ...body }));
  route({
    method: "DELETE", path: templateImage, id: "removeCampaignTemplateImage", description: "Remove template art.",
    scope: campaignWrite, input: { params: c.templateParams, body: c.removeTemplateImage }, output: "CampaignImageState",
  }, (ctx, { params, body }) => campaigns.removeTemplateImage(ctx, { ...params, ...body }));

  const proposalImage = "/campaigns/:campaignId/item-proposals/:proposalId/image";
  route({
    method: "GET", path: proposalImage, id: "readItemProposalImage", description: "Read proposal art metadata.",
    scope: "campaigns:read", input: { params: c.proposalParams }, output: "CampaignImageState",
  }, (ctx, { params }) => campaigns.openProposalImage(ctx, params));
  route({
    method: "PUT", path: proposalImage, id: "setItemProposalImage", description: "Upload or replace art on a pending proposal.",
    scope: campaignWrite, input: { params: c.proposalParams, body: c.setProposalImage }, output: "CampaignImageState",
    bodyLimit: 8 * 1024 * 1024, bucket: "upload",
  }, (ctx, { params, body }) => campaigns.setProposalImage(ctx, { ...params, ...body }));
  route({
    method: "DELETE", path: proposalImage, id: "removeItemProposalImage", description: "Remove art from a pending proposal.",
    scope: campaignWrite, input: { params: c.proposalParams, body: c.removeProposalImage }, output: "CampaignImageState",
  }, (ctx, { params, body }) => campaigns.removeProposalImage(ctx, { ...params, ...body }));

  for (const thumbnail of [false, true]) {
    const suffix = thumbnail ? "/thumbnail" : "";
    const label = thumbnail ? "Thumbnail" : "";
    route({
      method: "GET", path: `${templateImage}/:fileId${suffix}`, id: `downloadCampaignTemplateImage${label}`,
      description: `Download ${thumbnail ? "a WebP thumbnail of " : ""}template art.`,
      scope: "campaigns:read", input: { params: c.templateImageParams }, output: "binary",
    }, (ctx, { params }) => campaigns.openCampaignItemImageBytes(ctx, {
      campaignId: params.campaignId, resourceId: params.templateId, kind: "template", fileId: params.fileId, thumbnail,
    }));
    route({
      method: "GET", path: `${proposalImage}/:fileId${suffix}`, id: `downloadItemProposalImage${label}`,
      description: `Download ${thumbnail ? "a WebP thumbnail of " : ""}proposal art.`,
      scope: "campaigns:read", input: { params: c.proposalImageParams }, output: "binary",
    }, (ctx, { params }) => campaigns.openCampaignItemImageBytes(ctx, {
      campaignId: params.campaignId, resourceId: params.proposalId, kind: "proposal", fileId: params.fileId, thumbnail,
    }));
  }
}
