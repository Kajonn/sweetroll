export type UserSummary = { userId: string };

export type SystemSummary = {
  systemId: string;
  name: string;
  access: string;
  lifecycle: "active" | "archived";
  createdAt: string;
  updatedAt: string;
};

export type DraftView = {
  revision: number;
  document: { [key: string]: unknown };
  sourceChecksum: string;
  updatedBy: string;
  updatedAt: string;
};

export type VersionSummary = {
  versionId: string;
  systemId: string;
  semanticVersion: string;
  checksum: string;
  releaseNotes: string;
  lifecycle: string;
  createdAt: string;
};

export type PackageDiagnostic = {
  code: string;
  path: string;
  message: string;
};

export type DocumentAssessment = {
  ok: boolean;
  diagnostics: PackageDiagnostic[];
};

export type SystemWorkspace = {
  system: SystemSummary;
  draft: DraftView | null;
  versions: VersionSummary[];
  assessment: DocumentAssessment;
};

export type PreviewSnapshot = {
  snapshotId: string;
  systemId: string;
  sourceRevision: number;
  package: { [key: string]: unknown };
  expiresAt: string;
};

export type PublishedVersion = {
  versionId: string;
  systemId: string;
  semanticVersion: string;
  checksum: string;
  package: { [key: string]: unknown };
  releaseNotes: string;
  lifecycle: string;
  createdAt: string;
};
