export const PACKAGE_LIMITS = {
  actions: 256,
  dicePerRoll: 100,
  encodedBytes: 1024 * 1024,
  entities: 32,
  expressionAstDepth: 32,
  expressionAstNodes: 256,
  expressionBytes: 1024,
  expressions: 1024,
  fields: 512,
  grantedActions: 256,
  referenceDataSets: 64,
  referenceRecordValues: 64,
  referenceRecordsPerSet: 1000,
  sectionsPerSheet: 64,
  sheetElements: 1024,
  sheets: 32,
  sidesPerDie: 1000,
  slots: 64,
  templateFields: 512,
  templates: 128,
  validations: 256,
} as const;

// Dynamic sheet objects budget notes (Task 2):
// - `templates`/`slots` mirror the `maxItems: 128/64` literals in
//   schema/document.ts (SystemDocumentV1) and schema/package.ts
//   (SystemPackageV1). Those stay literals for now: this Task 2 commit is
//   scoped to limits/structural/compatibility plus the structural test, so
//   unifying the schemas to reference these constants is deferred — keep the
//   values in sync with those literals until then.
// - `templateFields` is the global field budget shared with entity fields
//   (entity fields + template fields, combined); `grantedActions` is the
//   global action budget shared with entity actions (entity actions +
//   template granted actions, combined).
