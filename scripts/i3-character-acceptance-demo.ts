// I3 character-backend acceptance demonstration.
//
// Walks the documented character HTTP surface end-to-end over real PostgreSQL:
// sign-in -> publish a system version -> create/read/set/bump/roll/replay ->
// revision race -> archive/recover -> activity -> export -> breaking publish ->
// migration preview/commit/rollback -> ownership transfer -> expired-key
// rejection. Everything goes through Fastify `inject`, so the exact same route
// definitions, auth hook, and response envelope the production bootstrap uses
// are exercised. Status codes are printed per step and asserted against the
// documented transport mapping.
//
// Re-runnable: every run derives a fresh idempotency key from Date.now().
//
// Run via `scripts/i3-character-acceptance-demo.sh`.

import { Pool } from "pg";
import type { LightMyRequestResponse } from "fastify";

import { buildI3App, buildD20V2Document, type I3AppHandle } from "../tests/integration/i3-app.js";
import { d20Document } from "../src/systems/implementation/package/fixtures/index.js";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://sweetroll:sweetroll@localhost:5432/sweetroll";

const cookieHeader = (user: { cookie: string }) => ({ cookie: user.cookie });

async function signInAndPublish(app: I3AppHandle, ts: number): Promise<string> {
  const ada = app.users.ada;
  const create = await app.app.inject({
    method: "POST",
    url: "/systems",
    headers: cookieHeader(ada),
    payload: { source: { kind: "blank", name: `I3 Demo ${ts}` }, idempotencyKey: `d-create-${ts}` },
  });
  assertStatus(create, 201, "POST /systems (blank draft)");
  const systemId = create.json().workspace.system.systemId as string;
  const initialRevision = create.json().workspace.draft?.revision ?? 1;

  const save = await app.app.inject({
    method: "PUT",
    url: `/systems/${systemId}/draft`,
    headers: cookieHeader(ada),
    payload: { expectedRevision: initialRevision, document: d20Document },
  });
  assertStatus(save, 200, "PUT /systems/{id}/draft (d20)");
  const draftRevision = save.json().workspace.draft.revision as number;

  const publish = await app.app.inject({
    method: "POST",
    url: `/systems/${systemId}/publish`,
    headers: cookieHeader(ada),
    payload: {
      expectedRevision: draftRevision,
      semanticVersion: "1.0.0",
      releaseNotes: "I3 acceptance demo",
      idempotencyKey: `d-pub-${ts}`,
      acknowledgeBreaking: true,
    },
  });
  assertStatus(publish, 200, "POST /systems/{id}/publish (v1.0.0)");
  return publish.json().version.versionId as string;
}

