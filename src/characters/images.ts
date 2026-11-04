import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Pool, PoolClient } from "pg";
import type { RequestContext } from "../systems/authoring.js";
import { hashInput } from "../systems/implementation/authoring/assess.js";
import { resolveMediaRoot } from "../platform/image-storage.js";
import {
  processImage,
  decodeImageBase64,
  ImageProcessingError,
  type ImageContentType,
  type ImageScanner,
} from "../platform/image-processing.js";
import { createClamScanner } from "../platform/image-scanner.js";

export type Portrait = {
  fileId: string;
  description: string;
  contentType: ImageContentType;
  width: number;
  height: number;
  sizeBytes: number;
  checksum: string;
};
export type PortraitState = { revision: number; portrait: Portrait | null };
export type PortraitError = {
  code:
    | "bad_request"
    | "not_found"
    | "conflict"
    | "idempotency_mismatch"
    | "result_unavailable"
    | "too_large"
    | "unprocessable"
    | "temporarily_unavailable"
    | "internal";
  message: string;
  latestRevision?: number;
};
export type PortraitResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: PortraitError };
export type PortraitCommand = {
  characterId: string;
  expectedCharacterRevision: number;
  expectedPortraitRevision: number;
  idempotencyKey: string;
};
export type SetPortraitInput = PortraitCommand & {
  description: string;
  contentType: ImageContentType;
  dataBase64: string;
};
export interface CharacterImages {
  openPortrait(
    ctx: RequestContext,
    input: { characterId: string },
  ): Promise<PortraitResult<PortraitState>>;
  setPortrait(
    ctx: RequestContext,
    input: SetPortraitInput,
  ): Promise<PortraitResult<PortraitState>>;
  removePortrait(
    ctx: RequestContext,
    input: PortraitCommand,
  ): Promise<PortraitResult<PortraitState>>;
  openPortraitImage(
    ctx: RequestContext,
    input: { characterId: string; fileId?: string; thumbnail: boolean },
  ): Promise<PortraitResult<{ bytes: Buffer; contentType: ImageContentType }>>;
}

type Authority = {
  characterId: string;
  ownerId: string | null;
  campaignId: string | null;
  revision: number;
  active: boolean;
};
type AssetRow = {
  id: string;
  storage_key: string;
  media_type: ImageContentType;
  width: number;
  height: number;
  size_bytes: number;
  checksum: string;
  thumbnail_checksum: string;
  description: string;
  revision: number;
};
class Denial extends Error {
  constructor(readonly error: PortraitError) {
    super(error.message);
  }
}
const deny = (
  code: PortraitError["code"],
  message: string,
  latestRevision?: number,
): never => {
  throw new Denial({
    code,
    message,
    ...(latestRevision === undefined ? {} : { latestRevision }),
  });
};
const missing = (): never =>
  deny("not_found", "The requested portrait does not exist.");
const root = () => join(resolveMediaRoot(), "portraits");
const checksum = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

