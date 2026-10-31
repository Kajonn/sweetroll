import {effectiveEntryDefinition} from "./effective-entry.js";
import type {
  CharacterProjectionElement,
  CharacterProjectionFieldConstraints,
  CharacterProjectionSlotEntry,
  CharacterProjectionV1,
  RuntimeScalar,
  RuntimeStateV1,
  RuntimeValidation,
} from "../../runtime.js";
import type {
  EntityDefinitionV1,
  FieldV1,
  GrantedActionV1,
  ObjectTemplateV1,
  SheetElementV1,
  SlotDefinitionV1,
  SystemPackageV1,
} from "../package/schema/index.js";

export function buildCharacterProjection(input: {
  packageValue: SystemPackageV1;
  entity: EntityDefinitionV1;
  state: RuntimeStateV1;
  derivedValues: Record<string, RuntimeScalar>;
  validations: RuntimeValidation[];
}): CharacterProjectionV1 {
  const { packageValue, entity, state, derivedValues, validations } = input;
  const fields = new Map(entity.fields.map((field) => [field.id, field]));
  const actions = new Map(packageValue.actions.map((action) => [action.id, action]));
  const slots = new Map((packageValue.slots ?? []).map((slot) => [slot.id, slot]));
  const templates = new Map((packageValue.templates ?? []).map((template) => [template.id, template]));
  const validationsFor = (id: string): RuntimeValidation[] =>
    validations.filter((validation) => validation.targetDefinitionId === id);
  const entitySheets = packageValue.sheets.filter((sheet) => sheet.targetEntityId === entity.id);
  const bound = new Set(entitySheets.flatMap(sheet => sheet.sections.flatMap(section =>
    section.elements.flatMap(element => element.kind === "field" ? [element.fieldId] : [])
  )));

  return {
    projectionVersion: "1.0",
    systemId: packageValue.systemId,
    versionId: packageValue.versionId,
    packageChecksum: packageValue.integrity.checksum,
    entityId: entity.id,
    entityLabel: entity.label,
    completionFields: entity.fields.flatMap((field) =>
      field.kind !== "computed" && field.kind !== "image" && field.kind !== "resource"
        && field.required && !bound.has(field.id)
        ? [projectField(field.id, field, state, derivedValues, validationsFor)]
        : []),
    sheets: entitySheets
      .map((sheet) => ({
        id: sheet.id,
        label: sheet.label,
        sections: sheet.sections.map((section) => ({
          id: section.id,
          label: section.label,
          elements: section.elements.flatMap((element) => projectElement(
            element,
            { fields, actions, slots, templates, packageValue },
            state,
            derivedValues,
            validationsFor,
          )),
        })),
      })),
    derivedValues: { ...derivedValues },
    validations: validations.map((validation) => ({ ...validation })),
  };
}

function projectElement(
  element: SheetElementV1,
  lookups: {
    fields: Map<string, FieldV1>;
    actions: Map<string, SystemPackageV1["actions"][number]>;
    slots: Map<string, SlotDefinitionV1>;
    templates: Map<string, ObjectTemplateV1>;
    packageValue: SystemPackageV1;
  },
  state: RuntimeStateV1,
  derivedValues: Record<string, RuntimeScalar>,
  validationsFor: (id: string) => RuntimeValidation[],
): CharacterProjectionElement[] {
  if (element.kind === "heading") return [{ ...element }];
  if (element.kind === "slot") return projectSlot(element.slotId, element.id, lookups, state, validationsFor);
  if (element.kind === "action") {
    const action = lookups.actions.get(element.actionId)!;
    return [{
      kind: "action",
      id: element.id,
      actionId: action.id,
      label: action.label,
      actionKind: action.kind,
      inputs: action.kind === "roll" ? action.inputs.map((input) => ({ ...input })) : [],
      validations: validationsFor(action.id),
    }];
  }

  const fieldId = element.kind === "field" ? element.fieldId : element.resourceId;
  const field = lookups.fields.get(fieldId)!;
  if (field.kind === "resource") {
    return [{
      kind: "resource",
      id: element.id,
      resourceId: field.id,
      label: field.label,
      value: structuredClone(state.values[field.id]) as { current: number; max: number },
      min: field.min,
      max: field.max,
      step: field.step,
      resetTo: field.resetTo,
      validations: validationsFor(field.id),
    }];
  }

  return [projectField(element.id, field, state, derivedValues, validationsFor)];
}

/**
 * Slot projection (Task 5): the slot element itself carries the slot's
 * entries, followed directly by one synthetic `action` element per granted
 * action of each templated entry (entry order, then template action order).
 * Custom entries are data-only and never gain synthetic actions; entries
 * whose template is gone project with their stored values but no actions.
 */