function assertStatus(response: LightMyRequestResponse, expected: number, label: string): void {
  const actual = response.statusCode;
  console.log(`STEP: ${label} -> ${actual}${actual === expected ? "" : ` (expected ${expected})`}`);
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}: ${response.body}`);
  }
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: DATABASE_URL, max: 16 });
  try {
    const app = await buildI3App({ pool });
    const ada = app.users.ada;
    const bob = app.users.bob;
    const ts = Date.now();

    console.log(`INFO: actor ada=${ada.actorId} bob=${bob.actorId} ts=${ts}`);

    const v1Id = await signInAndPublish(app, ts);

    const create = await app.app.inject({
      method: "POST",
      url: "/characters",
      headers: cookieHeader(ada),
      payload: {
        systemVersionId: v1Id,
        entityDefinitionId: "character",
        name: "Aria",
        idempotencyKey: `d-c1-${ts}`,
      },
    });
    assertStatus(create, 201, "POST /characters (create)");
    const characterId = create.json().character.characterId as string;
    console.log(`INFO: characterId=${characterId}`);

    const open = await app.app.inject({
      method: "GET",
      url: `/characters/${characterId}`,
      headers: cookieHeader(ada),
    });
    assertStatus(open, 200, "GET /characters/{id}");
    console.log(
      `INFO: etag=${open.headers.etag} cache-control=${open.headers["cache-control"]} x-resource-revision=${open.headers["x-resource-revision"]}`,
    );

    const set1 = await app.app.inject({
      method: "POST",
      url: `/characters/${characterId}/fields/ability/set`,
      headers: cookieHeader(ada),
      payload: { value: 15, expectedRevision: 1, idempotencyKey: `d-s1-${ts}` },
    });
    assertStatus(set1, 200, "POST .../fields/ability/set");

    const bump1 = await app.app.inject({
      method: "POST",
      url: `/characters/${characterId}/resources/health/bump`,
      headers: cookieHeader(ada),
      payload: { direction: "down", expectedRevision: 2, idempotencyKey: `d-b1-${ts}` },
    });
    assertStatus(bump1, 200, "POST .../resources/health/bump (down)");

    const roll1 = await app.app.inject({
      method: "POST",
      url: `/characters/${characterId}/actions/check`,
      headers: cookieHeader(ada),
      payload: { inputs: { bonus: 2 }, expectedRevision: 3, idempotencyKey: `d-a1-${ts}` },
    });
    assertStatus(roll1, 200, "POST .../actions/check");
    const firstRoll = roll1.json().result;
    console.log(
      `INFO: roll dice=${JSON.stringify(firstRoll.roll.dice)} total=${firstRoll.roll.total} expression=${firstRoll.roll.expression}`,
    );

    const replay = await app.app.inject({
      method: "POST",
      url: `/characters/${characterId}/actions/check`,
      headers: cookieHeader(ada),
      payload: { inputs: { bonus: 2 }, expectedRevision: 3, idempotencyKey: `d-a1-${ts}` },
    });
    assertStatus(replay, 200, "POST .../actions/check (replay)");
    if (!replay.json().result.character.reconciliation.replayed) {
      throw new Error("replay: expected replayed:true");
    }
    if (replay.json().result.character.reconciliation.commandExecutionId !== firstRoll.character.reconciliation.commandExecutionId) {
      throw new Error("replay: commandExecutionId changed");
    }
    console.log("INFO: replay replayed=true, same commandExecutionId");

    const raceA = await app.app.inject({
      method: "POST",
      url: `/characters/${characterId}/resources/health/bump`,
      headers: cookieHeader(ada),
      payload: { direction: "down", expectedRevision: 3, idempotencyKey: `d-r1-${ts}` },
    });
    const raceB = await app.app.inject({
      method: "POST",
      url: `/characters/${characterId}/resources/health/bump`,
      headers: cookieHeader(ada),
      payload: { direction: "down", expectedRevision: 3, idempotencyKey: `d-r2-${ts}` },
    });
    const winners = [raceA, raceB].filter((r) => r.statusCode === 200);
    const conflicts = [raceA, raceB].filter((r) => r.statusCode === 409);
    console.log(
      `STEP: race two bumps at revision 3 -> ${raceA.statusCode} / ${raceB.statusCode} (expected one 200, one 409)`,
    );
    if (winners.length !== 1 || conflicts.length !== 1) {
      throw new Error(`race: expected exactly one winner and one 409, got ${raceA.statusCode}/${raceB.statusCode}`);
    }
    const raceWinnerCode = winners[0]!.json().result.character.reconciliation;
    console.log(`INFO: winner revision=${raceWinnerCode.revision}`);

    const archive = await app.app.inject({
      method: "PATCH",
      url: `/characters/${characterId}`,
      headers: cookieHeader(ada),
      payload: { command: "archive", expectedRevision: 4, idempotencyKey: `d-ar-${ts}` },
    });
    assertStatus(archive, 200, "PATCH /characters/{id} (archive)");

    const playWhileArchived = await app.app.inject({
      method: "POST",
      url: `/characters/${characterId}/fields/ability/set`,
      headers: cookieHeader(ada),
      payload: { value: 12, expectedRevision: 5, idempotencyKey: `d-arplay-${ts}` },
    });
    assertStatus(playWhileArchived, 409, "POST .../fields/... (archived)");

    const recover = await app.app.inject({
      method: "PATCH",
      url: `/characters/${characterId}`,
      headers: cookieHeader(ada),
      payload: { command: "recover", expectedRevision: 5, idempotencyKey: `d-rc-${ts}` },
    });
    assertStatus(recover, 200, "PATCH /characters/{id} (recover)");

    const activity = await app.app.inject({
      method: "GET",
      url: `/characters/${characterId}/activity?limit=100`,
      headers: cookieHeader(ada),
    });
    assertStatus(activity, 200, "GET /characters/{id}/activity");
    const kinds = (activity.json().events as Array<{ kind: string }>).map((e) => e.kind);
    console.log(`INFO: activity kinds=${JSON.stringify(kinds)}`);

    const exported1 = await app.app.inject({
      method: "POST",
      url: `/characters/${characterId}/exports`,
      headers: cookieHeader(ada),
      payload: { idempotencyKey: `d-ex1-${ts}` },
    });
    assertStatus(exported1, 200, "POST /characters/{id}/exports");
    console.log(`INFO: export mediaType=${exported1.headers["content-type"]}`);

    const v2Document = buildD20V2Document();
    const systemId = await systemIdFor(app, v1Id);
    const draft2 = await app.app.inject({
      method: "PUT",
      url: `/systems/${systemId}/draft`,
      headers: cookieHeader(ada),
      payload: { expectedRevision: 2, document: v2Document },
    });
    assertStatus(draft2, 200, "PUT /systems/{id}/draft (breaking v2)");
    const draft2Revision = draft2.json().workspace.draft.revision as number;

    const blocked = await app.app.inject({
      method: "POST",
      url: `/systems/${systemId}/publish`,
      headers: cookieHeader(ada),
      payload: {
        expectedRevision: draft2Revision,
        semanticVersion: "2.0.0",
        releaseNotes: "Breaking: rename ability",
        idempotencyKey: `d-pub2-noack-${ts}`,
        acknowledgeBreaking: false,
      },
    });
    assertStatus(blocked, 422, "POST /systems/{id}/publish (breaking, no acknowledge)");

    const published2 = await app.app.inject({
      method: "POST",
      url: `/systems/${systemId}/publish`,
      headers: cookieHeader(ada),
      payload: {
        expectedRevision: draft2Revision,
        semanticVersion: "2.0.0",
        releaseNotes: "Breaking: rename ability",
        idempotencyKey: `d-pub2-${ts}`,
        acknowledgeBreaking: true,
      },
    });
    assertStatus(published2, 200, "POST /systems/{id}/publish (v2.0.0 acknowledged)");
    const v2Id = published2.json().version.versionId as string;

    const pinned = await app.app.inject({
      method: "GET",
      url: `/characters/${characterId}`,
      headers: cookieHeader(ada),
    });
    assertStatus(pinned, 200, "GET /characters/{id} (still pinned to v1)");
    if (pinned.json().character.systemVersionId !== v1Id) {
      throw new Error("pinned: character moved off v1 before migration");
    }
    console.log("INFO: character remains pinned to v1 after v2 publish");

    const preview = await app.app.inject({
      method: "POST",
      url: `/characters/${characterId}/migration-previews`,
      headers: cookieHeader(ada),
      payload: { targetVersionId: v2Id, mappings: { ability: "ability_score" } },
    });
    assertStatus(preview, 201, "POST .../migration-previews");
    const previewBody = preview.json().preview;
    console.log(
      `INFO: preview candidate=${JSON.stringify(previewBody.candidateState.values)} warnings=${JSON.stringify(previewBody.warnings)}`,
    );

    const commit = await app.app.inject({
      method: "POST",
      url: `/characters/${characterId}/migrations/${previewBody.previewId}/commit`,
      headers: cookieHeader(ada),
      payload: { expectedRevision: 6, idempotencyKey: `d-cm-${ts}` },
    });
    assertStatus(commit, 200, "POST .../migrations/{id}/commit");

    const migrationId = await migrationIdFor(app, characterId);

    const rollback = await app.app.inject({
      method: "POST",
      url: `/characters/${characterId}/migrations/${migrationId}/rollback`,
      headers: cookieHeader(ada),
      payload: { idempotencyKey: `d-rb-${ts}` },
    });
    assertStatus(rollback, 200, "POST .../migrations/{id}/rollback");

    const transfer = await app.app.inject({
      method: "POST",
      url: `/characters/${characterId}/ownership-transfer`,
      headers: cookieHeader(ada),
      payload: { toUserId: bob.actorId, expectedRevision: 8, idempotencyKey: `d-tr-${ts}` },
    });
    assertStatus(transfer, 200, "POST /characters/{id}/ownership-transfer (to Bob)");

    const oldOwnerOpen = await app.app.inject({
      method: "GET",
      url: `/characters/${characterId}`,
      headers: cookieHeader(ada),
    });
    assertStatus(oldOwnerOpen, 404, "GET /characters/{id} (old owner)");
    if (oldOwnerOpen.json().error.cacheDisposition !== "purge") {
      throw new Error("old-owner open: expected purge disposition");
    }

    const transferReplay = await app.app.inject({
      method: "POST",
      url: `/characters/${characterId}/ownership-transfer`,
      headers: cookieHeader(ada),
      payload: { toUserId: bob.actorId, expectedRevision: 8, idempotencyKey: `d-tr-${ts}` },
    });
    assertStatus(transferReplay, 200, "POST .../ownership-transfer (old-owner replay)");
    const replayed = transferReplay.json().result.character.reconciliation.replayed;
    if (!replayed) {
      throw new Error("transfer replay: expected replayed:true");
    }
    if (transferReplay.json().result.character.ownerId !== bob.actorId) {
      throw new Error("transfer replay: ownerId did not stay with Bob");
    }

    await app.pool.query(
      `UPDATE character_command_executions SET expires_at = now() - interval '1 second'
        WHERE actor_id = $1 AND command_kind = 'character_create' AND idempotency_key = $2`,
      [ada.actorId, `d-c1-${ts}`],
    );
    const expired = await app.app.inject({
      method: "POST",
      url: "/characters",
      headers: cookieHeader(ada),
      payload: {
        systemVersionId: v1Id,
        entityDefinitionId: "character",
        name: "Aria",
        idempotencyKey: `d-c1-${ts}`,
      },
    });
    assertStatus(expired, 409, "POST /characters (expired replay window)");
    if (!/replay/i.test(expired.json().error.message)) {
      throw new Error("expired: message did not mention replay window");
    }

    console.log("ALL STEPS PASSED");
    await app.app.close();
  } finally {
    await pool.end();
  }
}

async function systemIdFor(app: I3AppHandle, versionId: string): Promise<string> {
  const result = await app.pool.query<{ system_id: string }>(
    "SELECT system_id FROM system_versions WHERE id = $1",
    [versionId],
  );
  return result.rows[0]!.system_id;
}

async function migrationIdFor(app: I3AppHandle, characterId: string): Promise<string> {
  const result = await app.pool.query<{ id: string }>(
    "SELECT id FROM character_migrations WHERE character_id = $1 ORDER BY committed_at DESC LIMIT 1",
    [characterId],
  );
  return result.rows[0]!.id;
}

main().catch((err: unknown) => {
  console.error("DEMO FAILED:", err);
  process.exit(1);
});