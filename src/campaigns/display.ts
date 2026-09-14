import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Pool, PoolClient } from "pg";
import sharp from "sharp";

import type { RequestContext } from "../systems/authoring.js";
import { hashToken, newSessionToken } from "../identity/util.js";
import type { CampaignPersistenceRepository } from "./persistence.js";
import { canManageCampaign } from "./policy.js";
import type { CampaignError, CampaignResult } from "./index.js";
import { resolveMediaRoot } from "./media.js";
import type { FogOp, TokenRecord } from "./scenes.js";

export type DisplayProjection = {
  sceneId: string;
  sceneRevision: number;
  imageUrl: string; // redacted derivative for this revision, e.g. `/displays/:id/scenes/:sceneId/image?rev=N`
  tokens: Array<{ tokenId: string; label: string; x: number; y: number; size: number; imageUrl: string | null }>;
};

export type PairDisplayInput = { campaignId: string };
export type PairDisplaySuccess = { code: string };
export type RedeemDisplayCodeInput = { code: string };
export type RedeemDisplayCodeSuccess = { displayId: string; secret: string };
export type GetDisplayProjectionInput = { displayId: string; secret: string; sceneId: string };
export type RevokeDisplayInput = { displayId: string };
export type RevokeDisplaySuccess = { displayId: string };

/** Pairing codes live 5 minutes; redeem is single-use (the row is deleted). */
const PAIRING_CODE_TTL_MS = 5 * 60 * 1000;
const CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const CODE_LENGTH = 6;
const MAX_MINT_ATTEMPTS = 8;

const NOT_FOUND_MESSAGE = "The requested display resource does not exist.";

/** 6-char pairing code over an unambiguous alphabet (no lowercase lookalikes). */
export function generateDisplayCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let code = "";
  for (const byte of bytes) {
    code += CODE_ALPHABET[(byte as number) % CODE_ALPHABET.length];
  }
  return code;
}

/**
 * Disk root for per-revision redacted derivatives. Tests override it
 * per-suite through `SWEETROLL_DISPLAY_DIR`; production resolves to
 * `<repo>/data/display`. Resolved per call so the override applies without
 * reboot (same pattern as `resolveMediaRoot`).
 */
export function resolveDisplayRoot(): string {
  const override = process.env.SWEETROLL_DISPLAY_DIR;
  if (override !== undefined && override.length > 0) return resolve(override);
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  return resolve(moduleDir, "..", "..", "data", "display");
}

/**
 * Derivative cache key: one PNG per (sceneId, revision), so a fog/token
 * stroke (which bumps the revision) composites a new file instead of
 * overwriting the old one. Task 4 serves this path on the display-credential
 * image route.
 */
export function displayDerivativePath(sceneId: string, revision: number): string {
  return join(resolveDisplayRoot(), `${sceneId}-rev${revision}.png`);
}

export type CreateDisplayCommandsInput = {
  pool: Pool;
  repo: CampaignPersistenceRepository;
  now?: (() => Date) | undefined;
  newId?: (() => string) | undefined;
};

export interface DisplayCommands {
  pairDisplay(ctx: RequestContext, input: PairDisplayInput): Promise<CampaignResult<PairDisplaySuccess>>;
  redeemDisplayCode(input: RedeemDisplayCodeInput): Promise<CampaignResult<RedeemDisplayCodeSuccess>>;
  getDisplayProjection(input: GetDisplayProjectionInput): Promise<CampaignResult<DisplayProjection>>;
  revokeDisplay(ctx: RequestContext, input: RevokeDisplayInput): Promise<CampaignResult<RevokeDisplaySuccess>>;
}

