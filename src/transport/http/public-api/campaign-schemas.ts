import { Type } from "@sinclair/typebox";

import { ImageDescriptorSchema } from "../../../platform/image-attachment.js";
import { MAX_IMAGE_BYTES } from "../../../platform/image-processing.js";
import { ObjectTemplateV1Schema, SystemPresentationSchema } from "../../../systems/implementation/package/schema/document.js";
import { DerivedBaseSchema, TemplateDefaultsSchema } from "../../../systems/implementation/package/schema/dynamic.js";
import { characterSchemas } from "./characters.js";
import { systemSchemas } from "./systems.js";
import * as s from "./schemas.js";

const { object, uuid, text, dateTime, nullable } = s;
const looseObject = Type.Object({}, { additionalProperties: true });
const count = Type.Integer({ minimum: 0 });
const campaignStatus = Type.Union([Type.Literal("active"), Type.Literal("archived")]);
const memberRole = Type.Union([Type.Literal("owner"), Type.Literal("co_gm"), Type.Literal("player")]);
const invitedRole = Type.Union([Type.Literal("player"), Type.Literal("co_gm")]);
const invitationStatus = Type.Union([
  Type.Literal("pending"), Type.Literal("accepted"), Type.Literal("declined"), Type.Literal("revoked"),
]);
const contentAudience = Type.Union([
  Type.Literal("gm_only"), Type.Literal("all_players"), Type.Literal("selected_players"), Type.Literal("owner_only"),
]);
const contentStatus = Type.Union([Type.Literal("active"), Type.Literal("deleted")]);
const templateKind = Type.Union([Type.Literal("item"), Type.Literal("spell"), Type.Literal("talent"), Type.Literal("effect")]);
const templateAudience = Type.Union([Type.Literal("all_players"), Type.Literal("gm_only"), Type.Literal("selected_players")]);
const templateGrants = Type.Array(object({ userId: uuid, generation: Type.Integer({ minimum: 1 }) }), { maxItems: 100 });
const proposalStatus = Type.Union([Type.Literal("pending"), Type.Literal("approved"), Type.Literal("rejected")]);
const imageType = Type.Union([Type.Literal("image/png"), Type.Literal("image/jpeg"), Type.Literal("image/webp")]);
const pageCursor = nullable(s.cursor);
const title = Type.String({ minLength: 1, maxLength: 200, pattern: "\\S" });
const description = Type.String({ maxLength: 10_000 });
const userIds = Type.Array(uuid, { maxItems: 100, uniqueItems: true });
const fraction = Type.Number({ minimum: 0, maximum: 1 });

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export const campaignId = object({ campaignId: uuid });
export const memberParams = object({ campaignId: uuid, userId: uuid });
export const invitationParams = object({ campaignId: uuid, invitationId: uuid });
export const campaignCharacterParams = object({ campaignId: uuid, characterId: uuid });
export const contentId = object({ contentId: uuid });
export const templateParams = object({ campaignId: uuid, templateId: uuid });
export const templateImageParams = object({ campaignId: uuid, templateId: uuid, fileId: uuid });
export const proposalParams = object({ campaignId: uuid, proposalId: uuid });
export const proposalImageParams = object({ campaignId: uuid, proposalId: uuid, fileId: uuid });
export const mediaParams = object({ campaignId: uuid, fileId: uuid });
export const sceneId = object({ sceneId: uuid });
export const tokenParams = object({ sceneId: uuid, tokenId: uuid });
export const displayParams = object({ campaignId: uuid, displayId: uuid });
export const pageQuery = object(s.page(s.cursor));
export const contentQuery = object({ ...s.page(s.cursor), status: Type.Optional(contentStatus) });
export const templateQuery = object({ ...s.page(s.cursor), kind: Type.Optional(templateKind), status: Type.Optional(campaignStatus) });
export const proposalQuery = object({ ...s.page(s.cursor), status: Type.Optional(proposalStatus) });
export const sceneLibraryQuery = object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })), cursor: Type.Optional(uuid) });

