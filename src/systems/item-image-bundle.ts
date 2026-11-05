import type { Pool } from "pg";
import type { ImageScanner } from "../platform/image-processing.js";
import { decodeImageBase64, ImageProcessingError } from "../platform/image-processing.js";
import { discardPreparedItemImage, imageChecksum, itemImageDescriptor, loadItemImage, prepareItemImage, readItemImageBytes, type PreparedItemImage } from "../platform/item-image-storage.js";
import type { ImageDescriptor } from "../platform/image-attachment.js";
import type { SystemExportV1, SystemPackageV1 } from "./implementation/package/schema/index.js";
import { assertSystemImages, systemImages } from "./implementation/persistence/image-references.js";

export const SYSTEM_IMAGE_BUNDLE_BYTES = 10 * 1024 * 1024;
function invalid(): never { throw new ImageProcessingError("unprocessable", "The system image manifest is incomplete or does not match its package."); }

export async function exportSystemItemImages(pool: Pool, systemId: string, pkg: SystemPackageV1): Promise<NonNullable<SystemExportV1["images"]>> {
  const images = [...new Map(systemImages(pkg).map(image => [image.fileId, image])).values()];
  if (!images.length) return [];
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await assertSystemImages(client, systemId, pkg);
    const exported: NonNullable<SystemExportV1["images"]> = [];
    let total = 0;
    for (const image of images) {
      const record = await loadItemImage(client, image.fileId), bytes = await readItemImageBytes(record, false);
      total += bytes.length;
      if (total > SYSTEM_IMAGE_BUNDLE_BYTES) throw new ImageProcessingError("too_large", "System export images exceed the 10 MiB bundle limit.");
      exported.push({ fileId: image.fileId, contentType: record.media_type, checksum: record.checksum, dataBase64: bytes.toString("base64") });
    }
    await client.query("COMMIT"); return exported;
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

export async function prepareImportedItemImages(bundle: SystemExportV1, scan: ImageScanner, actorId: string): Promise<{ prepared: PreparedItemImage[]; descriptors: Map<string, ImageDescriptor> }> {
  const wanted = new Map(systemImages(bundle.package).map(image => [image.fileId, image]));
  const manifest = bundle.images ?? [], prepared: PreparedItemImage[] = [], descriptors = new Map<string, ImageDescriptor>();
  if (manifest.length !== wanted.size || new Set(manifest.map(image => image.fileId)).size !== manifest.length) invalid();
  let total = 0;
  try {
    // Every use of a shared file must agree on its immutable byte metadata.
    for (const image of systemImages(bundle.package)) {
      const expected = wanted.get(image.fileId)!;
      if (image.width !== expected.width || image.height !== expected.height || image.contentType !== expected.contentType || image.sizeBytes !== expected.sizeBytes || image.checksum !== expected.checksum || !image.description.trim()) invalid();
    }
    // Check the entire bounded bundle before decoding/scanning individual images.
    for (const entry of manifest) {
      const expected = wanted.get(entry.fileId); if (!expected) invalid();
      const bytes = decodeImageBase64(entry.dataBase64); total += bytes.length;
      if (total > SYSTEM_IMAGE_BUNDLE_BYTES) throw new ImageProcessingError("too_large", "System import images exceed the 10 MiB bundle limit.");
      if (imageChecksum(bytes) !== entry.checksum || entry.checksum !== expected.checksum || entry.contentType !== expected.contentType || bytes.length !== expected.sizeBytes) invalid();
    }
    for (const entry of manifest) {
      const expected = wanted.get(entry.fileId)!;
      const image = await prepareItemImage({ ...entry, description: expected.description }, scan, actorId, null);
      prepared.push(image);
      if (image.record.width !== expected.width || image.record.height !== expected.height) invalid();
      descriptors.set(entry.fileId, itemImageDescriptor(image.record, expected.description));
    }
    return { prepared, descriptors };
  } catch (error) { await Promise.all(prepared.map(discardPreparedItemImage)); throw error; }
}
