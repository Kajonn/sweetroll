import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import type { RequestContext } from "../systems/authoring.js";
import { hashInput } from "../systems/implementation/authoring/assess.js";
import type {
  DefinitionId,
  RuntimeStateV1,
  SystemRuntime,
  VersionId,
} from "../systems/runtime.js";
import { isActiveMember, isGameMaster, type MembershipRecord } from "../campaigns/policy.js";

import { claimExecutionOnClient } from "./idempotency.js";

export type CharacterId = string;
export type UserId = string;
export type CampaignId = string;
export type ExecutionId = string;

export type PlacementErrorCode =
  | "bad_request"
  | "not_found"
  | "conflict"
  | "idempotency_mismatch"
  | "internal";

export type PlacementError = {
  code: PlacementErrorCode;
  message: string;
  latestRevision?: number | null;
};

export type PlacementResult<T> = { ok: true; value: T } | { ok: false; error: PlacementError };

/**
 * Lean placement DTO: current record state plus campaign custody. Unlike the
 * full Characters view it carries no Runtime-derived projection/validation:
 * placement operations persist (adopt/assign/claim) or store (create) state
 * while locked and never evaluate Runtime inside the transaction.
 */
export type PlacedCharacterView = {
  characterId: CharacterId;
  /** Always NULL while attached: custody is campaignId/controllers, never an owner user. */
  ownerId: null;
  campaignId: CampaignId;
  controllers: UserId[];
  placementGeneration: number;
  returnOwnerId: UserId | null;
  name: string;
  systemVersionId: VersionId;
  entityDefinitionId: DefinitionId;
  revision: number;
  lifecycle: "active" | "archived";
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  state: RuntimeStateV1;
  replayed: boolean;
};

/** Runtime-prepared initialization, resolved OUTSIDE any transaction. */
export type PreparedCampaignCharacter = {
  versionId: VersionId;
  entityDefinitionId: DefinitionId;
  state: RuntimeStateV1;
  packageChecksum: string;
};

export type CreateInCampaignInput = {
  campaignId: CampaignId;
  expectedCampaignRevision: number;
  membershipGeneration: number;
  idempotencyKey: string;
  name: string;
  entityDefinitionId: DefinitionId;
  prepared: PreparedCampaignCharacter;
  /** GM-only assignment; players must pass exactly themselves. Defaults per role. */
  controllerUserIds?: UserId[];
};

export type AdoptCharacterInput = {
  campaignId: CampaignId;
  expectedCampaignRevision: number;
  membershipGeneration: number;
  characterId: CharacterId;
  expectedCharacterRevision: number;
  /** Explicit disclosure acknowledgement: sheet contents return to the owner on departure. */
  acknowledgedDisclosure: boolean;
  idempotencyKey: string;
};

export type AssignControllersInput = {
  campaignId: CampaignId;
  expectedCampaignRevision: number;
  membershipGeneration: number;
  characterId: CharacterId;
  expectedCharacterRevision: number;
  /** Full replacement set; must retain the return owner when one is recorded. */
  controllerUserIds: UserId[];
  /** GM claim designations added alongside the replacement; each must be an active member. */
  designateClaimants?: UserId[];
  idempotencyKey: string;
};

export type ClaimCharacterInput = {
  campaignId: CampaignId;
  expectedCampaignRevision: number;
  membershipGeneration: number;
  characterId: CharacterId;
  expectedCharacterRevision: number;
  idempotencyKey: string;
};

export type MemberReturnInput = {
  campaignId: CampaignId;
  /** Departing member whose controllers/designations clear and whose adopted sheets return. */
  userId: UserId;
  actorId: UserId;
  requestId: string;
};

export type MemberReturnResult = {
  returned: Array<{ characterId: CharacterId; revision: number; placementGeneration: number }>;
  releasedControllers: number;
  releasedDesignations: number;
};

/** Narrow seam consumed by the Campaigns module (member-removal return). */
export interface CampaignCharacterPlacement {
  returnForMember(client: PoolClient, input: MemberReturnInput): Promise<MemberReturnResult>;
}

export interface CampaignPlacement extends CampaignCharacterPlacement {
  createInCampaign(
    client: PoolClient,
    ctx: RequestContext,
    input: CreateInCampaignInput,
  ): Promise<PlacementResult<PlacedCharacterView>>;
  adopt(
    client: PoolClient,
    ctx: RequestContext,
    input: AdoptCharacterInput,
  ): Promise<PlacementResult<PlacedCharacterView>>;
  assign(
    client: PoolClient,
    ctx: RequestContext,
    input: AssignControllersInput,
  ): Promise<PlacementResult<PlacedCharacterView>>;
  claim(
    client: PoolClient,
    ctx: RequestContext,
    input: ClaimCharacterInput,
  ): Promise<PlacementResult<PlacedCharacterView>>;
}

export type CreateCampaignPlacementInput = {
  pool: Pool;
  runtime: SystemRuntime;
  now?: () => Date;
  newId?: () => string;
  newExecutionId?: () => string;
  /** Supported bound for attached characters per campaign (default 200). */
  maxAttachedCharacters?: number;
  hooks?: {
    /** Test seam: invoked inside the removal transaction after each single-character return. */
    afterSingleReturn?: (info: { campaignId: string; characterId: string }) => Promise<void>;
  };
};

type CampaignRow = {
  id: string;
  owner_id: string;
  system_version_id: string;
  title: string;
  status: string;
  revision: number;
  access_revision: number;
};

type MembershipRow = {
  campaign_id: string;
  user_id: string;
  role: string;
  status: string;
  generation: number;
};

