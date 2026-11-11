import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

import type { AppError, RequestContext, Result } from "./authoring.js";
import { hashInput } from "./implementation/authoring/assess.js";
import { compareExtensionPackages, type CompatibilityFinding } from "./implementation/package/compatibility.js";
import type { PackageDiagnostic } from "./implementation/package/diagnostics.js";
import { decodeExtensionDocument } from "./implementation/package/extension.js";
import type {
  ExtensionDocumentV1,
  ExtensionPackageV1,
  SystemDocumentV1,
  SystemPackageV1,
} from "./implementation/package/schema/index.js";
import type {
  AuthorizedExtensionUse,
  DraftRecord,
  SystemId,
  SystemPersistenceRepository,
  SystemRecord,
  UserId,
  VersionId,
  VersionRecord,
} from "./implementation/persistence/index.js";
import { assertSystemImages, InvalidSystemImage } from "./implementation/persistence/image-references.js";
import { compileExtensionDocument } from "./implementation/rules/compile-extension.js";

// System extensions, stage E2 (design 6.8; plan 2026-11-07-system-extensions).
// An extension is a `systems` row of kind `extension` with its own draft
// format (`ExtensionDocumentV1`) and published, immutable extension packages
// in `system_versions`. Sharing, archive/restore, version deprecation,
// deletion and template art reuse the system routes and tables unchanged.

