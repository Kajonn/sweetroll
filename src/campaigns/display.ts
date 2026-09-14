import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
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
export type ListDisplayCredentialsInput = { campaignId: string };
/**
 * I7b Task 4: GM Settings credential metadata. Carries no secret material
 * (no secret, no hash) — the plaintext secret exists only in the single
 * redeem response.
 */
export type DisplayCredentialMetadata = {
  displayId: string;
  campaignId: string;
  revokedAt: Date | null;
  createdAt: Date;
};
export type GetDisplaySceneImageInput = {
  displayId: string;
  secret: string;
  sceneId: string;
  rev: number;
};
export type GetDisplayTokenImageInput = {
  displayId: string;
  secret: string;
  sceneId: string;
  tokenId: string;
};
/** I7b Task 4: image bytes for the display-credential binary routes. */
export type DisplayImageBytes = {
  contentType: string;
  bytes: Buffer;
  revision: number;
};

/** Pairing codes live 5 minutes; redeem is single-use (the row is deleted). */
const PAIRING_CODE_TTL_MS = 5 * 60 * 1000;
// Uppercase alphanumeric code alphabet. Note: this alphabet is NOT
// unambiguous — 0/O and 1/I remain confusable. Codes are machine-copied
// (typed once from the GM screen into the display), never hand-transcribed
// from dictation, so readability outranks disambiguation here.
const CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const CODE_LENGTH = 6;
const MAX_MINT_ATTEMPTS = 8;

const NOT_FOUND_MESSAGE = "The requested display resource does not exist.";

