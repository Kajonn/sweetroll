import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { createSystemItemImages, type SystemItemImages } from "./item-images.js";
import { ImageProcessingError, type ImageScanner } from "../platform/image-processing.js";
import { InvalidSystemImage, assertSystemImages, systemImages } from "./implementation/persistence/image-references.js";
import { exportSystemItemImages, prepareImportedItemImages } from "./item-image-bundle.js";
import { discardPreparedItemImage, ItemImageMissing, type PreparedItemImage } from "../platform/item-image-storage.js";
import { createClamScanner } from "../platform/image-scanner.js";

import {
  assessDocument,
  blankSystemDocument,
  documentChecksum,
  documentDiagnosticPointers,
  documentFromPackage,
  hashInput,
  type PackageAssessment,
} from "./implementation/authoring/assess.js";
import { decodeSystemExport } from "./implementation/package/codec.js";
import type { PackageDiagnostic } from "./implementation/package/diagnostics.js";
import type {
  SystemDocumentV1,
  SystemExportV1,
  SystemPackageV1,
} from "./implementation/package/schema/index.js";
import type {
  AuthorizedCreationVersion,
  CreationVersionsCursor,
  DraftRecord,
  SystemId,
  SystemPersistenceRepository,
  SystemRecord,
  UserId,
  VersionId,
  VersionChoice,
  VersionRecord,
} from "./implementation/persistence/index.js";
import { decodeCreationVersionsCursor } from "./implementation/persistence/index.js";
import { compileDocument } from "./implementation/rules/compile-document.js";
import { comparePackages, type CompatibilityFinding } from "./implementation/package/compatibility.js";

export type Result<T> = { ok: true; value: T } | { ok: false; error: AppError };

export type AppErrorCode =
  | "too_large"
  | "unprocessable"
  | "temporarily_unavailable"
  | "bad_request"
  | "conflict"
  | "idempotency_mismatch"
  | "internal"
  | "invalid_package"
  | "not_found";

export type AppError = {
  code: AppErrorCode;
  message: string;
  latestRevision?: number | null;
  diagnostics?: PackageDiagnostic[];
};

export type RequestContext = {
  actorId: UserId;
  requestId: string;
};

export type SystemSummary = {
  systemId: SystemId;
  name: string;
  access: string;
  lifecycle: string;
  createdAt: Date;
  updatedAt: Date;
};

export type DraftView = {
  revision: number;
  document: SystemDocumentV1;
  sourceChecksum: string;
  updatedBy: UserId;
  updatedAt: Date;
};

export type VersionSummary = {
  versionId: VersionId;
  systemId: SystemId;
  semanticVersion: string;
  checksum: string;
  releaseNotes: string;
  lifecycle: string;
  createdAt: Date;
};

export type AuthoringWorkspace = {
  system: SystemSummary;
  draft: DraftView | null;
  versions: VersionSummary[];
  assessment: PackageAssessment;
};

export type ListSystemsResult = {
  systems: SystemSummary[];
  nextCursor: SystemId | null;
};

export type ListCreationVersionsInput = {
  limit?: number;
  cursor?: string | null;
  q?: string | null;
  systemId?: string | null;
};

export type ListCreationVersionsResult = {
  versions: AuthorizedCreationVersion[];
  nextCursor: string | null;
};

export type PreviewSnapshot = {
  snapshotId: string;
  systemId: SystemId;
  sourceRevision: number;
  package: SystemPackageV1;
  expiresAt: Date;
};

export type PublishedVersion = {
  versionId: VersionId;
  systemId: SystemId;
  semanticVersion: string;
  checksum: string;
  package: SystemPackageV1;
  releaseNotes: string;
  lifecycle: string;
  createdAt: Date;
};

export type ExportedPackage = SystemExportV1;

export type ListVersionsInput = {
  systemId: SystemId;
};

export type ListVersionsResult = {
  versions: VersionSummary[];
};

