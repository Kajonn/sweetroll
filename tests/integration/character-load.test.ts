import { randomUUID } from "node:crypto";

import { performance } from "node:perf_hooks";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import {
  buildI3App,
  createI3Pool,
  createI3Schema,
  dropI3Schema,
  type I3AppHandle,
} from "./i3-app.js";
import { d20Document } from "../../src/systems/implementation/package/fixtures/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl === undefined ? describe.skip : describe;

const CHAR_COUNT = 50;
const READ_COUNT = CHAR_COUNT * 10;
const BUMP_ROUNDS = 4;
const ROLLS_PER_CHAR = 4;
const CONCURRENCY = 8;

const p95 = (latencies: number[]): number => {
  const sorted = [...latencies].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[index]!;
};

async function mapBounded<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<number[]> {
  const latencies: number[] = [];
  const queue = [...items];
  const workers = Array.from({ length: concurrency }, async () => {
    for (;;) {
      const item = queue.shift();
      if (item === undefined) return;
      const start = performance.now();
      await fn(item);
      latencies.push(performance.now() - start);
    }
  });
  await Promise.all(workers);
  return latencies;
}

describeWithDatabase("characters session-burst load", () => {
  let app: I3AppHandle;
  let pool: Pool;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const schema = `i3_load_${randomUUID().replaceAll("-", "")}`;
    await createI3Schema(databaseUrl!, schema);
    pool = createI3Pool(databaseUrl!, schema, 16);
    app = await buildI3App({ pool });
    cleanup = async () => {
      await app.app.close();
      await pool.end();
      await dropI3Schema(databaseUrl!, schema);
    };
  });

  afterAll(async () => {
    await cleanup();
  });

  it("sustains a session burst within budget: 50 characters, 500 reads, 200 bumps, 200 rolls, no lost or duplicate effects", async () => {
    const ada = app.users.ada;
    const cookie = { cookie: ada.cookie };

    // ---- seed the version ------------------------------------------------
    const system = await app.app.inject({
      method: "POST",
      url: "/systems",
      headers: cookie,
      payload: { source: { kind: "blank", name: "D20 Load" }, idempotencyKey: "load-sys" },
    });
    expect(system.statusCode, system.body).toBe(201);
    const draftRev = system.json().workspace.draft.revision;
    const saved = await app.app.inject({
      method: "PUT",
      url: `/systems/${system.json().workspace.system.systemId}/draft`,
      headers: cookie,
      payload: { expectedRevision: draftRev, document: d20Document },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const published = await app.app.inject({
      method: "POST",
      url: `/systems/${system.json().workspace.system.systemId}/publish`,
      headers: cookie,
      payload: {
        expectedRevision: saved.json().workspace.draft.revision,
        semanticVersion: "1.0.0",
        releaseNotes: "",
        idempotencyKey: "load-pub",
        acknowledgeBreaking: true,
      },
    });
    expect(published.statusCode, published.body).toBe(200);
    const versionId = published.json().version.versionId as string;

    // ---- create 50 characters --------------------------------------------
    const characterIds: string[] = [];
    const createLatencies = await mapBounded(
      Array.from({ length: CHAR_COUNT }, (_, i) => i),
      CONCURRENCY,
      async (i) => {
        const response = await app.app.inject({
          method: "POST",
          url: "/characters",
          headers: cookie,
          payload: {
            systemVersionId: versionId,
            entityDefinitionId: "character",
            name: `Load-${i}`,
            idempotencyKey: `lc-${i}`,
          },
        });
        expect(response.statusCode, response.body).toBe(201);
        expect(response.json().character.reconciliation.revision).toBe(1);
        characterIds[i] = response.json().character.characterId as string;
      },
    );

    // ---- 500 reads ---------------------------------------------------------
    const readLatencies = await mapBounded(
      Array.from({ length: READ_COUNT }, (_, i) => i % CHAR_COUNT),
      CONCURRENCY,
      async (i) => {
        const response = await app.app.inject({
          method: "GET",
          url: `/characters/${characterIds[i]!}`,
          headers: cookie,
        });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.headers["x-resource-revision"]).toBe("1");
        expect(response.headers["cache-control"]).toBe("private");
      },
    );

    // ---- 200 bumps (4 rounds x 50 distinct character+revision pairs) -----
    const writeLatencies: number[] = [];
    for (let round = 1; round <= BUMP_ROUNDS; round += 1) {
      const roundLatencies = await mapBounded(
        Array.from({ length: CHAR_COUNT }, (_, i) => i),
        CONCURRENCY,
        async (i) => {
          const response = await app.app.inject({
            method: "POST",
            url: `/characters/${characterIds[i]!}/resources/health/bump`,
            headers: cookie,
            payload: {
              direction: "down",
              expectedRevision: round,
              idempotencyKey: `lb-${i}-${round}`,
            },
          });
          expect(response.statusCode, response.body).toBe(200);
          expect(response.json().result.character.reconciliation.revision).toBe(round + 1);
          expect(response.json().result.character.state.values.health.current).toBe(10 - round);
        },
      );
      writeLatencies.push(...roundLatencies);
    }

    // ---- 200 rolls (unique keys at the final revision; rolls must not bump)
    const rollLatencies = await mapBounded(
      Array.from({ length: CHAR_COUNT * ROLLS_PER_CHAR }, (_, i) => i),
      CONCURRENCY,
      async (i) => {
        const charIndex = i % CHAR_COUNT;
        const rollIndex = Math.floor(i / CHAR_COUNT);
        const response = await app.app.inject({
          method: "POST",
          url: `/characters/${characterIds[charIndex]!}/actions/check`,
          headers: cookie,
          payload: {
            inputs: {},
            expectedRevision: BUMP_ROUNDS + 1,
            idempotencyKey: `la-${charIndex}-${rollIndex}`,
          },
        });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json().result.character.reconciliation.revision).toBe(BUMP_ROUNDS + 1);
        expect(response.json().result.roll.dice).toHaveLength(1);
      },
    );

    // ---- no lost/duplicate effects in the database ------------------------
    for (const [charIndex, characterId] of characterIds.entries()) {
      const char = await pool.query<{ revision: number; state_json: { values: { health: { current: number } } } }>(
        "SELECT revision, state_json FROM characters WHERE id = $1",
        [characterId],
      );
      expect(char.rows[0]!.revision).toBe(BUMP_ROUNDS + 1);
      expect(char.rows[0]!.state_json.values.health.current).toBe(10 - BUMP_ROUNDS);

      const exec = await pool.query<{ n: number; statuses: string[] }>(
        `SELECT count(*)::int AS n, array_agg(status) AS statuses
           FROM character_command_executions
          WHERE actor_id = $1
            AND (
              idempotency_key = 'lc-' || $2::text
              OR idempotency_key LIKE 'lb-' || $2::text || '-%'
              OR idempotency_key LIKE 'la-' || $2::text || '-%'
            )`,
        [ada.actorId, charIndex],
      );
      expect(exec.rows[0]!.n).toBe(1 + BUMP_ROUNDS + ROLLS_PER_CHAR);
      expect(exec.rows[0]!.statuses).toHaveLength(1 + BUMP_ROUNDS + ROLLS_PER_CHAR);
      const allCompleted = exec.rows[0]!.statuses.every((s) => s === "completed");
      expect(allCompleted).toBe(true);

      const rolls = await pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM character_rolls WHERE character_id = $1",
        [characterId],
      );
      expect(rolls.rows[0]!.n).toBe(ROLLS_PER_CHAR);
    }

    const executions = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM character_command_executions WHERE actor_id = $1",
      [ada.actorId],
    );
    expect(executions.rows[0]!.n).toBe(CHAR_COUNT * (1 + BUMP_ROUNDS + ROLLS_PER_CHAR));

    // ---- p95 budgets -------------------------------------------------------
    const results = {
      creates: { count: createLatencies.length, p95Ms: round(p95(createLatencies)) },
      reads: { count: readLatencies.length, p95Ms: round(p95(readLatencies)) },
      bumps: { count: writeLatencies.length, p95Ms: round(p95(writeLatencies)) },
      rolls: { count: rollLatencies.length, p95Ms: round(p95(rollLatencies)) },
    };
    // eslint-disable-next-line no-console
    console.log(`[load] p95 latencies: ${JSON.stringify(results)}`);

    expect(readLatencies).toHaveLength(READ_COUNT);
    expect(writeLatencies).toHaveLength(BUMP_ROUNDS * CHAR_COUNT);
    expect(rollLatencies).toHaveLength(ROLLS_PER_CHAR * CHAR_COUNT);

    expect(p95(createLatencies)).toBeLessThanOrEqual(300);
    expect(p95(readLatencies)).toBeLessThanOrEqual(300);
    expect(p95(writeLatencies)).toBeLessThanOrEqual(300);
    expect(p95(rollLatencies)).toBeLessThanOrEqual(500);
  }, 120_000);
});

function round(value: number): number {
  return Math.round(value * 10) / 10;
}