const campaignRevision = { expectedCampaignRevision: s.revision, idempotencyKey: s.key };
export const createCampaign = object({ systemVersionId: uuid, title, description: Type.Optional(description), idempotencyKey: s.key });
export const updateCampaign = object({ title: Type.Optional(title), description: Type.Optional(description), ...campaignRevision });
export const campaignCommand = object(campaignRevision);
export const changeRole = object({ role: invitedRole, ...campaignRevision });
export const issueInvitation = object({ intendedRole: invitedRole, expiresAt: Type.Optional(dateTime), ...campaignRevision });
export const rotateInvitation = object({ expectedInvitationRevision: s.revision, expiresAt: Type.Optional(dateTime), ...campaignRevision });
export const revokeInvitation = object({ expectedInvitationRevision: s.revision, ...campaignRevision });
const invitationToken = Type.String({
  minLength: 1, maxLength: 512,
  description: "Single-use invitation token delivered out of band. Send it only in request bodies; it is never logged.",
});
export const reviewInvitation = object({ token: invitationToken });
export const consumeInvitation = object({
  campaignId: uuid, token: invitationToken,
  expectedInvitationRevision: s.revision, reviewedAccessRevision: s.revision, idempotencyKey: s.key,
});
export const exportCampaign = object({ idempotencyKey: s.key });
export const createCampaignCharacter = object({
  name: Type.String({ minLength: 1, maxLength: 120, pattern: "\\S" }),
  entityDefinitionId: s.definitionId,
  initialValues: Type.Optional(s.values),
  controllerUserIds: Type.Optional(userIds),
  ...campaignRevision,
});
const placementRevision = { expectedCampaignRevision: s.revision, expectedCharacterRevision: s.revision, idempotencyKey: s.key };
export const assignControllers = object({ controllerUserIds: userIds, designateClaimants: Type.Optional(userIds), ...placementRevision });
export const claimCharacter = object(placementRevision);
export const adoptCharacter = object({
  ...placementRevision,
  acknowledgedDisclosure: Type.Boolean({
    description: "Acknowledges that all sheet contents, including GM edits, return to the original owner on departure.",
  }),
});
const contentText = { title: Type.Optional(Type.String({ maxLength: 200 })), body: Type.Optional(Type.String({ maxLength: 100_000 })),
  tags: Type.Optional(Type.Array(Type.String({ maxLength: 64 }), { maxItems: 32 })) };
export const createContent = object({
  ...contentText, audience: Type.Optional(contentAudience), grantedUserIds: Type.Optional(userIds), idempotencyKey: s.key,
});
const contentRevision = { expectedContentRevision: s.revision, idempotencyKey: s.key };
export const updateContent = object({ ...contentText, audience: Type.Optional(contentAudience), ...contentRevision });
export const contentCommand = object(contentRevision);
export const replaceGrants = object({ grantedUserIds: userIds, ...contentRevision });
export const previewContent = object({ targetUserId: uuid, contentId: Type.Optional(uuid) });
const templateContentInput = object({
  defaultValues: Type.Optional(TemplateDefaultsSchema),
  name: Type.String({ minLength: 1, maxLength: 200 }),
  description: Type.Optional(Type.String({ maxLength: 2000 })),
  notes: Type.Optional(Type.String({ maxLength: 2000 })),
  defaultQuantity: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
});
const templateRevision = { expectedTemplateRevision: s.revision, idempotencyKey: s.key };
export const createTemplate = object({
  kind: templateKind, audience: Type.Optional(templateAudience), grants: Type.Optional(templateGrants),
  baseTemplateId: Type.Optional(s.definitionId), content: templateContentInput, idempotencyKey: s.key,
});
export const updateTemplate = object({ content: templateContentInput, ...templateRevision });
export const templateCommand = object(templateRevision);
export const shareTemplate = object({ audience: templateAudience, grants: templateGrants, ...templateRevision });
export const previewTemplates = object({ targetUserId: uuid, ...s.page(s.cursor) });
const proposalContentInput = object({
  name: Type.String({ minLength: 1, maxLength: 200 }),
  description: Type.Optional(Type.String({ maxLength: 2000 })),
  notes: Type.Optional(Type.String({ maxLength: 2000 })),
  defaultQuantity: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
});
export const submitProposal = object({ kind: templateKind, content: proposalContentInput, idempotencyKey: s.key });
const proposalRevision = { expectedProposalRevision: s.revision, idempotencyKey: s.key };
export const approveProposal = object({ expectedImageRevision: Type.Optional(s.attachmentRevision), ...proposalRevision });
export const rejectProposal = object({
  expectedImageRevision: Type.Optional(s.attachmentRevision), reason: Type.Optional(Type.String({ maxLength: 2000 })), ...proposalRevision,
});
export const setTemplateImage = object({ ...templateRevision, ...s.imageUpload });
export const removeTemplateImage = object(templateRevision);
const proposalImageRevision = { ...proposalRevision, expectedImageRevision: s.attachmentRevision };
export const setProposalImage = object({ ...proposalImageRevision, ...s.imageUpload });
export const removeProposalImage = object(proposalImageRevision);
const uuidKey = Type.String({ format: "uuid", description: "UUID idempotency key shared with the browser media and scene commands." });
export const uploadMedia = object({
  name: Type.String({ minLength: 1, maxLength: 256 }), contentType: imageType,
  dataBase64: Type.String({ minLength: 1, maxLength: Math.ceil(MAX_IMAGE_BYTES / 3) * 4 }), idempotencyKey: uuidKey,
});
export const deleteMedia = object({ expectedRevision: s.revision, idempotencyKey: uuidKey });
export const createScene = object({ backgroundFileId: uuid, idempotencyKey: uuidKey });
const sceneRevision = { expectedSceneRevision: s.revision, idempotencyKey: uuidKey };
export const updateScene = object({ backgroundFileId: uuid, ...sceneRevision });
const fogOp = object({
  mode: Type.Union([Type.Literal("reveal"), Type.Literal("conceal")]),
  runs: Type.Array(object({ x: fraction, y: fraction, r: Type.Number({ exclusiveMinimum: 0 }) }), { minItems: 1, maxItems: 512 }),
});
export const fogEdit = object({ op: fogOp, ...sceneRevision });
export const placeToken = object({
  label: Type.String({ minLength: 1, maxLength: 256 }), x: fraction, y: fraction,
  size: Type.Number({ exclusiveMinimum: 0, maximum: 1 }), visible: Type.Boolean(), imageFileId: nullable(uuid), ...sceneRevision,
});
export const moveToken = object({ x: fraction, y: fraction, ...sceneRevision });
export const sceneCommand = object(sceneRevision);

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