export type CreateDraftSource =
  | { kind: "blank"; name: string }
  | { kind: "clone"; versionId: VersionId }
  | { kind: "import"; content: string };

export type CreateDraftInput = {
  source: CreateDraftSource;
  idempotencyKey: string;
};

export type SaveDraftInput = {
  systemId: SystemId;
  expectedRevision: number | null;
  document: unknown;
};

export type PreviewDraftInput = {
  systemId: SystemId;
};

export type PublishDraftInput = {
  systemId: SystemId;
  expectedRevision: number;
  semanticVersion: string;
  releaseNotes: string;
  idempotencyKey: string;
  acknowledgeBreaking: boolean;
};

export type LifecycleChangeInput =
  | { kind: "system"; systemId: SystemId; lifecycle: "active" | "archived" }
  | { kind: "version"; versionId: VersionId; lifecycle: "deprecated" };

export type LifecycleResult =
  | { kind: "system"; systemId: SystemId; lifecycle: string }
  | { kind: "version"; versionId: VersionId; systemId: SystemId; lifecycle: string };

export type ChangeSharingInput = {
  systemId: SystemId;
  access: "private" | "link" | "public";
};

export type SharingResult = {
  systemId: SystemId;
  access: string;
};

export interface SystemAuthoring extends SystemItemImages {
  validateDocument(document: unknown): PackageAssessment;
  createDraft(ctx: RequestContext, input: CreateDraftInput): Promise<Result<AuthoringWorkspace>>;
  open(ctx: RequestContext, systemId: SystemId): Promise<Result<AuthoringWorkspace>>;
  list(
    ctx: RequestContext,
    input: { limit: number; cursor: SystemId | null },
  ): Promise<Result<ListSystemsResult>>;
  saveDraft(ctx: RequestContext, input: SaveDraftInput): Promise<Result<AuthoringWorkspace>>;
  previewDraft(ctx: RequestContext, input: PreviewDraftInput): Promise<Result<PreviewSnapshot>>;
  publish(ctx: RequestContext, input: PublishDraftInput): Promise<Result<PublishedVersion>>;
  authorizeVersionUse(
    ctx: RequestContext,
    versionId: VersionId,
  ): Promise<Result<{ systemId: SystemId; versionId: VersionId; checksum: string }>>;
  listAuthorizedVersions(
    ctx: RequestContext,
    input: { limit?: number; cursor?: string | null; q?: string | null; systemId?: string | null },
  ): Promise<Result<ListCreationVersionsResult>>;
  /** Design 6.7: later published versions of the same system the actor may move to. */
  listUpgradeTargets(ctx: RequestContext, fromVersionId: VersionId): Promise<Result<VersionChoice[]>>;
  /** Metadata for versions a record already pins (current or revert target). */
  describeVersionChoices(versionIds: VersionId[]): Promise<Result<VersionChoice[]>>;
  exportVersion(ctx: RequestContext, versionId: VersionId): Promise<Result<ExportedPackage>>;
  listVersions(
    ctx: RequestContext,
    input: ListVersionsInput,
  ): Promise<Result<ListVersionsResult>>;
  changeLifecycle(ctx: RequestContext, input: LifecycleChangeInput): Promise<Result<LifecycleResult>>;
  changeSharing(ctx: RequestContext, input: ChangeSharingInput): Promise<Result<SharingResult>>;
  deleteSystem(ctx: RequestContext, systemId: SystemId): Promise<Result<{ systemId: SystemId }>>;
}

const SEMANTIC_VERSION_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;
const PREVIEW_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PAGE_LIMIT = 100;
const NOT_FOUND_MESSAGE = "The requested resource does not exist.";
const MISMATCH_MESSAGE = "This idempotency key was already used with different input.";

export type CreateSystemAuthoringInput = {
  pool: Pool;
  scanImage?: ImageScanner;
  repo: SystemPersistenceRepository;
};