/** Character-owned policy and transactions; no global asset read capability. */
export function createCharacterImages(options: {
  pool: Pool;
  scanImage?: ImageScanner;
  now?: () => Date;
}): CharacterImages {
  const { pool } = options;
  const scanImage = options.scanImage ?? createClamScanner();
  const now = options.now ?? (() => new Date());
  async function transaction<T>(
    write: boolean,
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query(write ? "BEGIN" : "BEGIN READ ONLY");
      const value = await work(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async function authority(
    client: PoolClient,
    actorId: string,
    id: string,
    lock: boolean,
  ): Promise<Authority> {
    const scope = (
      await client.query<{ campaign_id: string | null }>(
        "SELECT campaign_id FROM characters WHERE id=$1",
        [id],
      )
    ).rows[0];
    if (!scope) return missing();
    let campaignActive = true;
    if (scope.campaign_id !== null) {
      const campaign = (
        await client.query<{ status: string }>(
          `SELECT status FROM campaigns WHERE id=$1${lock ? " FOR UPDATE" : ""}`,
          [scope.campaign_id],
        )
      ).rows[0];
      if (!campaign) return missing();
      campaignActive = campaign.status === "active";
    }
    const row = (
      await client.query<{
        id: string;
        owner_id: string | null;
        campaign_id: string | null;
        revision: number;
        lifecycle: string;
      }>(
        `SELECT id,owner_id,campaign_id,revision,lifecycle FROM characters WHERE id=$1${lock ? " FOR UPDATE" : ""}`,
        [id],
      )
    ).rows[0];
    if (!row || row.campaign_id !== scope.campaign_id) return missing();
    if (row.campaign_id === null) {
      if (row.owner_id !== actorId) return missing();
    } else {
      const member = (
        await client.query<{ role: string; status: string }>(
          "SELECT role,status FROM campaign_members WHERE campaign_id=$1 AND user_id=$2",
          [row.campaign_id, actorId],
        )
      ).rows[0];
      if (!member || member.status !== "active") return missing();
      if (member.role !== "owner" && member.role !== "co_gm") {
        const controller = await client.query(
          "SELECT 1 FROM character_controllers WHERE character_id=$1 AND user_id=$2",
          [id, actorId],
        );
        if (controller.rowCount !== 1) return missing();
      }
    }
    return {
      characterId: row.id,
      ownerId: row.owner_id,
      campaignId: row.campaign_id,
      revision: row.revision,
      active: campaignActive && row.lifecycle === "active",
    };
  }
  async function current(
    client: PoolClient,
    id: string,
  ): Promise<{ state: PortraitState; asset: AssetRow | null }> {
    const link = (
      await client.query<{
        revision: number;
        description: string;
        asset_id: string | null;
      }>(
        "SELECT revision,description,asset_id FROM character_portraits WHERE character_id=$1",
        [id],
      )
    ).rows[0];
    if (!link?.asset_id)
      return {
        state: { revision: link?.revision ?? 0, portrait: null },
        asset: null,
      };
    const asset = (
      await client.query<AssetRow>(
        "SELECT * FROM character_image_assets WHERE id=$1",
        [link.asset_id],
      )
    ).rows[0];
    if (!asset) return missing();
    return {
      state: {
        revision: link.revision,
        portrait: {
          fileId: asset.id,
          description: link.description,
          contentType: asset.media_type,
          width: asset.width,
          height: asset.height,
          sizeBytes: asset.size_bytes,
          checksum: asset.checksum,
        },
      },
      asset,
    };
  }
  function resultError<T>(error: unknown): PortraitResult<T> {
    if (error instanceof Denial) return { ok: false, error: error.error };
    if (error instanceof ImageProcessingError)
      return { ok: false, error: { code: error.code, message: error.message } };
    return {
      ok: false,
      error: {
        code: "internal",
        message: "The portrait could not be saved. Try again later.",
      },
    };
  }
  async function replay(
    client: PoolClient,
    ctx: RequestContext,
    command: PortraitCommand,
    inputHash: string,
    state: PortraitState,
  ): Promise<PortraitState | null> {
    const row = (
      await client.query<{
        input_hash: string;
        result_json: PortraitState;
        expires_at: Date;
      }>(
        "SELECT input_hash,result_json,expires_at FROM character_image_receipts WHERE actor_id=$1 AND idempotency_key=$2",
        [ctx.actorId, command.idempotencyKey],
      )
    ).rows[0];
    if (!row) return null;
    if (row.input_hash !== inputHash)
      return deny(
        "idempotency_mismatch",
        "This image request key was used with different input.",
      );
    if (row.expires_at <= now())
      return deny(
        "result_unavailable",
        "This image request has expired. Refresh before trying again.",
      );
    if (state.revision !== row.result_json.revision)
      return deny(
        "result_unavailable",
        "The portrait changed after this request. Refresh to see the current image.",
        state.revision,
      );
    return row.result_json;
  }
  function check(command: PortraitCommand) {
    if (
      !Number.isInteger(command.expectedCharacterRevision) ||
      command.expectedCharacterRevision < 1 ||
      !Number.isInteger(command.expectedPortraitRevision) ||
      command.expectedPortraitRevision < 0
    )
      return deny(
        "bad_request",
        "Expected character and portrait revisions are required.",
      );
    if (
      typeof command.idempotencyKey !== "string" ||
      command.idempotencyKey.length < 1 ||
      command.idempotencyKey.length > 256
    )
      return deny("bad_request", "An image request key is required.");
  }
  function checkRevision(
    auth: Authority,
    state: PortraitState,
    command: PortraitCommand,
  ) {
    if (!auth.active)
      return deny(
        "conflict",
        "Recover the character and campaign before changing its portrait.",
      );
    if (
      auth.revision !== command.expectedCharacterRevision ||
      state.revision !== command.expectedPortraitRevision
    )
      return deny(
        "conflict",
        "The character or portrait changed. Refresh before trying again.",
        state.revision,
      );
  }
  async function change(
    ctx: RequestContext,
    command: PortraitCommand,
    upload: SetPortraitInput | null,
  ): Promise<PortraitResult<PortraitState>> {
    let written: string | null = null,
      committed = false;
    try {
      check(command);
      if (
        upload &&
        (typeof upload.description !== "string" ||
          !upload.description.trim() ||
          upload.description.length > 500)
      )
        return deny(
          "bad_request",
          "Describe the portrait in 1–500 characters.",
        );
      const inputHash = hashInput({
        characterId: command.characterId,
        expectedCharacterRevision: command.expectedCharacterRevision,
        expectedPortraitRevision: command.expectedPortraitRevision,
        idempotencyKey: command.idempotencyKey,
        kind: upload ? "upload" : "remove",
        description: upload?.description ?? null,
        contentType: upload?.contentType ?? null,
        checksum: upload
          ? checksum(decodeImageBase64(upload.dataBase64))
          : null,
      });
      const prior = await transaction(false, async (client) => {
        const auth = await authority(
          client,
          ctx.actorId,
          command.characterId,
          false,
        );
        const { state } = await current(client, command.characterId);
        const stored = await replay(client, ctx, command, inputHash, state);
        if (stored) return stored;
        checkRevision(auth, state, command);
        return null;
      });
      if (prior) return { ok: true, value: prior };
      const prepared = upload ? await processImage(upload, scanImage) : null;
      const assetId = prepared ? randomUUID() : null;
      if (prepared && assetId) {
        await mkdir(root(), { recursive: true });
        await writeFile(join(root(), assetId), prepared.bytes, {
          mode: 0o600,
          flag: "wx",
        });
        written = assetId;
        await writeFile(
          join(root(), `${assetId}.thumb.webp`),
          prepared.thumbnail,
          { mode: 0o600, flag: "wx" },
        );
      }
      const value = await transaction(true, async (client) => {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
          [`character-image-request:${ctx.actorId}:${command.idempotencyKey}`],
        );
        const auth = await authority(
          client,
          ctx.actorId,
          command.characterId,
          true,
        );
        const { state } = await current(client, command.characterId);
        const stored = await replay(client, ctx, command, inputHash, state);
        if (stored) return stored;
        checkRevision(auth, state, command);
        if (prepared && assetId) {
          await client.query(
            "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
            [`character-image-owner:${ctx.actorId}`],
          );
          const usage = (
            await client.query<{ count: string; bytes: string }>(
              "SELECT count(*)::text count,COALESCE(sum(size_bytes+thumbnail_bytes),0)::text bytes FROM character_image_assets WHERE created_by=$1 OR ($2::uuid IS NOT NULL AND campaign_id=$2)",
              [ctx.actorId, auth.campaignId],
            )
          ).rows[0]!;
          if (
            Number(usage.count) >= 256 ||
            Number(usage.bytes) +
              prepared.bytes.length +
              prepared.thumbnail.length >
              100 * 1024 * 1024
          )
            return deny(
              "too_large",
              "Portrait storage has reached its 100 MiB or 256 image quota.",
            );
          await client.query(
            "INSERT INTO character_image_assets(id,created_by,campaign_id,storage_key,media_type,width,height,size_bytes,thumbnail_bytes,checksum,thumbnail_checksum) VALUES ($1,$2,$3,$1,$4,$5,$6,$7,$8,$9,$10)",
            [
              assetId,
              ctx.actorId,
              auth.campaignId,
              prepared.contentType,
              prepared.width,
              prepared.height,
              prepared.bytes.length,
              prepared.thumbnail.length,
              prepared.checksum,
              checksum(prepared.thumbnail),
            ],
          );
        }
        const revision = state.revision + 1;
        await client.query(
          "INSERT INTO character_portraits(character_id,asset_id,description,revision) VALUES ($1,$2,$3,$4) ON CONFLICT(character_id) DO UPDATE SET asset_id=EXCLUDED.asset_id,description=EXCLUDED.description,revision=EXCLUDED.revision",
          [
            command.characterId,
            assetId,
            upload?.description.trim() ?? "",
            revision,
          ],
        );
        const next = (await current(client, command.characterId)).state;
        await client.query(
          "INSERT INTO character_image_receipts(actor_id,idempotency_key,input_hash,result_json,expires_at) VALUES ($1,$2,$3,$4,$5)",
          [
            ctx.actorId,
            command.idempotencyKey,
            inputHash,
            JSON.stringify(next),
            new Date(now().getTime() + 30 * 86400000),
          ],
        );
        return next;
      });
      committed = assetId !== null && value.portrait?.fileId === assetId;
      return { ok: true, value };
    } catch (error) {
      return resultError(error);
    } finally {
      if (written && !committed)
        for (const path of [
          join(root(), written),
          join(root(), `${written}.thumb.webp`),
        ])
          await unlink(path).catch(() => {});
    }
  }
  return {
    async openPortrait(ctx, input) {
      try {
        return {
          ok: true,
          value: await transaction(false, async (client) => {
            await authority(client, ctx.actorId, input.characterId, false);
            return (await current(client, input.characterId)).state;
          }),
        };
      } catch (error) {
        return resultError(error);
      }
    },
    setPortrait: (ctx, input) => change(ctx, input, input),
    removePortrait: (ctx, input) => change(ctx, input, null),
    async openPortraitImage(ctx, input) {
      try {
        const asset = await transaction(false, async (client) => {
          await authority(client, ctx.actorId, input.characterId, false);
          const v = await current(client, input.characterId);
          if (!v.asset || (input.fileId && v.asset.id !== input.fileId))
            return missing();
          return v.asset;
        });
        const bytes = await readFile(
          join(
            root(),
            input.thumbnail
              ? `${asset.storage_key}.thumb.webp`
              : asset.storage_key,
          ),
        ).catch(() => missing());
        if (
          checksum(bytes) !==
          (input.thumbnail ? asset.thumbnail_checksum : asset.checksum)
        )
          return missing();
        await transaction(false, async (client) => {
          await authority(client, ctx.actorId, input.characterId, false);
          if ((await current(client, input.characterId)).asset?.id !== asset.id)
            return missing();
        });
        return {
          ok: true,
          value: {
            bytes,
            contentType: input.thumbnail ? "image/webp" : asset.media_type,
          },
        };
      } catch (error) {
        return resultError(error);
      }
    },
  };
}
