import type { Pool, PoolClient } from "pg";
import type { RequestContext } from "./authoring.js";
import type { SystemDocumentV1, SystemPackageV1 } from "./implementation/package/schema/index.js";
import { documentChecksum, hashInput } from "./implementation/authoring/assess.js";
import { assertSystemImages } from "./implementation/persistence/image-references.js";
import { ImageProcessingError, decodeImageBase64, type ImageContentType, type ImageScanner } from "../platform/image-processing.js";
import { createClamScanner } from "../platform/image-scanner.js";
import type { ImageAttachmentError, ImageAttachmentResult, ImageAttachmentState } from "../platform/image-attachment.js";
import { discardPreparedItemImage, imageChecksum, insertPreparedItemImage, itemImageDescriptor, ItemImageMissing, loadItemImage, prepareItemImage, readItemImageBytes, type PreparedItemImage } from "../platform/item-image-storage.js";

export type SystemItemImageLocation = { systemId: string; templateId: string };
export type SystemItemImageCommand = SystemItemImageLocation & { expectedRevision: number; idempotencyKey: string };
export type UploadSystemItemImage = SystemItemImageCommand & { description: string; contentType: ImageContentType; dataBase64: string };
export type SystemItemImageBytes = { source: { kind: "draft"; systemId: string } | { kind: "version"; versionId: string }; templateId: string; fileId: string; thumbnail: boolean };
export interface SystemItemImages {
  openItemImage(ctx: RequestContext, input: SystemItemImageLocation): Promise<ImageAttachmentResult<ImageAttachmentState>>;
  setItemImage(ctx: RequestContext, input: UploadSystemItemImage): Promise<ImageAttachmentResult<ImageAttachmentState>>;
  removeItemImage(ctx: RequestContext, input: SystemItemImageCommand): Promise<ImageAttachmentResult<ImageAttachmentState>>;
  openItemImageBytes(ctx: RequestContext, input: SystemItemImageBytes): Promise<ImageAttachmentResult<{ bytes: Buffer; contentType: ImageContentType }>>;
}
class Denial extends Error { constructor(readonly error: ImageAttachmentError) { super(error.message); } }
const deny = (code: ImageAttachmentError["code"], message: string, latestRevision?: number): never => { throw new Denial({ code, message, ...(latestRevision === undefined ? {} : { latestRevision }) }); };
const missing = (): never => deny("not_found", "The requested image does not exist.");
export function createSystemItemImages(options: { pool: Pool; scanImage?: ImageScanner }): SystemItemImages {
  const scan = options.scanImage ?? createClamScanner(), pool = options.pool;
  const failure = <T>(cause: unknown): ImageAttachmentResult<T> => ({ ok: false, error: cause instanceof Denial ? cause.error : cause instanceof ImageProcessingError ? { code: cause.code, message: cause.message } : cause instanceof ItemImageMissing ? { code: "not_found", message: "The requested image does not exist." } : { code: "internal", message: "The image could not be loaded or saved. Try again later." } });
  async function transaction<T>(write: boolean, work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try { await client.query(write ? "BEGIN" : "BEGIN READ ONLY"); const value = await work(client); await client.query("COMMIT"); return value; }
    catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
  async function draft(client: PoolClient, ctx: RequestContext, input: SystemItemImageLocation, write = false) {
    const system = (await client.query<{ owner_id: string | null; lifecycle: string }>(`SELECT owner_id,lifecycle FROM systems WHERE id=$1${write ? " FOR UPDATE" : ""}`, [input.systemId])).rows[0];
    if (!system || system.owner_id !== ctx.actorId) return missing();
    const row = (await client.query<{ revision: number; document_json: SystemDocumentV1 }>(`SELECT revision,document_json FROM system_drafts WHERE system_id=$1${write ? " FOR UPDATE" : ""}`, [input.systemId])).rows[0];
    if (!row) return missing();
    const template = row.document_json.templates?.find(t => t.id === input.templateId);
    if (!template) return missing();
    return { active: system.lifecycle === "active", document: row.document_json, template, state: { revision: row.revision, image: template.image ?? null } satisfies ImageAttachmentState };
  }
  async function replay(client: PoolClient, ctx: RequestContext, command: SystemItemImageCommand, hash: string, state: ImageAttachmentState) {
    const row = (await client.query<{ input_hash: string; result_json: ImageAttachmentState; expires_at: Date }>("SELECT input_hash,result_json,expires_at FROM item_image_receipts WHERE actor_id=$1 AND idempotency_key=$2", [ctx.actorId, command.idempotencyKey])).rows[0];
    if (!row) return null;
    if (row.input_hash !== hash) return deny("idempotency_mismatch", "This image request key was used with different input.");
    if (row.expires_at <= new Date() || row.result_json.revision !== state.revision) return deny("result_unavailable", "The draft changed after this request. Refresh and review its current image.", state.revision);
    return row.result_json;
  }
  async function change(ctx: RequestContext, command: SystemItemImageCommand, upload: UploadSystemItemImage | null): Promise<ImageAttachmentResult<ImageAttachmentState>> {
    let prepared: PreparedItemImage | undefined, committed = false;
    try {
      if (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 1 || typeof command.idempotencyKey !== "string" || !command.idempotencyKey || command.idempotencyKey.length > 256) return deny("bad_request", "Expected revision and an image request key are required.");
      const hash = hashInput({ operation: "system_item_image", systemId: command.systemId, templateId: command.templateId, expectedRevision: command.expectedRevision, idempotencyKey: command.idempotencyKey, ...(upload ? { description: upload.description, contentType: upload.contentType, checksum: imageChecksum(decodeImageBase64(upload.dataBase64)) } : { remove: true }) });
      const previous = await transaction(false, async client => {
        const current = await draft(client, ctx, command);
        const stored = await replay(client, ctx, command, hash, current.state); if (stored) return stored;
        if (!current.active || current.state.revision !== command.expectedRevision) return deny("conflict", "The draft changed or is archived. Refresh before changing its art.", current.state.revision);
        return null;
      });
      if (previous) return { ok: true, value: previous };
      if (upload) prepared = await prepareItemImage(upload, scan, ctx.actorId, null);
      const image = prepared;
      const next = await transaction(true, async client => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`item-image-request:${ctx.actorId}:${command.idempotencyKey}`]);
        const current = await draft(client, ctx, command, true);
        const stored = await replay(client, ctx, command, hash, current.state); if (stored) return stored;
        if (!current.active || current.state.revision !== command.expectedRevision) return deny("conflict", "The draft changed or is archived. Refresh before changing its art.", current.state.revision);
        if (image) {
          await insertPreparedItemImage(client, image);
          await client.query("INSERT INTO system_image_permissions(system_id,asset_id) VALUES($1,$2)", [command.systemId, image.record.id]);
          current.template.image = itemImageDescriptor(image.record, image.description);
        } else delete current.template.image;
        await assertSystemImages(client, command.systemId, current.document);
        const revision = current.state.revision + 1;
        await client.query("UPDATE system_drafts SET revision=$2,document_json=$3::jsonb,source_checksum=$4,updated_by=$5,updated_at=now() WHERE system_id=$1", [command.systemId, revision, JSON.stringify(current.document), documentChecksum(current.document), ctx.actorId]);
        await client.query("INSERT INTO system_audit_records(system_id,actor_id,kind,summary,request_id) VALUES($1,$2,'item_image_changed','System item image changed',$3)", [command.systemId, ctx.actorId, ctx.requestId]);
        const state = { revision, image: current.template.image ?? null };
        await client.query("INSERT INTO item_image_receipts(actor_id,idempotency_key,input_hash,result_json,expires_at) VALUES($1,$2,$3,$4::jsonb,$5)", [ctx.actorId, command.idempotencyKey, hash, JSON.stringify(state), new Date(Date.now() + 30 * 86400000)]);
        return state;
      });
      committed = !!image && next.image?.fileId === image.record.id;
      return { ok: true, value: next };
    } catch (error) { return failure(error); }
    finally { if (prepared && !committed) await discardPreparedItemImage(prepared); }
  }
  async function authorizedImage(client: PoolClient, ctx: RequestContext, input: SystemItemImageBytes) {
    let pkg: SystemDocumentV1 | SystemPackageV1, systemId: string;
    if (input.source.kind === "draft") { systemId = input.source.systemId; pkg = (await draft(client, ctx, { systemId, templateId: input.templateId })).document; }
    else {
      const row = (await client.query<{ system_id: string; package_json: SystemPackageV1 }>("SELECT v.system_id,v.package_json FROM system_versions v JOIN systems s ON s.id=v.system_id WHERE v.id=$1 AND v.lifecycle='published' AND s.lifecycle='active' AND (s.owner_id=$2 OR s.access IN ('public','link'))", [input.source.versionId, ctx.actorId])).rows[0];
      if (!row) return missing(); systemId = row.system_id; pkg = row.package_json;
    }
    const image = pkg.templates?.find(t => t.id === input.templateId)?.image;
    if (!image || image.fileId !== input.fileId) return missing();
    await assertSystemImages(client, systemId, pkg);
    return loadItemImage(client, image.fileId);
  }
  return {
    async openItemImage(ctx, input) { try { return { ok: true, value: await transaction(false, async client => (await draft(client, ctx, input)).state) }; } catch (error) { return failure(error); } },
    setItemImage: (ctx, input) => change(ctx, input, input),
    removeItemImage: (ctx, input) => change(ctx, input, null),
    async openItemImageBytes(ctx, input) {
      try {
        const image = await transaction(false, client => authorizedImage(client, ctx, input));
        const bytes = await readItemImageBytes(image, input.thumbnail);
        await transaction(false, client => authorizedImage(client, ctx, input));
        return { ok: true, value: { bytes, contentType: input.thumbnail ? "image/webp" : image.media_type } };
      } catch (error) { return failure(error); }
    },
  };
}