export type ExtensionSummary = {
  extensionId: SystemId;
  baseSystemId: SystemId;
  name: string;
  access: string;
  lifecycle: string;
  owned: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type ExtensionVersionSummary = {
  versionId: VersionId;
  extensionId: SystemId;
  semanticVersion: string;
  checksum: string;
  releaseNotes: string;
  lifecycle: string;
  builtAgainstVersionId: VersionId;
  createdAt: Date;
};

export type ExtensionDraftView = {
  revision: number;
  document: ExtensionDocumentV1;
  baseVersionId: VersionId;
  sourceChecksum: string;
  updatedBy: UserId;
  updatedAt: Date;
};

export type ExtensionAssessment = {
  ok: boolean;
  diagnostics: PackageDiagnostic[];
  /** Non-blocking findings, e.g. a template kind no base sheet slot accepts. */
  warnings: PackageDiagnostic[];
};

export type ExtensionWorkspace = {
  extension: ExtensionSummary;
  draft: ExtensionDraftView | null;
  versions: ExtensionVersionSummary[];
  assessment: ExtensionAssessment;
};

export type ExtensionListItem = ExtensionSummary & {
  latestVersion: ExtensionVersionSummary | null;
};

export type ExtensionPreview = {
  baseVersionId: VersionId;
  package: ExtensionPackageV1;
  warnings: PackageDiagnostic[];
};

export type PublishedExtensionVersion = ExtensionVersionSummary & {
  package: ExtensionPackageV1;
};

export type CreateExtensionInput = {
  systemId: SystemId;
  baseVersionId: VersionId;
  name: string;
  idempotencyKey: string;
};

export type SaveExtensionDraftInput = {
  extensionId: SystemId;
  expectedRevision: number;
  document: unknown;
  /** Omit to keep the current base version. */
  baseVersionId?: VersionId;
};

export type PublishExtensionInput = {
  extensionId: SystemId;
  expectedRevision: number;
  semanticVersion: string;
  releaseNotes: string;
  idempotencyKey: string;
  acknowledgeBreaking: boolean;
};

export interface ExtensionAuthoring {
  createExtension(ctx: RequestContext, input: CreateExtensionInput): Promise<Result<ExtensionWorkspace>>;
  open(ctx: RequestContext, extensionId: SystemId): Promise<Result<ExtensionWorkspace>>;
  list(
    ctx: RequestContext,
    input: { systemId: SystemId; limit: number; cursor: SystemId | null },
  ): Promise<Result<{ extensions: ExtensionListItem[]; nextCursor: SystemId | null }>>;
  saveDraft(ctx: RequestContext, input: SaveExtensionDraftInput): Promise<Result<ExtensionWorkspace>>;
  preview(ctx: RequestContext, extensionId: SystemId): Promise<Result<ExtensionPreview>>;
  publish(ctx: RequestContext, input: PublishExtensionInput): Promise<Result<PublishedExtensionVersion>>;
  /** A published version of an active extension the actor may use (owner, public or link). */
  authorizeExtensionUse(ctx: RequestContext, versionId: VersionId): Promise<Result<AuthorizedExtensionUse>>;
}

export type CreateExtensionAuthoringInput = {
  pool: Pool;
  repo: SystemPersistenceRepository;
};

const SEMANTIC_VERSION_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PAGE_LIMIT = 100;
const NAME_MAX_LENGTH = 120;

const errors = {
  badRequest: (message: string): AppError => ({ code: "bad_request", message }),
  notFound: (message = "The requested resource does not exist."): AppError => ({ code: "not_found", message }),
  conflict: (message: string, latestRevision?: number | null): AppError => ({
    code: "conflict",
    message,
    ...(latestRevision === undefined ? {} : { latestRevision }),
  }),
  mismatch: (): AppError => ({
    code: "idempotency_mismatch",
    message: "This idempotency key was already used with different input.",
  }),
  invalid: (diagnostics: PackageDiagnostic[]): AppError => ({
    code: "invalid_package",
    message: "The extension package is invalid.",
    diagnostics,
  }),
  internal: (): AppError => ({ code: "internal", message: "An internal error occurred." }),
};

export function blankExtensionDocument(name: string, language: string): ExtensionDocumentV1 {
  return {
    schemaVersion: "2.0",
    metadata: { name, description: "", language },
    expressions: [],
    templates: [],
  };
}

export function createExtensionAuthoringModule(input: CreateExtensionAuthoringInput): ExtensionAuthoring {
  const { repo, pool } = input;
  const now = () => new Date();

  async function ownedExtension(extensionId: SystemId, actorId: UserId): Promise<SystemRecord | null> {
    const extension = await repo.openSystem(extensionId);
    if (extension === null || extension.kind !== "extension" || extension.ownerId !== actorId) return null;
    return extension;
  }

  /** A published base version of `systemId` the actor may build against. */
  async function usableBase(actorId: UserId, systemId: SystemId, versionId: VersionId): Promise<SystemPackageV1 | null> {
    const use = await repo.authorizeVersionUse(actorId, versionId);
    if (use === null || use.systemId !== systemId) return null;
    const version = await repo.loadVersion(versionId);
    return version === null ? null : version.package as SystemPackageV1;
  }

  async function assess(document: unknown, baseVersionId: VersionId | null): Promise<ExtensionAssessment> {
    const decoded = decodeExtensionDocument(document);
    if (!decoded.ok) return { ok: false, diagnostics: decoded.diagnostics, warnings: [] };
    const base = baseVersionId === null ? null : await repo.loadVersion(baseVersionId);
    if (base === null) {
      return { ok: false, diagnostics: [{ code: "missing_reference", path: "/baseVersionId", message: "Choose a base system version." }], warnings: [] };
    }
    const compiled = compileExtensionDocument(decoded.value, base.package as SystemPackageV1, {
      extensionId: "00000000-0000-4000-8000-000000000000",
      versionId: "00000000-0000-4000-8000-000000000001",
      semanticVersion: "0.0.0",
    });
    return compiled.ok
      ? { ok: true, diagnostics: [], warnings: compiled.value.warnings }
      : { ok: false, diagnostics: compiled.diagnostics, warnings: [] };
  }

  async function workspace(extension: SystemRecord, actorId: UserId, draft?: DraftRecord | null): Promise<ExtensionWorkspace> {
    const [currentDraft, versions] = await Promise.all([
      draft === undefined ? repo.loadDraft(extension.systemId) : Promise.resolve(draft),
      repo.listVersions(extension.systemId),
    ]);
    const assessment = currentDraft === null
      ? { ok: true, diagnostics: [], warnings: [] }
      : await assess(currentDraft.document, currentDraft.baseVersionId);
    return {
      extension: summarize(extension, actorId),
      draft: currentDraft === null ? null : draftView(currentDraft),
      versions: versions.map(summarizeVersion),
      assessment,
    };
  }

  async function validateImages(extensionId: SystemId, document: ExtensionDocumentV1): Promise<void> {
    if (!document.templates.some((template) => template.image)) return;
    const client = await pool.connect();
    try {
      await assertSystemImages(client, extensionId, document as unknown as SystemDocumentV1);
    } finally {
      client.release();
    }
  }

  async function receipt<T>(ctx: RequestContext, commandKind: string, key: string, inputHash: string) {
    const stored = await repo.loadReceipt({ actorId: ctx.actorId, commandKind, key });
    if (stored === null) return { replayed: false as const };
    if (stored.inputHash !== inputHash) return { replayed: "mismatch" as const };
    return { replayed: true as const, value: stored.result as T };
  }

  function failure(cause: unknown): { ok: false; error: AppError } {
    if (cause instanceof InvalidSystemImage) {
      return { ok: false, error: errors.invalid([{ code: "unavailable_image", path: "/templates", message: cause.message }]) };
    }
    return { ok: false, error: errors.internal() };
  }

  return {
    async createExtension(ctx, input) {
      try {
        const name = input.name.trim();
        if (name === "" || name.length > NAME_MAX_LENGTH) {
          return { ok: false, error: errors.badRequest(`name must be 1 to ${NAME_MAX_LENGTH} characters.`) };
        }
        const inputHash = hashInput({ systemId: input.systemId, baseVersionId: input.baseVersionId, name });
        const commandKind = "extension_create";
        const replay = await receipt<ExtensionWorkspace>(ctx, commandKind, input.idempotencyKey, inputHash);
        if (replay.replayed === "mismatch") return { ok: false, error: errors.mismatch() };
        if (replay.replayed === true) return reopen(ctx, replay.value.extension.extensionId);

        const base = await usableBase(ctx.actorId, input.systemId, input.baseVersionId);
        if (base === null) return { ok: false, error: errors.notFound() };
        const document = blankExtensionDocument(name, base.language);
        const created = await repo.executeWithReceipt<ExtensionWorkspace, AppError>({
          actorId: ctx.actorId,
          commandKind,
          key: input.idempotencyKey,
          inputHash,
          expiresAt: new Date(now().getTime() + RECEIPT_TTL_MS),
        }, async (transaction) => {
          const extension = await transaction.createSystem({ ownerId: ctx.actorId, name, baseSystemId: input.systemId });
          await transaction.appendAudit({
            systemId: extension.systemId,
            actorId: ctx.actorId,
            kind: "extension_created",
            summary: "Extension created",
            requestId: ctx.requestId,
          });
          const saved = await transaction.saveDraft({
            systemId: extension.systemId,
            expectedRevision: null,
            document,
            sourceChecksum: hashInput(document),
            updatedBy: ctx.actorId,
            requestId: ctx.requestId,
            baseVersionId: input.baseVersionId,
          });
          if (!saved.ok) throw new Error("A newly created extension already has a draft.");
          return {
            ok: true,
            value: {
              extension: summarize(extension, ctx.actorId),
              draft: draftView(saved.draft),
              versions: [],
              assessment: { ok: true, diagnostics: [], warnings: [] },
            },
          };
        });
        if (!created.ok) return "mismatch" in created ? { ok: false, error: errors.mismatch() } : created;
        if ("replayed" in created) return reopen(ctx, created.value.extension.extensionId);
        return { ok: true, value: created.value };
      } catch (cause) {
        return failure(cause);
      }
    },

    async open(ctx, extensionId) {
      return reopen(ctx, extensionId);
    },

    async list(ctx, input) {
      try {
        const limit = Math.trunc(input.limit);
        if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
          return { ok: false, error: errors.badRequest(`limit must be an integer from 1 through ${MAX_PAGE_LIMIT}.`) };
        }
        const system = await repo.openSystem(input.systemId);
        if (
          system === null ||
          system.kind !== "system" ||
          (system.ownerId !== null && system.ownerId !== ctx.actorId && system.access === "private")
        ) {
          return { ok: false, error: errors.notFound() };
        }
        const page = await repo.listExtensionsPage(ctx.actorId, input.systemId, { limit, cursor: input.cursor });
        const extensions = await Promise.all(page.extensions.map(async (extension) => {
          const latest = (await repo.listPublishedVersions(extension.systemId))[0];
          return { ...summarize(extension, ctx.actorId), latestVersion: latest === undefined ? null : summarizeVersion(latest) };
        }));
        return { ok: true, value: { extensions, nextCursor: page.nextCursor } };
      } catch (cause) {
        return failure(cause);
      }
    },

    async saveDraft(ctx, input) {
      try {
        const extension = await ownedExtension(input.extensionId, ctx.actorId);
        if (extension === null) return { ok: false, error: errors.notFound() };
        const current = await repo.loadDraft(input.extensionId);
        if (current === null || current.revision !== input.expectedRevision) {
          return { ok: false, error: errors.conflict("The draft was modified by another request.", current?.revision ?? null) };
        }
        if (input.baseVersionId !== undefined && input.baseVersionId !== current.baseVersionId) {
          const base = await usableBase(ctx.actorId, extension.baseSystemId!, input.baseVersionId);
          if (base === null) return { ok: false, error: errors.badRequest("baseVersionId is not a usable version of this system.") };
        }
        const decoded = decodeExtensionDocument(input.document);
        if (!decoded.ok && decoded.diagnostics.some((diagnostic) => diagnostic.code === "invalid_schema" || diagnostic.code === "invalid_json")) {
          return { ok: false, error: errors.invalid(decoded.diagnostics) };
        }
        const document = input.document as ExtensionDocumentV1;
        const saved = await repo.saveDraft({
          systemId: input.extensionId,
          expectedRevision: input.expectedRevision,
          document,
          sourceChecksum: hashInput(document),
          updatedBy: ctx.actorId,
          requestId: ctx.requestId,
          ...(input.baseVersionId === undefined ? {} : { baseVersionId: input.baseVersionId }),
        });
        if (!saved.ok) {
          return { ok: false, error: errors.conflict("The draft was modified by another request.", saved.latestRevision) };
        }
        const renamed = document.metadata.name.trim() === ""
          ? extension
          : { ...extension, name: document.metadata.name, updatedAt: saved.draft.updatedAt };
        return { ok: true, value: await workspace(renamed, ctx.actorId, saved.draft) };
      } catch (cause) {
        return failure(cause);
      }
    },

    async preview(ctx, extensionId) {
      try {
        const extension = await ownedExtension(extensionId, ctx.actorId);
        if (extension === null) return { ok: false, error: errors.notFound() };
        const draft = await repo.loadDraft(extensionId);
        if (draft === null || draft.baseVersionId === null) return { ok: false, error: errors.notFound("The extension has no draft to preview.") };
        const compiled = await compileDraft(ctx, extension, draft, randomUUID(), "0.0.0");
        if (!compiled.ok) return compiled;
        return { ok: true, value: { baseVersionId: draft.baseVersionId, package: compiled.value.package, warnings: compiled.value.warnings } };
      } catch (cause) {
        return failure(cause);
      }
    },

    async publish(ctx, input) {
      try {
        if (!SEMANTIC_VERSION_PATTERN.test(input.semanticVersion)) {
          return { ok: false, error: errors.badRequest("semanticVersion must be X.Y.Z with non-negative integers.") };
        }
        const extension = await ownedExtension(input.extensionId, ctx.actorId);
        if (extension === null) return { ok: false, error: errors.notFound() };
        if (extension.lifecycle === "archived") {
          return { ok: false, error: errors.conflict("An archived extension cannot publish versions.") };
        }
        const inputHash = hashInput({
          extensionId: input.extensionId,
          expectedRevision: input.expectedRevision,
          semanticVersion: input.semanticVersion,
          releaseNotes: input.releaseNotes,
          acknowledgeBreaking: input.acknowledgeBreaking,
        });
        const commandKind = "extension_publish";
        const replay = await receipt<PublishedExtensionVersion>(ctx, commandKind, input.idempotencyKey, inputHash);
        if (replay.replayed === "mismatch") return { ok: false, error: errors.mismatch() };
        if (replay.replayed === true) return { ok: true, value: replay.value };

        const draft = await repo.loadDraft(input.extensionId);
        if (draft === null || draft.baseVersionId === null) {
          return { ok: false, error: errors.notFound("The extension has no draft to publish.") };
        }
        if (draft.revision !== input.expectedRevision) {
          return { ok: false, error: errors.conflict("The draft was modified by another request.", draft.revision) };
        }
        const versionId = randomUUID();
        const compiled = await compileDraft(ctx, extension, draft, versionId, input.semanticVersion);
        if (!compiled.ok) return compiled;
        const pkg = compiled.value.package;

        const latest = (await repo.listVersions(input.extensionId))[0] ?? null;
        let findings: CompatibilityFinding[] = [];
        if (latest !== null) {
          const report = compareExtensionPackages(latest.package as ExtensionPackageV1, pkg);
          findings = report.findings;
          if (!report.compatible) {
            const nextMajor = Number(input.semanticVersion.split(".")[0]);
            const latestMajor = Number(latest.semanticVersion.split(".")[0]);
            if (!input.acknowledgeBreaking || nextMajor <= latestMajor) {
              return { ok: false, error: errors.invalid(findings as unknown as PackageDiagnostic[]) };
            }
          }
        }

        const publication = await repo.executeWithReceipt<PublishedExtensionVersion, AppError>({
          actorId: ctx.actorId,
          commandKind,
          key: input.idempotencyKey,
          inputHash,
          expiresAt: new Date(now().getTime() + RECEIPT_TTL_MS),
        }, async (transaction) => {
          const result = await transaction.publishVersion({
            systemId: input.extensionId,
            versionId,
            expectedRevision: draft.revision,
            sourceChecksum: draft.sourceChecksum,
            semanticVersion: input.semanticVersion,
            checksum: pkg.integrity.checksum,
            package: pkg,
            releaseNotes: input.releaseNotes,
            compatibilityFindings: findings,
            compatibilityBaseVersionId: latest?.versionId ?? null,
            builtAgainstVersionId: draft.baseVersionId,
            acknowledgeBreaking: input.acknowledgeBreaking,
            actorId: ctx.actorId,
            requestId: ctx.requestId,
          });
          if (!result.ok) {
            switch (result.code) {
              case "stale_revision":
                return { ok: false, error: errors.conflict("The draft was modified by another request.", result.latestRevision) };
              case "breaking_version":
                return { ok: false, error: errors.invalid(result.findings as unknown as PackageDiagnostic[]) };
              case "not_found":
                return { ok: false, error: errors.notFound() };
              case "archived":
                return { ok: false, error: errors.conflict("An archived extension cannot publish versions.") };
              case "duplicate_version":
                return { ok: false, error: errors.conflict("A version with this semantic version or identical content already exists for this extension.") };
            }
          }
          return { ok: true, value: { ...summarizeVersion(result.version), package: pkg } };
        });
        if (!publication.ok) return "mismatch" in publication ? { ok: false, error: errors.mismatch() } : publication;
        return { ok: true, value: publication.value };
      } catch (cause) {
        return failure(cause);
      }
    },

    async authorizeExtensionUse(ctx, versionId) {
      try {
        const use = await repo.authorizeExtensionUse(ctx.actorId, versionId);
        return use === null ? { ok: false, error: errors.notFound() } : { ok: true, value: use };
      } catch (cause) {
        return failure(cause);
      }
    },
  };

  async function reopen(ctx: RequestContext, extensionId: SystemId): Promise<Result<ExtensionWorkspace>> {
    try {
      const extension = await ownedExtension(extensionId, ctx.actorId);
      if (extension === null) return { ok: false, error: errors.notFound() };
      return { ok: true, value: await workspace(extension, ctx.actorId) };
    } catch (cause) {
      return failure(cause);
    }
  }

  async function compileDraft(
    ctx: RequestContext,
    extension: SystemRecord,
    draft: DraftRecord,
    versionId: VersionId,
    semanticVersion: string,
  ): Promise<Result<{ package: ExtensionPackageV1; warnings: PackageDiagnostic[] }>> {
    const base = await usableBase(ctx.actorId, extension.baseSystemId!, draft.baseVersionId!);
    if (base === null) {
      return { ok: false, error: errors.conflict("The base system version is no longer available. Choose another base version.") };
    }
    const decoded = decodeExtensionDocument(draft.document);
    if (!decoded.ok) return { ok: false, error: errors.invalid(decoded.diagnostics) };
    await validateImages(extension.systemId, decoded.value);
    const compiled = compileExtensionDocument(decoded.value, base, {
      extensionId: extension.systemId,
      versionId,
      semanticVersion,
    });
    if (!compiled.ok) return { ok: false, error: errors.invalid(compiled.diagnostics) };
    return { ok: true, value: compiled.value };
  }
}

function summarize(extension: SystemRecord, actorId: UserId): ExtensionSummary {
  return {
    extensionId: extension.systemId,
    baseSystemId: extension.baseSystemId!,
    name: extension.name,
    access: extension.access,
    lifecycle: extension.lifecycle,
    owned: extension.ownerId === actorId,
    createdAt: extension.createdAt,
    updatedAt: extension.updatedAt,
  };
}

function summarizeVersion(version: VersionRecord): ExtensionVersionSummary {
  return {
    versionId: version.versionId,
    extensionId: version.systemId,
    semanticVersion: version.semanticVersion,
    checksum: version.checksum,
    releaseNotes: version.releaseNotes,
    lifecycle: version.lifecycle,
    builtAgainstVersionId: version.builtAgainstVersionId!,
    createdAt: version.createdAt,
  };
}

function draftView(draft: DraftRecord): ExtensionDraftView {
  return {
    revision: draft.revision,
    document: draft.document as ExtensionDocumentV1,
    baseVersionId: draft.baseVersionId!,
    sourceChecksum: draft.sourceChecksum,
    updatedBy: draft.updatedBy,
    updatedAt: draft.updatedAt,
  };
}
