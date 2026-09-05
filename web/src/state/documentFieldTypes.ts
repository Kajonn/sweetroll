export type DefinitionId = string;

export type ChoiceOptionV1 = {
  id: DefinitionId;
  label: string;
};

export type TextFieldV1 = {
  kind: "text";
  id: DefinitionId;
  label: string;
  default: string;
  required: boolean;
  minLength: number;
  maxLength: number;
};

export type IntegerFieldV1 = {
  kind: "integer";
  id: DefinitionId;
  label: string;
  default: number;
  required: boolean;
  min: number;
  max: number;
  step: number;
};

export type DecimalFieldV1 = {
  kind: "decimal";
  id: DefinitionId;
  label: string;
  default: number;
  required: boolean;
  min: number;
  max: number;
  step: number;
};

export type BooleanFieldV1 = {
  kind: "boolean";
  id: DefinitionId;
  label: string;
  default: boolean;
  required: boolean;
};

export type SingleChoiceFieldV1 = {
  kind: "singleChoice";
  id: DefinitionId;
  label: string;
  required: boolean;
  default: DefinitionId | null;
  options: ChoiceOptionV1[];
};

export type MultiChoiceFieldV1 = {
  kind: "multiChoice";
  id: DefinitionId;
  label: string;
  required: boolean;
  default: DefinitionId[];
  options: ChoiceOptionV1[];
};

export type ResourceFieldV1 = {
  kind: "resource";
  id: DefinitionId;
  label: string;
  default: { current: number; max: number };
  min: number;
  max: number;
  step: number;
  resetTo: "min" | "max";
};

export type ComputedFieldV1 = {
  kind: "computed";
  id: DefinitionId;
  label: string;
  valueType: "number" | "text" | "boolean";
  expressionId: DefinitionId;
};

export type ImageFieldV1 = {
  kind: "image";
  id: DefinitionId;
  label: string;
  required: boolean;
};

export type FieldV1 =
  | TextFieldV1
  | IntegerFieldV1
  | DecimalFieldV1
  | BooleanFieldV1
  | SingleChoiceFieldV1
  | MultiChoiceFieldV1
  | ResourceFieldV1
  | ComputedFieldV1
  | ImageFieldV1;

export type FieldKind = FieldV1["kind"];
