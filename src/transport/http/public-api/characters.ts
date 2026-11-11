import { Type } from "@sinclair/typebox";

import type { CharacterCommandResult, Characters } from "../../../characters/index.js";
import { EntrySourceSchema } from "../../../systems/implementation/package/schema/dynamic.js";
import { FieldV1Schema, TemplateKindSchema } from "../../../systems/implementation/package/schema/document.js";
import { BindingValueSchema, DieResultSchema, PushResultSchema, RollBreakdownSchema } from "../../../systems/implementation/rules/result.js";
import { map, wire, type Route } from "./router.js";
import { RollOptionsQuery, RollOptionsSchema } from "../roll-options.js";
import * as s from "./schemas.js";

const audience = Type.Union([Type.Literal("owner_only"), Type.Literal("gm_only"), Type.Literal("campaign")]);
export const roll = s.object({
  targetCharacterId: Type.Optional(s.uuid),
  respondsTo: Type.Optional(s.uuid),
  rollId: Type.Union([s.uuid, Type.Null()], {
    description: "Saved roll ID of a push-tracked roll, for reads and pushes. Null for rolls without a push policy, "
      + "and when the reader may not correlate the roll; those appear in the activity feed.",
  }),
  actionId: s.definitionId,
  expression: s.text,
  dice: Type.Array(DieResultSchema),
  bindings: Type.Array(s.object({
    scope: Type.Union([Type.Literal("fields"), Type.Literal("inputs"), Type.Literal("item"), Type.Literal("aggregates"), Type.Literal("target"), Type.Literal("opposed")]),
    definitionId: Type.String({ minLength: 1, maxLength: 205 }),
    value: BindingValueSchema,
  })),
  total: Type.Number(),
  // The first outcome band whose condition held. Present on the command result; stored rolls carry it in `output`.
  outcome: Type.Optional(s.object({ id: s.definitionId, label: s.text })),
  details: Type.Optional(Type.Array(s.object({ id: s.definitionId, label: s.text, value: Type.Number() }), { maxItems: 8 })),
  output: s.text,
  audience,
  breakdown: RollBreakdownSchema,
  push: Type.Optional(PushResultSchema),
});
const commandResult = s.object({
  characterId: s.uuid,
  revision: s.revision,
  roll: Type.Union([roll, Type.Null()]),
  nominal: Type.Union([s.object({ actionId: s.definitionId, entryId: s.text, output: s.text }), Type.Null()]),
});
const looseObject = Type.Object({}, { additionalProperties: true });

export const characterSchemas = {
  CharacterCommandResult: commandResult,
  Roll: roll,
  RollOptions: RollOptionsSchema,
  PushOptions: s.object({
    canPush: Type.Boolean(),
    reason: Type.Union([s.text, Type.Null()]),
    eligibleDiceIds: Type.Array(s.text),
    revision: s.revision,
    nextAttempt: Type.Integer({ minimum: 1 }),
    maxAttempts: Type.Integer({ minimum: 1 }),
  }),
  EntryTemplates: s.object({
    templates: Type.Array(s.object({
      id: s.definitionId,
      label: s.text,
      kind: TemplateKindSchema,
      source: Type.Optional(EntrySourceSchema),
      defaultQuantity: Type.Optional(Type.Integer({ minimum: 1 })),
      fields: Type.Array(FieldV1Schema),
      grantedActions: Type.Array(s.object({
        id: s.definitionId,
        label: s.text,
        actionKind: Type.Union([Type.Literal("roll"), Type.Literal("resourceBump")]),
        target: Type.Optional(s.object({ entityId: s.definitionId })),
        respondsTo: Type.Optional(Type.Literal(true)),
        inputs: Type.Array(s.object({
          id: s.definitionId,
          label: s.text,
          valueType: Type.Union([Type.Literal("integer"), Type.Literal("decimal"), Type.Literal("boolean"), Type.Literal("text")]),
          required: Type.Boolean(),
          default: s.scalar,
        })),
      })),
    })),
  }),
  CharacterActivity: s.object({
    events: Type.Array(s.object({
      eventId: s.uuid,
      kind: s.text,
      characterRevision: s.revision,
      rollId: Type.Union([s.text, Type.Null()]),
      roll: Type.Optional(roll),
      payload: looseObject,
      requestId: s.text,
      occurredAt: s.dateTime,
    })),
    nextCursor: s.nullable(s.cursor),
  }),
  CharacterExport: s.object({
    schemaVersion: Type.Literal("1.0"),
    mediaType: Type.Literal("application/vnd.sweetroll.character+json;version=1"),
    characterId: s.uuid,
    name: s.text,
    entityDefinitionId: s.definitionId,
    lifecycle: s.lifecycle,
    createdAt: s.dateTime,
    updatedAt: s.dateTime,
    systemVersionId: s.uuid,
    packageChecksum: s.text,
    revision: s.revision,
    state: s.object({
      schemaVersion: Type.Literal("1.0"),
      values: looseObject,
      entries: Type.Record(Type.String(), looseObject),
    }),
  }),
};

