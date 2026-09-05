import { useState } from "react";

import { renderExpression } from "@sweetroll/rules";

import { evaluateRoll } from "../api/evaluateExpression.js";
import { t } from "../i18n/index.js";
import type { ScalarValue, ValueType } from "../ports/evaluateExpression.js";

import type {
  ChoiceOptionV1,
  CompiledExpressionSummary,
  EntityDefinitionV1,
  FieldV1,
  SampleData,
  SampleFieldValue,
  SampleResourceValue,
  SampleScalarValue,
  SystemPackageV1,
} from "./sampleData.js";
import styles from "./PreviewSheet.module.css";

export type DefinitionId = string;

export type SheetElementKind = "heading" | "field" | "resource" | "action";

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

export type SheetElementV1 =
  | HeadingSheetElementV1
  | FieldSheetElementV1
  | ResourceSheetElementV1
  | ActionSheetElementV1;

export type SheetSectionV1 = {
  id: DefinitionId;
  label: string;
  elements: SheetElementV1[];
};

export type SheetV1 = {
  id: DefinitionId;
  label: string;
  targetEntityId: DefinitionId;
  sections: SheetSectionV1[];
};

export type ActionInputV1 = {
  id: DefinitionId;
  label: string;
  valueType: "integer" | "decimal" | "boolean" | "text";
  required: boolean;
  default: ScalarValue;
};

export type RollActionV1 = {
  kind: "roll";
  id: DefinitionId;
  label: string;
  expressionId: DefinitionId;
  inputs: ActionInputV1[];
  outputTemplate: string;
};

export type ResourceBumpOperationV1 =
  | { kind: "delta"; amount: number }
  | { kind: "reset" };

export type ResourceBumpActionV1 = {
  kind: "resourceBump";
  id: DefinitionId;
  label: string;
  resourceId: DefinitionId;
  operation: ResourceBumpOperationV1;
};

export type ActionV1 = RollActionV1 | ResourceBumpActionV1;

type PackageWithMeta = SystemPackageV1 & {
  sheets?: SheetV1[];
  actions?: ActionV1[];
};

export type PreviewSheetProps = {
  pkg: SystemPackageV1;
  sample: SampleData;
  sheetId?: string;
};

type SheetWithMeta = {
  sheet: SheetV1;
  entity: EntityDefinitionV1;
  actions: ActionV1[];
};

type FieldTypeMap = Record<DefinitionId, ValueType>;

function isResourceValue(
  v: SampleFieldValue | undefined,
): v is SampleResourceValue {
  if (v === undefined || typeof v !== "object" || Array.isArray(v)) return false;
  const obj = v as { current?: unknown; max?: unknown };
  return (
    typeof obj.current === "number" &&
    typeof obj.max === "number"
  );
}

function isMultiChoiceValue(v: SampleFieldValue | undefined): v is DefinitionId[] {
  return Array.isArray(v);
}

function findSheet(
  pkg: SystemPackageV1,
  sample: SampleData,
  sheetId: string | undefined,
): SheetWithMeta | null {
  const extended = pkg as PackageWithMeta;
  const sheets = extended.sheets ?? [];
  const actions = extended.actions ?? [];
  if (sheets.length === 0) return null;
  const target =
    sheetId === undefined ? sheets[0] : sheets.find((s) => s.id === sheetId);
  if (target === undefined) return null;
  const entity = pkg.entities.find((e) => e.id === target.targetEntityId);
  if (entity === undefined) return null;
  if (sample[entity.id] === undefined) return null;
  return { sheet: target, entity, actions };
}

function fieldType(field: FieldV1): ValueType | undefined {
  switch (field.kind) {
    case "text":
      return "text";
    case "integer":
    case "decimal":
    case "resource":
      return "number";
    case "boolean":
      return "boolean";
    case "singleChoice":
    case "multiChoice":
      return "text";
    case "computed":
      return field.valueType;
    case "image":
      return undefined;
  }
}

function buildFieldTypes(entity: EntityDefinitionV1): FieldTypeMap {
  const out: FieldTypeMap = {};
  for (const field of entity.fields) {
    const vt = fieldType(field);
    if (vt !== undefined) out[field.id] = vt;
  }
  return out;
}

function findField(
  entity: EntityDefinitionV1,
  fieldId: DefinitionId,
): FieldV1 | null {
  return entity.fields.find((f) => f.id === fieldId) ?? null;
}

function findAction(actions: ActionV1[], actionId: DefinitionId): ActionV1 | null {
  return actions.find((a) => a.id === actionId) ?? null;
}

function findExpression(
  expressions: CompiledExpressionSummary[],
  expressionId: DefinitionId,
): CompiledExpressionSummary | null {
  return expressions.find((e) => e.id === expressionId) ?? null;
}