function projectSlot(
  slotId: string,
  elementId: string,
  lookups: {
    slots: Map<string, SlotDefinitionV1>;
    templates: Map<string, ObjectTemplateV1>;
    packageValue: SystemPackageV1;
  },
  state: RuntimeStateV1,
  validationsFor: (id: string) => RuntimeValidation[],
): CharacterProjectionElement[] {
  const slot = lookups.slots.get(slotId);
  const slotEntries = Object.values(state.entries ?? {})
    .filter((entry) => entry.slotId === slotId)
    .sort((left, right) => (left.entryId < right.entryId ? -1 : left.entryId > right.entryId ? 1 : 0));
  const projected: CharacterProjectionSlotEntry[] = slotEntries.map((entry) => {
    const template = effectiveEntryDefinition(lookups.packageValue, entry);
    return {
      entryId: entry.entryId,
      templateId: entry.templateId,
      ...(entry.source === undefined ? {} : {source:structuredClone(entry.source)}),
      label: entry.snapshot && "base" in entry.snapshot ? entry.snapshot.values.name : template?.label ?? customEntryLabel(entry.values),
      ...(entry.snapshot && "base" in entry.snapshot && template ? {definition:projectEntryDefinition(template), metadata:structuredClone(entry.snapshot.values)} : {}),
      values: structuredClone(entry.values),
      ...(entry.quantity === undefined ? {} : { quantity: entry.quantity }),
    };
  });
  const elements: CharacterProjectionElement[] = [{
    kind: "slot",
    id: elementId,
    slotId,
    label: slot?.label ?? slotId,
    accepts: slot ? [...slot.accepts] : [],
    entries: projected,
  }];
  for (const entry of slotEntries) {
    const template = effectiveEntryDefinition(lookups.packageValue, entry);
    if (template === undefined) continue;
    for (const action of template.grantedActions) {
      elements.push(projectGrantedAction(entry.entryId, action, validationsFor));
    }
  }
  return elements;
}

function projectGrantedAction(
  entryId: string,
  action: GrantedActionV1,
  validationsFor: (id: string) => RuntimeValidation[],
): CharacterProjectionElement {
  return {
    kind: "action",
    id: `${entryId}__${action.id}`,
    actionId: action.id,
    entryId,
    label: action.label,
    actionKind: action.kind,
    inputs: action.kind === "roll" ? action.inputs.map((input) => ({ ...input })) : [],
    validations: validationsFor(action.id),
  };
}

function customEntryLabel(values: Record<string, unknown>): string {
  const name = values.name;
  return typeof name === "string" && name.length > 0 ? name : "Custom entry";
}

function projectField(
  id: string,
  field: Exclude<FieldV1, { kind: "resource" }>,
  state: RuntimeStateV1,
  derivedValues: Record<string, RuntimeScalar>,
  validationsFor: (id: string) => RuntimeValidation[],
): Extract<CharacterProjectionElement, { kind: "field" }> {
  return {
    kind: "field",
    id,
    fieldId: field.id,
    label: field.label,
    fieldKind: field.kind,
    value: field.kind === "computed"
      ? derivedValues[field.id]!
      : structuredClone(state.values[field.id]) as RuntimeScalar | string[],
    editable: field.kind !== "computed",
    constraints: field.kind === "computed" ? {} : fieldConstraints(field),
    validations: validationsFor(field.id),
  };
}

function fieldConstraints(
  field: Exclude<FieldV1, { kind: "computed" } | { kind: "resource" }>,
): CharacterProjectionFieldConstraints {
  switch (field.kind) {
    case "text":
      return {
        required: field.required,
        minLength: field.minLength,
        maxLength: field.maxLength,
      };
    case "integer":
    case "decimal":
      return { required: field.required, min: field.min, max: field.max, step: field.step };
    case "singleChoice":
    case "multiChoice":
      return { required: field.required, options: field.options.map((option) => ({ ...option })) };
    case "boolean":
    case "image":
      return { required: field.required };
  }
}

/** UI data only. Execution and policy remain owned by the pinned package resolver. */
function projectEntryDefinition(template:ObjectTemplateV1):NonNullable<CharacterProjectionSlotEntry["definition"]>{
 return {id:template.id,label:template.label,kind:template.kind,
  fields:template.fields.filter((f):f is Exclude<FieldV1,{kind:"computed"}|{kind:"image"}>=>f.kind!=="computed" && f.kind!=="image").map(f=>({id:f.id,label:f.label,kind:f.kind,default:structuredClone(f.default),...(f.kind==="resource"?{min:f.min,max:f.max,step:f.step}:fieldConstraints(f))})),
  grantedActions:template.grantedActions.map(a=>({id:a.id,label:a.label,kind:a.kind,inputs:a.kind==="roll"?a.inputs.map(i=>({...i})):[]}))};
}
