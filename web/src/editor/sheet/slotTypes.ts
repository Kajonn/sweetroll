import type { ResourceBumpActionV1 } from "../actions/ResourceBumpEditor.js";
import type { RollActionV1 } from "../actions/RollActionEditor.js";
import type { FieldV1 } from "../../state/documentFieldTypes.js";
import type { SystemDocumentV1 } from "../../state/documentReducer.js";

/**
 * Dynamic sheet objects — creator-side document types (Task 6).
 *
 * The backend owns the canonical schemas (`SystemDocumentV1` with optional
 * `templates`/`slots`). The web reducer (`state/documentReducer.ts`) stays
 * structurally open at runtime: `replace` and the spread-based setters carry
 * unknown keys through untouched, so creator-authored templates/slots persist
 * in draft documents and round-trip to the server without a reducer change.
 * These helpers read/write them defensively (`undefined` = absent, additive).
 */

export type TemplateKind = "item" | "spell" | "talent" | "effect";

export const TEMPLATE_KINDS: ReadonlyArray<TemplateKind> = ["item", "spell", "talent", "effect"];

/** Template-granted roll action: entity roll shape + optional nominal flag. */
export type GrantedRollActionV1 = RollActionV1 & { nominal?: boolean };

/** Template-granted resource bump: entity bump shape + optional nominal flag. */
export type GrantedResourceBumpActionV1 = ResourceBumpActionV1 & { nominal?: boolean };

export type GrantedActionV1 = GrantedRollActionV1 | GrantedResourceBumpActionV1;

export type ObjectTemplateV1 = {
  id: string;
  label: string;
  kind: TemplateKind;
  description?: string;
  fields: FieldV1[];
  grantedActions: GrantedActionV1[];
};

export type SlotDefinitionV1 = {
  id: string;
  label: string;
  accepts: TemplateKind[];
  maxEntries?: number;
};

/** A working document that may carry creator-authored templates/slots. */
export type TemplatesDocument = SystemDocumentV1 & {
  templates?: ObjectTemplateV1[];
  slots?: SlotDefinitionV1[];
};

export function readTemplates(document: SystemDocumentV1): ObjectTemplateV1[] {
  return ((document as TemplatesDocument).templates ?? []) as ObjectTemplateV1[];
}

export function readSlots(document: SystemDocumentV1): SlotDefinitionV1[] {
  return ((document as TemplatesDocument).slots ?? []) as SlotDefinitionV1[];
}

/**
 * Persist templates through the generic `replace` action: the web reducer
 * type does not name these keys, so the cast is centralized here rather than
 * spread across editors. Runtime keys survive verbatim.
 */
export function withTemplates(
  document: SystemDocumentV1,
  templates: ObjectTemplateV1[],
): SystemDocumentV1 {
  return { ...(document as TemplatesDocument), templates } as unknown as SystemDocumentV1;
}

export function withSlots(
  document: SystemDocumentV1,
  slots: SlotDefinitionV1[],
): SystemDocumentV1 {
  return { ...(document as TemplatesDocument), slots } as unknown as SystemDocumentV1;
}

/** Collect every definition id in the document so allocations stay global. */
export function collectUsedIds(document: SystemDocumentV1): Set<string> {
  const used = new Set<string>();
  const doc = document as TemplatesDocument;
  for (const entity of document.entities) {
    used.add(entity.id);
    for (const field of entity.fields) used.add(field.id);
  }
  for (const expression of document.expressions) used.add(expression.id);
  for (const action of document.actions) used.add(action.id);
  for (const sheet of document.sheets) {
    used.add(sheet.id);
    for (const section of sheet.sections as Array<{ id: string; elements: Array<{ id: string }> }>) {
      used.add(section.id);
      for (const element of section.elements) used.add(element.id);
    }
  }
  for (const template of doc.templates ?? []) {
    used.add(template.id);
    for (const field of template.fields) used.add(field.id);
    for (const action of template.grantedActions) used.add(action.id);
  }
  for (const slot of doc.slots ?? []) used.add(slot.id);
  return used;
}

export function nextScopedId(used: Set<string>, prefix: string): string {
  for (let i = 1; i < 10_000; i++) {
    const candidate = `${prefix}_${i}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
  return `${prefix}_${Date.now()}`;
}
