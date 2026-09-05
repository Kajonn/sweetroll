import { randomUUID } from "node:crypto";

import {
  assessDocument,
  blankSystemDocument,
  documentChecksum,
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
  DraftRecord,
  SystemId,
  SystemPersistenceRepository,
  SystemRecord,
  UserId,
  VersionId,
  VersionRecord,
} from "./implementation/persistence/index.js";
import { compileDocument } from "./implementation/rules/compile-document.js";
import { comparePackages } from "./implementation/package/compatibility.js";

export type Result<T> = { ok: true; value: T } | { ok: false; error: AppError };

export type AppErrorCode =
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
};

export type LifecycleChangeInput =
  | { kind: "system"; systemId: SystemId; lifecycle: "active" | "archived" }
  | { kind: "version"; versionId: VersionId; lifecycle: "deprecated" };

export type LifecycleResult =
  | { kind: "system"; systemId: SystemId; lifecycle: string }
  | { kind: "version"; versionId: VersionId; systemId: SystemId; lifecycle: string };

export interface SystemAuthoring {
  createDraft(ctx: RequestContext, input: CreateDraftInput): Promise<Result<AuthoringWorkspace>>;
  open(ctx: RequestContext, systemId: SystemId): Promise<Result<AuthoringWorkspace>>;
  list(
    ctx: RequestContext,
    input: { limit: number; cursor: SystemId | null },
  ): Promise<Result<ListSystemsResult>>;
  saveDraft(ctx: RequestContext, input: SaveDraftInput): Promise<Result<AuthoringWorkspace>>;
  previewDraft(ctx: RequestContext, input: PreviewDraftInput): Promise<Result<PreviewSnapshot>>;
  publish(ctx: RequestContext, input: PublishDraftInput): Promise<Result<PublishedVersion>>;
  exportVersion(ctx: RequestContext, versionId: VersionId): Promise<Result<ExportedPackage>>;
  listVersions(
    ctx: RequestContext,
    input: ListVersionsInput,
  ): Promise<Result<ListVersionsResult>>;
  changeLifecycle(ctx: RequestContext, input: LifecycleChangeInput): Promise<Result<LifecycleResult>>;
  deleteSystem(ctx: RequestContext, systemId: SystemId): Promise<Result<{ systemId: SystemId }>>;
}

const SEMANTIC_VERSION_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;
const PREVIEW_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PAGE_LIMIT = 100;
const NOT_FOUND_MESSAGE = "The requested resource does not exist.";
const MISMATCH_MESSAGE = "This idempotency key was already used with different input.";

export type CreateSystemAuthoringInput = {
  repo: SystemPersistenceRepository;
};

