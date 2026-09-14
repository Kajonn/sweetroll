import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import type { RequestContext } from "../systems/authoring.js";
import { hashInput } from "../systems/implementation/authoring/assess.js";
import type { CampaignPersistenceRepository, SceneRecord } from "./persistence.js";
import { canManageCampaign } from "./policy.js";
import type { CampaignError, CampaignResult } from "./index.js";

export type FogOp = { mode: "reveal" | "conceal"; runs: Array<{ x: number; y: number; r: number }> };
export type TokenRecord = {
  tokenId: string;
  label: string;
  x: number;
  y: number;
  size: number;
  visible: boolean;
  imageFileId: string | null;
};
export type SceneView = {
  sceneId: string;
  campaignId: string;
  revision: number;
  backgroundFileId: string;
  fog: FogOp[];
  tokens: TokenRecord[];
};
export type OpenSceneInput = { sceneId: string };
export type CreateSceneInput = { campaignId: string; backgroundFileId: string; idempotencyKey: string };
export type UpdateSceneInput = {
  sceneId: string;
  expectedSceneRevision: number;
  backgroundFileId: string;
  idempotencyKey: string;
};
export type ApplyFogEditInput = {
  sceneId: string;
  expectedSceneRevision: number;
  op: FogOp;
  idempotencyKey: string;
};
export type PlaceTokenInput = {
  sceneId: string;
  expectedSceneRevision: number;
  label: string;
  x: number;
  y: number;
  size: number;
  visible: boolean;
  imageFileId: string | null;
  idempotencyKey: string;
};
export type MoveTokenInput = {
  sceneId: string;
  tokenId: string;
  expectedSceneRevision: number;
  x: number;
  y: number;
  idempotencyKey: string;
};
export type RemoveTokenInput = {
  sceneId: string;
  tokenId: string;
  expectedSceneRevision: number;
  idempotencyKey: string;
};

const CREATE_KIND = "scene_create";
const UPDATE_KIND = "scene_update";
const FOG_EDIT_KIND = "scene_fog_edit";
const TOKEN_PLACE_KIND = "scene_token_place";
const TOKEN_MOVE_KIND = "scene_token_move";
const TOKEN_REMOVE_KIND = "scene_token_remove";

const RECEIPT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const NOT_FOUND_MESSAGE = "The requested scene does not exist.";
const MISMATCH_MESSAGE = "This idempotency key was already used with different input.";

/**
 * Thrown inside a transaction when the idempotency receipt insert loses a
 * concurrent race after the mutation already ran. Rolling back keeps the
 * spurious row from committing; the caller then replays the winner.
 */
class ReceiptRace extends Error {
  constructor() {
    super("scene idempotency receipt raced");
  }
}

export type CreateSceneCommandsInput = {
  pool: Pool;
  repo: CampaignPersistenceRepository;
  now?: (() => Date) | undefined;
  newId?: (() => string) | undefined;
};

export interface SceneCommands {
  openScene(ctx: RequestContext, input: OpenSceneInput): Promise<CampaignResult<SceneView>>;
  createScene(ctx: RequestContext, input: CreateSceneInput): Promise<CampaignResult<SceneView>>;
  updateScene(ctx: RequestContext, input: UpdateSceneInput): Promise<CampaignResult<SceneView>>;
  applyFogEdit(ctx: RequestContext, input: ApplyFogEditInput): Promise<CampaignResult<SceneView>>;
  placeToken(ctx: RequestContext, input: PlaceTokenInput): Promise<CampaignResult<SceneView>>;
  moveToken(ctx: RequestContext, input: MoveTokenInput): Promise<CampaignResult<SceneView>>;
  removeToken(ctx: RequestContext, input: RemoveTokenInput): Promise<CampaignResult<SceneView>>;
}

