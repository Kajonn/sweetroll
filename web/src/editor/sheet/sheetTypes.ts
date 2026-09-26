import type { DefinitionId } from "../../state/documentFieldTypes.js";

export type SheetElementKind = "heading" | "field" | "resource" | "action" | "slot";

export type HeadingSheetElementV1 = {
  kind: "heading";
  id: DefinitionId;
  text: string;
  level: 2 | 3;
};

export type FieldSheetElementV1 = {
  kind: "field";
  id: DefinitionId;
  fieldId: DefinitionId;
};

export type ResourceSheetElementV1 = {
  kind: "resource";
  id: DefinitionId;
  resourceId: DefinitionId;
};

export type ActionSheetElementV1 = {
  kind: "action";
  id: DefinitionId;
  actionId: DefinitionId;
};

export type SlotSheetElementV1 = {
  kind: "slot";
  id: DefinitionId;
  slotId: DefinitionId;
};

export type SheetElementV1 =
  | HeadingSheetElementV1
  | FieldSheetElementV1
  | ResourceSheetElementV1
  | ActionSheetElementV1
  | SlotSheetElementV1;

export type SheetSectionV1 = {
  id: DefinitionId;
  label: string;
  elements: SheetElementV1[];
};

export type SheetEditorV1 = {
  id: DefinitionId;
  label: string;
  targetEntityId: DefinitionId;
  sections: SheetSectionV1[];
};

export function isHeadingElement(
  element: SheetElementV1,
): element is HeadingSheetElementV1 {
  return element.kind === "heading";
}

export function isFieldElement(
  element: SheetElementV1,
): element is FieldSheetElementV1 {
  return element.kind === "field";
}

export function isResourceElement(
  element: SheetElementV1,
): element is ResourceSheetElementV1 {
  return element.kind === "resource";
}

export function isActionElement(
  element: SheetElementV1,
): element is ActionSheetElementV1 {
  return element.kind === "action";
}

export function isSlotElement(
  element: SheetElementV1,
): element is SlotSheetElementV1 {
  return element.kind === "slot";
}
