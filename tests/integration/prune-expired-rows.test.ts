import { randomUUID } from "node:crypto";

import { Client, type Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  PRUNE_LOCK_NAME,
  PRUNE_TABLES,
  pruneExpiredRows,
  type PruneTable,
} from "../../src/platform/prune.js";
import { createI3Pool, createI3Schema, dropI3Schema } from "./i3-app.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl === undefined ? describe.skip : describe;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describeWithDatabase("expired-row pruning (issue #62)", () => {
  const schema = `prune_${randomUUID().replaceAll("-", "")}`;
  let pool: Pool;
  let userId: string;
  let systemId: string;
  let campaignId: string;
  const now = new Date();
  const graceMs = DAY;
  // Past the grace period: prunable.
  const longExpired = new Date(now.getTime() - 3 * DAY);
  // Expired, but still inside the grace period: kept.
  const recentlyExpired = new Date(now.getTime() - HOUR);
  const live = new Date(now.getTime() + DAY);

  beforeAll(async () => {
    await createI3Schema(databaseUrl!, schema);
    pool = createI3Pool(databaseUrl!, schema, 4);
    userId = (await pool.query<{ id: string }>("INSERT INTO users (display_name) VALUES ('Pruner') RETURNING id")).rows[0]!.id;
    systemId = (
      await pool.query<{ id: string }>("INSERT INTO systems (owner_id, name) VALUES ($1, 'Prune system') RETURNING id", [userId])
    ).rows[0]!.id;
    const versionId = (
      await pool.query<{ id: string }>(
        `INSERT INTO system_versions (system_id, semantic_version, checksum, package_json)
         VALUES ($1, '1.0.0', $2, '{}'::jsonb) RETURNING id`,
        [systemId, `prune-${randomUUID()}`],
      )
    ).rows[0]!.id;
    campaignId = (
      await pool.query<{ id: string }>(
        "INSERT INTO campaigns (owner_id, system_version_id, title) VALUES ($1, $2, 'Prune campaign') RETURNING id",
        [userId, versionId],
      )
    ).rows[0]!.id;
  });

  afterAll(async () => {
    await pool?.end();
    await dropI3Schema(databaseUrl!, schema);
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE ${PRUNE_TABLES.join(", ")}`);
  });

  async function labels(table: PruneTable, column: string): Promise<string[]> {
    const result = await pool.query<{ label: string }>(`SELECT ${column} AS label FROM ${table} ORDER BY 1`);
    return result.rows.map((row) => row.label);
  }

  async function seedReceipt(label: string, expiresAt: Date) {
    await pool.query(
      `INSERT INTO idempotency_receipts (actor_id, command_kind, key, input_hash, result_json, expires_at)
       VALUES ($1, 'test', $2, 'h', '{}'::jsonb, $3)`,
      [userId, label, expiresAt],
    );
  }

  async function seedAll() {
    for (const [label, expiresAt] of [["expired", longExpired], ["grace", recentlyExpired], ["live", live]] as const) {
      await seedReceipt(label, expiresAt);
      await pool.query(
        `INSERT INTO preview_snapshots (system_id, source_revision, package_json, expires_at)
         VALUES ($1, 1, jsonb_build_object('label', $2::text), $3)`,
        [systemId, label, expiresAt],
      );
      await pool.query(
        `INSERT INTO campaign_command_executions (actor_id, command_kind, idempotency_key, input_hash, campaign_id, result_json, expires_at)
         VALUES ($1, 'test', $2, 'h', $3, '{}'::jsonb, $4)`,
        [userId, label, campaignId, expiresAt],
      );
      for (const table of ["character_image_receipts", "item_image_receipts"]) {
        await pool.query(
          `INSERT INTO ${table} (actor_id, idempotency_key, input_hash, result_json, expires_at)
           VALUES ($1, $2, 'h', '{}'::jsonb, $3)`,
          [userId, label, expiresAt],
        );
      }
      await pool.query("INSERT INTO display_codes (code_hash, campaign_id, expires_at) VALUES ($1, $2, $3)", [
        label,
        campaignId,
        expiresAt,
      ]);
    }

    // Character executions: status + lease + replay expiry.
    const executions: Array<[string, "pending" | "completed", Date, Date]> = [
      ["completed-expired", "completed", longExpired, longExpired],
      ["completed-grace", "completed", longExpired, recentlyExpired],
      ["completed-live", "completed", longExpired, live],
      ["pending-abandoned", "pending", longExpired, longExpired],
      // A live lease is an in-progress command, whatever its replay expiry.
      ["pending-in-progress", "pending", live, longExpired],
      ["pending-lease-grace", "pending", recentlyExpired, longExpired],
    ];
    for (const [label, status, leaseExpiresAt, expiresAt] of executions) {
      await pool.query(
        `INSERT INTO character_command_executions
           (actor_id, command_kind, idempotency_key, input_hash, execution_id, status, lease_expires_at, result_json, expires_at)
         VALUES ($1, 'test', $2, 'h', $3, $4, $5, CASE WHEN $4 = 'completed' THEN '{}'::jsonb END, $6)`,
        [userId, label, randomUUID(), status, leaseExpiresAt, expiresAt],
      );
    }

    // Sessions and personal tokens: expiry or revocation ends usability.
    const credentials: Array<[string, Date, Date | null]> = [
      ["expired", longExpired, null],
      ["expired-grace", recentlyExpired, null],
      ["revoked", live, longExpired],
      ["revoked-grace", live, recentlyExpired],
      ["live", live, null],
    ];
    for (const [label, expiresAt, revokedAt] of credentials) {
      await pool.query("INSERT INTO sessions (user_id, token_hash, expires_at, revoked_at) VALUES ($1, $2, $3, $4)", [
        userId,
        label,
        expiresAt,
        revokedAt,
      ]);
      await pool.query(
        `INSERT INTO personal_access_tokens (user_id, token_hash, label, scopes, expires_at, revoked_at)
         VALUES ($1, $2, $2, ARRAY['characters:read'], $3, $4)`,
        [userId, label, expiresAt, revokedAt],
      );
    }

    // Invitations: only never-consumed pending invitations past expiry go.
    const invitations: Array<[string, string, Date]> = [
      ["pending-expired", "pending", longExpired],
      ["pending-grace", "pending", recentlyExpired],
      ["pending-live", "pending", live],
      ["accepted-expired", "accepted", longExpired],
      ["declined-expired", "declined", longExpired],
      ["revoked-expired", "revoked", longExpired],
    ];
    for (const [label, status, expiresAt] of invitations) {
      await pool.query(
        `INSERT INTO campaign_invitations (campaign_id, issued_by, intended_role, token_hash, status, consuming_actor_id,
                                           accepted_membership_generation, expires_at)
         VALUES ($1, $2, 'player', $3, $4, CASE WHEN $4 IN ('accepted', 'declined') THEN $2::uuid END,
                 CASE WHEN $4 = 'accepted' THEN 1 END, $5)`,
        [campaignId, userId, label, status, expiresAt],
      );
    }
  }

  it("deletes only rows expired past the grace period and keeps live, in-progress and historical rows", async () => {
    await seedAll();

    const result = await pruneExpiredRows(pool, { now, graceMs });

    expect(result.skipped).toBe(false);
    if (result.skipped) return;
    expect(result.truncated).toBe(false);
    expect(result.deleted).toEqual({
      idempotency_receipts: 1,
      preview_snapshots: 1,
      character_command_executions: 2,
      campaign_command_executions: 1,
      character_image_receipts: 1,
      item_image_receipts: 1,
      sessions: 2,
      personal_access_tokens: 2,
      campaign_invitations: 1,
      display_codes: 1,
    });
    expect(result.totalDeleted).toBe(13);

    expect(await labels("idempotency_receipts", "key")).toEqual(["grace", "live"]);
    expect(await labels("preview_snapshots", "package_json->>'label'")).toEqual(["grace", "live"]);
    expect(await labels("campaign_command_executions", "idempotency_key")).toEqual(["grace", "live"]);
    expect(await labels("character_image_receipts", "idempotency_key")).toEqual(["grace", "live"]);
    expect(await labels("item_image_receipts", "idempotency_key")).toEqual(["grace", "live"]);
    expect(await labels("display_codes", "code_hash")).toEqual(["grace", "live"]);
    expect(await labels("character_command_executions", "idempotency_key")).toEqual([
      "completed-grace",
      "completed-live",
      "pending-in-progress",
      "pending-lease-grace",
    ]);
    expect(await labels("sessions", "token_hash")).toEqual(["expired-grace", "live", "revoked-grace"]);
    expect(await labels("personal_access_tokens", "token_hash")).toEqual(["expired-grace", "live", "revoked-grace"]);
    expect(await labels("campaign_invitations", "token_hash")).toEqual([
      "accepted-expired",
      "declined-expired",
      "pending-grace",
      "pending-live",
      "revoked-expired",
    ]);

    // Nothing left to do on a second pass.
    const again = await pruneExpiredRows(pool, { now, graceMs });
    expect(again.skipped === false && again.totalDeleted).toBe(0);
  });

  it("drains large backlogs in bounded batches", async () => {
    for (let index = 0; index < 7; index += 1) await seedReceipt(`old-${index}`, longExpired);
    await seedReceipt("keep", live);

    const result = await pruneExpiredRows(pool, { now, graceMs, batchSize: 3 });

    expect(result.skipped === false && result.deleted.idempotency_receipts).toBe(7);
    expect(await labels("idempotency_receipts", "key")).toEqual(["keep"]);
  });

  it("stops at the time budget and reports the run as truncated", async () => {
    await seedReceipt("old", longExpired);

    const result = await pruneExpiredRows(pool, { now, graceMs, timeBudgetMs: 0 });

    expect(result).toMatchObject({ skipped: false, truncated: true, totalDeleted: 0 });
    expect(await labels("idempotency_receipts", "key")).toEqual(["old"]);
  });

  it("uses a conservative default grace period of seven days", async () => {
    await seedReceipt("six-days", new Date(now.getTime() - 6 * DAY));
    await seedReceipt("eight-days", new Date(now.getTime() - 8 * DAY));

    await pruneExpiredRows(pool, { now });

    expect(await labels("idempotency_receipts", "key")).toEqual(["six-days"]);
  });

  it("lets only the advisory-lock holder prune, so replicas never prune concurrently", async () => {
    await seedReceipt("old", longExpired);
    const other = new Client({ connectionString: databaseUrl });
    await other.connect();
    try {
      await other.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [PRUNE_LOCK_NAME]);

      expect(await pruneExpiredRows(pool, { now, graceMs })).toEqual({ skipped: true });
      expect(await labels("idempotency_receipts", "key")).toEqual(["old"]);

      await other.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [PRUNE_LOCK_NAME]);
      const result = await pruneExpiredRows(pool, { now, graceMs });
      expect(result.skipped === false && result.deleted.idempotency_receipts).toBe(1);
    } finally {
      await other.end();
    }
  });

  it("allows exactly one of two simultaneous runs and releases the lock afterwards", async () => {
    await seedReceipt("old", longExpired);

    const results = await Promise.all([
      pruneExpiredRows(pool, { now, graceMs }),
      pruneExpiredRows(pool, { now, graceMs }),
    ]);

    const ran = results.filter((result) => !result.skipped);
    expect(ran.length).toBeGreaterThanOrEqual(1);
    // Whatever interleaving happened, the row was deleted exactly once.
    const deleted = ran.reduce((sum, result) => sum + (result.skipped ? 0 : result.totalDeleted), 0);
    expect(deleted).toBe(1);
    // The lock is not left held by a pooled connection.
    const probe = new Client({ connectionString: databaseUrl });
    await probe.connect();
    try {
      const locked = await probe.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
        [PRUNE_LOCK_NAME],
      );
      expect(locked.rows[0]?.locked).toBe(true);
    } finally {
      await probe.end();
    }
  });
});