function defaultBinding(valueType: ValueType): ScalarValue {
  switch (valueType) {
    case "number":
      return 0;
    case "text":
      return "";
    case "boolean":
      return false;
  }
}

function coerceScalar(
  value: SampleScalarValue,
  valueType: ValueType,
): ScalarValue {
  if (value === null) return defaultBinding(valueType);
  switch (valueType) {
    case "number":
      return typeof value === "number" ? value : Number(value);
    case "text":
      return typeof value === "string" ? value : String(value);
    case "boolean":
      return typeof value === "boolean" ? value : value === "true";
  }
}

function buildActionBindings(
  entity: EntityDefinitionV1,
  record: { fields: Record<DefinitionId, SampleFieldValue> } | undefined,
  action: ActionV1 | null,
): Record<string, ScalarValue> {
  const out: Record<string, ScalarValue> = {};
  const fieldTypes = buildFieldTypes(entity);
  for (const [id, vt] of Object.entries(fieldTypes)) {
    const v = record === undefined ? undefined : record.fields[id];
    if (v === undefined) {
      out[id] = defaultBinding(vt);
      continue;
    }
    if (isResourceValue(v)) {
      out[id] = v.current;
      continue;
    }
    if (isMultiChoiceValue(v)) continue;
    if (v === null) {
      out[id] = defaultBinding(vt);
      continue;
    }
    out[id] = coerceScalar(v, vt);
  }
  if (action !== null && action.kind === "roll") {
    for (const input of action.inputs) {
      out[input.id] = input.default;
    }
  }
  return out;
}

function renderScalarValue(
  value: SampleScalarValue,
  field: FieldV1,
): string {
  switch (field.kind) {
    case "text":
      return value === null ? "" : String(value);
    case "integer":
    case "decimal":
    case "computed":
      return value === null ? "" : String(value);
    case "boolean":
      return value === true
        ? t("editor.fields.boolean.true")
        : t("editor.fields.boolean.false");
    case "singleChoice":
    case "multiChoice":
      return value === null ? "" : String(value);
    case "resource":
    case "image":
      return value === null ? "" : String(value);
  }
}

function choiceLabel(
  options: ChoiceOptionV1[],
  optionId: DefinitionId | null,
): string {
  if (optionId === null) return "";
  const match = options.find((o) => o.id === optionId);
  return match === undefined ? "" : match.label;
}

function renderFieldValue(
  field: FieldV1,
  value: SampleFieldValue,
): string {
  switch (field.kind) {
    case "singleChoice":
      return typeof value === "string" || value === null
        ? choiceLabel(field.options, value)
        : "";
    case "multiChoice":
      return isMultiChoiceValue(value)
        ? value
            .map((id) => choiceLabel(field.options, id))
            .filter((label) => label.length > 0)
            .join(", ")
        : "";
    case "resource":
      return isResourceValue(value) ? `${value.current}/${value.max}` : "";
    case "image":
      return "";
    case "boolean":
      return renderScalarValue(typeof value === "boolean" ? value : null, field);
    case "text":
    case "integer":
    case "decimal":
    case "computed":
      return renderScalarValue(
        value === null ||
          typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "boolean"
          ? value
          : null,
        field,
      );
  }
}

function modifiersFromRoll(
  roll: { total: number; dice: Array<{ value: number; kept: boolean }> },
): number {
  return roll.total - roll.dice.reduce((s, d) => (d.kept ? s + d.value : s), 0);
}

function formatOutput(template: string, total: number): string {
  return template.replace(/\{total\}/g, String(total));
}

function expressionInputTypes(action: RollActionV1): Record<string, ValueType> {
  const out: Record<string, ValueType> = {};
  for (const input of action.inputs) {
    out[input.id] =
      input.valueType === "text"
        ? "text"
        : input.valueType === "boolean"
          ? "boolean"
          : "number";
  }
  return out;
}

export function PreviewSheet({ pkg, sample, sheetId }: PreviewSheetProps) {
  const resolved = findSheet(pkg, sample, sheetId);
  if (resolved === null) {
    return (
      <div className={styles.sheet} data-testid="preview-sheet-empty">
        <p className={styles.unsupported}>{t("preview.sheet.empty")}</p>
      </div>
    );
  }
  const { sheet, entity, actions } = resolved;
  return (
    <div className={styles.sheet} data-testid={`preview-sheet-${sheet.id}`}>
      <h1 className={styles.title}>{sheet.label}</h1>
      {sheet.sections.map((section) => (
        <PreviewSection
          key={section.id}
          section={section}
          entity={entity}
          actions={actions}
          expressions={pkg.expressions}
          sample={sample}
        />
      ))}
    </div>
  );
}

type PreviewSectionProps = {
  section: SheetSectionV1;
  entity: EntityDefinitionV1;
  actions: ActionV1[];
  expressions: CompiledExpressionSummary[];
  sample: SampleData;
};