const campaign = object({
  campaignId: uuid, ownerId: uuid, systemVersionId: uuid, title: text, description: text, status: campaignStatus,
  revision: s.revision, accessRevision: s.revision, archivedAt: Type.Union([dateTime, Type.Null()]),
  createdAt: dateTime, updatedAt: dateTime, presentation: Type.Optional(SystemPresentationSchema),
});
const member = object({
  campaignId: uuid, userId: uuid, role: memberRole, status: Type.Union([Type.Literal("active"), Type.Literal("removed")]),
  generation: count, displayName: Type.Optional(nullable(text)), createdAt: dateTime, updatedAt: dateTime,
});
const invitationMetadata = {
  invitationId: uuid, campaignId: uuid, intendedRole: invitedRole, status: invitationStatus,
  expiresAt: dateTime, invitationRevision: s.revision, issuedBy: uuid,
};
const contentSummary = {
  contentId: uuid, campaignId: uuid, creatorId: uuid, audience: contentAudience, title: text, tags: Type.Array(text),
  revision: s.revision, accessRevision: s.revision, status: contentStatus, createdAt: dateTime, updatedAt: dateTime,
};
const content = object({
  ...contentSummary, body: text, deletedAt: Type.Union([dateTime, Type.Null()]),
  grantedUserIds: Type.Optional(Type.Array(uuid, { description: "Present only for GMs and the creator." })),
});
const template = object({
  templateId: uuid, campaignId: uuid, creatorId: uuid, kind: templateKind, audience: templateAudience, grants: templateGrants,
  status: campaignStatus, revision: s.revision, contentRevision: s.revision,
  content: object({ ...templateContentInput.properties, base: Type.Optional(DerivedBaseSchema) }),
  image: Type.Optional(ImageDescriptorSchema), createdAt: dateTime, updatedAt: dateTime,
});
const proposal = object({
  proposalId: uuid, campaignId: uuid, submitterId: uuid, kind: templateKind, content: proposalContentInput, status: proposalStatus,
  revision: s.revision, image: Type.Optional(Type.Union([ImageDescriptorSchema, Type.Null()])),
  imageRevision: Type.Optional(count), createdAt: dateTime, updatedAt: dateTime,
  decision: Type.Union([object({ actorId: uuid, decidedAt: dateTime, reason: nullable(text) }), Type.Null()]),
  approvedTemplateId: nullable(uuid),
  eligibility: Type.Optional(object({
    canApprove: Type.Boolean(),
    reason: Type.Union([Type.Null(), ...(["already_decided", "campaign_archived", "submitter_inactive", "catalog_full"] as const)
      .map((reason) => Type.Literal(reason))]),
  })),
});
const media = object({
  fileId: uuid, campaignId: uuid, name: text, mediaType: imageType, sizeBytes: count, width: count, height: count,
  checksum: text, revision: s.revision,
});
const scene = object({
  sceneId: uuid, campaignId: uuid, revision: s.revision, backgroundFileId: uuid,
  fog: Type.Array(fogOp),
  tokens: Type.Array(object({
    tokenId: uuid, label: text, x: Type.Number(), y: Type.Number(), size: Type.Number(), visible: Type.Boolean(),
    imageFileId: nullable(uuid),
  })),
});