const name = Type.String({ minLength: 1, maxLength: 120, pattern: "\\S" });
const manage = Type.Union([
  s.object({ command: Type.Literal("rename"), name, ...s.revisionCommand }),
  s.object({ command: Type.Literal("archive"), ...s.revisionCommand }),
  s.object({ command: Type.Literal("recover"), ...s.revisionCommand }),
]);
const actionParams = s.object({ characterId: s.uuid, actionId: s.definitionId });
const rollParams = s.object({ characterId: s.uuid, rollId: s.uuid });
const executeAction = s.object({
  targetCharacterId: Type.Optional(s.uuid),
  respondsTo: Type.Optional(s.uuid),
  inputs: Type.Optional(Type.Record(s.definitionId, s.scalar, { maxProperties: 64 })),
  audience: Type.Optional(audience),
  entryId: Type.Optional(s.uuid),
  ...s.revisionCommand,
});
const activityQuery = s.object(s.page(s.cursor));
const transfer = s.object({ toUserId: s.uuid, ...s.revisionCommand });
const portraitBytes = s.object({ characterId: s.uuid, fileId: s.uuid });
const entryBytes = s.object({ characterId: s.uuid, entryId: s.uuid, fileId: s.uuid });

/** Push-tracked rolls carry their saved ID; the browser reads and pushes only those. */
export function commandView({ character, roll: saved, nominal }: CharacterCommandResult) {
  return {
    characterId: character.characterId,
    revision: character.revision,
    roll: saved === null ? null : { ...wire(saved) as object, rollId: saved.push?.rollId ?? null },
    nominal: nominal ?? null,
  };
}

