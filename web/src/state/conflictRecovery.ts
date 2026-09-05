export type ConflictPayload =
  | { kind: "theirs"; document: unknown }
  | { kind: "force"; document: unknown; expectedRevision: null }
  | { kind: "merge"; document: unknown; expectedRevision: number };

export function buildAcceptTheirsPayload(theirsDocument: unknown): ConflictPayload {
  return { kind: "theirs", document: theirsDocument };
}

export function buildKeepMinePayload(document: unknown): ConflictPayload {
  return { kind: "force", document, expectedRevision: null };
}

export function buildMergeIntoServerPayload(document: unknown, latestRevision: number): ConflictPayload {
  return { kind: "merge", document, expectedRevision: latestRevision };
}
