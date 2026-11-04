import { Type, type Static } from "@sinclair/typebox";

export const ImageDescriptorSchema = Type.Object({
  fileId: Type.String({ pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" }),
  description: Type.String({ minLength: 1, maxLength: 500 }),
  contentType: Type.Union([Type.Literal("image/png"), Type.Literal("image/jpeg"), Type.Literal("image/webp")]),
  width: Type.Integer({ minimum: 1, maximum: 4096 }),
  height: Type.Integer({ minimum: 1, maximum: 4096 }),
  sizeBytes: Type.Integer({ minimum: 1, maximum: 5 * 1024 * 1024 }),
  checksum: Type.String({ pattern: "^[0-9a-f]{64}$" }),
}, { additionalProperties: false });
export type ImageDescriptor = Static<typeof ImageDescriptorSchema>;
export type ImageAttachmentState = { revision: number; image: ImageDescriptor | null; parentRevision?: number };
export type ImageAttachmentError = { code: "bad_request" | "not_found" | "conflict" | "idempotency_mismatch" | "result_unavailable" | "too_large" | "unprocessable" | "temporarily_unavailable" | "internal"; message: string; latestRevision?: number };
export type ImageAttachmentResult<T> = { ok: true; value: T } | { ok: false; error: ImageAttachmentError };