/** 6-char pairing code over an uppercase alphanumeric alphabet. Codes are
 * machine-copied from the GM screen, never hand-transcribed (0/O and 1/I
 * stay confusable by design, see CODE_ALPHABET). */
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
  listDisplayCredentials(
    ctx: RequestContext,
    input: ListDisplayCredentialsInput,
  ): Promise<CampaignResult<DisplayCredentialMetadata[]>>;
  getDisplaySceneImage(input: GetDisplaySceneImageInput): Promise<CampaignResult<DisplayImageBytes>>;
  getDisplayTokenImage(input: GetDisplayTokenImageInput): Promise<CampaignResult<DisplayImageBytes>>;
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

  /**
   * I7b Task 4: shared display-credential + scene resolution for the
   * projection and both binary image reads. Every failure — missing fields,
   * unknown/revoked credential, secret mismatch, unknown scene, scene from
   * another campaign — collapses to null (the caller maps it to generic
   * not_found without distinguishing cases).
   */
  async function resolveDisplayScene(
    projectionInput: GetDisplayProjectionInput,
  ): Promise<
    | {
        credential: { displayId: string; campaignId: string };
        scene: {
          sceneId: string;
          campaignId: string;
          revision: number;
          backgroundFileId: string;
          fog: unknown;
          tokens: unknown;
        };
      }
    | null
  > {
    if (
      !checkPresent(projectionInput.displayId) ||
      !checkPresent(projectionInput.secret) ||
      !checkPresent(projectionInput.sceneId)
    ) {
      return null;
    }
    const credential = await repo.loadDisplayCredential(input.pool, projectionInput.displayId);
    if (
      credential === null ||
      credential.revokedAt !== null ||
      !secretMatches(projectionInput.secret, credential.secretHash)
    ) {
      return null;
    }
    const scene = await repo.loadScene(input.pool, projectionInput.sceneId);
    if (scene === null || scene.campaignId !== credential.campaignId) {
      return null;
    }
    return {
      credential: { displayId: credential.displayId, campaignId: credential.campaignId },
      scene,
    };
  }

  /**
   * I7b Task 4: cache-miss composite shared by the projection and the scene
   * image route. Bytes are deterministic in (background, fog), so a
   * concurrent second composite writes identical content.
   */
  async function ensureDerivative(
    sceneId: string,
    revision: number,
    backgroundBytes: Buffer,
    fog: FogOp[],
  ): Promise<string> {
    const derivativePath = displayDerivativePath(sceneId, revision);
    try {
      await readFile(derivativePath);
    } catch {
      await mkdir(dirname(derivativePath), { recursive: true });
      const derivative = await compositeDerivative(backgroundBytes, fog);
      await writeFile(derivativePath, derivative, { mode: 0o600 });
    }
    return derivativePath;
  }

  async function readBackgroundBytes(storageKey: string): Promise<Buffer | null> {
    try {
      return await readFile(join(resolveMediaRoot(), storageKey));
    } catch {
      // Row present but bytes missing from disk: fail closed.
      return null;
    }
  }

  /**
   * I7b Task 4: revoke-time purge of cached derivative files for the
   * campaign's scenes. Derivatives regenerate lazily on the next projection
   * (see the regeneration test in tests/integration/campaign-scenes.test.ts).
   * Best-effort: a purge failure never fails the revoke itself.
   */
  async function purgeCampaignDerivatives(campaignId: string): Promise<void> {
    try {
      const sceneIds = await repo.listSceneIdsByCampaign(input.pool, campaignId);
      const prefixes = new Set(sceneIds.map((sceneId) => `${sceneId}-rev`));
      if (prefixes.size === 0) return;
      let names: string[];
      try {
        names = await readdir(resolveDisplayRoot());
      } catch {
        return;
      }
      for (const name of names) {
        if (!name.endsWith(".png")) continue;
        let owned = false;
        for (const prefix of prefixes) {
          if (name.startsWith(prefix)) {
            owned = true;
            break;
          }
        }
        if (!owned) continue;
        try {
          await unlink(join(resolveDisplayRoot(), name));
        } catch {
          // Converged already (concurrent revoke) — keep purging the rest.
        }
      }
    } catch {
      // Purge is hygiene, not correctness: the revoke already committed.
    }
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
        const resolved = await resolveDisplayScene(projectionInput);
        if (resolved === null) {
          return { ok: false, error: errors.not_found() };
        }
        const { credential, scene } = resolved;
        const background = await repo.loadMediaFile(input.pool, scene.backgroundFileId);
        if (background === null || background.campaignId !== scene.campaignId) {
          // Orphaned background pin (image deleted while pinned, no FK):
          // fail closed — a scene without its background has no projection.
          return { ok: false, error: errors.not_found() };
        }
        const backgroundBytes = await readBackgroundBytes(background.storageKey);
        if (backgroundBytes === null) {
          return { ok: false, error: errors.not_found() };
        }
        const fog = parseStoredFog(scene.fog);
        const tokens = parseStoredTokens(scene.tokens);

        await ensureDerivative(scene.sceneId, scene.revision, backgroundBytes, fog);

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
        // I7b Task 4: revoke purges the campaign's cached derivatives (they
        // regenerate lazily on the next projection). Best-effort and outside
        // the transaction: the revoke already committed.
        await purgeCampaignDerivatives(revoked.campaignId);
        return { ok: true, value: { displayId: revoked.displayId } };
      } catch {
        return { ok: false, error: errors.internal() };
      }
    },

    async listDisplayCredentials(ctx, listInput) {
      try {
        if (!checkPresent(listInput.campaignId)) return { ok: false, error: errors.not_found() };
        // Single-client read-only snapshot: campaign identity and caller
        // membership share one snapshot; outsiders and players collapse to
        // generic not_found. Metadata only — secret hashes never leave.
        const outcome = await withClient(async (client) => {
          const campaign = await repo.openCampaign(client, listInput.campaignId);
          const membership =
            campaign === null ? null : await repo.loadMembership(client, listInput.campaignId, ctx.actorId);
          if (campaign === null || !canManageCampaign(campaign, membership)) return null;
          return await repo.listDisplayCredentialsByCampaign(client, listInput.campaignId);
        });
        if (outcome === null) return { ok: false, error: errors.not_found() };
        return {
          ok: true,
          value: outcome.map((record) => ({
            displayId: record.displayId,
            campaignId: record.campaignId,
            revokedAt: record.revokedAt,
            createdAt: record.createdAt,
          })),
        };
      } catch {
        return { ok: false, error: errors.internal() };
      }
    },

    async getDisplaySceneImage(imageInput) {
      try {
        if (typeof imageInput.rev !== "number" || !Number.isInteger(imageInput.rev) || imageInput.rev < 1) {
          return { ok: false, error: errors.not_found() };
        }
        const resolved = await resolveDisplayScene(imageInput);
        if (resolved === null) {
          return { ok: false, error: errors.not_found() };
        }
        const { scene } = resolved;
        // The rev cache key must name the current revision: a stale rev
        // names fog state that no longer holds, so it reads as missing and
        // the display refetches the projection instead of showing old fog.
        if (imageInput.rev !== scene.revision) {
          return { ok: false, error: errors.not_found() };
        }
        const background = await repo.loadMediaFile(input.pool, scene.backgroundFileId);
        if (background === null || background.campaignId !== scene.campaignId) {
          return { ok: false, error: errors.not_found() };
        }
        const backgroundBytes = await readBackgroundBytes(background.storageKey);
        if (backgroundBytes === null) {
          return { ok: false, error: errors.not_found() };
        }
        const derivativePath = await ensureDerivative(
          scene.sceneId,
          scene.revision,
          backgroundBytes,
          parseStoredFog(scene.fog),
        );
        let bytes: Buffer;
        try {
          bytes = await readFile(derivativePath);
        } catch {
          return { ok: false, error: errors.not_found() };
        }
        return { ok: true, value: { contentType: "image/png", bytes, revision: scene.revision } };
      } catch {
        return { ok: false, error: errors.internal() };
      }
    },

    async getDisplayTokenImage(tokenImageInput) {
      try {
        if (!checkPresent(tokenImageInput.tokenId)) return { ok: false, error: errors.not_found() };
        const resolved = await resolveDisplayScene(tokenImageInput);
        if (resolved === null) {
          return { ok: false, error: errors.not_found() };
        }
        const { scene } = resolved;
        const fog = parseStoredFog(scene.fog);
        const token = parseStoredTokens(scene.tokens).find(
          (candidate) => candidate.tokenId === tokenImageInput.tokenId,
        );
        // Only tokens the projection itself would list get image bytes:
        // unknown, hidden, fog-covered or imageless tokens read as missing
        // (never a GM original URL for a concealed token).
        if (
          token === undefined ||
          !token.visible ||
          !isPointRevealed(token.x, token.y, fog) ||
          token.imageFileId === null
        ) {
          return { ok: false, error: errors.not_found() };
        }
        const image = await repo.loadMediaFile(input.pool, token.imageFileId);
        if (image === null || image.campaignId !== scene.campaignId) {
          return { ok: false, error: errors.not_found() };
        }
        const bytes = await readBackgroundBytes(image.storageKey);
        if (bytes === null) {
          return { ok: false, error: errors.not_found() };
        }
        return { ok: true, value: { contentType: image.mediaType, bytes, revision: scene.revision } };
      } catch {
        return { ok: false, error: errors.internal() };
      }
    },
  };
}