function PreviewSection({
  section,
  entity,
  actions,
  expressions,
  sample,
}: PreviewSectionProps) {
  const record = sample[entity.id];
  return (
    <section
      className={styles.section}
      data-testid={`preview-section-${section.id}`}
      aria-label={section.label}
    >
      <h2 className={styles.sectionHeading}>{section.label}</h2>
      {section.elements.map((element) => (
        <PreviewElement
          key={element.id}
          element={element}
          entity={entity}
          actions={actions}
          expressions={expressions}
          record={record}
        />
      ))}
    </section>
  );
}

type PreviewElementProps = {
  element: SheetElementV1;
  entity: EntityDefinitionV1;
  actions: ActionV1[];
  expressions: CompiledExpressionSummary[];
  record: { fields: Record<DefinitionId, SampleFieldValue> } | undefined;
};

function PreviewElement({
  element,
  entity,
  actions,
  expressions,
  record,
}: PreviewElementProps) {
  switch (element.kind) {
    case "heading":
      return <PreviewHeading key={element.id} element={element} />;
    case "field": {
      const field = findField(entity, element.fieldId);
      const value =
        record === undefined ? undefined : record.fields[element.fieldId];
      return (
        <PreviewField
          key={element.id}
          element={element}
          field={field}
          value={value}
        />
      );
    }
    case "resource": {
      const field = findField(entity, element.resourceId);
      const value =
        record === undefined ? undefined : record.fields[element.resourceId];
      return (
        <PreviewResource
          key={element.id}
          element={element}
          field={field}
          value={value}
        />
      );
    }
    case "action": {
      const action = findAction(actions, element.actionId);
      return (
        <PreviewAction
          key={element.id}
          element={element}
          action={action}
          entity={entity}
          expressions={expressions}
          record={record}
        />
      );
    }
  }
}

function PreviewHeading({ element }: { element: HeadingSheetElementV1 }) {
  const className = element.level === 2 ? styles.heading2 : styles.heading3;
  if (element.level === 2) {
    return (
      <h3 className={className} data-testid={`preview-heading-${element.id}`}>
        {element.text}
      </h3>
    );
  }
  return (
    <h4 className={className} data-testid={`preview-heading-${element.id}`}>
      {element.text}
    </h4>
  );
}

function PreviewField({
  element,
  field,
  value,
}: {
  element: FieldSheetElementV1;
  field: FieldV1 | null;
  value: SampleFieldValue | undefined;
}) {
  const labelText = field?.label ?? element.fieldId;
  let valueText = "";
  if (field !== null && value !== undefined) {
    valueText = renderFieldValue(field, value);
  }
  return (
    <div className={styles.fieldRow} data-testid={`preview-field-${element.id}`}>
      <span
        className={styles.fieldLabel}
        data-testid={`preview-field-label-${element.id}`}
      >
        {labelText}
      </span>
      <span
        className={styles.fieldValue}
        data-testid={`preview-field-value-${element.id}`}
      >
        {valueText}
      </span>
    </div>
  );
}

function PreviewResource({
  element,
  field,
  value,
}: {
  element: ResourceSheetElementV1;
  field: FieldV1 | null;
  value: SampleFieldValue | undefined;
}) {
  const labelText = field?.label ?? element.resourceId;
  const resource = isResourceValue(value)
    ? value
    : field !== null && field.kind === "resource"
      ? { current: field.default.current, max: field.default.max }
      : null;
  return (
    <div
      className={styles.resourceRow}
      data-testid={`preview-resource-${element.id}`}
    >
      <span
        className={styles.fieldLabel}
        data-testid={`preview-resource-label-${element.id}`}
      >
        {labelText}
      </span>
      {resource !== null ? (
        <>
          <span
            className={styles.resourceCurrent}
            data-testid={`preview-resource-current-${element.id}`}
          >
            {resource.current}
          </span>
          <span
            className={styles.resourceMax}
            data-testid={`preview-resource-max-${element.id}`}
          >
            /{resource.max}
          </span>
        </>
      ) : (
        <span className={styles.resourceCurrent}>—</span>
      )}
    </div>
  );
}

type PreviewActionProps = {
  element: ActionSheetElementV1;
  action: ActionV1 | null;
  entity: EntityDefinitionV1;
  expressions: CompiledExpressionSummary[];
  record: { fields: Record<DefinitionId, SampleFieldValue> } | undefined;
};

