import { createHash, randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Pool, PoolClient } from "pg";
import sharp from "sharp";

import type { RequestContext } from "../systems/authoring.js";
import { hashInput } from "../systems/implementation/authoring/assess.js";
import type { CampaignPersistenceRepository, MediaFileRecord } from "./persistence.js";
import { canManageCampaign } from "./policy.js";
import type { CampaignError, CampaignResult } from "./index.js";

export type UploadImageInput = {
  campaignId: string;
  name: string;
  contentType: "image/png" | "image/jpeg" | "image/webp";
  dataBase64: string; // decoded cap 5 MiB enforced server-side
  idempotencyKey: string;
};

export type DeleteImageInput = {
  fileId: string;
  expectedRevision: number;
  idempotencyKey: string;
};

export type MediaFileView = {
  fileId: string;
  campaignId: string;
  name: string;
  mediaType: string;
  sizeBytes: number;
  width: number;
  height: number;
  checksum: string;
  revision: number;
};

/** Decoded image bytes above this size are rejected with `too_large`. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Either dimension above this size is rejected with `unprocessable`. */
export const MAX_IMAGE_DIMENSION = 4096;

const CONTENT_TYPES: UploadImageInput["contentType"][] = ["image/png", "image/jpeg", "image/webp"];

const UPLOAD_KIND = "campaign_image_upload";
const DELETE_KIND = "campaign_image_delete";

const RECEIPT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const NOT_FOUND_MESSAGE = "The requested campaign does not exist.";
const MISMATCH_MESSAGE = "This idempotency key was already used with different input.";

/**
 * Thrown inside a transaction when the idempotency receipt insert loses a
 * concurrent race after the mutation already ran. Rolling back keeps the
 * spurious row from committing; the caller then replays the winner.
 */
class ReceiptRace extends Error {
  constructor() {
    super("media idempotency receipt raced");
  }
}

export type CreateMediaCommandsInput = {
  pool: Pool;
  repo: CampaignPersistenceRepository;
  now?: (() => Date) | undefined;
  newId?: (() => string) | undefined;
};

export interface MediaCommands {
  uploadImage(ctx: RequestContext, input: UploadImageInput): Promise<CampaignResult<MediaFileView>>;
  deleteImage(ctx: RequestContext, input: DeleteImageInput): Promise<CampaignResult<MediaFileView>>;
}

/**
 * Disk root for validated originals. Tests override it per-suite through
 * `SWEETROLL_MEDIA_DIR`; production resolves to `<repo>/data/media`.
 * Resolved per call so the environment override applies without reboot.
 */
export function resolveMediaRoot(): string {
  const override = process.env.SWEETROLL_MEDIA_DIR;
  if (override !== undefined && override.length > 0) return resolve(override);
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  return resolve(moduleDir, "..", "..", "data", "media");
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

function hasMagicBytes(bytes: Buffer, contentType: UploadImageInput["contentType"]): boolean {
  switch (contentType) {
    case "image/png":
      return bytes.length >= PNG_MAGIC.length && bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC);
    case "image/jpeg":
      return bytes.length >= JPEG_MAGIC.length && bytes.subarray(0, JPEG_MAGIC.length).equals(JPEG_MAGIC);
    case "image/webp":
      return (
        bytes.length >= 12 &&
        bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
        bytes.subarray(8, 12).toString("ascii") === "WEBP"
      );
  }
}

function sharpFormatFor(contentType: UploadImageInput["contentType"]): string {
  switch (contentType) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpeg";
    case "image/webp":
      return "webp";
  }
}