type CharacterRow = {
  id: string;
  owner_id: string | null;
  campaign_id: string | null;
  placement_generation: number;
  return_owner_id: string | null;
  system_version_id: string;
  entity_definition_id: string;
  name: string;
  revision: number;
  state_json: unknown;
  lifecycle: string;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

const CREATE_KIND = "character_campaign_create";
const ADOPT_KIND = "character_campaign_adopt";
const ASSIGN_KIND = "character_campaign_assign";
const CLAIM_KIND = "character_campaign_claim";

const LEASE_MS = 60 * 1000;
const REPLAY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const NOT_FOUND_MESSAGE = "The requested campaign character does not exist.";
const MISMATCH_MESSAGE = "This idempotency key was already used with different input.";
const EXPIRED_MESSAGE = "The replay window for this idempotency key has expired. Retry with a new key.";
const IN_PROGRESS_MESSAGE = "Another request is already processing this idempotency key.";

/**
 * Resolves character initialization through Runtime BEFORE any transaction
 * opens. `createInCampaign` only rechecks the prepared resolution (pinned
 * version/entity equality) while locked and persists the prepared state; it
 * never calls Runtime itself.
 */
export async function prepareCampaignCharacter(
  runtime: SystemRuntime,
  input: {
    systemVersionId: VersionId;
    entityDefinitionId: DefinitionId;
    initialValues?: Record<DefinitionId, unknown>;
  },
): Promise<
  | { ok: true; value: PreparedCampaignCharacter }
  | { ok: false; error: { code: "bad_request" | "not_found" | "internal"; message: string } }
> {
  try {
    const resolved = await runtime.resolve({
      versionId: input.systemVersionId,
      entityId: input.entityDefinitionId,
      intent:
        input.initialValues === undefined
          ? { kind: "initialize" }
          : { kind: "initialize", values: input.initialValues },
    });
    if (!resolved.ok) {
      if (resolved.error.code === "not_found") {
        return {
          ok: false,
          error: { code: "not_found", message: "The published version or entity definition does not exist." },
        };
      }
      return { ok: false, error: { code: "bad_request", message: resolved.error.message } };
    }
    return {
      ok: true,
      value: {
        versionId: resolved.value.versionId,
        entityDefinitionId: input.entityDefinitionId,
        state: resolved.value.state,
        packageChecksum: resolved.value.packageChecksum,
      },
    };
  } catch {
    return { ok: false, error: { code: "internal", message: "An internal error occurred." } };
  }
}

export function createCampaignPlacement(input: CreateCampaignPlacementInput): CampaignPlacement {
  const now = input.now ?? (() => new Date());
  const newId = input.newId ?? (() => randomUUID());
  const newExecutionId = input.newExecutionId ?? (() => randomUUID());
  const maxAttached = input.maxAttachedCharacters ?? 200;

  const errors = {
    bad_request: (message: string): PlacementError => ({ code: "bad_request", message }),
    not_found: (message: string = NOT_FOUND_MESSAGE): PlacementError => ({ code: "not_found", message }),
    mismatch: (): PlacementError => ({ code: "idempotency_mismatch", message: MISMATCH_MESSAGE }),
    expired: (): PlacementError => ({ code: "conflict", message: EXPIRED_MESSAGE }),
    inProgress: (): PlacementError => ({ code: "conflict", message: IN_PROGRESS_MESSAGE }),
    conflict: (message: string, latestRevision?: number | null): PlacementError => ({
      code: "conflict",
      message,
      ...(latestRevision === undefined ? {} : { latestRevision }),
    }),
    internal: (): PlacementError => ({ code: "internal", message: "An internal error occurred." }),
  };

  function checkIdempotencyKey(key: unknown): PlacementError | null {
    if (typeof key !== "string" || key.length === 0 || key.length > 256) {
      return errors.bad_request("idempotencyKey must be a non-empty string of at most 256 characters.");
    }
    return null;
  }

  function checkRevision(value: unknown, name: string): PlacementError | null {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      return errors.bad_request(`${name} must be a positive integer.`);
    }
    return null;
  }

  async function lockCampaign(client: PoolClient, campaignId: string): Promise<CampaignRow | null> {
    const result = await client.query<CampaignRow>(
      `SELECT id, owner_id, system_version_id, title, status, revision, access_revision
         FROM campaigns WHERE id = $1 FOR UPDATE`,
      [campaignId],
    );
    return result.rows[0] ?? null;
  }

  async function loadMembership(
    client: PoolClient,
    campaignId: string,
    userId: string,
  ): Promise<MembershipRecord | null> {
    const result = await client.query<MembershipRow>(
      `SELECT campaign_id, user_id, role, status, generation
         FROM campaign_members WHERE campaign_id = $1 AND user_id = $2`,
      [campaignId, userId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    if (row.role !== "owner" && row.role !== "co_gm" && row.role !== "player") {
      throw new Error(`Unknown campaign role: ${row.role}`);
    }
    if (row.status !== "active" && row.status !== "removed") {
      throw new Error(`Unknown membership status: ${row.status}`);
    }
    return {
      campaignId: row.campaign_id,
      userId: row.user_id,
      role: row.role,
      status: row.status,
      generation: row.generation,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
  }

  async function lockCharacter(client: PoolClient, characterId: string): Promise<CharacterRow | null> {
    const result = await client.query<CharacterRow>(
      `SELECT id, owner_id, campaign_id, placement_generation, return_owner_id,
              system_version_id, entity_definition_id, name, revision, state_json,
              lifecycle, archived_at, created_at, updated_at
         FROM characters WHERE id = $1 FOR UPDATE`,
      [characterId],
    );
    return result.rows[0] ?? null;
  }

  async function loadControllers(client: PoolClient, characterId: string): Promise<UserId[]> {
    const result = await client.query<{ user_id: string }>(
      `SELECT user_id FROM character_controllers WHERE character_id = $1 ORDER BY user_id`,
      [characterId],
    );
    return result.rows.map((row) => row.user_id);
  }

  async function bumpCampaignRevision(
    client: PoolClient,
    campaignId: string,
    expectedRevision: number,
  ): Promise<CampaignRow | null> {
    const result = await client.query<CampaignRow>(
      `UPDATE campaigns
          SET revision = revision + 1, access_revision = access_revision + 1, updated_at = $2
        WHERE id = $1 AND revision = $3
        RETURNING id, owner_id, system_version_id, title, status, revision, access_revision`,
      [campaignId, now().toISOString(), expectedRevision],
    );
    return result.rows[0] ?? null;
  }

  function checkMembershipGeneration(membership: MembershipRecord, expected: number): PlacementError | null {
    if (membership.generation !== expected) {
      return errors.conflict("Membership changed under this request. Retry with the current generation.");
    }
    return null;
  }

  async function attachedCount(client: PoolClient, campaignId: string): Promise<number> {
    const result = await client.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM characters WHERE campaign_id = $1`,
      [campaignId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  function serializePlaced(view: PlacedCharacterView): unknown {
    return {
      ...view,
      archivedAt: view.archivedAt === null ? null : view.archivedAt.toISOString(),
      createdAt: view.createdAt.toISOString(),
      updatedAt: view.updatedAt.toISOString(),
    };
  }

  function deserializePlaced(stored: unknown): PlacedCharacterView {
    const raw = stored as Omit<PlacedCharacterView, "archivedAt" | "createdAt" | "updatedAt"> & {
      archivedAt: string | null;
      createdAt: string;
      updatedAt: string;
    };
    return {
      ...raw,
      archivedAt: raw.archivedAt === null ? null : new Date(raw.archivedAt),
      createdAt: new Date(raw.createdAt),
      updatedAt: new Date(raw.updatedAt),
    };
  }

  async function completeExecution(
    client: PoolClient,
    executionId: string,
    resultJson: unknown,
  ): Promise<void> {
    await client.query(
      `UPDATE character_command_executions
          SET status = 'completed', result_json = $1::jsonb, expires_at = $2
        WHERE execution_id = $3`,
      [JSON.stringify(resultJson), new Date(now().getTime() + REPLAY_TTL_MS).toISOString(), executionId],
    );
  }

  async function recordPlacementActivity(
    client: PoolClient,
    input: { characterId: string; revision: number; kind: string; payloadJson: unknown; actorId: string; requestId: string; campaignId: string },
  ): Promise<void> {
    await client.query(
      `INSERT INTO character_activity_events (character_id, character_revision, kind, payload_json, request_id, scope_campaign_id)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
      [input.characterId, input.revision, input.kind, JSON.stringify(input.payloadJson), input.requestId, input.campaignId],
    );
    await client.query(
      `INSERT INTO character_audit_records (character_id, actor_id, kind, summary, request_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [input.characterId, input.actorId, input.kind, input.kind, input.requestId],
    );
  }

  function toPlacedView(
    row: CharacterRow,
    controllers: UserId[],
    replayed: boolean,
  ): PlacedCharacterView {
    if (row.lifecycle !== "active" && row.lifecycle !== "archived") {
      throw new Error(`Unknown character lifecycle: ${row.lifecycle}`);
    }
    if (row.campaign_id === null) throw new Error("toPlacedView requires an attached row");
    return {
      characterId: row.id,
      ownerId: null,
      campaignId: row.campaign_id,
      controllers,
      placementGeneration: row.placement_generation,
      returnOwnerId: row.return_owner_id,
      name: row.name,
      systemVersionId: row.system_version_id,
      entityDefinitionId: row.entity_definition_id,
      revision: row.revision,
      lifecycle: row.lifecycle,
      archivedAt: row.archived_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      state: row.state_json as RuntimeStateV1,
      replayed,
    };
  }

  /**
   * Receipt-before-mutation claim shared by the four placement mutations.
   * The claim runs on the caller-owned client BEFORE any row lock, so a
   * same-key replay returns the stored outcome without touching campaign or
   * character rows; the locked section re-verifies authorization and
   * preconditions after the campaign lock, matching the campaigns discipline.
   */
  async function claimPlacement(
    client: PoolClient,
    ctx: RequestContext,
    options: { commandKind: string; idempotencyKey: string; inputHash: string },
  ): Promise<
    | { status: "claimed"; executionId: ExecutionId }
    | { status: "replay"; resultJson: unknown }
    | { error: PlacementError }
  > {
    const claimStartedAt = now();
    const claimed = await claimExecutionOnClient(client, {
      actorId: ctx.actorId,
      commandKind: options.commandKind,
      idempotencyKey: options.idempotencyKey,
      inputHash: options.inputHash,
      newExecutionId,
      now: claimStartedAt,
      leaseMs: LEASE_MS,
      replayTtlMs: REPLAY_TTL_MS,
    });
    if (claimed.status === "mismatch") return { error: errors.mismatch() };
    if (claimed.status === "in_progress") return { error: errors.inProgress() };
    if (claimed.status === "expired") return { error: errors.expired() };
    if (claimed.status === "replay") return { status: "replay", resultJson: claimed.resultJson };
    return { status: "claimed", executionId: claimed.executionId };
  }

  /** Reauthorizes a stored placement replay against CURRENT campaign access. */
  async function reauthorizeReplay(
    client: PoolClient,
    ctx: RequestContext,
    stored: { campaignId?: string; value?: unknown },
    input: { campaignId: string; membershipGeneration?: number },
  ): Promise<PlacementResult<PlacedCharacterView>> {
    if (stored.campaignId !== input.campaignId) return { ok: false, error: errors.mismatch() };
    const membership = await loadMembership(client, input.campaignId, ctx.actorId);
    // A removed member replays nothing campaign-scoped: unlike bare
    // leave/remove acknowledgements, placement outcomes carry live sheets.
    if (!isActiveMember(membership)) {
      return { ok: false, error: errors.not_found() };
    }
    if (input.membershipGeneration !== undefined && membership.generation !== input.membershipGeneration) {
      return { ok: false, error: errors.conflict("Membership changed under this request. Retry with the current generation.") };
    }
    const view = deserializePlaced((stored as { value: unknown }).value);
    // The sheet may have moved on (returned, reassigned): confirm it is still
    // attached to this campaign before disclosing the stored bytes.
    const current = await lockCharacter(client, view.characterId);
    if (current === null || current.campaign_id !== input.campaignId) {
      return { ok: false, error: errors.not_found() };
    }
    return { ok: true, value: { ...view, replayed: true } };
  }

  return {
    async createInCampaign(client, ctx, createInput) {
      try {
        const keyError = checkIdempotencyKey(createInput.idempotencyKey);
        if (keyError !== null) return { ok: false, error: keyError };
        const revisionError = checkRevision(createInput.expectedCampaignRevision, "expectedCampaignRevision");
        if (revisionError !== null) return { ok: false, error: revisionError };
        const generationError = checkRevision(createInput.membershipGeneration, "membershipGeneration");
        if (generationError !== null) return { ok: false, error: generationError };
        const name = createInput.name;
        if (typeof name !== "string" || name.trim().length === 0 || [...name].length > 200) {
          return { ok: false, error: errors.bad_request("name must be a non-empty string of at most 200 characters.") };
        }
        if (createInput.prepared.entityDefinitionId !== createInput.entityDefinitionId) {
          return { ok: false, error: errors.bad_request("The prepared character does not match the requested entity.") };
        }

        const inputHash = hashInput({
          commandKind: CREATE_KIND,
          campaignId: createInput.campaignId,
          expectedCampaignRevision: createInput.expectedCampaignRevision,
          membershipGeneration: createInput.membershipGeneration,
          name,
          entityDefinitionId: createInput.entityDefinitionId,
          preparedVersionId: createInput.prepared.versionId,
          preparedState: createInput.prepared.state,
          controllerUserIds: createInput.controllerUserIds ?? null,
        });
        const claimed = await claimPlacement(client, ctx, {
          commandKind: CREATE_KIND,
          idempotencyKey: createInput.idempotencyKey,
          inputHash,
        });
        if ("error" in claimed) return { ok: false, error: claimed.error };
        if (claimed.status === "replay") {
          return await reauthorizeReplay(client, ctx, claimed.resultJson as { campaignId?: string; value?: unknown }, {
            campaignId: createInput.campaignId,
            membershipGeneration: createInput.membershipGeneration,
          });
        }

        // Caller-owned transaction from here: campaign lock first, then
        // character insert. No Runtime call happens below; the prepared
        // resolution is only rechecked against the pinned campaign version.
        const campaign = await lockCampaign(client, createInput.campaignId);
        const membership = campaign === null ? null : await loadMembership(client, campaign.id, ctx.actorId);
        if (campaign === null || !isActiveMember(membership)) {
          return { ok: false, error: errors.not_found() };
        }
        if (campaign.status !== "active") {
          return {
            ok: false, error: errors.conflict("Archived campaigns reject character placement until recovered.", campaign.revision),
          };
        }
        const generationCheck = checkMembershipGeneration(membership, createInput.membershipGeneration);
        if (generationCheck !== null) return { ok: false, error: generationCheck };
        if (createInput.prepared.versionId !== campaign.system_version_id) {
          return { ok: false, error: errors.bad_request("The prepared character version does not match the pinned campaign version.") };
        }
        if (campaign.revision !== createInput.expectedCampaignRevision) {
          return {
            ok: false, error: errors.conflict(
              "The campaign has a newer revision. Retry with the latest revision and a new idempotency key.",
              campaign.revision,
            ),
          };
        }

        const manager = isGameMaster(membership);
        let controllers: UserId[];
        if (manager) {
          controllers = [...new Set(createInput.controllerUserIds ?? [])];
        } else {
          controllers = [ctx.actorId];
          const requested = createInput.controllerUserIds;
          if (requested !== undefined && (requested.length !== 1 || requested[0] !== ctx.actorId)) {
            return { ok: false, error: errors.bad_request("Players may only create characters they control themselves.") };
          }
        }
        for (const controllerId of controllers) {
          const controllerMembership = await loadMembership(client, campaign.id, controllerId);
          if (!isActiveMember(controllerMembership)) {
            return { ok: false, error: errors.bad_request("Controllers must be active members of the same campaign.") };
          }
        }
        if ((await attachedCount(client, campaign.id)) >= maxAttached) {
          return { ok: false, error: errors.bad_request("The campaign already holds the maximum number of characters.") };
        }

        const characterId = newId();
        const timestamp = now();
        const inserted = await client.query<CharacterRow>(
          `INSERT INTO characters
             (id, owner_id, campaign_id, placement_generation, return_owner_id,
              system_version_id, entity_definition_id, name, revision, state_json,
              visibility, lifecycle, created_at, updated_at)
           VALUES ($1, NULL, $2, 1, NULL, $3, $4, $5, 1, $6::jsonb, 'owner_only', 'active', $7, $7)
           RETURNING id, owner_id, campaign_id, placement_generation, return_owner_id,
                     system_version_id, entity_definition_id, name, revision, state_json,
                     lifecycle, archived_at, created_at, updated_at`,
          [
            characterId,
            campaign.id,
            createInput.prepared.versionId,
            createInput.entityDefinitionId,
            name,
            JSON.stringify(createInput.prepared.state),
            timestamp.toISOString(),
          ],
        );
        const row = inserted.rows[0];
        if (row === undefined) throw new Error("createInCampaign returned no row");
        for (const controllerId of controllers) {
          await client.query(
            `INSERT INTO character_controllers (character_id, campaign_id, user_id)
             VALUES ($1, $2, $3)`,
            [characterId, campaign.id, controllerId],
          );
        }
        await client.query(
          `INSERT INTO character_placements (character_id, generation, campaign_id, return_owner_id)
           VALUES ($1, 1, $2, NULL)`,
          [characterId, campaign.id],
        );
        await recordPlacementActivity(client, {
          characterId,
          revision: 1,
          kind: "character_campaign_created",
          payloadJson: { actorId: ctx.actorId, entityDefinitionId: createInput.entityDefinitionId },
          actorId: ctx.actorId,
          requestId: ctx.requestId,
          campaignId: campaign.id,
        });

        const bumped = await bumpCampaignRevision(client, campaign.id, createInput.expectedCampaignRevision);
        if (bumped === null) {
          return {
            ok: false, error: errors.conflict(
              "The campaign has a newer revision. Retry with the latest revision and a new idempotency key.",
              campaign.revision,
            ),
          };
        }

        const value = toPlacedView(row, controllers, false);
        await completeExecution(client, claimed.executionId, { campaignId: campaign.id, value: serializePlaced(value), idempotencyKey: createInput.idempotencyKey });
        return { ok: true, value };
      } catch {
        return { ok: false, error: errors.internal() };
      }
    },

    async adopt(client, ctx, adoptInput) {
      try {
        const keyError = checkIdempotencyKey(adoptInput.idempotencyKey);
        if (keyError !== null) return { ok: false, error: keyError };
        const revisionError = checkRevision(adoptInput.expectedCampaignRevision, "expectedCampaignRevision");
        if (revisionError !== null) return { ok: false, error: revisionError };
        const generationError = checkRevision(adoptInput.membershipGeneration, "membershipGeneration");
        if (generationError !== null) return { ok: false, error: generationError };
        const characterError = checkRevision(adoptInput.expectedCharacterRevision, "expectedCharacterRevision");
        if (characterError !== null) return { ok: false, error: characterError };
        if (adoptInput.acknowledgedDisclosure !== true) {
          return { ok: false, error: errors.bad_request("Adoption requires explicit disclosure acknowledgement.") };
        }

        const inputHash = hashInput({
          commandKind: ADOPT_KIND,
          campaignId: adoptInput.campaignId,
          expectedCampaignRevision: adoptInput.expectedCampaignRevision,
          membershipGeneration: adoptInput.membershipGeneration,
          characterId: adoptInput.characterId,
          expectedCharacterRevision: adoptInput.expectedCharacterRevision,
          acknowledgedDisclosure: true,
        });
        const claimed = await claimPlacement(client, ctx, {
          commandKind: ADOPT_KIND,
          idempotencyKey: adoptInput.idempotencyKey,
          inputHash,
        });
        if ("error" in claimed) return { ok: false, error: claimed.error };
        if (claimed.status === "replay") {
          return await reauthorizeReplay(client, ctx, claimed.resultJson as { campaignId?: string; value?: unknown }, {
            campaignId: adoptInput.campaignId,
            membershipGeneration: adoptInput.membershipGeneration,
          });
        }

        // Campaign lock first, character lock second: never campaign-after-character.
        const campaign = await lockCampaign(client, adoptInput.campaignId);
        const membership = campaign === null ? null : await loadMembership(client, campaign.id, ctx.actorId);
        if (campaign === null || !isActiveMember(membership)) {
          return { ok: false, error: errors.not_found() };
        }
        if (campaign.status !== "active") {
          return {
            ok: false, error: errors.conflict("Archived campaigns reject character placement until recovered.", campaign.revision),
          };
        }
        const generationCheck = checkMembershipGeneration(membership, adoptInput.membershipGeneration);
        if (generationCheck !== null) return { ok: false, error: generationCheck };
        if (campaign.revision !== adoptInput.expectedCampaignRevision) {
          return {
            ok: false, error: errors.conflict(
              "The campaign has a newer revision. Retry with the latest revision and a new idempotency key.",
              campaign.revision,
            ),
          };
        }
        const character = await lockCharacter(client, adoptInput.characterId);
        // Other users' sheets collapse to not_found: no existence or scope leak.
        if (character === null || character.owner_id !== ctx.actorId) {
          return { ok: false, error: errors.not_found() };
        }
        if (character.lifecycle === "archived") {
          return { ok: false, error: errors.conflict("Archived characters cannot be adopted until recovered.", character.revision) };
        }
        if (character.campaign_id !== null) {
          return { ok: false, error: errors.conflict("The character is already attached to a campaign.", character.revision) };
        }
        if (character.system_version_id !== campaign.system_version_id) {
          return { ok: false, error: errors.bad_request("The character version does not match the pinned campaign version. Migrate it first.") };
        }
        if (character.revision !== adoptInput.expectedCharacterRevision) {
          return {
            ok: false, error: errors.conflict(
              "The character has a newer revision. Retry with the latest revision and a new idempotency key.",
              character.revision,
            ),
          };
        }
        if ((await attachedCount(client, campaign.id)) >= maxAttached) {
          return { ok: false, error: errors.bad_request("The campaign already holds the maximum number of characters.") };
        }

        const timestamp = now();
        const updated = await client.query<CharacterRow>(
          `UPDATE characters
              SET owner_id = NULL, campaign_id = $2, return_owner_id = $3,
                  revision = revision + 1, placement_generation = placement_generation + 1,
                  updated_at = $4
            WHERE id = $1
            RETURNING id, owner_id, campaign_id, placement_generation, return_owner_id,
                      system_version_id, entity_definition_id, name, revision, state_json,
                      lifecycle, archived_at, created_at, updated_at`,
          [character.id, campaign.id, ctx.actorId, timestamp.toISOString()],
        );
        const row = updated.rows[0];
        if (row === undefined) throw new Error("adopt returned no row");
        // The return owner stays a controller for the whole attachment.
        await client.query(
          `INSERT INTO character_controllers (character_id, campaign_id, user_id)
           VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [character.id, campaign.id, ctx.actorId],
        );
        await client.query(
          `INSERT INTO character_placements (character_id, generation, campaign_id, return_owner_id)
           VALUES ($1, $2, $3, $4)`,
          [character.id, row.placement_generation, campaign.id, ctx.actorId],
        );
        await recordPlacementActivity(client, {
          characterId: character.id,
          revision: row.revision,
          kind: "character_adopted",
          payloadJson: { actorId: ctx.actorId, returnOwnerId: ctx.actorId },
          actorId: ctx.actorId,
          requestId: ctx.requestId,
          campaignId: campaign.id,
        });

        const bumped = await bumpCampaignRevision(client, campaign.id, adoptInput.expectedCampaignRevision);
        if (bumped === null) {
          return {
            ok: false, error: errors.conflict(
              "The campaign has a newer revision. Retry with the latest revision and a new idempotency key.",
              campaign.revision,
            ),
          };
        }

        // Attachment advances revision, which invalidates outstanding
        // migration previews bound to the old source revision.
        const controllers = await loadControllers(client, character.id);
        const value = toPlacedView(row, controllers, false);
        await completeExecution(client, claimed.executionId, { campaignId: campaign.id, value: serializePlaced(value), idempotencyKey: adoptInput.idempotencyKey });
        return { ok: true, value };
      } catch {
        return { ok: false, error: errors.internal() };
      }
    },

    async assign(client, ctx, assignInput) {
      try {
        const keyError = checkIdempotencyKey(assignInput.idempotencyKey);
        if (keyError !== null) return { ok: false, error: keyError };
        const revisionError = checkRevision(assignInput.expectedCampaignRevision, "expectedCampaignRevision");
        if (revisionError !== null) return { ok: false, error: revisionError };
        const generationError = checkRevision(assignInput.membershipGeneration, "membershipGeneration");
        if (generationError !== null) return { ok: false, error: generationError };
        const characterError = checkRevision(assignInput.expectedCharacterRevision, "expectedCharacterRevision");
        if (characterError !== null) return { ok: false, error: characterError };
        const controllers = [...new Set(assignInput.controllerUserIds)];
        if (controllers.length !== assignInput.controllerUserIds.length) {
          return { ok: false, error: errors.bad_request("Controller assignments must not repeat a member.") };
        }
        for (const controllerId of controllers) {
          if (typeof controllerId !== "string" || controllerId.length === 0) {
            return { ok: false, error: errors.bad_request("Controller assignments must be member IDs.") };
          }
        }
        const designations = [...new Set(assignInput.designateClaimants ?? [])];
        if (designations.length !== (assignInput.designateClaimants ?? []).length) {
          return { ok: false, error: errors.bad_request("Claim designations must not repeat a member.") };
        }

        const inputHash = hashInput({
          commandKind: ASSIGN_KIND,
          campaignId: assignInput.campaignId,
          expectedCampaignRevision: assignInput.expectedCampaignRevision,
          membershipGeneration: assignInput.membershipGeneration,
          characterId: assignInput.characterId,
          expectedCharacterRevision: assignInput.expectedCharacterRevision,
          controllerUserIds: controllers,
          designateClaimants: designations,
        });
        const claimed = await claimPlacement(client, ctx, {
          commandKind: ASSIGN_KIND,
          idempotencyKey: assignInput.idempotencyKey,
          inputHash,
        });
        if ("error" in claimed) return { ok: false, error: claimed.error };
        if (claimed.status === "replay") {
          return await reauthorizeReplay(client, ctx, claimed.resultJson as { campaignId?: string; value?: unknown }, {
            campaignId: assignInput.campaignId,
            membershipGeneration: assignInput.membershipGeneration,
          });
        }

        const campaign = await lockCampaign(client, assignInput.campaignId);
        const membership = campaign === null ? null : await loadMembership(client, campaign.id, ctx.actorId);
        // GM-only: non-managers collapse to not_found like other admin paths.
        if (campaign === null || membership === null || !isGameMaster(membership)) {
          return { ok: false, error: errors.not_found() };
        }
        if (campaign.status !== "active") {
          return {
            ok: false, error: errors.conflict("Archived campaigns reject character placement until recovered.", campaign.revision),
          };
        }
        const generationCheck = checkMembershipGeneration(membership, assignInput.membershipGeneration);
        if (generationCheck !== null) return { ok: false, error: generationCheck };
        if (campaign.revision !== assignInput.expectedCampaignRevision) {
          return {
            ok: false, error: errors.conflict(
              "The campaign has a newer revision. Retry with the latest revision and a new idempotency key.",
              campaign.revision,
            ),
          };
        }
        const character = await lockCharacter(client, assignInput.characterId);
        if (character === null || character.campaign_id !== campaign.id) {
          return { ok: false, error: errors.not_found() };
        }
        if (character.revision !== assignInput.expectedCharacterRevision) {
          return {
            ok: false, error: errors.conflict(
              "The character has a newer revision. Retry with the latest revision and a new idempotency key.",
              character.revision,
            ),
          };
        }
        // Adoption return-owner invariant: assignment cannot remove that
        // controller or change the return owner.
        if (character.return_owner_id !== null && !controllers.includes(character.return_owner_id)) {
          return { ok: false, error: errors.bad_request("Assignment cannot remove the adoption return owner as controller.") };
        }
        for (const controllerId of controllers) {
          const controllerMembership = await loadMembership(client, campaign.id, controllerId);
          if (!isActiveMember(controllerMembership)) {
            return { ok: false, error: errors.bad_request("Controllers must be active members of the same campaign.") };
          }
        }
        const existingDesignations = await client.query<{ user_id: string }>(
          `SELECT user_id FROM character_claim_designations WHERE character_id = $1`,
          [character.id],
        );
        const designated = new Set(existingDesignations.rows.map((row) => row.user_id));
        for (const claimantId of designations) {
          const claimantMembership = await loadMembership(client, campaign.id, claimantId);
          if (!isActiveMember(claimantMembership)) {
            return { ok: false, error: errors.bad_request("Claimants must be active members of the same campaign.") };
          }
          if (controllers.includes(claimantId)) {
            return { ok: false, error: errors.bad_request("A current controller needs no claim designation.") };
          }
          if (designated.has(claimantId)) {
            return { ok: false, error: errors.conflict("The member is already designated to claim this character.", character.revision) };
          }
        }

        await client.query(`DELETE FROM character_controllers WHERE character_id = $1`, [character.id]);
        for (const controllerId of controllers) {
          await client.query(
            `INSERT INTO character_controllers (character_id, campaign_id, user_id)
             VALUES ($1, $2, $3)`,
            [character.id, campaign.id, controllerId],
          );
        }
        for (const claimantId of designations) {
          await client.query("SAVEPOINT placement_designation");
          try {
            await client.query(
              `INSERT INTO character_claim_designations (character_id, campaign_id, user_id, designated_by)
               VALUES ($1, $2, $3, $4)`,
              [character.id, campaign.id, claimantId, ctx.actorId],
            );
            await client.query("RELEASE SAVEPOINT placement_designation");
          } catch {
            await client.query("ROLLBACK TO SAVEPOINT placement_designation");
            return { ok: false, error: errors.conflict("The member is already designated to claim this character.", character.revision) };
          }
        }
        await recordPlacementActivity(client, {
          characterId: character.id,
          revision: character.revision,
          kind: "character_controllers_assigned",
          payloadJson: { actorId: ctx.actorId, controllers, designations },
          actorId: ctx.actorId,
          requestId: ctx.requestId,
          campaignId: campaign.id,
        });

        const bumped = await bumpCampaignRevision(client, campaign.id, assignInput.expectedCampaignRevision);
        if (bumped === null) {
          return {
            ok: false, error: errors.conflict(
              "The campaign has a newer revision. Retry with the latest revision and a new idempotency key.",
              campaign.revision,
            ),
          };
        }

        const locked = await lockCharacter(client, character.id);
        if (locked === null) throw new Error("assign lost the character row");
        const value = toPlacedView(locked, [...controllers].sort(), false);
        await completeExecution(client, claimed.executionId, { campaignId: campaign.id, value: serializePlaced(value), idempotencyKey: assignInput.idempotencyKey });
        return { ok: true, value };
      } catch {
        return { ok: false, error: errors.internal() };
      }
    },

    async claim(client, ctx, claimInput) {
      try {
        const keyError = checkIdempotencyKey(claimInput.idempotencyKey);
        if (keyError !== null) return { ok: false, error: keyError };
        const revisionError = checkRevision(claimInput.expectedCampaignRevision, "expectedCampaignRevision");
        if (revisionError !== null) return { ok: false, error: revisionError };
        const generationError = checkRevision(claimInput.membershipGeneration, "membershipGeneration");
        if (generationError !== null) return { ok: false, error: generationError };
        const characterError = checkRevision(claimInput.expectedCharacterRevision, "expectedCharacterRevision");
        if (characterError !== null) return { ok: false, error: characterError };

        const inputHash = hashInput({
          commandKind: CLAIM_KIND,
          campaignId: claimInput.campaignId,
          expectedCampaignRevision: claimInput.expectedCampaignRevision,
          membershipGeneration: claimInput.membershipGeneration,
          characterId: claimInput.characterId,
          expectedCharacterRevision: claimInput.expectedCharacterRevision,
        });
        const claimed = await claimPlacement(client, ctx, {
          commandKind: CLAIM_KIND,
          idempotencyKey: claimInput.idempotencyKey,
          inputHash,
        });
        if ("error" in claimed) return { ok: false, error: claimed.error };
        if (claimed.status === "replay") {
          return await reauthorizeReplay(client, ctx, claimed.resultJson as { campaignId?: string; value?: unknown }, {
            campaignId: claimInput.campaignId,
            membershipGeneration: claimInput.membershipGeneration,
          });
        }

        const campaign = await lockCampaign(client, claimInput.campaignId);
        const membership = campaign === null ? null : await loadMembership(client, campaign.id, ctx.actorId);
        if (campaign === null || !isActiveMember(membership)) {
          return { ok: false, error: errors.not_found() };
        }
        if (campaign.status !== "active") {
          return {
            ok: false, error: errors.conflict("Archived campaigns reject character placement until recovered.", campaign.revision),
          };
        }
        const generationCheck = checkMembershipGeneration(membership, claimInput.membershipGeneration);
        if (generationCheck !== null) return { ok: false, error: generationCheck };
        if (campaign.revision !== claimInput.expectedCampaignRevision) {
          return {
            ok: false, error: errors.conflict(
              "The campaign has a newer revision. Retry with the latest revision and a new idempotency key.",
              campaign.revision,
            ),
          };
        }
        const character = await lockCharacter(client, claimInput.characterId);
        if (character === null || character.campaign_id !== campaign.id) {
          return { ok: false, error: errors.not_found() };
        }
        if (character.revision !== claimInput.expectedCharacterRevision) {
          return {
            ok: false, error: errors.conflict(
              "The character has a newer revision. Retry with the latest revision and a new idempotency key.",
              character.revision,
            ),
          };
        }
        // Designated claim only: the DELETE consumes the designation, so
        // exactly one concurrent claimant wins and the loser finds nothing.
        const consumed = await client.query<{ user_id: string }>(
          `DELETE FROM character_claim_designations
            WHERE character_id = $1 AND user_id = $2
            RETURNING user_id`,
          [character.id, ctx.actorId],
        );
        if (consumed.rows[0] === undefined) {
          return { ok: false, error: errors.not_found("No active claim designation exists for this member.") };
        }
        await client.query(
          `INSERT INTO character_controllers (character_id, campaign_id, user_id)
           VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [character.id, campaign.id, ctx.actorId],
        );
        await recordPlacementActivity(client, {
          characterId: character.id,
          revision: character.revision,
          kind: "character_claimed",
          payloadJson: { actorId: ctx.actorId },
          actorId: ctx.actorId,
          requestId: ctx.requestId,
          campaignId: campaign.id,
        });

        const bumped = await bumpCampaignRevision(client, campaign.id, claimInput.expectedCampaignRevision);
        if (bumped === null) {
          return {
            ok: false, error: errors.conflict(
              "The campaign has a newer revision. Retry with the latest revision and a new idempotency key.",
              campaign.revision,
            ),
          };
        }

        const controllers = await loadControllers(client, character.id);
        const value = toPlacedView(character, controllers, false);
        await completeExecution(client, claimed.executionId, { campaignId: campaign.id, value: serializePlaced(value), idempotencyKey: claimInput.idempotencyKey });
        return { ok: true, value };
      } catch {
        return { ok: false, error: errors.internal() };
      }
    },

    async returnForMember(client, removal) {
      // Runs inside the removeMember transaction (campaign row already
      // locked and revision-bumped there): all-or-nothing with the removal.
      // Adopted sheets return to their original owner with current state;
      // campaign-created sheets stay with remaining controllers and GMs.
      const adopted = await client.query<{ id: string }>(
        `SELECT id FROM characters
          WHERE campaign_id = $1 AND return_owner_id = $2
          ORDER BY id FOR UPDATE`,
        [removal.campaignId, removal.userId],
      );
      const returned: MemberReturnResult["returned"] = [];
      for (const row of adopted.rows) {
        const detached = await client.query<CharacterRow>(
          `UPDATE characters
              SET owner_id = return_owner_id, campaign_id = NULL, return_owner_id = NULL,
                  revision = revision + 1, placement_generation = placement_generation + 1,
                  updated_at = $2
            WHERE id = $1
            RETURNING id, owner_id, campaign_id, placement_generation, return_owner_id,
                      system_version_id, entity_definition_id, name, revision, state_json,
                      lifecycle, archived_at, created_at, updated_at`,
          [row.id, now().toISOString()],
        );
        const character = detached.rows[0];
        if (character === undefined) throw new Error("returnForMember lost the character row");
        await client.query(`DELETE FROM character_controllers WHERE character_id = $1`, [row.id]);
        await client.query(`DELETE FROM character_claim_designations WHERE character_id = $1`, [row.id]);
        await client.query(
          `UPDATE character_placements SET ended_at = $2
            WHERE character_id = $1 AND ended_at IS NULL`,
          [row.id, now().toISOString()],
        );
        // The return event keeps its campaign scope: campaign history is not
        // relabelled, and the departed actor cannot retrieve it (Task 5/7
        // audience policy); the standalone sheet itself carries no history.
        await client.query(
          `INSERT INTO character_activity_events (character_id, character_revision, kind, payload_json, request_id, scope_campaign_id)
           VALUES ($1, $2, 'character_returned', $3::jsonb, $4, $5)`,
          [row.id, character.revision, JSON.stringify({ returnOwnerId: removal.userId }), removal.requestId, removal.campaignId],
        );
        await client.query(
          `INSERT INTO character_audit_records (character_id, actor_id, kind, summary, request_id)
           VALUES ($1, $2, 'character_returned', 'Character returned to original owner', $3)`,
          [row.id, removal.actorId, removal.requestId],
        );
        returned.push({
          characterId: character.id,
          revision: character.revision,
          placementGeneration: character.placement_generation,
        });
        // Test seam: a throw here rolls the whole removal back (Task 3 hook proof).
        await input.hooks?.afterSingleReturn?.({ campaignId: removal.campaignId, characterId: character.id });
      }

      const releasedControllers = await client.query(
        `DELETE FROM character_controllers WHERE campaign_id = $1 AND user_id = $2`,
        [removal.campaignId, removal.userId],
      );
      const releasedDesignations = await client.query(
        `DELETE FROM character_claim_designations
          WHERE campaign_id = $1 AND (user_id = $2 OR designated_by = $2)`,
        [removal.campaignId, removal.userId],
      );
      return {
        returned,
        releasedControllers: releasedControllers.rowCount ?? 0,
        releasedDesignations: releasedDesignations.rowCount ?? 0,
      };
    },
  };
}