export function createSystemAuthoringModule(input: CreateSystemAuthoringInput): SystemAuthoring {
  const repo = input.repo;
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

  async function authorizeOwner(systemId: SystemId, actorId: UserId): Promise<SystemRecord | null> {
    const system = await repo.openSystem(systemId);
    if (system === null || system.ownerId !== actorId) return null;
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
    async createDraft(ctx, input) {
      try {
        const inputHash = hashInput(input.source);
        const receipt = await receiptResult<AuthoringWorkspace>(ctx, "system_create", input.idempotencyKey, inputHash);
        if (receipt.replayed === "mismatch") return { ok: false, error: errors.mismatch() };
        if (receipt.replayed === true) return { ok: true, value: receipt.value };

        let document: SystemDocumentV1;
        let name: string;
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
              (sourceSystem.ownerId !== null && sourceSystem.ownerId !== ctx.actorId)
            ) {
              return { ok: false, error: errors.not_found() };
            }
            pkg = version.package as SystemPackageV1;
          } else {
            const decoded = decodeSystemExport(input.source.content);
            if (!decoded.ok) return { ok: false, error: errors.invalid_package(decoded.diagnostics) };
            pkg = decoded.value.package;
          }
          document = documentFromPackage(pkg);
          name = document.metadata.name;
        }

        const system = await repo.createSystem({ ownerId: ctx.actorId, name });
        await repo.appendAudit({
          systemId: system.systemId,
          actorId: ctx.actorId,
          kind: "system_created",
          summary: "System created",
          requestId: ctx.requestId,
        });
        const saved = await repo.saveDraft({
          systemId: system.systemId,
          expectedRevision: null,
          document,
          sourceChecksum: documentChecksum(document),
          updatedBy: ctx.actorId,
          requestId: ctx.requestId,
        });
        if (!saved.ok) return { ok: false, error: errors.internal() };
        const versions = await repo.listVersions(system.systemId);
        const assessed = assessDocument(document);
        const workspace = toWorkspace(system, saved.draft, versions, assessed.assessment);
        await repo.recordReceipt({
          actorId: ctx.actorId,
          commandKind: "system_create",
          key: input.idempotencyKey,
          inputHash,
          result: workspace,
          expiresAt: new Date(now().getTime() + RECEIPT_TTL_MS),
        });
        return { ok: true, value: workspace };
      } catch {
        return { ok: false, error: errors.internal() };
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
      } catch {
        return { ok: false, error: errors.internal() };
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
      } catch {
        return { ok: false, error: errors.internal() };
      }
    },

    async saveDraft(ctx, input) {
      try {
        const system = await authorizeOwner(input.systemId, ctx.actorId);
        if (system === null) return { ok: false, error: errors.not_found() };
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
        return { ok: true, value: toWorkspace(system, saved.draft, versions, assessed.assessment) };
      } catch {
        return { ok: false, error: errors.internal() };
      }
    },

    async previewDraft(ctx, input) {
      try {
        const system = await authorizeOwner(input.systemId, ctx.actorId);
        if (system === null) return { ok: false, error: errors.not_found() };
        const draft = await repo.loadDraft(input.systemId);
        if (draft === null) return { ok: false, error: errors.not_found("The system has no draft to preview.") };
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
      } catch {
        return { ok: false, error: errors.internal() };
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
          expectedRevision: input.expectedRevision,
          semanticVersion: input.semanticVersion,
          releaseNotes: input.releaseNotes,
        });
        const receipt = await receiptResult<PublishedVersion>(ctx, "system_publish", input.idempotencyKey, inputHash);
        if (receipt.replayed === "mismatch") return { ok: false, error: errors.mismatch() };
        if (receipt.replayed === true) return { ok: true, value: receipt.value };

        const draft = await repo.loadDraft(input.systemId);
        if (draft === null) return { ok: false, error: errors.not_found("The system has no draft to publish.") };
        if (draft.revision !== input.expectedRevision) {
          return {
            ok: false,
            error: errors.conflict("The draft was modified by another request.", draft.revision),
          };
        }
        const assessed = assessDocument(draft.document);
        if (!assessed.ok || assessed.document === null) {
          return { ok: false, error: errors.invalid_package(assessed.assessment.diagnostics) };
        }
        const compiled = compileDocument(assessed.document, {
          systemId: input.systemId,
          versionId: randomUUID(),
          semanticVersion: input.semanticVersion,
        });
        if (!compiled.ok) return { ok: false, error: errors.invalid_package(compiled.diagnostics) };

        const previousVersions = await repo.listVersions(input.systemId);
        const latest = previousVersions[0] ?? null;
        if (latest !== null) {
          const compatibility = comparePackages(latest.package as SystemPackageV1, compiled.value);
          if (!compatibility.compatible) {
            return {
              ok: false,
              error: errors.invalid_package(compatibility.findings as unknown as PackageDiagnostic[]),
            };
          }
        }

        const result = await repo.publishVersion({
          systemId: input.systemId,
          expectedRevision: draft.revision,
          sourceChecksum: draft.sourceChecksum,
          semanticVersion: input.semanticVersion,
          checksum: compiled.value.integrity.checksum,
          package: compiled.value,
          releaseNotes: input.releaseNotes,
          actorId: ctx.actorId,
          requestId: ctx.requestId,
        });
        if (!result.ok) {
          if (result.code === "stale_revision") {
            return {
              ok: false,
              error: errors.conflict("The draft was modified by another request.", result.latestRevision),
            };
          }
          return {
            ok: false,
            error: errors.conflict(
              "A version with this semantic version or identical content already exists for this system.",
            ),
          };
        }

        const published: PublishedVersion = {
          versionId: result.version.versionId,
          systemId: result.version.systemId,
          semanticVersion: result.version.semanticVersion,
          checksum: result.version.checksum,
          package: compiled.value,
          releaseNotes: result.version.releaseNotes,
          lifecycle: result.version.lifecycle,
          createdAt: result.version.createdAt,
        };
        await repo.recordReceipt({
          actorId: ctx.actorId,
          commandKind: "system_publish",
          key: input.idempotencyKey,
          inputHash,
          result: published,
          expiresAt: new Date(now().getTime() + RECEIPT_TTL_MS),
        });
        return { ok: true, value: published };
      } catch {
        return { ok: false, error: errors.internal() };
      }
    },

    async exportVersion(ctx, versionId) {
      try {
        const version = await repo.loadVersion(versionId);
        if (version === null) return { ok: false, error: errors.not_found() };
        const system = await repo.openSystem(version.systemId);
        if (system === null || system.ownerId !== ctx.actorId) return { ok: false, error: errors.not_found() };
        const exported: ExportedPackage = {
          schemaVersion: "1.0",
          mediaType: "application/vnd.sweetroll.system+json;version=1",
          exportedAt: new Date().toISOString(),
          package: version.package as SystemPackageV1,
        };
        return { ok: true, value: exported };
      } catch {
        return { ok: false, error: errors.internal() };
      }
    },

    async listVersions(ctx, input) {
      try {
        const system = await authorizeOwner(input.systemId, ctx.actorId);
        if (system === null) return { ok: false, error: errors.not_found() };
        const versions = await repo.listVersions(input.systemId);
        return { ok: true, value: { versions: versions.map(summarizeVersion) } };
      } catch {
        return { ok: false, error: errors.internal() };
      }
    },

    async changeLifecycle(ctx, input) {
      try {
        if (input.kind === "system") {
          const system = await authorizeOwner(input.systemId, ctx.actorId);
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
      } catch {
        return { ok: false, error: errors.internal() };
      }
    },

    async deleteSystem(ctx, systemId) {
      try {
        const deleted = await repo.deleteOwnedSystem(systemId, ctx.actorId);
        if (!deleted) return { ok: false, error: errors.not_found() };
        return { ok: true, value: { systemId } };
      } catch {
        return { ok: false, error: errors.internal() };
      }
    },
  };
}