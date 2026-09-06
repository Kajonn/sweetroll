import type {
  CharacterProjectionElement,
  CharacterProjectionFieldConstraints,
  CharacterProjectionV1,
  RuntimeScalar,
  RuntimeStateV1,
  RuntimeValidation,
} from "../../runtime.js";
import type {
  EntityDefinitionV1,
  FieldV1,
  SheetElementV1,
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
          elements: section.elements.map((element) => projectElement(
            element,
            fields,
            actions,
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
  fields: Map<string, FieldV1>,
  actions: Map<string, SystemPackageV1["actions"][number]>,
  state: RuntimeStateV1,
  derivedValues: Record<string, RuntimeScalar>,
  validationsFor: (id: string) => RuntimeValidation[],
): CharacterProjectionElement {
  if (element.kind === "heading") return { ...element };
  if (element.kind === "action") {
    const action = actions.get(element.actionId)!;
    return {
      kind: "action",
      id: element.id,
      actionId: action.id,
      label: action.label,
      actionKind: action.kind,
      inputs: action.kind === "roll" ? action.inputs.map((input) => ({ ...input })) : [],
      validations: validationsFor(action.id),
    };
  }

  const fieldId = element.kind === "field" ? element.fieldId : element.resourceId;
  const field = fields.get(fieldId)!;
  if (field.kind === "resource") {
    return {
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
    };
  }

  return projectField(element.id, field, state, derivedValues, validationsFor);
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
