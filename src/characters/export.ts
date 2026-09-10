import { canonicalize } from "json-canonicalize";

import type { CharacterExportV1 } from "./index.js";
import type { CharacterRecord } from "./persistence.js";

/**
 * Builds the canonical `CharacterExportV1` document for one character record.
 *
 * The document excludes owner/actor/request/execution IDs and activity/roll
 * history per the export contract (design section 10). Migration lineage is
 * always empty in I3 because migration commit/rollback ship in a later slice.
 */
export function buildCharacterExportDocument(
  record: CharacterRecord,
  packageChecksum: string,
): CharacterExportV1 {
  return {
    schemaVersion: "1.0",
    mediaType: "application/vnd.sweetroll.character+json;version=1",
    characterId: record.characterId,
    name: record.name,
    entityDefinitionId: record.entityDefinitionId,
    lifecycle: record.lifecycle,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    systemVersionId: record.systemVersionId,
    packageChecksum,
    revision: record.revision,
    state: record.state,
    migrationLineage: [],
  };
}

/** Canonicalizes an export document for byte-equivalent replay/storage. */
export function canonicalizeCharacterExport(document: CharacterExportV1): string {
  return canonicalize(document);
}

/**
 * I6 Task 4: builds the export projection for an attached character from its
 * CURRENT record only. The document carries the live sheet state and an empty
 * migration lineage: pre-adoption personal history, campaign rolls and other
 * actors' data are never embedded. Authorization (which campaign members may
 * export) is decided by campaign policy at the call site, not here.
 */
export function buildAttachedCharacterExportDocument(
  record: Pick<
    CharacterRecord,
    "characterId" | "name" | "entityDefinitionId" | "lifecycle" | "createdAt" | "updatedAt" | "systemVersionId" | "revision" | "state"
  >,
  packageChecksum: string,
): CharacterExportV1 {
  return {
    schemaVersion: "1.0",
    mediaType: "application/vnd.sweetroll.character+json;version=1",
    characterId: record.characterId,
    name: record.name,
    entityDefinitionId: record.entityDefinitionId,
    lifecycle: record.lifecycle,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    systemVersionId: record.systemVersionId,
    packageChecksum,
    revision: record.revision,
    state: record.state,
    migrationLineage: [],
  };
}
