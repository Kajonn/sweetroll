import type { Pool, PoolClient } from "pg";
import type { RequestContext } from "../systems/authoring.js";
import { hashInput } from "../systems/implementation/authoring/assess.js";
import { ImageProcessingError, decodeImageBase64, type ImageContentType, type ImageScanner } from "../platform/image-processing.js";
import { createClamScanner } from "../platform/image-scanner.js";
import type { ImageAttachmentError, ImageAttachmentResult, ImageAttachmentState } from "../platform/image-attachment.js";
import { discardPreparedItemImage, imageChecksum, insertPreparedItemImage, itemImageDescriptor, ItemImageMissing, loadItemImage, prepareItemImage, readItemImageBytes, type PreparedItemImage } from "../platform/item-image-storage.js";
import { createCampaignPersistenceRepository } from "./persistence.js";
import { createTemplateRepository } from "./templatePersistence.js";
import { createProposalRepository } from "./proposalPersistence.js";
import { isActiveMember, isGameMaster } from "./policy.js";
import { canReadTemplate } from "./templatePolicy.js";

type TemplateLocation = { campaignId: string; templateId: string };
type ProposalLocation = { campaignId: string; proposalId: string };
type Key = { idempotencyKey: string };
type Upload = { description: string; contentType: ImageContentType; dataBase64: string };
type TemplateCommand = TemplateLocation & Key & { expectedTemplateRevision: number };
type ProposalCommand = ProposalLocation & Key & { expectedProposalRevision: number; expectedImageRevision: number };
type Location = { campaignId: string; resourceId: string; kind: "template" | "proposal" };
type Command = Location & Key & { expectedRevision: number; expectedParentRevision?: number };
export interface CampaignItemImages {
  openTemplateImage(ctx: RequestContext, input: TemplateLocation): Promise<ImageAttachmentResult<ImageAttachmentState>>;
  setTemplateImage(ctx: RequestContext, input: TemplateCommand & Upload): Promise<ImageAttachmentResult<ImageAttachmentState>>;
  removeTemplateImage(ctx: RequestContext, input: TemplateCommand): Promise<ImageAttachmentResult<ImageAttachmentState>>;
  openProposalImage(ctx: RequestContext, input: ProposalLocation): Promise<ImageAttachmentResult<ImageAttachmentState>>;
  setProposalImage(ctx: RequestContext, input: ProposalCommand & Upload): Promise<ImageAttachmentResult<ImageAttachmentState>>;
  removeProposalImage(ctx: RequestContext, input: ProposalCommand): Promise<ImageAttachmentResult<ImageAttachmentState>>;
  openCampaignItemImageBytes(ctx: RequestContext, input: Location & { fileId: string; thumbnail: boolean }): Promise<ImageAttachmentResult<{ bytes: Buffer; contentType: ImageContentType }>>;
}
class Denial extends Error { constructor(readonly error: ImageAttachmentError) { super(error.message); } }
const deny = (code: ImageAttachmentError["code"], message: string, latestRevision?: number): never => { throw new Denial({ code, message, ...(latestRevision === undefined ? {} : { latestRevision }) }); };
const missing = (): never => deny("not_found", "The requested image does not exist.");
export function createCampaignItemImages(options: { pool: Pool; scanImage?: ImageScanner }): CampaignItemImages {
  const pool = options.pool, scan = options.scanImage ?? createClamScanner();
  const campaigns = createCampaignPersistenceRepository(pool), catalog = createTemplateRepository(pool), proposals = createProposalRepository();
  function failure<T>(cause: unknown): ImageAttachmentResult<T> {
    return { ok: false, error: cause instanceof Denial ? cause.error : cause instanceof ImageProcessingError ? { code: cause.code, message: cause.message } : cause instanceof ItemImageMissing ? { code: "not_found", message: "The requested image does not exist." } : { code: "internal", message: "The image could not be loaded or saved. Try again later." } };
  }
  async function transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try { await client.query("BEGIN"); const value = await work(client); await client.query("COMMIT"); return value; }
    catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
  async function parent(client: PoolClient, ctx: RequestContext, loc: Location) {
    const campaign = await campaigns.lockCampaign(client, loc.campaignId);
    const member = campaign ? await campaigns.loadMembership(client, loc.campaignId, ctx.actorId) : null;
    if (!campaign || !isActiveMember(member)) return missing();
    if (loc.kind === "template") {
      const template = await catalog.read(client, { campaignId: loc.campaignId, templateId: loc.resourceId });
      if (!template || !canReadTemplate(template, member)) return missing();
      return { template, proposal: null, editable: isGameMaster(member), active: campaign.status === "active" && template.status === "active", state: { revision: template.revision, image: template.image ?? null } as ImageAttachmentState };
    }
    const proposal = await proposals.read(client, { campaignId: loc.campaignId, proposalId: loc.resourceId });
    if (!proposal || (!isGameMaster(member) && (proposal.submitterId !== ctx.actorId || proposal.membershipGeneration !== member.generation))) return missing();
    return { template: null, proposal, editable: member.role === "player" && proposal.submitterId === ctx.actorId && proposal.membershipGeneration === member.generation, active: campaign.status === "active" && proposal.status === "pending", state: { revision: proposal.imageRevision ?? 0, image: proposal.image ?? null, parentRevision: proposal.revision } as ImageAttachmentState };
  }
  function check(current: Awaited<ReturnType<typeof parent>>, command: Command) {
    if (!current.editable) return missing();
    if (!current.active || command.expectedRevision !== current.state.revision || command.expectedParentRevision !== current.state.parentRevision) return deny("conflict", "The item or its image changed. Refresh and review before trying again.", current.state.revision);
  }
  async function replay(client: PoolClient, ctx: RequestContext, command: Command, hash: string, state: ImageAttachmentState) {
    const row = (await client.query<{ input_hash: string; result_json: ImageAttachmentState; expires_at: Date }>("SELECT input_hash,result_json,expires_at FROM item_image_receipts WHERE actor_id=$1 AND idempotency_key=$2", [ctx.actorId, command.idempotencyKey])).rows[0];
    if (!row) return null;
    if (row.input_hash !== hash) return deny("idempotency_mismatch", "This image request key was used with different input.");
    if (row.expires_at <= new Date() || row.result_json.revision !== state.revision || row.result_json.parentRevision !== state.parentRevision) return deny("result_unavailable", "The item changed after this request. Refresh its current image.", state.revision);
    return row.result_json;
  }
  async function change(ctx: RequestContext, command: Command, upload: Upload | null): Promise<ImageAttachmentResult<ImageAttachmentState>> {
    let prepared: PreparedItemImage | undefined, committed = false;
    try {
      if (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < (command.kind === "proposal" ? 0 : 1) || (command.kind === "proposal" && (!Number.isSafeInteger(command.expectedParentRevision) || command.expectedParentRevision! < 1)) || typeof command.idempotencyKey !== "string" || !command.idempotencyKey || command.idempotencyKey.length > 256) return deny("bad_request", "Expected revisions and an image request key are required.");
      const hash = hashInput({ operation: "campaign_item_image", ...command, ...(upload ? { description: upload.description, contentType: upload.contentType, checksum: imageChecksum(decodeImageBase64(upload.dataBase64)) } : { remove: true }) });
      const previous = await transaction(async client => { const current = await parent(client, ctx, command); const saved = await replay(client, ctx, command, hash, current.state); if (saved) return saved; check(current, command); return null; });
      if (previous) return { ok: true, value: previous };
      if (upload) prepared = await prepareItemImage(upload, scan, ctx.actorId, command.campaignId);
      const image = prepared;
      const state = await transaction(async client => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`item-image-request:${ctx.actorId}:${command.idempotencyKey}`]);
        const current = await parent(client, ctx, command), saved = await replay(client, ctx, command, hash, current.state); if (saved) return saved;
        check(current, command);
        if (image) await insertPreparedItemImage(client, image);
        const descriptor = image ? itemImageDescriptor(image.record, image.description) : null;
        let next: ImageAttachmentState;
        if (current.template) {
          const updated = await catalog.update(client, current.template, current.template.content, ctx.actorId, descriptor);
          next = { revision: updated.revision, image: updated.image ?? null };
        } else {
          const revision = current.state.revision + 1;
          await client.query("INSERT INTO campaign_proposal_images(proposal_id,asset_id,description,revision) VALUES($1,$2,$3,$4) ON CONFLICT(proposal_id) DO UPDATE SET asset_id=EXCLUDED.asset_id,description=EXCLUDED.description,revision=EXCLUDED.revision", [command.resourceId, descriptor?.fileId ?? null, descriptor?.description ?? "", revision]);
          next = { revision, image: descriptor, parentRevision: current.proposal!.revision };
        }
        await campaigns.appendAudit(client, { campaignId: command.campaignId, actorId: ctx.actorId, kind: "item_image_changed", summary: "Campaign item artwork changed", requestId: ctx.requestId });
        await client.query("INSERT INTO item_image_receipts(actor_id,idempotency_key,input_hash,result_json,expires_at) VALUES($1,$2,$3,$4::jsonb,$5)", [ctx.actorId, command.idempotencyKey, hash, JSON.stringify(next), new Date(Date.now() + 30 * 86400000)]);
        return next;
      });
      committed = !!image && state.image?.fileId === image.record.id;
      return { ok: true, value: state };
    } catch (cause) { return failure(cause); } finally { if (prepared && !committed) await discardPreparedItemImage(prepared); }
  }
  const template = (body: TemplateCommand): Command => ({ campaignId: body.campaignId, resourceId: body.templateId, kind: "template", expectedRevision: body.expectedTemplateRevision, idempotencyKey: body.idempotencyKey });
  const proposal = (body: ProposalCommand): Command => ({ campaignId: body.campaignId, resourceId: body.proposalId, kind: "proposal", expectedRevision: body.expectedImageRevision, expectedParentRevision: body.expectedProposalRevision, idempotencyKey: body.idempotencyKey });
  async function open(ctx: RequestContext, loc: Location): Promise<ImageAttachmentResult<ImageAttachmentState>> { try { return { ok: true, value: await transaction(async client => (await parent(client, ctx, loc)).state) }; } catch (cause) { return failure(cause); } }
  return {
    openTemplateImage: (ctx, body) => open(ctx, { campaignId: body.campaignId, resourceId: body.templateId, kind: "template" }),
    openProposalImage: (ctx, body) => open(ctx, { campaignId: body.campaignId, resourceId: body.proposalId, kind: "proposal" }),
    setTemplateImage: (ctx, body) => change(ctx, template(body), body),
    removeTemplateImage: (ctx, body) => change(ctx, template(body), null),
    setProposalImage: (ctx, body) => change(ctx, proposal(body), body),
    removeProposalImage: (ctx, body) => change(ctx, proposal(body), null),
    async openCampaignItemImageBytes(ctx, body) {
      try {
        const read = async (client: PoolClient) => { const current = await parent(client, ctx, body); if (!current.state.image || current.state.image.fileId !== body.fileId) return missing(); return loadItemImage(client, body.fileId); };
        const record = await transaction(read), bytes = await readItemImageBytes(record, body.thumbnail);
        await transaction(read);
        return { ok: true, value: { bytes, contentType: body.thumbnail ? "image/webp" : record.media_type } };
      } catch (cause) { return failure(cause); }
    },
  };
}
