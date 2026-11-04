import { createHash } from "node:crypto";
import sharp from "sharp";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGE_DIMENSION = 4096;
export type ImageContentType = "image/png" | "image/jpeg" | "image/webp";
export type ImageScanner = (bytes: Buffer) => Promise<"clean" | "infected">;
export class ImageProcessingError extends Error {
  constructor(readonly code: "bad_request" | "too_large" | "unprocessable" | "temporarily_unavailable", message: string) { super(message); }
}

export function decodeImageBase64(value: unknown): Buffer {
  if (typeof value !== "string" || value.length === 0) throw new ImageProcessingError("bad_request", "Choose an image file.");
  if (value.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw new ImageProcessingError("too_large", "Images must be at most 5 MiB.");
  if (value.length % 4 !== 0) throw new ImageProcessingError("bad_request", "Image encoding is invalid.");
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 47 || (c === 61 && i >= value.length - 2))) {
      throw new ImageProcessingError("bad_request", "Image encoding is invalid.");
    }
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > MAX_IMAGE_BYTES) throw new ImageProcessingError("too_large", "Images must be at most 5 MiB.");
  if (bytes.toString("base64") !== value) throw new ImageProcessingError("bad_request", "Image encoding is invalid.");
  return bytes;
}

function matchesMagic(bytes: Buffer, type: ImageContentType): boolean {
  if (type === "image/png") return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (type === "image/jpeg") return bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]));
  return bytes.length >= 12 && bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP";
}

/** No policy here: the owning Module must authorize before invoking this. */
export async function processImage(input: { dataBase64: string; contentType: ImageContentType }, scan: ImageScanner) {
  const bytes = decodeImageBase64(input.dataBase64);
  const formats = { "image/png": "png", "image/jpeg": "jpeg", "image/webp": "webp" } as const;
  if (!(input.contentType in formats) || !matchesMagic(bytes, input.contentType)) throw new ImageProcessingError("unprocessable", "Image bytes do not match PNG, JPEG or WebP type.");
  let scanned: "clean" | "infected";
  try { scanned = await scan(bytes); } catch { throw new ImageProcessingError("temporarily_unavailable", "Image scanning is unavailable. Try again later."); }
  if (scanned !== "clean") throw new ImageProcessingError("unprocessable", "This image did not pass the safety scan.");
  try {
    const decoder = sharp(bytes, { limitInputPixels: MAX_IMAGE_DIMENSION ** 2, failOn: "warning", animated: false });
    const meta = await decoder.metadata();
    if (meta.format !== formats[input.contentType] || !meta.width || !meta.height || meta.width > MAX_IMAGE_DIMENSION || meta.height > MAX_IMAGE_DIMENSION || (meta.pages ?? 1) !== 1) {
      throw new Error("Invalid dimensions or animation");
    }
    // Re-encoding without keepMetadata/withMetadata drops EXIF, profiles and comments.
    const safe = await decoder.rotate().toFormat(formats[input.contentType]).toBuffer({ resolveWithObject: true });
    if (safe.data.length > MAX_IMAGE_BYTES) throw new ImageProcessingError("too_large", "The decoded image is too large to store safely.");
    const thumbnail = await sharp(safe.data).resize({ width: 256, height: 256, fit: "inside", withoutEnlargement: true }).webp({ quality: 78 }).toBuffer();
    if (thumbnail.length > 64 * 1024) throw new ImageProcessingError("too_large", "The image thumbnail is too complex. Choose a simpler image.");
    return { bytes: safe.data, thumbnail, contentType: input.contentType, width: safe.info.width, height: safe.info.height,
      checksum: createHash("sha256").update(safe.data).digest("hex"), inputChecksum: createHash("sha256").update(bytes).digest("hex") };
  } catch (error) {
    if (error instanceof ImageProcessingError) throw error;
    throw new ImageProcessingError("unprocessable", "The image is corrupt, animated or exceeds 4096 px per dimension.");
  }
}
