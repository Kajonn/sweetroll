/** Private byte/metadata mechanics. Each caller must authorize its own parent. */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PoolClient } from "pg";
import { resolveMediaRoot } from "./image-storage.js";
import { ImageProcessingError, processImage, type ImageContentType, type ImageScanner } from "./image-processing.js";
import type { ImageDescriptor } from "./image-attachment.js";

export type ItemImageRecord = { id: string; storage_key: string; created_by: string; campaign_id: string | null; media_type: ImageContentType; width: number; height: number; size_bytes: number; thumbnail_bytes: number; checksum: string; thumbnail_checksum: string };
export type PreparedItemImage = { record: ItemImageRecord; description: string };
const root = () => join(resolveMediaRoot(), "items");
export const imageChecksum = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export class ItemImageMissing extends Error {}
export const itemImageDescriptor = (record: ItemImageRecord, description: string): ImageDescriptor => ({ fileId: record.id, description, contentType: record.media_type, width: record.width, height: record.height, sizeBytes: record.size_bytes, checksum: record.checksum });
export function imageDescriptorMatches(record: ItemImageRecord, image: ImageDescriptor): boolean {
  return image.fileId === record.id && image.contentType === record.media_type && image.width === record.width && image.height === record.height && image.sizeBytes === record.size_bytes && image.checksum === record.checksum;
}
export async function discardPreparedItemImage(image: PreparedItemImage) {
  for (const name of [image.record.storage_key, `${image.record.storage_key}.thumb.webp`]) await unlink(join(root(), name)).catch(() => {});
}
export async function prepareItemImage(input: { dataBase64: string; contentType: ImageContentType; description: string }, scan: ImageScanner, actorId: string, campaignId: string | null): Promise<PreparedItemImage> {
  if (typeof input.description !== "string" || !input.description.trim() || input.description.length > 500) throw new ImageProcessingError("bad_request", "Describe the image in 1–500 characters.");
  const safe = await processImage(input, scan), id = randomUUID();
  const image: PreparedItemImage = { description: input.description.trim(), record: { id, storage_key: id, created_by: actorId, campaign_id: campaignId, media_type: safe.contentType, width: safe.width, height: safe.height, size_bytes: safe.bytes.length, thumbnail_bytes: safe.thumbnail.length, checksum: safe.checksum, thumbnail_checksum: imageChecksum(safe.thumbnail) } };
  await mkdir(root(), { recursive: true });
  await writeFile(join(root(), id), safe.bytes, { mode: 0o600, flag: "wx" });
  try { await writeFile(join(root(), `${id}.thumb.webp`), safe.thumbnail, { mode: 0o600, flag: "wx" }); }
  catch (error) { await discardPreparedItemImage(image); throw error; }
  return image;
}
export async function insertPreparedItemImage(client: PoolClient, image: PreparedItemImage) {
  const row = image.record;
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`item-image-owner:${row.created_by}`]);
  const usage = (await client.query<{ count: string; bytes: string }>("SELECT count(*)::text count,COALESCE(sum(size_bytes+thumbnail_bytes),0)::text bytes FROM item_image_assets WHERE created_by=$1 OR ($2::uuid IS NOT NULL AND campaign_id=$2)", [row.created_by, row.campaign_id])).rows[0]!;
  if (Number(usage.count) >= 256 || Number(usage.bytes) + row.size_bytes + row.thumbnail_bytes > 100 * 1024 * 1024) throw new ImageProcessingError("too_large", "Item image storage has reached its 100 MiB or 256 image quota.");
  await client.query("INSERT INTO item_image_assets(id,storage_key,created_by,campaign_id,media_type,width,height,size_bytes,thumbnail_bytes,checksum,thumbnail_checksum) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)", [row.id, row.storage_key, row.created_by, row.campaign_id, row.media_type, row.width, row.height, row.size_bytes, row.thumbnail_bytes, row.checksum, row.thumbnail_checksum]);
}
export async function loadItemImage(client: PoolClient, id: string): Promise<ItemImageRecord> {
  const row = (await client.query<ItemImageRecord>("SELECT * FROM item_image_assets WHERE id=$1", [id])).rows[0];
  if (!row) throw new ItemImageMissing(); return row;
}
export async function readItemImageBytes(record: ItemImageRecord, thumbnail: boolean): Promise<Buffer> {
  const bytes = await readFile(join(root(), thumbnail ? `${record.storage_key}.thumb.webp` : record.storage_key)).catch(() => { throw new ItemImageMissing(); });
  if (imageChecksum(bytes) !== (thumbnail ? record.thumbnail_checksum : record.checksum)) throw new ItemImageMissing();
  return bytes;
}