export function createSceneCommands(input: CreateSceneCommandsInput): SceneCommands {
  const repo = input.repo;
  const now = input.now ?? (() => new Date());
  const newId = input.newId ?? (() => randomUUID());

  const errors = {
    bad_request: (message: string): CampaignError => ({ code: "bad_request", message }),
    not_found: (message: string = NOT_FOUND_MESSAGE): CampaignError => ({ code: "not_found", message }),
    mismatch: (): CampaignError => ({ code: "idempotency_mismatch", message: MISMATCH_MESSAGE }),
    result_unavailable: (): CampaignError => ({
      code: "result_unavailable",
      message: "The original result is no longer available.",
    }),
    conflict: (message: string, latestRevision?: number | null): CampaignError => ({
      code: "conflict",
      message,
      ...(latestRevision === undefined ? {} : { latestRevision }),
    }),
    internal: (): CampaignError => ({ code: "internal", message: "An internal error occurred." }),
  };

  function checkIdempotencyKey(key: unknown): CampaignError | null {
    if (typeof key !== "string" || key.length === 0 || key.length > 256) {
      return errors.bad_request("idempotencyKey must be a non-empty string of at most 256 characters.");
    }
    return null;
  }

  function checkSceneRevision(value: unknown): CampaignError | null {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      return errors.bad_request("expectedSceneRevision must be a positive integer.");
    }
    return null;
  }

  function checkBackgroundFileId(value: unknown): CampaignError | null {
    if (typeof value !== "string" || value.length === 0) {
      return errors.bad_request("backgroundFileId must be a non-empty string.");
    }
    return null;
  }

  function checkTokenId(value: unknown): CampaignError | null {
    if (typeof value !== "string" || value.length === 0) {
      return errors.bad_request("tokenId must be a non-empty string.");
    }
    return null;
  }

  function checkLabel(value: unknown): CampaignError | null {
    if (typeof value !== "string" || value.trim().length === 0) {
      return errors.bad_request("label must be a non-empty string.");
    }
    if ([...value].length > 256) {
      return errors.bad_request("label must be at most 256 characters.");
    }
    return null;
  }

  function checkCoordinate(value: unknown, field: "x" | "y"): CampaignError | null {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      return errors.bad_request(`${field} must be a number between 0 and 1.`);
    }
    return null;
  }

  function checkSize(value: unknown): CampaignError | null {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1) {
      return errors.bad_request("size must be a number greater than 0 and at most 1.");
    }
    return null;
  }

  function checkFogOp(value: unknown): CampaignError | null {
    if (typeof value !== "object" || value === null) {
      return errors.bad_request("op must be an object with mode and runs.");
    }
    const op = value as { mode?: unknown; runs?: unknown };
    if (op.mode !== "reveal" && op.mode !== "conceal") {
      return errors.bad_request("op.mode must be reveal or conceal.");
    }
    if (!Array.isArray(op.runs) || op.runs.length === 0) {
      return errors.bad_request("op.runs must be a non-empty array.");
    }
    for (const run of op.runs) {
      if (typeof run !== "object" || run === null) {
        return errors.bad_request("op.runs must contain { x, y, r } with x and y between 0 and 1.");
      }
      const { x, y, r } = run as { x?: unknown; y?: unknown; r?: unknown };
      // Radii are normalized scene-space brush sizes: x/y must land on the
      // scene, while an oversized r simply covers it (no upper cap).
      if (
        typeof x !== "number" ||
        !Number.isFinite(x) ||
        x < 0 ||
        x > 1 ||
        typeof y !== "number" ||
        !Number.isFinite(y) ||
        y < 0 ||
        y > 1 ||
        typeof r !== "number" ||
        !Number.isFinite(r) ||
        r <= 0
      ) {
        return errors.bad_request("op.runs must contain { x, y, r } with x and y between 0 and 1.");
      }
    }
    return null;
  }

  function checkImageFileId(value: unknown): CampaignError | null {
    if (value === null) return null;
    if (typeof value !== "string" || value.length === 0) {
      return errors.bad_request("imageFileId must be a string or null.");
    }
    return null;
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
   * Stored fog/token payloads are written by these commands after
   * validation, so a shape failure here means a corrupt row: surface
   * `internal` (via the caller's catch) rather than leaking garbage.
   */
  function parseStoredFog(value: unknown): FogOp[] {
    if (!Array.isArray(value) || !value.every(isFogOp)) throw new Error("malformed scene fog payload");
    return value.map((op) => ({
      mode: op.mode,
      runs: op.runs.map((run) => ({ x: run.x, y: run.y, r: run.r })),
    }));
  }

  function parseStoredTokens(value: unknown): TokenRecord[] {
    if (!Array.isArray(value) || !value.every(isTokenRecord)) throw new Error("malformed scene tokens payload");
    return value.map((token) => ({
      tokenId: token.tokenId,
      label: token.label,
      x: token.x,
      y: token.y,
      size: token.size,
      visible: token.visible,
      imageFileId: token.imageFileId,
    }));
  }

  function toView(record: SceneRecord): SceneView {
    return {
      sceneId: record.sceneId,
      campaignId: record.campaignId,
      revision: record.revision,
      backgroundFileId: record.backgroundFileId,
      fog: parseStoredFog(record.fog),
      tokens: parseStoredTokens(record.tokens),
    };
  }

  function serializeView(view: SceneView): unknown {
    // Plain JSON scalars only (no dates): clone defensively so later
    // mutations of the live view cannot alias the stored envelope.
    return structuredClone(view);
  }

  function deserializeView(stored: unknown): SceneView {
    return structuredClone(stored as SceneView);
  }

  /**
   * Current-policy reauthorization for scene replays: the caller must still
   * be an active GM of the owning campaign, and the scene row must still
   * exist (campaign deletes cascade the row, turning the replay into
   * not_found instead of a ghost view).
   */
  async function reauthorizeScene(ctx: RequestContext, sceneId: string): Promise<CampaignError | null> {
    return await withClient(async (client) => {
      const scene = await repo.loadScene(client, sceneId);
      if (scene === null) return errors.not_found();
      const campaign = await repo.openCampaign(client, scene.campaignId);
      const membership =
        campaign === null ? null : await repo.loadMembership(client, scene.campaignId, ctx.actorId);
      if (campaign === null || !canManageCampaign(campaign, membership)) return errors.not_found();
      return null;
    });
  }

  async function resolveSceneReplay(
    ctx: RequestContext,
    options: {
      inputHash: string;
      receipt: { inputHash: string; resultJson: unknown; expiresAt: Date } | null;
    },
  ): Promise<CampaignResult<SceneView>> {
    if (options.receipt === null) return { ok: false, error: errors.internal() };
    if (options.receipt.inputHash !== options.inputHash) return { ok: false, error: errors.mismatch() };
    if (options.receipt.expiresAt.getTime() <= now().getTime()) {
      return { ok: false, error: errors.result_unavailable() };
    }
    const stored = options.receipt.resultJson as { sceneId?: string; value?: unknown };
    if (typeof stored.sceneId !== "string") return { ok: false, error: errors.internal() };
    const denial = await reauthorizeScene(ctx, stored.sceneId);
    if (denial !== null) return { ok: false, error: denial };
    return { ok: true, value: deserializeView(stored.value) };
  }

  type TxResult =
    | { committed: true; value: SceneView }
    | { committed: false; failure?: CampaignError; receipt?: { inputHash: string; resultJson: unknown; expiresAt: Date } | null };

  async function loadReceiptRace(
    receiptKey: { actorId: string; commandKind: string; idempotencyKey: string },
  ): Promise<TxResult> {
    const receipt = await repo.loadReceiptWithExpiry(input.pool, receiptKey);
    return { committed: false as const, receipt };
  }

  /**
   * Campaign-first lock order (see media.ts): resolve the owning campaign
   * with an unlocked read, lock the campaign, then lock the scene row, so
   * concurrent membership/scene mutations serialize.
   */
  async function lockSceneForMutation(
    client: PoolClient,
    sceneId: string,
  ): Promise<
    | { ok: true; campaignId: string }
    | { ok: false; failure: CampaignError }
  > {
    const known = await repo.loadScene(client, sceneId);
    if (known === null) return { ok: false, failure: errors.not_found() };
    return { ok: true, campaignId: known.campaignId };
  }

  function checkSceneGuard(
    revision: number,
    expectedRevision: number,
  ): CampaignError | null {
    if (revision !== expectedRevision) {
      return errors.conflict(
        "The scene has a newer revision. Retry with the latest revision and a new idempotency key.",
        revision,
      );
    }
    return null;
  }

  return {
    async openScene(ctx, openInput) {
      try {
        if (typeof openInput.sceneId !== "string" || openInput.sceneId.length === 0) {
          return { ok: false, error: errors.not_found() };
        }
        // Single-client read-only snapshot: the scene row, its campaign and
        // the caller membership share one snapshot; outsiders and players
        // collapse to generic not_found without learning the scene exists.
        const outcome = await withClient(async (client) => {
          const scene = await repo.loadScene(client, openInput.sceneId);
          if (scene === null) return { scene: null, campaign: null, membership: null };
          const campaign = await repo.openCampaign(client, scene.campaignId);
          const membership =
            campaign === null ? null : await repo.loadMembership(client, scene.campaignId, ctx.actorId);
          return { scene, campaign, membership };
        });
        if (
          outcome.scene === null ||
          outcome.campaign === null ||
          !canManageCampaign(outcome.campaign, outcome.membership)
        ) {
          return { ok: false, error: errors.not_found() };
        }
        return { ok: true, value: toView(outcome.scene) };
      } catch {
        return { ok: false, error: errors.internal() };
      }
    },

    async createScene(ctx, createInput) {
      try {
        const keyError = checkIdempotencyKey(createInput.idempotencyKey);
        if (keyError !== null) return { ok: false, error: keyError };
        const fileError = checkBackgroundFileId(createInput.backgroundFileId);
        if (fileError !== null) return { ok: false, error: fileError };

        const inputHash = hashInput({
          campaignId: createInput.campaignId,
          backgroundFileId: createInput.backgroundFileId,
        });
        const receiptKey = {
          actorId: ctx.actorId,
          commandKind: CREATE_KIND,
          idempotencyKey: createInput.idempotencyKey,
        };

        const preExisting = await repo.loadReceiptWithExpiry(input.pool, receiptKey);
        if (preExisting !== null) {
          return await resolveSceneReplay(ctx, { inputHash, receipt: preExisting });
        }

        const outcome: TxResult = await withTransaction(async (client) => {
          const campaign = await repo.lockCampaign(client, createInput.campaignId);
          const membership =
            campaign === null
              ? null
              : await repo.loadMembership(client, createInput.campaignId, ctx.actorId);
          const raced = await repo.loadReceiptWithExpiry(client, receiptKey);
          if (raced !== null) {
            return { committed: false as const, receipt: raced };
          }
          if (campaign === null || !canManageCampaign(campaign, membership)) {
            return { committed: false as const, failure: errors.not_found() as CampaignError };
          }
          const background = await repo.loadMediaFile(client, createInput.backgroundFileId);
          if (background === null || background.campaignId !== campaign.campaignId) {
            return { committed: false as const, failure: errors.not_found() as CampaignError };
          }
          const record = await repo.insertScene(client, {
            sceneId: newId(),
            campaignId: campaign.campaignId,
            backgroundFileId: background.fileId,
          });
          const value = toView(record);
          const inserted = await repo.tryInsertReceipt(client, {
            actorId: ctx.actorId,
            commandKind: CREATE_KIND,
            idempotencyKey: createInput.idempotencyKey,
            inputHash,
            campaignId: campaign.campaignId,
            resultJson: {
              campaignId: campaign.campaignId,
              sceneId: record.sceneId,
              value: serializeView(value),
              idempotencyKey: createInput.idempotencyKey,
            },
            expiresAt: new Date(now().getTime() + RECEIPT_TTL_MS),
          });
          if (!inserted) {
            throw new ReceiptRace();
          }
          return { committed: true as const, value };
        }).catch(async (error) => {
          if (error instanceof ReceiptRace) {
            return await loadReceiptRace(receiptKey);
          }
          throw error;
        });

        if ("failure" in outcome) return { ok: false, error: outcome.failure };
        if (outcome.committed) return { ok: true, value: outcome.value };
        return await resolveSceneReplay(ctx, { inputHash, receipt: outcome.receipt ?? null });
      } catch {
        return { ok: false, error: errors.internal() };
      }
    },

    async updateScene(ctx, updateInput) {
      try {
        const keyError = checkIdempotencyKey(updateInput.idempotencyKey);
        if (keyError !== null) return { ok: false, error: keyError };
        const revisionError = checkSceneRevision(updateInput.expectedSceneRevision);
        if (revisionError !== null) return { ok: false, error: revisionError };
        const fileError = checkBackgroundFileId(updateInput.backgroundFileId);
        if (fileError !== null) return { ok: false, error: fileError };

        const inputHash = hashInput({
          sceneId: updateInput.sceneId,
          expectedSceneRevision: updateInput.expectedSceneRevision,
          backgroundFileId: updateInput.backgroundFileId,
        });
        const receiptKey = {
          actorId: ctx.actorId,
          commandKind: UPDATE_KIND,
          idempotencyKey: updateInput.idempotencyKey,
        };

        const preExisting = await repo.loadReceiptWithExpiry(input.pool, receiptKey);
        if (preExisting !== null) {
          return await resolveSceneReplay(ctx, { inputHash, receipt: preExisting });
        }

        const outcome: TxResult = await withTransaction(async (client) => {
          const resolved = await lockSceneForMutation(client, updateInput.sceneId);
          if (!resolved.ok) {
            return { committed: false as const, failure: resolved.failure };
          }
          const campaign = await repo.lockCampaign(client, resolved.campaignId);
          const locked = await repo.lockScene(client, updateInput.sceneId);
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
          const guard = checkSceneGuard(locked.revision, updateInput.expectedSceneRevision);
          if (guard !== null) {
            return { committed: false as const, failure: guard };
          }
          const background = await repo.loadMediaFile(client, updateInput.backgroundFileId);
          if (background === null || background.campaignId !== locked.campaignId) {
            return { committed: false as const, failure: errors.not_found() as CampaignError };
          }
          const updated = await repo.updateSceneBackground(client, {
            sceneId: locked.sceneId,
            backgroundFileId: background.fileId,
            expectedRevision: updateInput.expectedSceneRevision,
          });
          if (updated === null) {
            return {
              committed: false as const,
              failure: errors.conflict(
                "The scene has a newer revision. Retry with the latest revision and a new idempotency key.",
                locked.revision,
              ),
            };
          }
          const value = toView(updated);
          const inserted = await repo.tryInsertReceipt(client, {
            actorId: ctx.actorId,
            commandKind: UPDATE_KIND,
            idempotencyKey: updateInput.idempotencyKey,
            inputHash,
            campaignId: locked.campaignId,
            resultJson: {
              campaignId: locked.campaignId,
              sceneId: locked.sceneId,
              value: serializeView(value),
              idempotencyKey: updateInput.idempotencyKey,
            },
            expiresAt: new Date(now().getTime() + RECEIPT_TTL_MS),
          });
          if (!inserted) {
            throw new ReceiptRace();
          }
          return { committed: true as const, value };
        }).catch(async (error) => {
          if (error instanceof ReceiptRace) {
            return await loadReceiptRace(receiptKey);
          }
          throw error;
        });

        if ("failure" in outcome) return { ok: false, error: outcome.failure };
        if (outcome.committed) return { ok: true, value: outcome.value };
        return await resolveSceneReplay(ctx, { inputHash, receipt: outcome.receipt ?? null });
      } catch {
        return { ok: false, error: errors.internal() };
      }
    },

    async applyFogEdit(ctx, fogInput) {
      try {
        const keyError = checkIdempotencyKey(fogInput.idempotencyKey);
        if (keyError !== null) return { ok: false, error: keyError };
        const revisionError = checkSceneRevision(fogInput.expectedSceneRevision);
        if (revisionError !== null) return { ok: false, error: revisionError };
        const opError = checkFogOp(fogInput.op);
        if (opError !== null) return { ok: false, error: opError };

        const inputHash = hashInput({
          sceneId: fogInput.sceneId,
          expectedSceneRevision: fogInput.expectedSceneRevision,
          op: fogInput.op,
        });
        const receiptKey = {
          actorId: ctx.actorId,
          commandKind: FOG_EDIT_KIND,
          idempotencyKey: fogInput.idempotencyKey,
        };

        const preExisting = await repo.loadReceiptWithExpiry(input.pool, receiptKey);
        if (preExisting !== null) {
          return await resolveSceneReplay(ctx, { inputHash, receipt: preExisting });
        }

        const outcome: TxResult = await withTransaction(async (client) => {
          const resolved = await lockSceneForMutation(client, fogInput.sceneId);
          if (!resolved.ok) {
            return { committed: false as const, failure: resolved.failure };
          }
          const campaign = await repo.lockCampaign(client, resolved.campaignId);
          const locked = await repo.lockScene(client, fogInput.sceneId);
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
          const guard = checkSceneGuard(locked.revision, fogInput.expectedSceneRevision);
          if (guard !== null) {
            return { committed: false as const, failure: guard };
          }
          const updated = await repo.appendSceneFogOp(client, {
            sceneId: locked.sceneId,
            fogOp: fogInput.op,
            expectedRevision: fogInput.expectedSceneRevision,
          });
          if (updated === null) {
            return {
              committed: false as const,
              failure: errors.conflict(
                "The scene has a newer revision. Retry with the latest revision and a new idempotency key.",
                locked.revision,
              ),
            };
          }
          const value = toView(updated);
          const inserted = await repo.tryInsertReceipt(client, {
            actorId: ctx.actorId,
            commandKind: FOG_EDIT_KIND,
            idempotencyKey: fogInput.idempotencyKey,
            inputHash,
            campaignId: locked.campaignId,
            resultJson: {
              campaignId: locked.campaignId,
              sceneId: locked.sceneId,
              value: serializeView(value),
              idempotencyKey: fogInput.idempotencyKey,
            },
            expiresAt: new Date(now().getTime() + RECEIPT_TTL_MS),
          });
          if (!inserted) {
            throw new ReceiptRace();
          }
          return { committed: true as const, value };
        }).catch(async (error) => {
          if (error instanceof ReceiptRace) {
            return await loadReceiptRace(receiptKey);
          }
          throw error;
        });

        if ("failure" in outcome) return { ok: false, error: outcome.failure };
        if (outcome.committed) return { ok: true, value: outcome.value };
        return await resolveSceneReplay(ctx, { inputHash, receipt: outcome.receipt ?? null });
      } catch {
        return { ok: false, error: errors.internal() };
      }
    },

    async placeToken(ctx, placeInput) {
      try {
        const keyError = checkIdempotencyKey(placeInput.idempotencyKey);
        if (keyError !== null) return { ok: false, error: keyError };
        const revisionError = checkSceneRevision(placeInput.expectedSceneRevision);
        if (revisionError !== null) return { ok: false, error: revisionError };
        const labelError = checkLabel(placeInput.label);
        if (labelError !== null) return { ok: false, error: labelError };
        const xError = checkCoordinate(placeInput.x, "x");
        if (xError !== null) return { ok: false, error: xError };
        const yError = checkCoordinate(placeInput.y, "y");
        if (yError !== null) return { ok: false, error: yError };
        const sizeError = checkSize(placeInput.size);
        if (sizeError !== null) return { ok: false, error: sizeError };
        if (typeof placeInput.visible !== "boolean") {
          return { ok: false, error: errors.bad_request("visible must be a boolean.") };
        }
        const imageError = checkImageFileId(placeInput.imageFileId);
        if (imageError !== null) return { ok: false, error: imageError };

        const inputHash = hashInput({
          sceneId: placeInput.sceneId,
          expectedSceneRevision: placeInput.expectedSceneRevision,
          label: placeInput.label,
          x: placeInput.x,
          y: placeInput.y,
          size: placeInput.size,
          visible: placeInput.visible,
          imageFileId: placeInput.imageFileId,
        });
        const receiptKey = {
          actorId: ctx.actorId,
          commandKind: TOKEN_PLACE_KIND,
          idempotencyKey: placeInput.idempotencyKey,
        };

        const preExisting = await repo.loadReceiptWithExpiry(input.pool, receiptKey);
        if (preExisting !== null) {
          return await resolveSceneReplay(ctx, { inputHash, receipt: preExisting });
        }

        const outcome: TxResult = await withTransaction(async (client) => {
          const resolved = await lockSceneForMutation(client, placeInput.sceneId);
          if (!resolved.ok) {
            return { committed: false as const, failure: resolved.failure };
          }
          const campaign = await repo.lockCampaign(client, resolved.campaignId);
          const locked = await repo.lockScene(client, placeInput.sceneId);
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
          const guard = checkSceneGuard(locked.revision, placeInput.expectedSceneRevision);
          if (guard !== null) {
            return { committed: false as const, failure: guard };
          }
          if (placeInput.imageFileId !== null) {
            const image = await repo.loadMediaFile(client, placeInput.imageFileId);
            if (image === null || image.campaignId !== locked.campaignId) {
              return { committed: false as const, failure: errors.not_found() as CampaignError };
            }
          }
          const token: TokenRecord = {
            tokenId: newId(),
            label: placeInput.label,
            x: placeInput.x,
            y: placeInput.y,
            size: placeInput.size,
            visible: placeInput.visible,
            imageFileId: placeInput.imageFileId,
          };
          const updated = await repo.updateSceneTokens(client, {
            sceneId: locked.sceneId,
            tokens: [...parseStoredTokens(locked.tokens), token],
            expectedRevision: placeInput.expectedSceneRevision,
          });
          if (updated === null) {
            return {
              committed: false as const,
              failure: errors.conflict(
                "The scene has a newer revision. Retry with the latest revision and a new idempotency key.",
                locked.revision,
              ),
            };
          }
          const value = toView(updated);
          const inserted = await repo.tryInsertReceipt(client, {
            actorId: ctx.actorId,
            commandKind: TOKEN_PLACE_KIND,
            idempotencyKey: placeInput.idempotencyKey,
            inputHash,
            campaignId: locked.campaignId,
            resultJson: {
              campaignId: locked.campaignId,
              sceneId: locked.sceneId,
              value: serializeView(value),
              idempotencyKey: placeInput.idempotencyKey,
            },
            expiresAt: new Date(now().getTime() + RECEIPT_TTL_MS),
          });
          if (!inserted) {
            throw new ReceiptRace();
          }
          return { committed: true as const, value };
        }).catch(async (error) => {
          if (error instanceof ReceiptRace) {
            return await loadReceiptRace(receiptKey);
          }
          throw error;
        });

        if ("failure" in outcome) return { ok: false, error: outcome.failure };
        if (outcome.committed) return { ok: true, value: outcome.value };
        return await resolveSceneReplay(ctx, { inputHash, receipt: outcome.receipt ?? null });
      } catch {
        return { ok: false, error: errors.internal() };
      }
    },

    async moveToken(ctx, moveInput) {
      try {
        const keyError = checkIdempotencyKey(moveInput.idempotencyKey);
        if (keyError !== null) return { ok: false, error: keyError };
        const revisionError = checkSceneRevision(moveInput.expectedSceneRevision);
        if (revisionError !== null) return { ok: false, error: revisionError };
        const tokenError = checkTokenId(moveInput.tokenId);
        if (tokenError !== null) return { ok: false, error: tokenError };
        const xError = checkCoordinate(moveInput.x, "x");
        if (xError !== null) return { ok: false, error: xError };
        const yError = checkCoordinate(moveInput.y, "y");
        if (yError !== null) return { ok: false, error: yError };

        const inputHash = hashInput({
          sceneId: moveInput.sceneId,
          tokenId: moveInput.tokenId,
          expectedSceneRevision: moveInput.expectedSceneRevision,
          x: moveInput.x,
          y: moveInput.y,
        });
        const receiptKey = {
          actorId: ctx.actorId,
          commandKind: TOKEN_MOVE_KIND,
          idempotencyKey: moveInput.idempotencyKey,
        };

        const preExisting = await repo.loadReceiptWithExpiry(input.pool, receiptKey);
        if (preExisting !== null) {
          return await resolveSceneReplay(ctx, { inputHash, receipt: preExisting });
        }

        const outcome: TxResult = await withTransaction(async (client) => {
          const resolved = await lockSceneForMutation(client, moveInput.sceneId);
          if (!resolved.ok) {
            return { committed: false as const, failure: resolved.failure };
          }
          const campaign = await repo.lockCampaign(client, resolved.campaignId);
          const locked = await repo.lockScene(client, moveInput.sceneId);
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
          const guard = checkSceneGuard(locked.revision, moveInput.expectedSceneRevision);
          if (guard !== null) {
            return { committed: false as const, failure: guard };
          }
          const tokens = parseStoredTokens(locked.tokens);
          if (!tokens.some((token) => token.tokenId === moveInput.tokenId)) {
            return { committed: false as const, failure: errors.not_found() as CampaignError };
          }
          const updated = await repo.updateSceneTokens(client, {
            sceneId: locked.sceneId,
            tokens: tokens.map((token) =>
              token.tokenId === moveInput.tokenId ? { ...token, x: moveInput.x, y: moveInput.y } : token,
            ),
            expectedRevision: moveInput.expectedSceneRevision,
          });
          if (updated === null) {
            return {
              committed: false as const,
              failure: errors.conflict(
                "The scene has a newer revision. Retry with the latest revision and a new idempotency key.",
                locked.revision,
              ),
            };
          }
          const value = toView(updated);
          const inserted = await repo.tryInsertReceipt(client, {
            actorId: ctx.actorId,
            commandKind: TOKEN_MOVE_KIND,
            idempotencyKey: moveInput.idempotencyKey,
            inputHash,
            campaignId: locked.campaignId,
            resultJson: {
              campaignId: locked.campaignId,
              sceneId: locked.sceneId,
              value: serializeView(value),
              idempotencyKey: moveInput.idempotencyKey,
            },
            expiresAt: new Date(now().getTime() + RECEIPT_TTL_MS),
          });
          if (!inserted) {
            throw new ReceiptRace();
          }
          return { committed: true as const, value };
        }).catch(async (error) => {
          if (error instanceof ReceiptRace) {
            return await loadReceiptRace(receiptKey);
          }
          throw error;
        });

        if ("failure" in outcome) return { ok: false, error: outcome.failure };
        if (outcome.committed) return { ok: true, value: outcome.value };
        return await resolveSceneReplay(ctx, { inputHash, receipt: outcome.receipt ?? null });
      } catch {
        return { ok: false, error: errors.internal() };
      }
    },

    async removeToken(ctx, removeInput) {
      try {
        const keyError = checkIdempotencyKey(removeInput.idempotencyKey);
        if (keyError !== null) return { ok: false, error: keyError };
        const revisionError = checkSceneRevision(removeInput.expectedSceneRevision);
        if (revisionError !== null) return { ok: false, error: revisionError };
        const tokenError = checkTokenId(removeInput.tokenId);
        if (tokenError !== null) return { ok: false, error: tokenError };

        const inputHash = hashInput({
          sceneId: removeInput.sceneId,
          tokenId: removeInput.tokenId,
          expectedSceneRevision: removeInput.expectedSceneRevision,
        });
        const receiptKey = {
          actorId: ctx.actorId,
          commandKind: TOKEN_REMOVE_KIND,
          idempotencyKey: removeInput.idempotencyKey,
        };

        const preExisting = await repo.loadReceiptWithExpiry(input.pool, receiptKey);
        if (preExisting !== null) {
          return await resolveSceneReplay(ctx, { inputHash, receipt: preExisting });
        }

        const outcome: TxResult = await withTransaction(async (client) => {
          const resolved = await lockSceneForMutation(client, removeInput.sceneId);
          if (!resolved.ok) {
            return { committed: false as const, failure: resolved.failure };
          }
          const campaign = await repo.lockCampaign(client, resolved.campaignId);
          const locked = await repo.lockScene(client, removeInput.sceneId);
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
          const guard = checkSceneGuard(locked.revision, removeInput.expectedSceneRevision);
          if (guard !== null) {
            return { committed: false as const, failure: guard };
          }
          const tokens = parseStoredTokens(locked.tokens);
          if (!tokens.some((token) => token.tokenId === removeInput.tokenId)) {
            return { committed: false as const, failure: errors.not_found() as CampaignError };
          }
          const updated = await repo.updateSceneTokens(client, {
            sceneId: locked.sceneId,
            tokens: tokens.filter((token) => token.tokenId !== removeInput.tokenId),
            expectedRevision: removeInput.expectedSceneRevision,
          });
          if (updated === null) {
            return {
              committed: false as const,
              failure: errors.conflict(
                "The scene has a newer revision. Retry with the latest revision and a new idempotency key.",
                locked.revision,
              ),
            };
          }
          const value = toView(updated);
          const inserted = await repo.tryInsertReceipt(client, {
            actorId: ctx.actorId,
            commandKind: TOKEN_REMOVE_KIND,
            idempotencyKey: removeInput.idempotencyKey,
            inputHash,
            campaignId: locked.campaignId,
            resultJson: {
              campaignId: locked.campaignId,
              sceneId: locked.sceneId,
              value: serializeView(value),
              idempotencyKey: removeInput.idempotencyKey,
            },
            expiresAt: new Date(now().getTime() + RECEIPT_TTL_MS),
          });
          if (!inserted) {
            throw new ReceiptRace();
          }
          return { committed: true as const, value };
        }).catch(async (error) => {
          if (error instanceof ReceiptRace) {
            return await loadReceiptRace(receiptKey);
          }
          throw error;
        });

        if ("failure" in outcome) return { ok: false, error: outcome.failure };
        if (outcome.committed) return { ok: true, value: outcome.value };
        return await resolveSceneReplay(ctx, { inputHash, receipt: outcome.receipt ?? null });
      } catch {
        return { ok: false, error: errors.internal() };
      }
    },
  };
}
