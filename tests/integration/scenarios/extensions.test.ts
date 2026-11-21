import { randomUUID } from "node:crypto";

import { expect } from "vitest";

import { emberTrailDocument } from "../fixtures/ember-trail/document.js";
import { scenario } from "./runner.js";

/**
 * System extensions through public API v1 (extensions plan E7): an author
 * publishes Ember Trail and an extension of it; a player builds a hero with the
 * extension, places its item and upgrades the extension; the GM adds the
 * extension to a campaign. Every step uses `/api/v1` and personal tokens.
 */
type Composition = { systemVersionId: string; extensions: Array<{ extensionId: string; versionId: string }> };
type Workspace = { extension: { extensionId: string }; draft: { revision: number } | null; assessment: { ok: boolean; diagnostics: unknown[] } };

/** A glowing brand: an item of the extension, its formula reads the hero's Might. */
const embersPack = (heat: number) => ({
  schemaVersion: "2.0",
  metadata: { name: "Embers pack", description: "Burning gear for the trail.", language: "en" },
  expressions: [{ id: "brand_burn", context: "roll", resultType: "number", source: `dice(1, 6) + fields.might + item.heat`, fallback: 0 }],
  templates: [{
    kind: "item", id: "brand", label: "Ember brand",
    fields: [{ kind: "integer", id: "heat", label: "Heat", default: heat, min: 0, max: 5, step: 1, required: false }],
    grantedActions: [{ kind: "roll", id: "burn", label: "Burn", expressionId: "brand_burn", inputs: [], outputTemplate: "Burn: {total}" }],
  }],
});