export function createSystemAuthoringModule(input: CreateSystemAuthoringInput): SystemAuthoring {
  const repo = input.repo;
  const scanner = input.scanImage ?? createClamScanner();
  async function validateImages(systemId: string, document: SystemDocumentV1) {
    if (!document.templates?.some(template => template.image)) return;
    const client = await input.pool.connect();
    try { await assertSystemImages(client, systemId, document); } finally { client.release(); }
  }
  function imageError(cause: unknown): AppError {
    if (cause instanceof InvalidSystemImage) return errors.invalid_package([{ code: "unavailable_image", path: "/templates", message: cause.message }]);
    if (cause instanceof ImageProcessingError) return { code: cause.code, message: cause.message };
    if (cause instanceof ItemImageMissing) return { code: "unprocessable", message: "A referenced image is unavailable. Restore its private bytes before exporting." };
    return errors.internal();
  }
  const now = () => new Date();

  const errors = {
    bad_request: (message: string): AppError => ({ code: "bad_request", message }),
    not_found: (message: string = NOT_FOUND_MESSAGE): AppError => ({ code: "not_found", message }),
    conflict: (message: string, latestRevision?: number | null): AppError => ({
      code: "conflict",
      message,
      ...(latestRevision === undefined ? {} : { latestRevision }),
    }),
    mismatch: (): AppError => ({ code: "idempotency_mismatch", message: MISMATCH_MESSAGE }),
    invalid_package: (diagnostics: PackageDiagnostic[]): AppError => ({
      code: "invalid_package",
      message: "The system package is invalid.",
      diagnostics,
    }),
    internal: (): AppError => ({ code: "internal", message: "An internal error occurred." }),
  };

  // System authoring paths serve `system` rows only; extension rows (design
  // 6.8) have their own draft format and module. Lifecycle, sharing, version
  // deprecation and deletion are generic and accept both kinds.
  async function authorizeOwner(
    systemId: SystemId,
    actorId: UserId,
    kind: SystemRecord["kind"] | "any" = "system",
  ): Promise<SystemRecord | null> {
    const system = await repo.openSystem(systemId);
    if (system === null || system.ownerId !== actorId) return null;
    if (kind !== "any" && system.kind !== kind) return null;
    return system;
  }

  function summarize(system: SystemRecord): SystemSummary {
    return {
      systemId: system.systemId,
      name: system.name,
      access: system.access,
      lifecycle: system.lifecycle,
      createdAt: system.createdAt,
      updatedAt: system.updatedAt,
    };
  }

  function summarizeVersion(version: VersionRecord): VersionSummary {
    return {
      versionId: version.versionId,
      systemId: version.systemId,
      semanticVersion: version.semanticVersion,
      checksum: version.checksum,
      releaseNotes: version.releaseNotes,
      lifecycle: version.lifecycle,
      createdAt: version.createdAt,
    };
  }

  function toWorkspace(
    system: SystemRecord,
    draft: DraftRecord | null,
    versions: VersionRecord[],
    assessment: PackageAssessment,
  ): AuthoringWorkspace {
    return {
      system: summarize(system),
      draft:
        draft === null
          ? null
          : {
              revision: draft.revision,
              document: draft.document as SystemDocumentV1,
              sourceChecksum: draft.sourceChecksum,
              updatedBy: draft.updatedBy,
              updatedAt: draft.updatedAt,
            },
      versions: versions.map(summarizeVersion),
      assessment,
    };
  }

  async function receiptResult<T>(
    ctx: RequestContext,
    commandKind: string,
    key: string,
    inputHash: string,
  ): Promise<{ replayed: true; value: T } | { replayed: false } | { replayed: "mismatch" }> {
    const receipt = await repo.loadReceipt({ actorId: ctx.actorId, commandKind, key });
    if (receipt === null) return { replayed: false };
    if (receipt.inputHash !== inputHash) return { replayed: "mismatch" };
    return { replayed: true, value: receipt.result as T };
  }

  return {
    ...createSystemItemImages({ pool: input.pool, scanImage: scanner }),
    validateDocument(document) {
      const assessed = assessDocument(document);
      return {
        ok: assessed.assessment.ok,
        diagnostics: documentDiagnosticPointers(assessed.document, assessed.assessment.diagnostics),
      };
    },

    async createDraft(ctx, input) {
      let newImages: PreparedItemImage[] = [], imagesCommitted = false;
      try {
        const inputHash = hashInput(input.source);
        const receipt = await receiptResult<AuthoringWorkspace>(ctx, "system_create", input.idempotencyKey, inputHash);
        if (receipt.replayed === "mismatch") return { ok: false, error: errors.mismatch() };
        if (receipt.replayed === true) {
          const owner = await authorizeOwner(receipt.value.system.systemId, ctx.actorId);
          return owner === null ? { ok: false, error: errors.not_found() } : { ok: true, value: receipt.value };
        }

        let document: SystemDocumentV1;
        let name: string;
        let retainedImageIds: string[] = [];
        let importedImages: Awaited<ReturnType<typeof prepareImportedItemImages>> | undefined;
        if (input.source.kind === "blank") {
          document = blankSystemDocument(input.source.name);
          name = input.source.name;
        } else {
          let pkg: SystemPackageV1;
          if (input.source.kind === "clone") {
            const version = await repo.loadVersion(input.source.versionId);
            const sourceSystem =
              version === null ? null : await repo.openSystem(version.systemId);
            // Template systems (owner_id NULL) are global and clonable by anyone.
            if (
              version === null ||
              sourceSystem === null ||
              sourceSystem.kind !== "system" ||
              (sourceSystem.ownerId !== null && sourceSystem.ownerId !== ctx.actorId)
            ) {
              return { ok: false, error: errors.not_found() };
            }
            pkg = version.package as SystemPackageV1;
            await validateImages(version.systemId, documentFromPackage(pkg));
            retainedImageIds = systemImages(pkg).map(image => image.fileId);
          } else {
            const decoded = decodeSystemExport(input.source.content);
            if (!decoded.ok) return { ok: false, error: errors.invalid_package(decoded.diagnostics) };
            pkg = decoded.value.package;
            importedImages = await prepareImportedItemImages(decoded.value, scanner, ctx.actorId);
            newImages = importedImages.prepared;
          }
          document = documentFromPackage(pkg);
          if (importedImages) for (const template of document.templates ?? []) {
            if (template.image) template.image = { ...importedImages.descriptors.get(template.image.fileId)!, description: template.image.description };
          }
          name = document.metadata.name;
        }

        const assessed = assessDocument(document);
        const result = await repo.executeWithReceipt<AuthoringWorkspace, AppError>({
          actorId: ctx.actorId,
          commandKind: "system_create",
          key: input.idempotencyKey,
          inputHash,
          expiresAt: new Date(now().getTime() + RECEIPT_TTL_MS),
        }, async (transaction) => {
          const system = await transaction.createSystem({ ownerId: ctx.actorId, name });
          await transaction.appendAudit({
            systemId: system.systemId,
            actorId: ctx.actorId,
            kind: "system_created",
            summary: "System created",
            requestId: ctx.requestId,
          });
          const saved = await transaction.saveDraft({
            systemId: system.systemId,
            expectedRevision: null,
            document,
            sourceChecksum: documentChecksum(document),
            updatedBy: ctx.actorId,
            requestId: ctx.requestId,
            newImages,
            retainedImageIds,
          });
          if (!saved.ok) throw new Error("A newly created system already has a draft.");
          return { ok: true, value: toWorkspace(system, saved.draft, [], assessed.assessment) };
        });
        if (!result.ok) return "mismatch" in result ? { ok: false, error: errors.mismatch() } : result;
        if ("replayed" in result) {
          if (await authorizeOwner(result.value.system.systemId, ctx.actorId) === null) {
            return { ok: false, error: errors.not_found() };
          }
        } else {
          imagesCommitted = true;
        }
        return { ok: true, value: result.value };
      } catch (cause) {
        return { ok: false, error: imageError(cause) };
      } finally {
        if (!imagesCommitted) await Promise.all(newImages.map(discardPreparedItemImage));
      }
    },

    async open(ctx, systemId) {
      try {
        const system = await authorizeOwner(systemId, ctx.actorId);
        if (system === null) return { ok: false, error: errors.not_found() };
        const [draft, versions] = await Promise.all([
          repo.loadDraft(systemId),
          repo.listVersions(systemId),
        ]);
        const assessment =
          draft === null ? { ok: true, diagnostics: [] } : assessDocument(draft.document).assessment;
        return { ok: true, value: toWorkspace(system, draft, versions, assessment) };
      } catch (cause) {
        return { ok: false, error: imageError(cause) };
      }
    },

    async list(ctx, input) {
      try {
        const limit = Math.trunc(input.limit);
        if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
          return {
            ok: false,
            error: errors.bad_request(`limit must be an integer from 1 through ${MAX_PAGE_LIMIT}.`),
          };
        }
        const page = await repo.listSystemsPage(ctx.actorId, { limit, cursor: input.cursor });
        return {
          ok: true,
          value: {
            systems: page.systems.map(summarize),
            nextCursor: page.nextCursor,
          },
        };
      } catch (cause) {
        return { ok: false, error: imageError(cause) };
      }
    },

    async saveDraft(ctx, input) {
      try {
        const system = await authorizeOwner(input.systemId, ctx.actorId);
        if (system === null) return { ok: false, error: errors.not_found() };
        const current = await repo.loadDraft(input.systemId);
        if ((current?.revision ?? null) !== input.expectedRevision) {
          return { ok: false, error: errors.conflict("The draft was modified by another request.", current?.revision ?? null) };
        }
        const assessed = assessDocument(input.document);
        if (assessed.document === null) {
          return { ok: false, error: errors.invalid_package(assessed.assessment.diagnostics) };
        }
        const saved = await repo.saveDraft({
          systemId: input.systemId,
          expectedRevision: input.expectedRevision,
          document: assessed.document,
          sourceChecksum: documentChecksum(assessed.document),
          updatedBy: ctx.actorId,
          requestId: ctx.requestId,
        });
        if (!saved.ok) {
          return {
            ok: false,
            error: errors.conflict("The draft was modified by another request.", saved.latestRevision),
          };
        }
        const versions = await repo.listVersions(input.systemId);
        const renamedSystem = assessed.document.metadata.name.trim() === ""
          ? system
          : { ...system, name: assessed.document.metadata.name, updatedAt: saved.draft.updatedAt };
        return { ok: true, value: toWorkspace(renamedSystem, saved.draft, versions, assessed.assessment) };
      } catch (cause) {
        return { ok: false, error: imageError(cause) };
      }
    },

    async previewDraft(ctx, input) {
      try {
        const system = await authorizeOwner(input.systemId, ctx.actorId);
        if (system === null) return { ok: false, error: errors.not_found() };
        const draft = await repo.loadDraft(input.systemId);
        if (draft === null) return { ok: false, error: errors.not_found("The system has no draft to preview.") };
        await validateImages(input.systemId, draft.document as SystemDocumentV1);
        const assessed = assessDocument(draft.document);
        if (!assessed.ok || assessed.document === null) {
          return { ok: false, error: errors.invalid_package(assessed.assessment.diagnostics) };
        }
        const compiled = compileDocument(assessed.document, {
          systemId: input.systemId,
          versionId: randomUUID(),
          semanticVersion: "0.0.0",
        });
        if (!compiled.ok) return { ok: false, error: errors.invalid_package(compiled.diagnostics) };
        const snapshot = await repo.createPreviewSnapshot({
          systemId: input.systemId,
          sourceRevision: draft.revision,
          package: compiled.value,
          expiresAt: new Date(now().getTime() + PREVIEW_TTL_MS),
        });
        return {
          ok: true,
          value: {
            snapshotId: snapshot.snapshotId,
            systemId: snapshot.systemId,
            sourceRevision: snapshot.sourceRevision,
            package: compiled.value,
            expiresAt: snapshot.expiresAt,
          },
        };
      } catch (cause) {
        return { ok: false, error: imageError(cause) };
      }
    },

    async publish(ctx, input) {
      try {
        if (!SEMANTIC_VERSION_PATTERN.test(input.semanticVersion)) {
          return {
            ok: false,
            error: errors.bad_request("semanticVersion must be X.Y.Z with non-negative integers."),
          };
        }
        const system = await authorizeOwner(input.systemId, ctx.actorId);
        if (system === null) return { ok: false, error: errors.not_found() };
        if (system.lifecycle === "archived") {
          return { ok: false, error: errors.conflict("An archived system cannot publish versions.") };
        }

        const inputHash = hashInput({
          systemId: input.systemId,
          expectedRevision: input.expectedRevision,
          semanticVersion: input.semanticVersion,
          releaseNotes: input.releaseNotes,
          acknowledgeBreaking: input.acknowledgeBreaking,
        });
        const commandKind = "system_publish";
        const receipt = await receiptResult<PublishedVersion>(ctx, commandKind, input.idempotencyKey, inputHash);
        if (receipt.replayed === "mismatch") return { ok: false, error: errors.mismatch() };
        if (receipt.replayed === true) return { ok: true, value: receipt.value };

        const draft = await repo.loadDraft(input.systemId);
        if (draft === null) return { ok: false, error: errors.not_found("The system has no draft to publish.") };
        if (draft.revision !== input.expectedRevision) {
          const completed = await receiptResult<PublishedVersion>(ctx, commandKind, input.idempotencyKey, inputHash);
          if (completed.replayed === "mismatch") return { ok: false, error: errors.mismatch() };
          if (completed.replayed === true) return { ok: true, value: completed.value };
          return {
            ok: false,
            error: errors.conflict("The draft was modified by another request.", draft.revision),
          };
        }
        await validateImages(input.systemId, draft.document as SystemDocumentV1);
        const assessed = assessDocument(draft.document);
        if (!assessed.ok || assessed.document === null) {
          return { ok: false, error: errors.invalid_package(assessed.assessment.diagnostics) };
        }
        const versionId = randomUUID();
        const compiled = compileDocument(assessed.document, {
          systemId: input.systemId,
          versionId,
          semanticVersion: input.semanticVersion,
        });
        if (!compiled.ok) return { ok: false, error: errors.invalid_package(compiled.diagnostics) };

        const previousVersions = await repo.listVersions(input.systemId);
        const latest = previousVersions[0] ?? null;
        let compatibilityFindings: CompatibilityFinding[] = [];
        if (latest !== null) {
          const compatibility = comparePackages(latest.package as SystemPackageV1, compiled.value);
          compatibilityFindings = compatibility.findings;
          if (!compatibility.compatible) {
            const nextMajor = Number(input.semanticVersion.split(".")[0]);
            const latestMajor = Number(latest.semanticVersion.split(".")[0]);
            if (!input.acknowledgeBreaking || nextMajor <= latestMajor) {
              return {
                ok: false,
                error: errors.invalid_package(compatibility.findings as unknown as PackageDiagnostic[]),
              };
            }
          }
        }

        const publication = await repo.executeWithReceipt<PublishedVersion, AppError>({
          actorId: ctx.actorId,
          commandKind,
          key: input.idempotencyKey,
          inputHash,
          expiresAt: new Date(now().getTime() + RECEIPT_TTL_MS),
        }, async (transaction) => {
          const result = await transaction.publishVersion({
            systemId: input.systemId,
            versionId,
            expectedRevision: draft.revision,
            sourceChecksum: draft.sourceChecksum,
            semanticVersion: input.semanticVersion,
            checksum: compiled.value.integrity.checksum,
            package: compiled.value,
            releaseNotes: input.releaseNotes,
            compatibilityFindings,
            compatibilityBaseVersionId: latest?.versionId ?? null,
            acknowledgeBreaking: input.acknowledgeBreaking,
            actorId: ctx.actorId,
            requestId: ctx.requestId,
          });
          if (!result.ok) {
            switch (result.code) {
              case "stale_revision":
                return { ok: false, error: errors.conflict("The draft was modified by another request.", result.latestRevision) };
              case "breaking_version":
                return { ok: false, error: errors.invalid_package(result.findings) };
              case "not_found":
                return { ok: false, error: errors.not_found() };
              case "archived":
                return { ok: false, error: errors.conflict("An archived system cannot publish versions.") };
              case "duplicate_version":
                return { ok: false, error: errors.conflict("A version with this semantic version or identical content already exists for this system.") };
            }
          }
          return { ok: true, value: { ...result.version, package: compiled.value } };
        });
        if (!publication.ok) return "mismatch" in publication ? { ok: false, error: errors.mismatch() } : publication;
        return { ok: true, value: publication.value };
      } catch (cause) {
        return { ok: false, error: imageError(cause) };
      }
    },

    async authorizeVersionUse(ctx, versionId) {
      try {
        const version = await repo.authorizeVersionUse(ctx.actorId, versionId);
        if (version === null) return { ok: false, error: errors.not_found() };
        return { ok: true, value: version };
      } catch (cause) {
        return { ok: false, error: imageError(cause) };
      }
    },

    async listUpgradeTargets(ctx, fromVersionId) {
      try {
        return { ok: true, value: await repo.listLaterAuthorizedVersions(ctx.actorId, fromVersionId) };
      } catch (cause) {
        return { ok: false, error: imageError(cause) };
      }
    },

    async describeVersionChoices(versionIds) {
      try {
        return { ok: true, value: await repo.describeVersionChoices(versionIds) };
      } catch (cause) {
        return { ok: false, error: imageError(cause) };
      }
    },

    async listAuthorizedVersions(ctx, input) {
      try {
        const limit = input.limit === undefined ? 20 : Math.trunc(input.limit);
        if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
          return {
            ok: false,
            error: errors.bad_request(`limit must be an integer from 1 through ${MAX_PAGE_LIMIT}.`),
          };
        }
        const rawCursor = input.cursor ?? null;
        const cursor: CreationVersionsCursor | null =
          rawCursor === null ? null : decodeCreationVersionsCursor(rawCursor);
        if (rawCursor !== null && cursor === null) {
          return { ok: false, error: errors.bad_request("cursor is malformed.") };
        }
        const page = await repo.listAuthorizedVersions(ctx.actorId, {
          limit,
          cursor,
          q: input.q ?? null,
          systemId: input.systemId ?? null,
        });
        return { ok: true, value: { versions: page.versions, nextCursor: page.nextCursor } };
      } catch (cause) {
        return { ok: false, error: imageError(cause) };
      }
    },

    async exportVersion(ctx, versionId) {
      try {
        const version = await repo.loadVersion(versionId);
        if (version === null) return { ok: false, error: errors.not_found() };
        const system = await repo.openSystem(version.systemId);
        if (system === null || system.ownerId !== ctx.actorId || system.kind !== "system") return { ok: false, error: errors.not_found() };
        const exported: ExportedPackage = {
          schemaVersion: "1.0",
          mediaType: "application/vnd.sweetroll.system+json;version=1",
          exportedAt: new Date().toISOString(),
          package: version.package as SystemPackageV1,
        };
        const images = await exportSystemItemImages(input.pool, version.systemId, exported.package);
        if (images.length) exported.images = images;
        const stillOwned = await repo.openSystem(version.systemId);
        if (stillOwned?.ownerId !== ctx.actorId) return { ok: false, error: errors.not_found() };
        if (Buffer.byteLength(JSON.stringify(exported), "utf8") > 16 * 1024 * 1024) return { ok: false, error: { code: "too_large", message: "System export exceeds the 16 MiB envelope limit." } };
        return { ok: true, value: exported };
      } catch (cause) {
        return { ok: false, error: imageError(cause) };
      }
    },

    async listVersions(ctx, input) {
      try {
        const system = await authorizeOwner(input.systemId, ctx.actorId);
        if (system === null) return { ok: false, error: errors.not_found() };
        const versions = await repo.listVersions(input.systemId);
        return { ok: true, value: { versions: versions.map(summarizeVersion) } };
      } catch (cause) {
        return { ok: false, error: imageError(cause) };
      }
    },

    async changeLifecycle(ctx, input) {
      try {
        if (input.kind === "system") {
          const system = await authorizeOwner(input.systemId, ctx.actorId, "any");
          if (system === null) return { ok: false, error: errors.not_found() };
          const updated = await repo.updateSystemLifecycle(input.systemId, input.lifecycle);
          if (updated === null) return { ok: false, error: errors.not_found() };
          await repo.appendAudit({
            systemId: updated.systemId,
            actorId: ctx.actorId,
            kind: input.lifecycle === "archived" ? "system_archived" : "system_restored",
            summary: input.lifecycle === "archived" ? "System archived" : "System restored",
            requestId: ctx.requestId,
          });
          return {
            ok: true,
            value: { kind: "system" as const, systemId: updated.systemId, lifecycle: updated.lifecycle },
          };
        }
        const version = await repo.loadVersion(input.versionId);
        if (version === null) return { ok: false, error: errors.not_found() };
        const system = await repo.openSystem(version.systemId);
        if (system === null || system.ownerId !== ctx.actorId) return { ok: false, error: errors.not_found() };
        const updated = await repo.updateVersionLifecycle(input.versionId, input.lifecycle);
        if (updated === null) return { ok: false, error: errors.not_found() };
        await repo.appendAudit({
          systemId: updated.systemId,
          actorId: ctx.actorId,
          kind: "version_deprecated",
          summary: `Version ${updated.semanticVersion} deprecated`,
          requestId: ctx.requestId,
        });
        return {
          ok: true,
          value: {
            kind: "version" as const,
            versionId: updated.versionId,
            systemId: updated.systemId,
            lifecycle: updated.lifecycle,
          },
        };
      } catch (cause) {
        return { ok: false, error: imageError(cause) };
      }
    },

    async changeSharing(ctx, input) {
      try {
        if (input.access !== "private" && input.access !== "link" && input.access !== "public") {
          return { ok: false, error: errors.bad_request("access must be private, link, or public.") };
        }
        const updated = await repo.updateSystemAccess({ ...input, actorId: ctx.actorId, requestId: ctx.requestId });
        if (updated === null) return { ok: false, error: errors.not_found() };
        return {
          ok: true,
          value: { systemId: updated.systemId, access: updated.access },
        };
      } catch (cause) {
        return { ok: false, error: imageError(cause) };
      }
    },

    async deleteSystem(ctx, systemId) {
      try {
        const deleted = await repo.deleteOwnedSystem(systemId, ctx.actorId);
        if (!deleted.ok) {
          if (deleted.code === "referenced") {
            return {
              ok: false,
              error: errors.conflict("The system is referenced and cannot be deleted."),
            };
          }
          return { ok: false, error: errors.not_found() };
        }
        return { ok: true, value: { systemId } };
      } catch (cause) {
        return { ok: false, error: imageError(cause) };
      }
    },
  };
}