export function createDisplayCommands(input: CreateDisplayCommandsInput): DisplayCommands {
  const repo = input.repo;
  const now = input.now ?? (() => new Date());
  const newId = input.newId ?? (() => randomUUID());

  const errors = {
    bad_request: (message: string): CampaignError => ({ code: "bad_request", message }),
    not_found: (message: string = NOT_FOUND_MESSAGE): CampaignError => ({ code: "not_found", message }),
    internal: (): CampaignError => ({ code: "internal", message: "An internal error occurred." }),
  };

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

  function checkPresent(value: unknown): value is string {
    return typeof value === "string" && value.length > 0;
  }

  function secretMatches(presentedSecret: string, storedHash: string): boolean {
    const presentedHash = hashToken(presentedSecret);
    const left = Buffer.from(presentedHash, "utf8");
    const right = Buffer.from(storedHash, "utf8");
    return left.length === right.length && timingSafeEqual(left, right);
  }

  function isFogOp(value: unknown): value is FogOp {
    if (typeof value !== "object" || value === null) return false;
    const op = value as { mode?: unknown; runs?: unknown };
    if (op.mode !== "reveal" && op.mode !== "conceal") return false;
    if (!Array.isArray(op.runs)) return false;
    return op.runs.every((run) => {
      if (typeof run !== "object" || run === null) return false;
      const { x, y, r } = run as { x?: unknown; y?: unknown; r?: unknown };
      return (
        typeof x === "number" &&
        typeof y === "number" &&
        typeof r === "number" &&
        Number.isFinite(x) &&
        Number.isFinite(y) &&
        Number.isFinite(r)
      );
    });
  }

  function isTokenRecord(value: unknown): value is TokenRecord {
    if (typeof value !== "object" || value === null) return false;
    const token = value as Record<string, unknown>;
    return (
      typeof token.tokenId === "string" &&
      typeof token.label === "string" &&
      typeof token.x === "number" &&
      typeof token.y === "number" &&
      typeof token.size === "number" &&
      typeof token.visible === "boolean" &&
      (token.imageFileId === null || typeof token.imageFileId === "string")
    );
  }

  /**
   * Stored fog/token payloads are written by the scene commands after
   * validation, so a shape failure here means a corrupt row: surface
   * `internal` (via the caller's catch) rather than leaking garbage.
   */
  function parseStoredFog(value: unknown): FogOp[] {
    if (!Array.isArray(value) || !value.every(isFogOp)) throw new Error("malformed scene fog payload");
    return value;
  }

  function parseStoredTokens(value: unknown): TokenRecord[] {
    if (!Array.isArray(value) || !value.every(isTokenRecord)) throw new Error("malformed scene tokens payload");
    return value;
  }

  /**
   * Reveal state of one normalized scene-space point: scenes start fully
   * fogged, and only covering runs change the state in op order (a later
   * conceal re-covers, a later reveal re-opens). Matches the pixel mask
   * below so token omission agrees with the derivative bytes.
   */
  function isPointRevealed(x: number, y: number, fog: FogOp[]): boolean {
    let revealed = false;
    for (const op of fog) {
      for (const run of op.runs) {
        const dx = x - run.x;
        const dy = y - run.y;
        if (dx * dx + dy * dy <= run.r * run.r) {
          revealed = op.mode === "reveal";
          break;
        }
      }
    }
    return revealed;
  }

  /**
   * Full-resolution reveal mask: 1 per revealed pixel, 0 per concealed.
   * Runs rasterize through pixel bounding boxes in normalized scene-space
   * (same distance metric as `isPointRevealed`), so large images stay
   * proportional to brush area rather than pixels × ops.
   */
  function buildRevealMask(width: number, height: number, fog: FogOp[]): Buffer {
    const mask = Buffer.alloc(width * height, 0);
    for (const op of fog) {
      const value = op.mode === "reveal" ? 1 : 0;
      for (const run of op.runs) {
        const minPx = Math.max(0, Math.floor((run.x - run.r) * width));
        const maxPx = Math.min(width - 1, Math.ceil((run.x + run.r) * width));
        const minPy = Math.max(0, Math.floor((run.y - run.r) * height));
        const maxPy = Math.min(height - 1, Math.ceil((run.y + run.r) * height));
        for (let py = minPy; py <= maxPy; py++) {
          for (let px = minPx; px <= maxPx; px++) {
            const nx = (px + 0.5) / width;
            const ny = (py + 0.5) / height;
            const dx = nx - run.x;
            const dy = ny - run.y;
            if (dx * dx + dy * dy <= run.r * run.r) {
              mask[py * width + px] = value;
            }
          }
        }
      }
    }
    return mask;
  }

  /**
   * Redacted derivative: concealed pixels are removed (opaque black), never
   * overlaid — the output bytes carry no recoverable concealed content.
   * Token positions stay data (never burned into pixels).
   */
  async function compositeDerivative(backgroundBytes: Buffer, fog: FogOp[]): Promise<Buffer> {
    const { data, info } = await sharp(backgroundBytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const width = info.width ?? 0;
    const height = info.height ?? 0;
    if (width < 1 || height < 1 || data.length < width * height * 4) {
      throw new Error("background decoded to an empty raster");
    }
    const mask = buildRevealMask(width, height, fog);
    for (let index = 0; index < width * height; index++) {
      if (mask[index] === 1) continue;
      const offset = index * 4;
      data[offset] = 0;
      data[offset + 1] = 0;
      data[offset + 2] = 0;
      data[offset + 3] = 255;
    }
    return await sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer();
  }

  return {
    async pairDisplay(ctx, pairInput) {
      try {
        if (!checkPresent(pairInput.campaignId)) {
          return { ok: false, error: errors.bad_request("campaignId must be a non-empty string.") };
        }
        const authorized = await withClient(async (client) => {
          const campaign = await repo.openCampaign(client, pairInput.campaignId);
          const membership =
            campaign === null ? null : await repo.loadMembership(client, pairInput.campaignId, ctx.actorId);
          if (campaign === null || !canManageCampaign(campaign, membership)) return false;
          return true;
        });
        if (!authorized) return { ok: false, error: errors.not_found() };

        // Each call mints a fresh code (no idempotency): the UNIQUE hash
        // retries on the (astronomically unlikely) collision instead of
        // failing the pairing attempt.
        const paired = await withTransaction(async (client) => {
          for (let attempt = 0; attempt < MAX_MINT_ATTEMPTS; attempt++) {
            const code = generateDisplayCode();
            const inserted = await repo.insertDisplayCode(client, {
              codeHash: hashToken(code),
              campaignId: pairInput.campaignId,
              expiresAt: new Date(now().getTime() + PAIRING_CODE_TTL_MS),
            });
            if (inserted !== null) return code;
          }
          throw new Error("display code mint collided repeatedly");
        });
        return { ok: true, value: { code: paired } };
      } catch {
        return { ok: false, error: errors.internal() };
      }
    },

    async redeemDisplayCode(redeemInput) {
      try {
        // Unknown/malformed/expired/used codes are indistinguishable:
        // everything that is not a live code row reads as generic not_found.
        if (!checkPresent(redeemInput.code)) return { ok: false, error: errors.not_found() };
        return await withTransaction(async (client) => {
          const codeHash = hashToken(redeemInput.code);
          const code = await repo.lockDisplayCodeByHash(client, codeHash);
          if (code === null) return { ok: false, error: errors.not_found() };
          if (code.expiresAt.getTime() <= now().getTime()) {
            await repo.deleteDisplayCode(client, codeHash);
            return { ok: false, error: errors.not_found() };
          }
          // Single-use: the code row dies with the redeem, so a replay (or a
          // concurrent second redeem behind the row lock) reads as missing.
          await repo.deleteDisplayCode(client, codeHash);
          const secret = newSessionToken();
          const credential = await repo.insertDisplayCredential(client, {
            displayId: newId(),
            campaignId: code.campaignId,
            secretHash: hashToken(secret),
          });
          return { ok: true, value: { displayId: credential.displayId, secret } };
        });
      } catch {
        return { ok: false, error: errors.internal() };
      }
    },

    async getDisplayProjection(projectionInput) {
      try {
        if (
          !checkPresent(projectionInput.displayId) ||
          !checkPresent(projectionInput.secret) ||
          !checkPresent(projectionInput.sceneId)
        ) {
          return { ok: false, error: errors.not_found() };
        }
        const credential = await repo.loadDisplayCredential(input.pool, projectionInput.displayId);
        if (
          credential === null ||
          credential.revokedAt !== null ||
          !secretMatches(projectionInput.secret, credential.secretHash)
        ) {
          return { ok: false, error: errors.not_found() };
        }
        const scene = await repo.loadScene(input.pool, projectionInput.sceneId);
        if (scene === null || scene.campaignId !== credential.campaignId) {
          return { ok: false, error: errors.not_found() };
        }
        const background = await repo.loadMediaFile(input.pool, scene.backgroundFileId);
        if (background === null || background.campaignId !== scene.campaignId) {
          // Orphaned background pin (image deleted while pinned, no FK):
          // fail closed — a scene without its background has no projection.
          return { ok: false, error: errors.not_found() };
        }
        let backgroundBytes: Buffer;
        try {
          backgroundBytes = await readFile(join(resolveMediaRoot(), background.storageKey));
        } catch {
          // Row present but bytes missing from disk: same fail-closed collapse.
          return { ok: false, error: errors.not_found() };
        }
        const fog = parseStoredFog(scene.fog);
        const tokens = parseStoredTokens(scene.tokens);

        const derivativePath = displayDerivativePath(scene.sceneId, scene.revision);
        try {
          await readFile(derivativePath);
        } catch {
          // Cache miss: composite the redacted derivative once per revision.
          // Bytes are deterministic in (background, fog), so a concurrent
          // second composite writes identical content.
          await mkdir(dirname(derivativePath), { recursive: true });
          const derivative = await compositeDerivative(backgroundBytes, fog);
          await writeFile(derivativePath, derivative, { mode: 0o600 });
        }

        return {
          ok: true,
          value: {
            sceneId: scene.sceneId,
            sceneRevision: scene.revision,
            imageUrl: `/displays/${credential.displayId}/scenes/${scene.sceneId}/image?rev=${scene.revision}`,
            tokens: tokens
              .filter((token) => token.visible && isPointRevealed(token.x, token.y, fog))
              .map((token) => ({
                tokenId: token.tokenId,
                label: token.label,
                x: token.x,
                y: token.y,
                size: token.size,
                // Task 4 wires this display-credential token image route;
                // imageless tokens carry null (never a GM original URL).
                imageUrl:
                  token.imageFileId === null
                    ? null
                    : `/displays/${credential.displayId}/scenes/${scene.sceneId}/tokens/${token.tokenId}/image?rev=${scene.revision}`,
              })),
          },
        };
      } catch {
        return { ok: false, error: errors.internal() };
      }
    },

    async revokeDisplay(ctx, revokeInput) {
      try {
        if (!checkPresent(revokeInput.displayId)) return { ok: false, error: errors.not_found() };
        const authorized = await withClient(async (client) => {
          const credential = await repo.loadDisplayCredential(client, revokeInput.displayId);
          if (credential === null) return false;
          const campaign = await repo.openCampaign(client, credential.campaignId);
          const membership =
            campaign === null ? null : await repo.loadMembership(client, credential.campaignId, ctx.actorId);
          // GM-only: outsiders, players and GMs of other campaigns read this
          // as not_found without learning whether the credential exists.
          if (campaign === null || !canManageCampaign(campaign, membership)) return false;
          return true;
        });
        if (!authorized) return { ok: false, error: errors.not_found() };
        const revoked = await withTransaction(async (client) => {
          return await repo.revokeDisplayCredential(client, {
            displayId: revokeInput.displayId,
            now: now(),
          });
        });
        // Already revoked (or raced): the credential is unusable either way.
        if (revoked === null) return { ok: false, error: errors.not_found() };
        return { ok: true, value: { displayId: revoked.displayId } };
      } catch {
        return { ok: false, error: errors.internal() };
      }
    },
  };
}