export function createMediaCommands(input: CreateMediaCommandsInput): MediaCommands {
  const repo = input.repo;
  const now = input.now ?? (() => new Date());
  const newId = input.newId ?? (() => randomUUID());

  const errors = {
    bad_request: (message: string): CampaignError => ({ code: "bad_request", message }),
    not_found: (message: string = NOT_FOUND_MESSAGE): CampaignError => ({ code: "not_found", message }),
    mismatch: (): CampaignError => ({ code: "idempotency_mismatch", message: MISMATCH_MESSAGE }),
    too_large: (message: string): CampaignError => ({ code: "too_large", message }),
    unprocessable: (message: string): CampaignError => ({ code: "unprocessable", message }),
    conflict: (message: string, latestRevision?: number | null): CampaignError => ({
      code: "conflict",
      message,
      ...(latestRevision === undefined ? {} : { latestRevision }),
    }),
    result_unavailable: (): CampaignError => ({
      code: "result_unavailable",
      message: "The original result is no longer available.",
    }),
    internal: (): CampaignError => ({ code: "internal", message: "An internal error occurred." }),
  };

  function checkIdempotencyKey(key: unknown): CampaignError | null {
    if (typeof key !== "string" || key.length === 0 || key.length > 256) {
      return errors.bad_request("idempotencyKey must be a non-empty string of at most 256 characters.");
    }
    return null;
  }

  function checkName(name: unknown): CampaignError | null {
    if (typeof name !== "string" || name.trim().length === 0) {
      return errors.bad_request("name must be a non-empty string.");
    }
    if ([...name].length > 256) {
      return errors.bad_request("name must be at most 256 characters.");
    }
    return null;
  }

  function checkRevision(value: unknown): CampaignError | null {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      return errors.bad_request("expectedRevision must be a positive integer.");
    }
    return null;
  }

  /**
   * Strict base64 decode. Regexes are deliberately avoided here: V8 overflows
   * its stack scanning multi-megabyte strings, and oversized payloads must
   * fail as `too_large` without allocating the decoded buffer. The decoded
   * length is computed from the encoding first; only in-cap payloads decode.
   */
  function decodeBytes(dataBase64: unknown): { bytes: Buffer } | { error: CampaignError } {
    if (typeof dataBase64 !== "string" || dataBase64.length === 0) {
      return { error: errors.bad_request("dataBase64 must be a non-empty base64 string.") };
    }
    // Whitespace-tolerant inputs are stripped in slices; a single
    // `/\s+/g` replacement overflows the V8 stack past ~1 MiB.
    const pieces: string[] = [];
    for (let index = 0; index < dataBase64.length; index += 65536) {
      pieces.push(dataBase64.slice(index, index + 65536).replace(/\s+/g, ""));
    }
    const normalized = pieces.join("");
    const length = normalized.length;
    if (length % 4 !== 0) {
      return { error: errors.bad_request("dataBase64 must be valid base64.") };
    }
    for (let index = 0; index < length; index++) {
      const code = normalized.charCodeAt(index);
      const alphabet =
        (code >= 48 && code <= 57) ||
        (code >= 65 && code <= 90) ||
        (code >= 97 && code <= 122) ||
        code === 43 ||
        code === 47;
      // Padding only as the final one or two characters.
      const padding = code === 61 && index >= length - 2;
      if (!alphabet && !padding) {
        return { error: errors.bad_request("dataBase64 must be valid base64.") };
      }
    }
    let padding = 0;
    if (normalized.endsWith("==")) padding = 2;
    else if (normalized.endsWith("=")) padding = 1;
    if ((length / 4) * 3 - padding > MAX_IMAGE_BYTES) {
      return {
        error: errors.too_large(`Image bytes exceed the ${MAX_IMAGE_BYTES} byte limit.`),
      };
    }
    return { bytes: Buffer.from(normalized, "base64") };
  }

  async function withClient<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await input.pool.connect();
    try {
      await client.query("BEGIN READ ONLY");
      try {
        const value = await work(client);
        await client.query("COMMIT");
        return value;
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // Preserve the original failure when rollback itself errors.
        }
        throw error;
      }
    } finally {
      client.release();
    }
  }

  async function withTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await input.pool.connect();
    try {
      await client.query("BEGIN");
      try {
        const value = await work(client);
        await client.query("COMMIT");
        return value;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    } finally {
      client.release();
    }
  }

  function toView(record: MediaFileRecord): MediaFileView {
    return {
      fileId: record.fileId,
      campaignId: record.campaignId,
      name: record.name,
      mediaType: record.mediaType,
      sizeBytes: record.sizeBytes,
      width: record.width,
      height: record.height,
      checksum: record.checksum,
      revision: record.revision,
    };
  }

  /**
   * Current-policy reauthorization for upload replays: the caller must still
   * be an active GM of the owning campaign, and the file row must still
   * exist (a later delete turns the replay into not_found — the bytes are
   * gone, so no ghost view is returned).
   */
  async function reauthorizeUpload(
    ctx: RequestContext,
    campaignId: string,
    fileId: string,
  ): Promise<CampaignError | null> {
    return await withClient(async (client) => {
      const campaign = await repo.openCampaign(client, campaignId);
      const membership =
        campaign === null ? null : await repo.loadMembership(client, campaignId, ctx.actorId);
      if (campaign === null || !canManageCampaign(campaign, membership)) return errors.not_found();
      const file = await repo.loadMediaFile(client, fileId);
      if (file === null || file.campaignId !== campaignId) return errors.not_found();
      return null;
    });
  }

  async function reauthorizeDelete(ctx: RequestContext, campaignId: string): Promise<CampaignError | null> {
    return await withClient(async (client) => {
      const campaign = await repo.openCampaign(client, campaignId);
      const membership =
        campaign === null ? null : await repo.loadMembership(client, campaignId, ctx.actorId);
      if (campaign === null || !canManageCampaign(campaign, membership)) return errors.not_found();
      return null;
    });
  }

  async function resolveUploadReplay(
    ctx: RequestContext,
    options: {
      inputHash: string;
      receipt: { inputHash: string; resultJson: unknown; expiresAt: Date } | null;
    },
  ): Promise<CampaignResult<MediaFileView>> {
    if (options.receipt === null) return { ok: false, error: errors.internal() };
    if (options.receipt.inputHash !== options.inputHash) return { ok: false, error: errors.mismatch() };
    if (options.receipt.expiresAt.getTime() <= now().getTime()) {
      return { ok: false, error: errors.result_unavailable() };
    }
    const stored = options.receipt.resultJson as { campaignId?: string; fileId?: string; value?: unknown };
    if (typeof stored.campaignId !== "string" || typeof stored.fileId !== "string") {
      return { ok: false, error: errors.internal() };
    }
    const denial = await reauthorizeUpload(ctx, stored.campaignId, stored.fileId);
    if (denial !== null) return { ok: false, error: denial };
    return { ok: true, value: stored.value as MediaFileView };
  }

  async function resolveDeleteReplay(
    ctx: RequestContext,
    options: {
      inputHash: string;
      receipt: { inputHash: string; resultJson: unknown; expiresAt: Date } | null;
    },
  ): Promise<CampaignResult<MediaFileView>> {
    if (options.receipt === null) return { ok: false, error: errors.internal() };
    if (options.receipt.inputHash !== options.inputHash) return { ok: false, error: errors.mismatch() };
    if (options.receipt.expiresAt.getTime() <= now().getTime()) {
      return { ok: false, error: errors.result_unavailable() };
    }
    const stored = options.receipt.resultJson as { campaignId?: string; value?: unknown };
    if (typeof stored.campaignId !== "string") return { ok: false, error: errors.internal() };
    // Delete replays through the deleted row: only campaign-level GM access
    // is rechecked, mirroring deleteContent's deleted-row replay.
    const denial = await reauthorizeDelete(ctx, stored.campaignId);
    if (denial !== null) return { ok: false, error: denial };
    return { ok: true, value: stored.value as MediaFileView };
  }

  async function removeBytes(storageKey: string): Promise<void> {
    try {
      await unlink(join(resolveMediaRoot(), storageKey));
    } catch {
      // Best-effort: the metadata row is the source of truth, and a missing
      // file after a committed delete is already converged.
    }
  }

  return {
    async uploadImage(ctx, uploadInput) {
      let writtenStorageKey: string | null = null;
      try {
        const keyError = checkIdempotencyKey(uploadInput.idempotencyKey);
        if (keyError !== null) return { ok: false, error: keyError };
        const nameError = checkName(uploadInput.name);
        if (nameError !== null) return { ok: false, error: nameError };
        if (!CONTENT_TYPES.some((candidate) => candidate === uploadInput.contentType)) {
          return { ok: false, error: errors.bad_request("contentType must be image/png, image/jpeg or image/webp.") };
        }
        const decoded = decodeBytes(uploadInput.dataBase64);
        if ("error" in decoded) return { ok: false, error: decoded.error };
        const bytes = decoded.bytes;
        if (!hasMagicBytes(bytes, uploadInput.contentType)) {
          return {
            ok: false,
            error: errors.unprocessable("Image bytes do not match the declared content type."),
          };
        }
        let metadata: { format?: string; width?: number; height?: number };
        try {
          metadata = await sharp(bytes).metadata();
        } catch {
          return { ok: false, error: errors.unprocessable("Image bytes could not be decoded.") };
        }
        if (
          metadata.format !== sharpFormatFor(uploadInput.contentType) ||
          metadata.width === undefined ||
          metadata.height === undefined ||
          metadata.width < 1 ||
          metadata.height < 1 ||
          metadata.width > MAX_IMAGE_DIMENSION ||
          metadata.height > MAX_IMAGE_DIMENSION
        ) {
          return {
            ok: false,
            error: errors.unprocessable("Image dimensions are invalid or exceed the 4096 px limit."),
          };
        }

        const checksum = createHash("sha256").update(bytes).digest("hex");
        const inputHash = hashInput({
          campaignId: uploadInput.campaignId,
          name: uploadInput.name,
          contentType: uploadInput.contentType,
          checksum,
        });
        const receiptKey = {
          actorId: ctx.actorId,
          commandKind: UPLOAD_KIND,
          idempotencyKey: uploadInput.idempotencyKey,
        };

        const preExisting = await repo.loadReceiptWithExpiry(input.pool, receiptKey);
        if (preExisting !== null) {
          return await resolveUploadReplay(ctx, { inputHash, receipt: preExisting });
        }

        // Bytes hit the disk before the metadata row: a crash leaves at most
        // an unreferenced file, never a row pointing at missing bytes. The
        // key is fresh per attempt, so any failure below unlinks only ours.
        const fileId = newId();
        const storageKey = newId();
        await mkdir(resolveMediaRoot(), { recursive: true });
        await writeFile(join(resolveMediaRoot(), storageKey), bytes, { mode: 0o600 });
        writtenStorageKey = storageKey;

        const outcome = await withTransaction(async (client) => {
          // Campaign-first lock order (see content.ts): campaign, then the
          // new media row, so concurrent membership/media mutations serialize.
          const campaign = await repo.lockCampaign(client, uploadInput.campaignId);
          const membership =
            campaign === null
              ? null
              : await repo.loadMembership(client, uploadInput.campaignId, ctx.actorId);
          const raced = await repo.loadReceiptWithExpiry(client, receiptKey);
          if (raced !== null) {
            return { committed: false as const, receipt: raced };
          }
          if (campaign === null || !canManageCampaign(campaign, membership)) {
            return { committed: false as const, failure: errors.not_found() as CampaignError };
          }
          const record = await repo.insertMediaFile(client, {
            fileId,
            campaignId: campaign.campaignId,
            ownerId: ctx.actorId,
            name: uploadInput.name,
            mediaType: uploadInput.contentType,
            sizeBytes: bytes.length,
            width: metadata.width ?? 0,
            height: metadata.height ?? 0,
            checksum,
            storageKey,
          });
          const value = toView(record);
          const stored = {
            campaignId: campaign.campaignId,
            fileId,
            value,
            idempotencyKey: uploadInput.idempotencyKey,
          };
          const inserted = await repo.tryInsertReceipt(client, {
            actorId: ctx.actorId,
            commandKind: UPLOAD_KIND,
            idempotencyKey: uploadInput.idempotencyKey,
            inputHash,
            campaignId: campaign.campaignId,
            resultJson: stored,
            expiresAt: new Date(now().getTime() + RECEIPT_TTL_MS),
          });
          if (!inserted) {
            throw new ReceiptRace();
          }
          return { committed: true as const, value };
        }).catch(async (error) => {
          if (error instanceof ReceiptRace) {
            const receipt = await repo.loadReceiptWithExpiry(input.pool, receiptKey);
            return { committed: false as const, receipt };
          }
          throw error;
        });

        if ("failure" in outcome) {
          await removeBytes(storageKey);
          writtenStorageKey = null;
          return { ok: false, error: outcome.failure };
        }
        if (outcome.committed) {
          writtenStorageKey = null;
          return { ok: true, value: outcome.value };
        }
        await removeBytes(storageKey);
        writtenStorageKey = null;
        return await resolveUploadReplay(ctx, { inputHash, receipt: outcome.receipt ?? null });
      } catch {
        if (writtenStorageKey !== null) {
          await removeBytes(writtenStorageKey);
        }
        return { ok: false, error: errors.internal() };
      }
    },

    async deleteImage(ctx, deleteInput) {
      try {
        const keyError = checkIdempotencyKey(deleteInput.idempotencyKey);
        if (keyError !== null) return { ok: false, error: keyError };
        const revisionError = checkRevision(deleteInput.expectedRevision);
        if (revisionError !== null) return { ok: false, error: revisionError };

        const inputHash = hashInput({
          fileId: deleteInput.fileId,
          expectedRevision: deleteInput.expectedRevision,
        });
        const receiptKey = {
          actorId: ctx.actorId,
          commandKind: DELETE_KIND,
          idempotencyKey: deleteInput.idempotencyKey,
        };

        const preExisting = await repo.loadReceiptWithExpiry(input.pool, receiptKey);
        if (preExisting !== null) {
          return await resolveDeleteReplay(ctx, { inputHash, receipt: preExisting });
        }

        const outcome = await withTransaction(async (client) => {
          // Campaign-first lock order: resolve the owning campaign with an
          // unlocked read, lock the campaign, then lock the media row.
          const known = await repo.loadMediaFile(client, deleteInput.fileId);
          if (known === null) {
            return { committed: false as const, failure: errors.not_found() as CampaignError };
          }
          const campaign = await repo.lockCampaign(client, known.campaignId);
          const locked = await repo.lockMediaFile(client, known.fileId);
          if (locked === null) {
            return { committed: false as const, failure: errors.not_found() as CampaignError };
          }
          const membership =
            campaign === null ? null : await repo.loadMembership(client, locked.campaignId, ctx.actorId);
          const raced = await repo.loadReceiptWithExpiry(client, receiptKey);
          if (raced !== null) {
            return { committed: false as const, receipt: raced };
          }
          if (campaign === null || !canManageCampaign(campaign, membership)) {
            return { committed: false as const, failure: errors.not_found() as CampaignError };
          }
          if (locked.revision !== deleteInput.expectedRevision) {
            return {
              committed: false as const,
              failure: errors.conflict(
                "The file has a newer revision. Retry with the latest revision and a new idempotency key.",
                locked.revision,
              ),
            };
          }
          const deleted = await repo.deleteMediaFile(client, {
            fileId: locked.fileId,
            expectedRevision: deleteInput.expectedRevision,
          });
          if (deleted === null) {
            return {
              committed: false as const,
              failure: errors.conflict(
                "The file has a newer revision. Retry with the latest revision and a new idempotency key.",
                locked.revision,
              ),
            };
          }
          const value = toView(deleted);
          const stored = {
            campaignId: campaign.campaignId,
            fileId: locked.fileId,
            value,
            idempotencyKey: deleteInput.idempotencyKey,
          };
          const inserted = await repo.tryInsertReceipt(client, {
            actorId: ctx.actorId,
            commandKind: DELETE_KIND,
            idempotencyKey: deleteInput.idempotencyKey,
            inputHash,
            campaignId: campaign.campaignId,
            resultJson: stored,
            expiresAt: new Date(now().getTime() + RECEIPT_TTL_MS),
          });
          if (!inserted) {
            throw new ReceiptRace();
          }
          return { committed: true as const, value, storageKey: deleted.storageKey };
        }).catch(async (error) => {
          if (error instanceof ReceiptRace) {
            const receipt = await repo.loadReceiptWithExpiry(input.pool, receiptKey);
            return { committed: false as const, receipt };
          }
          throw error;
        });

        if ("failure" in outcome) return { ok: false, error: outcome.failure };
        if (outcome.committed) {
          // Bytes are unlinked only after the row delete commits: a receipt
          // race rolls the row back, and the file must still be there.
          await removeBytes(outcome.storageKey);
          return { ok: true, value: outcome.value };
        }
        return await resolveDeleteReplay(ctx, { inputHash, receipt: outcome.receipt ?? null });
      } catch {
        return { ok: false, error: errors.internal() };
      }
    },
  };
}