scenario("Extensions through v1: author, build, upgrade and add to a campaign", async ({ actor, phase }) => {
  const author = await actor("cara", ["systems:read", "systems:write"]);
  const bob = await actor("bob", ["systems:read", "characters:read", "characters:write"]);
  const gm = await actor("ada", ["systems:read", "characters:read", "characters:write", "campaigns:read", "campaigns:write"]);

  await phase("Publish the system and an extension");
  const created = await author.command<{ system: { systemId: string }; draft: { revision: number } }>("POST /systems", { name: "Ember Trail" }, 201);
  const system = `/systems/${created.system.systemId}` as const;
  const saved = await author.json<{ draft: { revision: number } }>(`PUT ${system}/draft`, { document: emberTrailDocument, expectedRevision: created.draft.revision });
  const { versionId: baseVersionId } = await author.command<{ versionId: string }>(`POST ${system}/publish`, {
    expectedRevision: saved.draft.revision, semanticVersion: "1.0.0",
  }, 201);
  await author.json(`PUT ${system}/sharing`, { access: "link" });

  const opened = await author.command<Workspace>(`POST ${system}/extensions`, { baseVersionId, name: "Embers pack" }, 201);
  const extensionId = opened.extension.extensionId;
  const extension = `/extensions/${extensionId}` as const;
  // A draft that reads an unknown field is assessed, not rejected.
  const broken = await author.json<Workspace>(`PUT ${extension}/draft`, {
    expectedRevision: opened.draft!.revision,
    document: { ...embersPack(1), expressions: [{ ...embersPack(1).expressions[0], source: "dice(1, 6) + fields.speed" }] },
  });
  expect(broken.assessment.ok).toBe(false);
  const fixed = await author.json<Workspace>(`PUT ${extension}/draft`, { expectedRevision: broken.draft!.revision, document: embersPack(1) });
  expect(fixed.assessment).toMatchObject({ ok: true, diagnostics: [] });
  const preview = await author.json<{ baseVersionId: string; package: { templates: Array<{ id: string }> } }>(`POST ${extension}/preview`);
  expect(preview.baseVersionId).toBe(baseVersionId);
  expect(preview.package.templates.map((template) => template.id)).toEqual(["brand"]);
  const v1 = await author.command<{ versionId: string; semanticVersion: string }>(`POST ${extension}/publish`, {
    expectedRevision: fixed.draft!.revision, semanticVersion: "1.0.0",
  }, 201);
  expect(v1.semanticVersion).toBe("1.0.0");
  // Sharing uses the system routes with the extension's ID.
  await author.json(`PATCH /systems/${extensionId}`, { access: "public" });
  const listed = await bob.json<{ extensions: Array<{ extensionId: string; latestVersion: { versionId: string } | null; owned: boolean }> }>(`GET ${system}/extensions`);
  expect(listed.extensions).toEqual([expect.objectContaining({ extensionId, owned: false, latestVersion: expect.objectContaining({ versionId: v1.versionId }) })]);
  await bob.status(`GET ${extension}`, 404);
  await bob.status(`POST ${extension}/publish`, 403, { expectedRevision: 1, semanticVersion: "9.0.0", idempotencyKey: randomUUID() });

  await phase("Build a hero with the extension");
  const options = await bob.json<{ extensions: Array<{ extensionId: string; versionId: string }> }>(`GET /characters/creation-options?systemVersionId=${baseVersionId}`);
  expect(options.extensions).toEqual([expect.objectContaining({ extensionId, versionId: v1.versionId, name: "Embers pack" })]);
  const hero = await bob.command<{ characterId: string; revision: number }>("POST /characters", {
    name: "Cinder", systemVersionId: baseVersionId, entityDefinitionId: "hero", initialValues: { might: 2 },
    extensions: [{ extensionId, versionId: v1.versionId }],
  }, 201);
  const path = `/characters/${hero.characterId}` as const;
  let revision = hero.revision;
  const entryId = randomUUID();
  ({ revision } = await bob.command<{ revision: number }>(`POST ${path}/entries`, {
    entryId, slotId: "gear", templateId: "brand", extensionId,
    source: { kind: "system", templateId: "brand", extensionId }, expectedRevision: revision,
  }));
  const sheet = await bob.json<{ extensions: Composition["extensions"]; entries: Array<{ entryId: string; extensionId?: string; values: Record<string, unknown> }> }>(`GET ${path}`);
  expect(sheet.extensions).toEqual([{ extensionId, versionId: v1.versionId }]);
  expect(sheet.entries.find((entry) => entry.entryId === entryId)).toMatchObject({ extensionId, values: { heat: 1 } });
  const burn = await bob.command<{ revision: number; roll: { total: number; dice: Array<{ value: number }> } }>(`POST ${path}/actions/burn`, { entryId, inputs: {}, expectedRevision: revision });
  revision = burn.revision;
  expect(burn.roll.total).toBe(burn.roll.dice[0]!.value + 3);

  await phase("Upgrade the extension on the hero, then revert");
  const v2 = await author.command<{ versionId: string }>(`POST ${extension}/publish`, {
    expectedRevision: (await author.json<Workspace>(`PUT ${extension}/draft`, {
      expectedRevision: (await author.json<Workspace>(`GET ${extension}`)).draft!.revision, document: embersPack(2),
    })).draft!.revision,
    semanticVersion: "1.1.0",
  }, 201);
  const compositionOptions = await bob.json<{ current: { extensions: Array<{ upgrades: Array<{ versionId: string }> }> }; revertTo: unknown }>(`GET ${path}/composition-options`);
  expect(compositionOptions.current.extensions[0]!.upgrades.map((choice) => choice.versionId)).toEqual([v2.versionId]);
  expect(compositionOptions.revertTo).toBeNull();
  const upgraded: Composition = { systemVersionId: baseVersionId, extensions: [{ extensionId, versionId: v2.versionId }] };
  const check = await bob.json<{ change: { kind: string }; report: { ok: boolean; changedEntries: Array<{ updatedFields: string[] }> } }>(`POST ${path}/composition-check`, { target: upgraded });
  expect(check).toMatchObject({ change: { kind: "extension_upgrade" }, report: { ok: true, changedEntries: [{ updatedFields: ["heat"] }] } });
  ({ revision } = await bob.command<{ revision: number }>(`POST ${path}/composition`, { target: upgraded, expectedRevision: revision }));
  expect((await bob.json<{ entries: Array<{ values: Record<string, unknown> }> }>(`GET ${path}`)).entries[0]!.values.heat).toBe(2);
  // Removing the extension is blocked while its item is placed; the revert target is the previous composition.
  const removal = await bob.json<{ change: { kind: string }; report: { ok: boolean } }>(`POST ${path}/composition-check`, {
    target: { systemVersionId: baseVersionId, extensions: [] },
  });
  expect(removal).toMatchObject({ change: { kind: "extension_remove" }, report: { ok: false } });
  ({ revision } = await bob.command<{ revision: number }>(`POST ${path}/composition`, {
    target: { systemVersionId: baseVersionId, extensions: [{ extensionId, versionId: v1.versionId }] }, expectedRevision: revision,
  }));
  expect((await bob.json<{ extensions: Composition["extensions"] }>(`GET ${path}`)).extensions).toEqual([{ extensionId, versionId: v1.versionId }]);

  await phase("Add the extension to a campaign");
  const { campaignId } = await gm.command<{ campaignId: string }>("POST /campaigns", { systemVersionId: baseVersionId, title: "Smoke road" }, 201);
  const campaign = `/campaigns/${campaignId}` as const;
  const campaignOptions = await gm.json<{ available: Array<{ extensionId: string; version: { versionId: string } }> }>(`GET ${campaign}/composition-options`);
  expect(campaignOptions.available).toEqual([expect.objectContaining({ extensionId, version: expect.objectContaining({ versionId: v2.versionId }) })]);
  const added: Composition = { systemVersionId: baseVersionId, extensions: [{ extensionId, versionId: v2.versionId }] };
  const campaignCheck = await gm.json<{ ok: boolean; change: { kind: string } }>(`POST ${campaign}/composition-check`, { target: added });
  expect(campaignCheck).toMatchObject({ ok: true, change: { kind: "extension_add" } });
  const revisionBefore = (await gm.json<{ revision: number }>(`GET ${campaign}`)).revision;
  const moved = await gm.command<{ campaignId: string; revision: number }>(`POST ${campaign}/composition`, { target: added, expectedCampaignRevision: revisionBefore });
  expect(moved.revision).toBeGreaterThan(revisionBefore);
  const after = await gm.json<{ current: { extensions: Array<{ extensionId: string }> }; revertTo: { extensions: unknown[] } }>(`GET ${campaign}/composition-options`);
  expect(after.current.extensions.map((choice) => choice.extensionId)).toEqual([extensionId]);
  expect(after.revertTo.extensions).toEqual([]);
  // A player token cannot change a campaign's rules.
  await bob.status(`GET ${campaign}/composition-options`, 403);
});
