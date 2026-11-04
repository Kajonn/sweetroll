import type { Pool, PoolClient } from "pg";
import type { RequestContext } from "../systems/authoring.js";
import type { RuntimeStateV1 } from "../systems/runtime.js";
import { hashInput } from "../systems/implementation/authoring/assess.js";
import { authorizeCharacterImage, type CharacterImageAuthority } from "./image-authority.js";
import { ImageProcessingError, decodeImageBase64, type ImageContentType, type ImageScanner } from "../platform/image-processing.js";
import { createClamScanner } from "../platform/image-scanner.js";
import type { ImageAttachmentError, ImageAttachmentResult, ImageAttachmentState } from "../platform/image-attachment.js";
import { discardPreparedItemImage, imageChecksum, imageDescriptorMatches, insertPreparedItemImage, itemImageDescriptor, ItemImageMissing, loadItemImage, prepareItemImage, readItemImageBytes, type PreparedItemImage, type ItemImageRecord } from "../platform/item-image-storage.js";

type Location = { characterId: string; entryId: string };
type Command = Location & { expectedCharacterRevision: number; expectedImageRevision: number; idempotencyKey: string };
type Upload = Command & { description: string; contentType: ImageContentType; dataBase64: string };
export interface CharacterEntryImages {
  openEntryImage(ctx: RequestContext, input: Location): Promise<ImageAttachmentResult<ImageAttachmentState>>;
  setEntryImage(ctx: RequestContext, input: Upload): Promise<ImageAttachmentResult<ImageAttachmentState>>;
  removeEntryImage(ctx: RequestContext, input: Command): Promise<ImageAttachmentResult<ImageAttachmentState>>;
  openEntryImageBytes(ctx: RequestContext, input: Location & { fileId?: string; thumbnail: boolean }): Promise<ImageAttachmentResult<{ bytes: Buffer; contentType: ImageContentType }>>;
}
class Denial extends Error { constructor(readonly error: ImageAttachmentError) { super(error.message); } }
const deny = (code: ImageAttachmentError["code"], message: string, latestRevision?: number): never => { throw new Denial({ code, message, ...(latestRevision === undefined ? {} : { latestRevision }) }); };
const missing = (): never => deny("not_found", "The requested entry image does not exist.");
export function createCharacterEntryImages(options: { pool: Pool; scanImage?: ImageScanner }): CharacterEntryImages {
  const pool = options.pool, scan = options.scanImage ?? createClamScanner();
  function failure<T>(cause: unknown): ImageAttachmentResult<T> { return { ok: false, error: cause instanceof Denial ? cause.error : cause instanceof ImageProcessingError ? { code: cause.code, message: cause.message } : cause instanceof ItemImageMissing ? { code: "not_found", message: "The requested entry image does not exist." } : { code: "internal", message: "The entry image could not be loaded or saved. Try again later." } }; }
  async function transaction<T>(write: boolean, work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try { await client.query(write ? "BEGIN" : "BEGIN READ ONLY"); const value = await work(client); await client.query("COMMIT"); return value; }
    catch (cause) { await client.query("ROLLBACK"); throw cause; } finally { client.release(); }
  }
  async function current(client: PoolClient, loc: Location): Promise<{ state: ImageAttachmentState; asset: ItemImageRecord | null }> {
    const row = (await client.query<{ state_json: RuntimeStateV1 }>("SELECT state_json FROM characters WHERE id=$1", [loc.characterId])).rows[0];
    const entry = row?.state_json.entries?.[loc.entryId]; if (!entry || entry.entryId !== loc.entryId) return missing();
    const link = (await client.query<{ revision: number; pinned_asset_id: string | null; asset_id: string | null; description: string; overridden: boolean }>("SELECT * FROM character_entry_images WHERE character_id=$1 AND entry_id=$2", [loc.characterId, loc.entryId])).rows[0];
    let image = entry.image ?? null;
    let asset: ItemImageRecord | null = null;
    if (link?.overridden) { if (link.asset_id) { asset = await loadItemImage(client, link.asset_id); image = itemImageDescriptor(asset, link.description); } else image = null; }
    else if (image) { if (link?.pinned_asset_id !== image.fileId) return missing(); asset = await loadItemImage(client, image.fileId); if (!imageDescriptorMatches(asset, image)) return missing(); }
    return { state: { revision: link?.revision ?? 0, image }, asset };
  }
  async function authority(client: PoolClient, ctx: RequestContext, loc: Location, write: boolean) {
    const auth = await authorizeCharacterImage(client, ctx.actorId, loc.characterId, write); if (!auth) return missing();
    return { auth, ...(await current(client, loc)) };
  }
  function check(auth: CharacterImageAuthority, state: ImageAttachmentState, command: Command) {
    if (!auth.active || auth.revision !== command.expectedCharacterRevision || state.revision !== command.expectedImageRevision) return deny("conflict", "The character or entry image changed. Refresh before trying again.", state.revision);
  }
  async function replay(client: PoolClient, ctx: RequestContext, command: Command, hash: string, state: ImageAttachmentState) {
    const row = (await client.query<{ input_hash: string; result_json: ImageAttachmentState; expires_at: Date }>("SELECT input_hash,result_json,expires_at FROM item_image_receipts WHERE actor_id=$1 AND idempotency_key=$2", [ctx.actorId, command.idempotencyKey])).rows[0];
    if (!row) return null;
    if (row.input_hash !== hash) return deny("idempotency_mismatch", "This image request key was used with different input.");
    if (row.expires_at <= new Date() || hashInput(row.result_json) !== hashInput(state)) return deny("result_unavailable", "The entry image changed after this request. Refresh to see its current art.", state.revision);
    return row.result_json;
  }
  async function change(ctx: RequestContext, command: Command, upload: Upload | null): Promise<ImageAttachmentResult<ImageAttachmentState>> {
    let prepared: PreparedItemImage | undefined, committed = false;
    try {
      if (!Number.isSafeInteger(command.expectedCharacterRevision) || command.expectedCharacterRevision < 1 || !Number.isSafeInteger(command.expectedImageRevision) || command.expectedImageRevision < 0 || typeof command.idempotencyKey !== "string" || !command.idempotencyKey || command.idempotencyKey.length > 256) return deny("bad_request", "Expected revisions and an image request key are required.");
      const hash = hashInput({ operation: "character_entry_image", characterId: command.characterId, entryId: command.entryId, expectedCharacterRevision: command.expectedCharacterRevision, expectedImageRevision: command.expectedImageRevision, idempotencyKey: command.idempotencyKey, ...(upload ? { description: upload.description, contentType: upload.contentType, checksum: imageChecksum(decodeImageBase64(upload.dataBase64)) } : { remove: true }) });
      const preflight = await transaction(false, async client => { const parent = await authority(client, ctx, command, false); const stored = await replay(client, ctx, command, hash, parent.state); if (stored) return { replay: stored, campaignId: parent.auth.campaignId }; check(parent.auth, parent.state, command); return { replay: null, campaignId: parent.auth.campaignId }; });
      if (preflight.replay) return { ok: true, value: preflight.replay };
      if (upload) prepared = await prepareItemImage(upload, scan, ctx.actorId, preflight.campaignId);
      const image = prepared;
      const state = await transaction(true, async client => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`item-image-request:${ctx.actorId}:${command.idempotencyKey}`]);
        const parent = await authority(client, ctx, command, true), saved = await replay(client, ctx, command, hash, parent.state); if (saved) return saved;
        check(parent.auth, parent.state, command);
        if (parent.auth.campaignId !== preflight.campaignId) return deny("conflict", "Character placement changed. Refresh before uploading its art.");
        if (image) await insertPreparedItemImage(client, image);
        const descriptor = image ? itemImageDescriptor(image.record, image.description) : null;
        await client.query("INSERT INTO character_entry_images(character_id,entry_id,asset_id,description,overridden,revision) VALUES($1,$2,$3,$4,true,$5) ON CONFLICT(character_id,entry_id) DO UPDATE SET asset_id=EXCLUDED.asset_id,description=EXCLUDED.description,overridden=true,revision=EXCLUDED.revision", [command.characterId, command.entryId, descriptor?.fileId ?? null, descriptor?.description ?? "", parent.state.revision + 1]);
        const next = (await current(client, command)).state;
        await client.query("INSERT INTO character_audit_records(character_id,actor_id,kind,summary,request_id) VALUES($1,$2,'entry_image_changed','Entry image changed',$3)", [command.characterId, ctx.actorId, ctx.requestId]);
        await client.query("INSERT INTO item_image_receipts(actor_id,idempotency_key,input_hash,result_json,expires_at) VALUES($1,$2,$3,$4::jsonb,$5)", [ctx.actorId, command.idempotencyKey, hash, JSON.stringify(next), new Date(Date.now() + 30 * 86400000)]);
        return next;
      });
      committed = !!image && state.image?.fileId === image.record.id;
      return { ok: true, value: state };
    } catch (cause) { return failure(cause); } finally { if (prepared && !committed) await discardPreparedItemImage(prepared); }
  }
  return {
    async openEntryImage(ctx, loc) { try { return { ok: true, value: await transaction(false, async client => (await authority(client, ctx, loc, false)).state) }; } catch (cause) { return failure(cause); } },
    setEntryImage: (ctx, body) => change(ctx, body, body),
    removeEntryImage: (ctx, body) => change(ctx, body, null),
    async openEntryImageBytes(ctx, loc) {
      try {
        const read = async (client: PoolClient) => { const { asset } = await authority(client, ctx, loc, false); if (!asset || (loc.fileId && loc.fileId !== asset.id)) return missing(); return asset; };
        const asset = await transaction(false, read), bytes = await readItemImageBytes(asset, loc.thumbnail);
        const currentAsset = await transaction(false, read); if (currentAsset.id !== asset.id) return missing();
        return { ok: true, value: { bytes, contentType: loc.thumbnail ? "image/webp" : asset.media_type } };
      } catch (cause) { return failure(cause); }
    },
  };
}
