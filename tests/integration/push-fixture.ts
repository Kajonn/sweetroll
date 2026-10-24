import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import {
  createI3Schema,
  createI3Pool,
  buildI3App,
  dropI3Schema,
} from "./i3-app.js";
import { namedDicePoolDocument } from "../../src/systems/implementation/package/fixtures/named-dice-pool.js";
import type { SystemDocumentV1 } from "../../src/systems/implementation/package/schema/index.js";
export async function makePushApp(
  source: "entity" | "item" = "entity",
  change?: (d: SystemDocumentV1) => void,
) {
  const db = process.env.TEST_DATABASE_URL!,
    schema = `push_${randomUUID().replaceAll("-", "")}`;
  await createI3Schema(db, schema);
  const pool = createI3Pool(db, schema);
  const h = await buildI3App({ pool });
  const headers = { cookie: h.users.ada.cookie };
  const doc = namedDicePoolDocument();
  doc.schemaVersion = "1.2";
  const a = doc.actions.find((a) => a.kind === "roll")!;
  if (a.kind !== "roll") throw Error("fixture");
  a.pushPolicy = {
    version: "1.0",
    maxAttempts: 2,
    successThreshold: 1,
    allowOnSuccess: true,
    groups: [{ groupId: "attribute", lockedFaces: [], reportedFaces: [1] }],
  };
  if (source === "item") {
    doc.slots = [{ id: "gear_slot", label: "Gear", accepts: ["item"] }];
    doc.templates = [
      {
        id: "tool",
        label: "Tool",
        kind: "item",
        fields: [],
        grantedActions: [
          {
            ...structuredClone(a),
            id: "tool_pool",
            expressionId: "tool_expr",
            inputs: [
              {
                id: "gear_bonus",
                label: "Bonus",
                valueType: "integer",
                required: false,
                default: 0,
              },
            ],
          },
        ],
      },
    ];
    doc.expressions.push({
      ...doc.expressions.find((e) => e.id === "pool_roll_expr")!,
      id: "tool_expr",
      source: doc.expressions
        .find((e) => e.id === "pool_roll_expr")!
        .source.replaceAll("inputs.bonus_dice", "inputs.gear_bonus"),
    });
    doc.sheets[0]!.sections[1]!.elements.push({
      kind: "slot",
      id: "gear_slot_element",
      slotId: "gear_slot",
    });
  }
  change?.(doc);
  const create = await h.app.inject({
    method: "POST",
    url: "/systems",
    headers,
    payload: {
      source: { kind: "blank", name: "Push fixture" },
      idempotencyKey: randomUUID(),
    },
  });
  expect(create.statusCode, create.body).toBe(201);
  const w = create.json().workspace;
  const saved = await h.app.inject({
    method: "PUT",
    url: `/systems/${w.system.systemId}/draft`,
    headers,
    payload: { expectedRevision: w.draft.revision, document: doc },
  });
  expect(saved.statusCode, saved.body).toBe(200);
  const pub = await h.app.inject({
    method: "POST",
    url: `/systems/${w.system.systemId}/publish`,
    headers,
    payload: {
      expectedRevision: saved.json().workspace.draft.revision,
      semanticVersion: "1.0.0",
      releaseNotes: "",
      acknowledgeBreaking: true,
      idempotencyKey: randomUUID(),
    },
  });
  expect(pub.statusCode, pub.body).toBe(200);
  const created = await h.app.inject({
    method: "POST",
    url: "/characters",
    headers,
    payload: {
      systemVersionId: pub.json().version.versionId,
      entityDefinitionId: "character",
      name: "Push Hero",
      idempotencyKey: randomUUID(),
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  const id = created.json().character.characterId;
  const entryId = randomUUID();
  let revision = 1;
  if (source === "item") {
    const add = await h.app.inject({
      method: "POST",
      url: `/characters/${id}/entries`,
      headers,
      payload: {
        entry: {
          entryId,
          slotId: "gear_slot",
          templateId: "tool",
          values: {},
          quantity: 1,
        },
        expectedRevision: 1,
        idempotencyKey: randomUUID(),
      },
    });
    expect(add.statusCode, add.body).toBe(200);
    revision = 2;
  }
  const root = await h.app.inject({
    method: "POST",
    url: `/characters/${id}/actions/${source === "item" ? "tool_pool" : "test_pool"}`,
    headers,
    payload: {
      inputs: { [source === "item" ? "gear_bonus" : "bonus_dice"]: 1 },
      ...(source === "item" ? { entryId } : {}),
      expectedRevision: revision,
      idempotencyKey: randomUUID(),
    },
  });
  expect(root.statusCode, root.body).toBe(200);
  return {
    ...h,
    headers,
    id,
    entryId,
    revision,
    root: root.json().result.roll,
    systemId: w.system.systemId,
    versionId: pub.json().version.versionId,
    document: doc,
    push: (parentId: string, rev = revision, key = randomUUID(), extra = {}) =>
      h.app.inject({
        method: "POST",
        url: `/characters/${id}/rolls/${parentId}/push`,
        headers,
        payload: { expectedRevision: rev, idempotencyKey: key, ...extra },
      }),
    cleanup: async () => {
      await h.app.close();
      await pool.end();
      await dropI3Schema(db, schema);
    },
  };
}
