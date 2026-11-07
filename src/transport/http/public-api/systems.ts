import { Type } from "@sinclair/typebox";

import type { SystemAuthoring } from "../../../systems/authoring.js";
import { map, ok, type Result, type Route } from "./router.js";
import * as s from "./schemas.js";

const access = Type.Union([Type.Literal("private"), Type.Literal("link"), Type.Literal("public")]);
const lifecycleChange = s.object({
  lifecycle: Type.Optional(s.lifecycle),
  access: Type.Optional(access),
});
const deprecate = s.object({ lifecycle: Type.Literal("deprecated") });
const templateImage = s.object({ systemId: s.uuid, templateId: s.definitionId, fileId: s.uuid });
const versionImage = s.object({ versionId: s.uuid, templateId: s.definitionId, fileId: s.uuid });

export const systemSchemas = {
  SystemLifecycle: s.object({
    systemId: s.uuid,
    lifecycle: Type.Union([s.lifecycle, Type.Null()], { description: "Present when the lifecycle changed." }),
    access: Type.Union([access, Type.Null()], { description: "Present when the access changed." }),
  }),
  DeletedSystem: s.object({ systemId: s.uuid }),
  VersionList: s.object({ versions: Type.Array(s.publication) }),
};

export function registerSystemRoutes(route: Route, { authoring }: { authoring: SystemAuthoring }) {
  route({
    method: "PATCH", path: "/systems/:systemId", id: "updateSystem",
    description: "Archive or recover an owned system and optionally change its access. Send at least one field.",
    scope: "systems:write", input: { params: s.systemId, body: lifecycleChange }, output: "SystemLifecycle",
    example: { lifecycle: "archived" },
  }, async (ctx, { params, body }): Promise<Result<unknown>> => {
    if (body.lifecycle === undefined && body.access === undefined) {
      return { ok: false, error: { code: "bad_request", message: "Send lifecycle, access, or both." } };
    }
    let lifecycle: string | null = null;
    let changedAccess: string | null = null;
    if (body.lifecycle !== undefined) {
      const changed = await authoring.changeLifecycle(ctx, { kind: "system", systemId: params.systemId, lifecycle: body.lifecycle });
      if (!changed.ok) return changed;
      lifecycle = changed.value.lifecycle;
    }
    if (body.access !== undefined) {
      const changed = await authoring.changeSharing(ctx, { systemId: params.systemId, access: body.access });
      if (!changed.ok) return changed;
      changedAccess = changed.value.access;
    }
    return ok({ systemId: params.systemId, lifecycle, access: changedAccess });
  });

  route({
    method: "DELETE", path: "/systems/:systemId", id: "deleteSystem",
    description: "Delete an owned system that no character, campaign or clone references.",
    scope: "systems:write", input: { params: s.systemId }, output: "DeletedSystem",
  }, (ctx, { params }) => authoring.deleteSystem(ctx, params.systemId));

  route({
    method: "GET", path: "/systems/:systemId/versions", id: "listSystemVersions",
    description: "List the published versions of an owned system, newest first.",
    scope: "systems:read", input: { params: s.systemId }, output: "VersionList",
  }, async (ctx, { params }) => map(await authoring.listVersions(ctx, params), ({ versions }) => ({
    versions: versions.map((version) => ({ ...version, createdAt: new Date(version.createdAt).toISOString() })),
  })));

  route({
    method: "PATCH", path: "/system-versions/:versionId", id: "deprecateSystemVersion",
    description: "Deprecate an owned published version. Existing characters and campaigns stay pinned to it.",
    scope: "systems:write", input: { params: s.versionId, body: deprecate }, output: "Publication",
  }, async (ctx, { params }) => {
    const changed = await authoring.changeLifecycle(ctx, { kind: "version", versionId: params.versionId, lifecycle: "deprecated" });
    if (!changed.ok) return changed;
    const listed = await authoring.listVersions(ctx, { systemId: changed.value.systemId });
    return map(listed, ({ versions }) => {
      const version = versions.find((entry) => entry.versionId === params.versionId);
      if (version === undefined) throw new Error("Deprecated version is missing from its system.");
      return { ...version, createdAt: new Date(version.createdAt).toISOString() };
    });
  });

  for (const thumbnail of [false, true]) {
    const suffix = thumbnail ? "/thumbnail" : "";
    const label = thumbnail ? "Thumbnail" : "";
    route({
      method: "GET", path: `/systems/:systemId/templates/:templateId/image/:fileId${suffix}`,
      id: `downloadSystemDraftImage${label}`,
      description: `Download ${thumbnail ? "a WebP thumbnail of " : ""}draft template art.`,
      scope: "systems:read", input: { params: templateImage }, output: "binary",
    }, (ctx, { params }) => authoring.openItemImageBytes(ctx, {
      source: { kind: "draft", systemId: params.systemId }, templateId: params.templateId, fileId: params.fileId, thumbnail,
    }));
    route({
      method: "GET", path: `/system-versions/:versionId/templates/:templateId/image/:fileId${suffix}`,
      id: `downloadSystemVersionImage${label}`,
      description: `Download ${thumbnail ? "a WebP thumbnail of " : ""}template art from a usable published version.`,
      scope: "systems:read", input: { params: versionImage }, output: "binary",
    }, (ctx, { params }) => authoring.openItemImageBytes(ctx, {
      source: { kind: "version", versionId: params.versionId }, templateId: params.templateId, fileId: params.fileId, thumbnail,
    }));
  }
}