function PreviewAction({
  element,
  action,
  entity,
  expressions,
  record,
}: PreviewActionProps) {
  const [openRollResult, setOpenRollResult] = useState(false);
  const labelText = action?.label ?? element.actionId;
  const handleClick = () => {
    if (action === null) return;
    if (action.kind === "roll") {
      setOpenRollResult((v) => !v);
    }
  };
  return (
    <div data-testid={`preview-action-wrapper-${element.id}`}>
      <button
        type="button"
        className={styles.actionButton}
        onClick={handleClick}
        disabled={action === null}
        data-testid={`preview-action-${element.id}`}
      >
        {labelText}
      </button>
      {openRollResult && action !== null && action.kind === "roll" && record !== undefined ? (
        <RollResultSheet
          action={action}
          entity={entity}
          expressions={expressions}
          record={record}
          onClose={() => setOpenRollResult(false)}
        />
      ) : null}
    </div>
  );
}

type RollResultSheetProps = {
  action: RollActionV1;
  entity: EntityDefinitionV1;
  expressions: CompiledExpressionSummary[];
  record: { fields: Record<DefinitionId, SampleFieldValue> };
  onClose: () => void;
};

function RollResultSheet({
  action,
  entity,
  expressions,
  record,
  onClose,
}: RollResultSheetProps) {
  const expression = findExpression(expressions, action.expressionId);
  const source = expression === null ? "0" : renderExpression(expression.ast);
  const fieldTypes = buildFieldTypes(entity);
  const inputTypes = expressionInputTypes(action);
  const env = { fields: fieldTypes, inputs: inputTypes };
  const bindings = buildActionBindings(entity, record, action);
  const evaluation = evaluateRoll({
    source,
    env,
    resultType: "number",
    fallback: 0,
    bindings,
  });
  const result = evaluation.result;
  return (
    <div
      className={styles.rollSheet}
      data-testid={`preview-roll-result-${action.id}`}
      aria-label={t("preview.rollResult.title")}
    >
      <div className={styles.rollSheetHeader}>
        <h5 className={styles.rollSheetTitle}>{t("preview.rollResult.title")}</h5>
        <button
          type="button"
          className={styles.rollSheetClose}
          onClick={onClose}
          data-testid="preview-roll-result-close"
        >
          {t("preview.rollResult.close")}
        </button>
      </div>
      <div className={styles.rollSheetRow}>
        <span className={styles.rollSheetLabel}>
          {t("preview.rollResult.audience")}
        </span>
        <span data-testid="preview-roll-result-audience">
          {t("preview.rollResult.audience.preview")}
        </span>
      </div>
      {result.diagnostics.length > 0 ? (
        <div className={styles.rollSheetRow}>
          <span className={styles.rollSheetLabel}>
            {t("preview.rollResult.diagnostics")}
          </span>
          <ul className={styles.diagnosticList}>
            {result.diagnostics.map((d, i) => (
              <li
                key={`${d.code}-${i}`}
                className={styles.diagnosticItem}
                data-code={d.code}
              >
                {d.code}: {d.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {result.ok && result.roll !== null ? (
        <>
          <div className={styles.rollSheetRow}>
            <span className={styles.rollSheetLabel}>
              {t("preview.rollResult.expression")}
            </span>
            <span
              className={styles.formatted}
              data-testid="preview-roll-result-expression"
            >
              {result.expression ?? ""}
            </span>
          </div>
          <div className={styles.rollSheetRow}>
            <span className={styles.rollSheetLabel}>
              {t("preview.rollResult.dice")}
            </span>
            <ul className={styles.diceList}>
              {result.roll.dice.map((d, i) => (
                <li
                  key={`${d.sides}-${i}`}
                  className={styles.diceChip}
                  data-kept={d.kept ? "true" : "false"}
                  data-testid="preview-roll-result-die"
                >
                  d{d.sides}={d.value}
                </li>
              ))}
            </ul>
          </div>
          <div className={styles.rollSheetRow}>
            <span className={styles.rollSheetLabel}>
              {t("preview.rollResult.modifiers")}
            </span>
            <span data-testid="preview-roll-result-modifiers">
              {modifiersFromRoll(result.roll)}
            </span>
          </div>
          <div className={styles.rollSheetRow}>
            <span className={styles.rollSheetLabel}>
              {t("preview.rollResult.total")}
            </span>
            <span data-testid="preview-roll-result-total">
              {result.roll.total}
            </span>
          </div>
          <div className={styles.rollSheetRow}>
            <span className={styles.rollSheetLabel}>
              {t("preview.rollResult.formatted")}
            </span>
            <span
              className={styles.formatted}
              data-testid="preview-roll-result-formatted"
            >
              {formatOutput(action.outputTemplate, result.roll.total)}
            </span>
          </div>
        </>
      ) : null}
      {result.ok && result.roll === null ? (
        <div className={styles.rollSheetRow}>
          <span className={styles.rollSheetLabel}>
            {t("preview.rollResult.total")}
          </span>
          <span data-testid="preview-roll-result-total">{String(result.value)}</span>
        </div>
      ) : null}
    </div>
  );
}