export const campaignSchemas = {
  Campaign: campaign,
  CampaignPage: object({
    campaigns: Type.Array(object({
      campaignId: uuid, title: text, status: campaignStatus, revision: s.revision, accessRevision: s.revision, updatedAt: dateTime,
    })),
    nextCursor: pageCursor,
  }),
  Member: member,
  MemberPage: object({ members: Type.Array(member), nextCursor: pageCursor }),
  IssuedInvitation: object({
    ...invitationMetadata,
    token: Type.Optional(Type.String({ description: "One-time token; present only on the first issue or rotate response." })),
    tokenUnavailable: Type.Optional(Type.Literal(true, {
      description: "Same-key replay marker: the token cannot be recovered. Rotate with a new key after a lost response.",
    })),
  }),
  InvitationPage: object({
    invitations: Type.Array(object({
      invitationId: uuid, intendedRole: invitedRole, status: invitationStatus, expiresAt: dateTime,
      invitationRevision: s.revision, issuedBy: uuid, createdAt: dateTime,
    })),
    nextCursor: pageCursor,
  }),
  InvitationReview: object({
    invitationId: uuid, campaignId: uuid, campaignTitle: text, systemVersionId: uuid, inviterDisplayName: text,
    intendedRole: invitedRole, expiresAt: dateTime, invitationRevision: s.revision, accessRevision: s.revision,
  }),
  InvitationAcceptance: object({ invitationId: uuid, campaignId: uuid, membership: member, membershipGeneration: count }),
  InvitationDeclination: object({ invitationId: uuid, campaignId: uuid, status: Type.Literal("declined") }),
  CampaignActivity: object({
    events: Type.Array(object({
      eventId: uuid, kind: text, actorId: uuid, sourceContentId: nullable(uuid), sourceRollId: nullable(text),
      requestId: text, occurredAt: dateTime,
    })),
    nextCursor: pageCursor,
  }),
  CampaignExport: object({
    exportVersion: Type.Literal(1),
    campaign: looseObject,
    members: Type.Array(looseObject),
    content: Type.Array(looseObject),
    activity: Type.Array(looseObject),
    rolls: Type.Array(looseObject),
    templates: Type.Optional(Type.Array(looseObject)),
    proposals: Type.Optional(Type.Array(looseObject)),
  }),
  CampaignCharacterPage: object({
    characters: Type.Array(object({
      characterId: uuid, campaignId: uuid, name: text, entityDefinitionId: s.definitionId, systemVersionId: uuid,
      revision: s.revision, lifecycle: s.lifecycle, placementGeneration: count, controllers: Type.Array(uuid), updatedAt: dateTime,
    })),
    nextCursor: pageCursor,
  }),
  ClaimableCharacterPage: object({
    characters: Type.Array(object({ characterId: uuid, name: text, revision: s.revision, lifecycle: s.lifecycle })),
    nextCursor: pageCursor,
  }),
  Content: content,
  ContentPage: object({ content: Type.Array(object(contentSummary)), nextCursor: pageCursor }),
  ContentPreview: object({
    content: Type.Union([Type.Array(object(contentSummary)), content], {
      description: "The target member's readable list, or one note when contentId was sent.",
    }),
  }),
  CampaignTemplate: template,
  CampaignTemplatePage: object({ templates: Type.Array(template), nextCursor: pageCursor }),
  TemplateBases: object({ templates: Type.Array(ObjectTemplateV1Schema) }),
  Proposal: proposal,
  ProposalPage: object({ proposals: Type.Array(proposal), nextCursor: pageCursor }),
  ProposalDecision: object({ proposal, template: Type.Union([template, Type.Null()]) }),
  CampaignImageState: object({
    revision: count, image: Type.Union([ImageDescriptorSchema, Type.Null()]), parentRevision: Type.Optional(s.revision),
  }),
  Media: media,
  MediaPage: object({ images: Type.Array(media), nextCursor: nullable(uuid) }),
  Scene: scene,
  ScenePage: object({ scenes: Type.Array(object({ sceneId: uuid, backgroundFileId: uuid, revision: s.revision })), nextCursor: nullable(uuid) }),
  DisplayCode: object({ code: Type.String({ description: "Single-use pairing code to enter on the table display." }) }),
  DisplayCredentials: object({
    displays: Type.Array(object({ displayId: uuid, campaignId: uuid, revokedAt: Type.Union([dateTime, Type.Null()]), createdAt: dateTime })),
  }),
  RevokedDisplay: object({ displayId: uuid }),
};

export const outputSchemas = { ...systemSchemas, ...characterSchemas, ...campaignSchemas };
