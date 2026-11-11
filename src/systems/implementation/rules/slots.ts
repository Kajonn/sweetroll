import type { ObjectTemplateV1, SystemDocumentV1 } from "../package/schema/index.js";
import { DEFAULT_SLOT_MAX_ENTRIES } from "../runtime/entries.js";
import type { SlotEnvironment } from "./data.js";

type SlotRules = Pick<SystemDocumentV1, "sheets" | "slots" | "templates">;

export function slotEnvironment(
  rules: SlotRules,
  entityId: string,
  templates: readonly ObjectTemplateV1[] = rules.templates,
): SlotEnvironment {
  const ids = new Set(rules.sheets.filter(sheet => sheet.targetEntityId === entityId)
    .flatMap(sheet => sheet.sections.flatMap(section => section.elements.flatMap(element =>
      element.kind === "slot" ? [element.slotId] : [],
    ))));
  return Object.fromEntries(rules.slots.filter(slot => ids.has(slot.id)).map(slot => {
    const fields: Record<string, "number" | "boolean" | "unsupported" | "mixed"> = Object.create(null);
    for (const template of templates) {
      if (!slot.accepts.includes(template.kind)) continue;
      for (const field of template.fields) {
        const type = field.kind === "integer" || field.kind === "decimal" ? "number"
          : field.kind === "boolean" ? "boolean" : "unsupported";
        const previous = fields[field.id];
        fields[field.id] = previous === undefined || previous === type ? type : "mixed";
      }
    }
    return [slot.id, { capacity: slot.maxEntries ?? DEFAULT_SLOT_MAX_ENTRIES, fields }];
  }));
}