export function registerCharacterRoutes(route: Route, { characters }: { characters: Characters }) {
  route({
    method: "PATCH", path: "/characters/:characterId", id: "manageCharacter",
    description: "Rename, archive or recover a character. Archived characters reject play commands until recovered.",
    scope: "characters:write", input: { params: s.characterId, body: manage }, output: "CharacterCommandResult",
    example: { command: "rename", name: "Rowan the Bold", expectedRevision: 3, idempotencyKey: "rename-1" },
  }, async (ctx, { params, body }) => {
    const { command, expectedRevision, idempotencyKey } = body;
    const result = await characters.manage(ctx, command === "rename"
      ? { kind: "rename", characterId: params.characterId, name: body.name, expectedRevision, idempotencyKey }
      : { kind: command, characterId: params.characterId, expectedRevision, idempotencyKey });
    return map(result, commandView);
  });

  route({
    method: "GET", path: "/characters/:characterId/templates", id: "listCharacterEntryTemplates",
    description: "List the system and campaign templates the caller may place on this character, with granted actions.",
    scope: "characters:read", input: { params: s.characterId }, output: "EntryTemplates",
  }, async (ctx, { params }) => map(await characters.listEntryTemplates(ctx, params), (templates) => ({ templates: wire(templates) })));

  route({
    method: "GET", path: "/characters/:characterId/actions/:actionId/roll-options", id: "listCharacterRollOptions",
    description: "List eligible targets and recent visible rolls for a campaign action on a character the caller controls.",
    scope: "characters:read", input: { params: actionParams, querystring: RollOptionsQuery }, output: "RollOptions",
  }, async (ctx, { params, query }) => map(await characters.rollOptions(ctx, { ...params, ...query }), wire));

  route({
    method: "POST", path: "/characters/:characterId/actions/:actionId", id: "executeCharacterAction",
    description: "Execute an entity action, or a template-granted action with entryId. Rolls are server-side. "
      + "Attached characters accept a roll audience; standalone characters accept only owner_only.",
    scope: "characters:write", input: { params: actionParams, body: executeAction }, output: "CharacterCommandResult",
    example: { inputs: {}, expectedRevision: 3, idempotencyKey: "roll-1" },
  }, async (ctx, { params, body }) => {
    const { inputs = {}, audience: requested, entryId, expectedRevision, idempotencyKey, targetCharacterId, respondsTo } = body;
    return map(await characters.apply(ctx, {
      kind: "executeAction", ...params, inputs, expectedRevision, idempotencyKey,
      ...(requested === undefined ? {} : { audience: requested }),
      ...(entryId === undefined ? {} : { entryId }),
      ...(targetCharacterId === undefined ? {} : { targetCharacterId }),
      ...(respondsTo === undefined ? {} : { respondsTo }),
    }), commandView);
  });

  route({
    method: "GET", path: "/characters/:characterId/rolls/:rollId", id: "readCharacterRoll",
    description: "Read a saved push-tracked roll the caller may see under its audience.",
    scope: "characters:read", input: { params: rollParams }, output: "Roll",
  }, async (ctx, { params }) => map(await characters.readRoll(ctx, params), (saved) => ({
    ...wire(saved) as object, rollId: params.rollId,
  })));

  route({
    method: "GET", path: "/characters/:characterId/rolls/:rollId/push-options", id: "readRollPushOptions",
    description: "Read whether a saved roll can be pushed, and which dice a push rerolls.",
    scope: "characters:read", input: { params: rollParams }, output: "PushOptions",
  }, (ctx, { params }) => characters.pushOptions(ctx, params));

  route({
    method: "POST", path: "/characters/:characterId/rolls/:rollId/push", id: "pushCharacterRoll",
    description: "Push a saved roll at the current character revision. The result carries the new roll ID.",
    scope: "characters:write", input: { params: rollParams, body: s.revisionCommandBody }, output: "CharacterCommandResult",
  }, async (ctx, { params, body }) => map(await characters.apply(ctx, {
    kind: "pushRoll", characterId: params.characterId, parentRollId: params.rollId, ...body,
  }), commandView));

  route({
    method: "GET", path: "/characters/:characterId/activity", id: "listCharacterActivity",
    description: "Read the character activity feed, newest first, filtered by roll audience.",
    scope: "characters:read", input: { params: s.characterId, querystring: activityQuery }, output: "CharacterActivity",
  }, async (ctx, { params, query }) => map(await characters.listActivity(ctx, {
    characterId: params.characterId, limit: query.limit ?? 25, cursor: query.cursor ?? null,
  }), (page) => ({
    events: page.events.map(({ id, roll: eventRoll, ...event }) => ({
      ...wire(event) as object, eventId: id, payload: event.payload ?? {},
      ...(eventRoll === undefined ? {} : { roll: { ...wire(eventRoll) as object, rollId: event.rollId } }),
    })),
    nextCursor: page.nextCursor,
  })));

  route({
    method: "POST", path: "/characters/:characterId/exports", id: "exportCharacter",
    description: "Export the current character state as a portable document.",
    scope: "characters:read", input: { params: s.characterId }, output: "CharacterExport",
  }, (ctx, { params }) => characters.exportCharacter(ctx, params));

  route({
    method: "POST", path: "/characters/:characterId/ownership-transfer", id: "transferCharacter",
    description: "Transfer an owned standalone character to another account. The caller loses access.",
    scope: "characters:write", input: { params: s.characterId, body: transfer }, output: "CharacterMutation",
  }, async (ctx, { params, body }) => map(
    await characters.manage(ctx, { kind: "transferOwnership", characterId: params.characterId, ...body }),
    ({ character }) => ({ characterId: character.characterId, revision: character.revision }),
  ));

  // GET on /portrait and /image (Part A) returns metadata; a thumbnail of
  // the current art has its own path.
  route({
    method: "GET", path: "/characters/:characterId/portrait/thumbnail", id: "downloadCurrentPortraitThumbnail",
    description: "Download a WebP thumbnail of the current portrait.",
    scope: "characters:read", input: { params: s.characterId }, output: "binary",
  }, (ctx, { params }) => characters.openPortraitImage(ctx, { ...params, thumbnail: true }));
  route({
    method: "GET", path: "/characters/:characterId/entries/:entryId/image/thumbnail", id: "downloadCurrentEntryImageThumbnail",
    description: "Download a WebP thumbnail of the displayed art for an inventory entry.",
    scope: "characters:read", input: { params: s.entryId }, output: "binary",
  }, (ctx, { params }) => characters.openEntryImageBytes(ctx, { ...params, thumbnail: true }));
  for (const thumbnail of [false, true]) {
    const suffix = thumbnail ? "/thumbnail" : "";
    const label = thumbnail ? "Thumbnail" : "";
    const what = thumbnail ? "a WebP thumbnail of " : "";
    route({
      method: "GET", path: `/characters/:characterId/portrait/:fileId${suffix}`, id: `downloadPortrait${label}`,
      description: `Download ${what}the portrait with this file ID while it is current.`,
      scope: "characters:read", input: { params: portraitBytes }, output: "binary",
    }, (ctx, { params }) => characters.openPortraitImage(ctx, { ...params, thumbnail }));
    route({
      method: "GET", path: `/characters/:characterId/entries/:entryId/image/:fileId${suffix}`, id: `downloadEntryImage${label}`,
      description: `Download ${what}inventory entry art with this file ID while it is displayed.`,
      scope: "characters:read", input: { params: entryBytes }, output: "binary",
    }, (ctx, { params }) => characters.openEntryImageBytes(ctx, { ...params, thumbnail }));
  }
}
