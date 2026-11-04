import type { PoolClient } from "pg";
import type { SystemDocumentV1, SystemPackageV1 } from "../package/schema/index.js";
import type { ImageDescriptor } from "../../../platform/image-attachment.js";
import { imageDescriptorMatches, insertPreparedItemImage, type ItemImageRecord, type PreparedItemImage } from "../../../platform/item-image-storage.js";

export class InvalidSystemImage extends Error { constructor() { super("An image reference is unavailable to this system."); } }
export function systemImages(document: SystemDocumentV1 | SystemPackageV1): ImageDescriptor[] {
  return (document.templates ?? []).flatMap(template => template.image ? [template.image] : []);
}
export async function assertSystemImages(client: PoolClient, systemId: string, document: SystemDocumentV1 | SystemPackageV1) {
  const images = systemImages(document); if (!images.length) return;
  const rows = await client.query<ItemImageRecord>("SELECT a.* FROM item_image_assets a JOIN system_image_permissions p ON p.asset_id=a.id WHERE p.system_id=$1 AND a.id=ANY($2::uuid[])", [systemId, images.map(i => i.fileId)]);
  const allowed = new Map(rows.rows.map(row => [row.id, row]));
  for (const image of images) { const row = allowed.get(image.fileId); if (!row || !image.description.trim() || !imageDescriptorMatches(row, image)) throw new InvalidSystemImage(); }
}
export async function saveSystemImages(client: PoolClient, systemId: string, document: SystemDocumentV1, prepared: PreparedItemImage[] = [], retained: string[] = []) {
  for (const image of prepared) await insertPreparedItemImage(client, image);
  for (const id of [...prepared.map(image => image.record.id), ...retained]) await client.query("INSERT INTO system_image_permissions(system_id,asset_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [systemId, id]);
  await assertSystemImages(client, systemId, document);
}
