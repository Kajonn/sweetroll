import { useState } from "react";

import type { ApiClient } from "../api/client.js";
import { t } from "../i18n/index.js";
import type { FieldV1 } from "../state/documentFieldTypes.js";
import type {
  DocumentAction,
  SystemDocumentV1,
} from "../state/documentReducer.js";
import { Button, Checkbox, EmptyState, FormField, NumberInput, Select } from "../ui/index.js";
import { defaultField } from "./EntityList.js";
import {
  ResourceBumpEditor,
} from "./actions/ResourceBumpEditor.js";
import {
  GUIDED_DICE_KINDS,
  RollActionEditor,
} from "./actions/RollActionEditor.js";
import { BooleanFieldEditor } from "./fields/BooleanFieldEditor.js";
import { ChoiceFieldEditor } from "./fields/ChoiceFieldEditor.js";
import { ResourceFieldEditor } from "./fields/ResourceFieldEditor.js";
import { ScalarFieldEditor } from "./fields/ScalarFieldEditor.js";
import styles from "./DocumentEditor.module.css";
import {
  collectUsedIds,
  nextScopedId,
  readSlots,
  readTemplates,
  TEMPLATE_KINDS,
  withSlots,
  withTemplates,
  type GrantedActionV1,
  type GrantedResourceBumpActionV1,
  type GrantedRollActionV1,
  type ObjectTemplateV1,
  type SlotDefinitionV1,
  type TemplateKind,
} from "./sheet/slotTypes.js";

/** Template field kinds: the existing field union minus computed/image. */
const TEMPLATE_FIELD_KINDS: ReadonlyArray<FieldV1["kind"]> = [
  "text",
  "integer",
  "decimal",
  "boolean",
  "singleChoice",
  "multiChoice",
  "resource",
];

// Local labels for the new template/slot surfaces. These live here (rather
// than the i18n table) so the Task 6 commit stays inside `web/src/editor/`;
// move them into `web/src/i18n/messages.ts` as a follow-up.
const STRINGS = {
  templatesTitle: "Templates",
  addTemplate: "Add template",
  templatesEmpty: "No templates yet.",
  slotsTitle: "Slots",
  addSlot: "Add slot",
  slotsEmpty: "No slots yet.",
  templateDefaultLabel: "Template",
  slotDefaultLabel: "Slot",
  description: "Description",
  accepts: "Accepts",
  maxEntries: "Max entries",
} as const;

export type TemplatesTabProps = {
  client: ApiClient;
  document: SystemDocumentV1;
  dispatch: React.Dispatch<DocumentAction>;
};

/**
 * Templates tab: creator authoring for object templates (fields + granted
 * actions) and slot definitions. Clones the SheetsTab list structure (header
 * + add button + empty state + per-item detail), not its code.
 *
 * Granted roll actions reuse `RollActionEditor` in guided mode (same as the
 * Dice tab): canned dice kinds inline, full expression sources editable in
 * the Advanced disclosure, which already lists every `document.expressions`
 * entry including template-owned ones. Resource bumps reuse
 * `ResourceBumpEditor` directly (grammar-free).
 */
export function TemplatesTab({ client, document, dispatch }: TemplatesTabProps) {
  const templates = readTemplates(document);
  const slots = readSlots(document);

  const replaceTemplate = (id: string, patch: Partial<ObjectTemplateV1>) => {
    const next = templates.map((template) =>
      template.id === id ? { ...template, ...patch } : template,
    );
    dispatch({ type: "replace", document: withTemplates(document, next) });
  };
  const addTemplate = () => {
    const used = collectUsedIds(document);
    const id = nextScopedId(used, "template");
    const template: ObjectTemplateV1 = {
      id,
      label: STRINGS.templateDefaultLabel,
      kind: "item",
      fields: [],
      grantedActions: [],
    };
    dispatch({ type: "replace", document: withTemplates(document, [...templates, template]) });
  };
  const removeTemplate = (id: string) => {
    dispatch({
      type: "replace",
      document: withTemplates(document, templates.filter((template) => template.id !== id)),
    });
  };

  const replaceSlot = (id: string, patch: Partial<SlotDefinitionV1>) => {
    const next = slots.map((slot) => (slot.id === id ? { ...slot, ...patch } : slot));
    dispatch({ type: "replace", document: withSlots(document, next) });
  };
  const addSlot = () => {
    const used = collectUsedIds(document);
    const id = nextScopedId(used, "slot");
    const slot: SlotDefinitionV1 = { id, label: STRINGS.slotDefaultLabel, accepts: ["item"] };
    dispatch({ type: "replace", document: withSlots(document, [...slots, slot]) });
  };
  const removeSlot = (id: string) => {
    dispatch({
      type: "replace",
      document: withSlots(document, slots.filter((slot) => slot.id !== id)),
    });
  };

  return (
    <section data-testid="templates-tab" data-path="/templates">
      <section data-testid="templates-section" data-path="/templates/list">
        <header className={styles.tabHeader}>
          <h2 className={styles.tabTitle}>{STRINGS.templatesTitle}</h2>
          <Button variant="secondary" onClick={addTemplate} data-testid="templates-add-button">
            {STRINGS.addTemplate}
          </Button>
        </header>
        {templates.length === 0 ? (
          <div data-testid="templates-tab-empty">
            <EmptyState title={STRINGS.templatesEmpty} />
          </div>
        ) : (
          <ul className={styles.actionList}>
            {templates.map((template, idx) => (
              <li key={template.id} data-path={`/templates/${idx}`}>
                <TemplateDetail
                  client={client}
                  document={document}
                  dispatch={dispatch}
                  template={template}
                  onChange={(patch) => replaceTemplate(template.id, patch)}
                  onRemove={() => removeTemplate(template.id)}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
      <section data-testid="slots-section" data-path="/slots">
        <header className={styles.tabHeader}>
          <h2 className={styles.tabTitle}>{STRINGS.slotsTitle}</h2>
          <Button variant="secondary" onClick={addSlot} data-testid="slots-add-button">
            {STRINGS.addSlot}
          </Button>
        </header>
        {slots.length === 0 ? (
          <div data-testid="slots-tab-empty">
            <EmptyState title={STRINGS.slotsEmpty} />
          </div>
        ) : (
          <ul className={styles.actionList}>
            {slots.map((slot, idx) => (
              <li key={slot.id} data-path={`/slots/${idx}`}>
                <SlotDetail
                  slot={slot}
                  onChange={(patch) => replaceSlot(slot.id, patch)}
                  onRemove={() => removeSlot(slot.id)}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}

function TemplateDetail({
  client,
  document,
  dispatch,
  template,
  onChange,
  onRemove,
}: {
  client: ApiClient;
  document: SystemDocumentV1;
  dispatch: React.Dispatch<DocumentAction>;
  template: ObjectTemplateV1;
  onChange: (patch: Partial<ObjectTemplateV1>) => void;
  onRemove: () => void;
}) {
  const [fieldKind, setFieldKind] = useState<FieldV1["kind"]>("text");
  const expressions = document.expressions ?? [];

  const expressionSourceFor = (expressionId: string): string =>
    expressions.find((entry) => entry.id === expressionId)?.source ?? "";
  const hasExpression = (expressionId: string): boolean =>
    expressions.some((entry) => entry.id === expressionId);
  const commitExpressionSource = (expressionId: string, source: string) => {
    if (!hasExpression(expressionId)) return;
    dispatch({ type: "setExpressionSource", expressionId, source });
  };

  const addField = () => {
    const used = new Set(template.fields.map((f) => f.id));
    let id = "field";
    for (let i = 1; used.has(id); i++) id = `field_${i}`;
    const field = defaultField(fieldKind);
    field.id = id;
    field.label = t("editor.entity.newFieldLabel");
    onChange({ fields: [...template.fields, field] });
  };
  const replaceField = (originalFieldId: string, field: FieldV1) => {
    onChange({
      fields: template.fields.map((f) => (f.id === originalFieldId ? field : f)),
    });
  };
  const removeField = (fieldId: string) => {
    onChange({ fields: template.fields.filter((f) => f.id !== fieldId) });
  };

  const addGrantedRoll = () => {
    const used = collectUsedIds(document);
    const expressionId = nextScopedId(used, "expr");
    dispatch({
      type: "addExpression",
      expression: {
        id: expressionId,
        context: "roll",
        resultType: "number",
        source: "d20",
        fallback: 0,
      },
    });
    const action: GrantedRollActionV1 = {
      kind: "roll",
      id: nextScopedId(used, "action"),
      label: t("editor.actions.kind.roll"),
      expressionId,
      inputs: [],
      outputTemplate: "Result: {total}",
    };
    onChange({ grantedActions: [...template.grantedActions, action] });
  };
  const addGrantedResourceBump = () => {
    const used = collectUsedIds(document);
    const action: GrantedResourceBumpActionV1 = {
      kind: "resourceBump",
      id: nextScopedId(used, "action"),
      label: t("editor.actions.kind.resourceBump"),
      resourceId: "",
      operation: { kind: "delta", amount: 1 },
    };
    onChange({ grantedActions: [...template.grantedActions, action] });
  };
  const replaceGrantedAction = (actionId: string, next: GrantedActionV1) => {
    onChange({
      grantedActions: template.grantedActions.map((a) => (a.id === actionId ? next : a)),
    });
  };
  const removeGrantedAction = (actionId: string) => {
    onChange({ grantedActions: template.grantedActions.filter((a) => a.id !== actionId) });
  };

  return (
    <div data-testid={`template-row-${template.id}`}>
      <div className={styles.tabHeader}>
        <FormField label={t("editor.fields.label")}>
          <input
            id={`template-label-${template.id}`}
            type="text"
            value={template.label}
            maxLength={120}
            onChange={(e) => onChange({ label: e.target.value })}
            data-testid={`template-label-${template.id}`}
          />
        </FormField>
        <Select
          label={t("editor.entity.kind.label")}
          id={`template-kind-${template.id}`}
          value={template.kind}
          onChange={(e) => onChange({ kind: e.target.value as TemplateKind })}
          data-testid={`template-kind-${template.id}`}
          options={TEMPLATE_KINDS.map((kind) => ({ value: kind, label: kind }))}
        />
        <span data-testid={`template-id-${template.id}`}>
          {t("editor.entity.idLabel")} {template.id}
        </span>
        <Button
          variant="secondary"
          className={styles.removeButton}
          onClick={onRemove}
          data-testid={`template-remove-${template.id}`}
        >
          {t("editor.sheet.removeConfirm.confirm")}
        </Button>
      </div>
      <FormField label={STRINGS.description}>
        <input
          id={`template-description-${template.id}`}
          type="text"
          value={template.description ?? ""}
          maxLength={2000}
          onChange={(e) => onChange({ description: e.target.value })}
          data-testid={`template-description-${template.id}`}
        />
      </FormField>
      <div className={styles.tabHeader}>
        <h3 className={styles.tabTitle}>{t("editor.entities.fields")}</h3>
        <Select
          label={t("editor.entities.fieldKind")}
          id={`template-field-kind-${template.id}`}
          value={fieldKind}
          onChange={(e) => setFieldKind(e.target.value as FieldV1["kind"])}
          data-testid={`template-field-kind-picker-${template.id}`}
          options={TEMPLATE_FIELD_KINDS.map((kind) => ({
            value: kind,
            label: t(`editor.fields.kind.${kind}`),
          }))}
        />
        <Button
          variant="secondary"
          onClick={addField}
          data-testid={`template-add-field-${template.id}`}
        >
          {t("editor.entities.addField")}
        </Button>
      </div>
      <div data-testid={`template-fields-${template.id}`}>
        {template.fields.map((field) => (
          <div key={field.id}>
            <TemplateFieldEditor
              field={field}
              onChange={(next) => replaceField(field.id, next)}
            />
            <Button
              variant="secondary"
              className={styles.removeButton}
              onClick={() => removeField(field.id)}
              data-testid={`template-field-remove-${field.id}`}
            >
              {t("editor.sheet.removeConfirm.confirm")}
            </Button>
          </div>
        ))}
      </div>
      <div className={styles.tabHeader}>
        <h3 className={styles.tabTitle}>{t("editor.actions.addTitle")}</h3>
        <Button
          variant="secondary"
          onClick={addGrantedRoll}
          data-testid={`template-add-roll-${template.id}`}
        >
          {t("editor.actions.addRoll")}
        </Button>
        <Button
          variant="secondary"
          onClick={addGrantedResourceBump}
          data-testid={`template-add-resource-bump-${template.id}`}
        >
          {t("editor.actions.addResourceBump")}
        </Button>
      </div>
      <div data-testid={`template-actions-${template.id}`}>
        {template.grantedActions.map((action) =>
          action.kind === "roll" ? (
            <div key={action.id}>
              <RollActionEditor
                client={client}
                systemId="s1"
                action={action}
                onChange={(next) =>
                  replaceGrantedAction(
                    action.id,
                    action.nominal === undefined ? next : { ...next, nominal: action.nominal },
                  )
                }
                expressionSource={expressionSourceFor(action.expressionId)}
                onExpressionSourceChange={(next) => {
                  commitExpressionSource(action.expressionId, next);
                }}
                fieldTypes={templateFieldTypeMap(template)}
                guided
                diceKind={guidedDiceKindFor(expressionSourceFor(action.expressionId))}
                onDiceKindChange={
                  hasExpression(action.expressionId)
                    ? (kind) => {
                        if (kind === "custom") return;
                        commitExpressionSource(action.expressionId, kind);
                      }
                    : undefined
                }
              />
              <GrantedNominalToggle
                action={action}
                onChange={(nominal) =>
                  replaceGrantedAction(action.id, withNominal(action, nominal))
                }
              />
              <Button
                variant="secondary"
                className={styles.removeButton}
                onClick={() => removeGrantedAction(action.id)}
                data-testid={`template-action-remove-${action.id}`}
              >
                {t("editor.sheet.removeConfirm.confirm")}
              </Button>
            </div>
          ) : (
            <div key={action.id}>
              <ResourceBumpEditor
                action={action}
                onChange={(next) =>
                  replaceGrantedAction(
                    action.id,
                    action.nominal === undefined ? next : { ...next, nominal: action.nominal },
                  )
                }
                availableResources={templateResourceFields(template)}
              />
              <GrantedNominalToggle
                action={action}
                onChange={(nominal) =>
                  replaceGrantedAction(action.id, withNominal(action, nominal))
                }
              />
              <Button
                variant="secondary"
                className={styles.removeButton}
                onClick={() => removeGrantedAction(action.id)}
                data-testid={`template-action-remove-${action.id}`}
              >
                {t("editor.sheet.removeConfirm.confirm")}
              </Button>
            </div>
          ),
        )}
      </div>
    </div>
  );
}

/**
 * Set or clear the nominal flag without ever writing an explicit
 * `nominal: undefined` key (the codebase compiles with
 * `exactOptionalPropertyTypes`).
 */
function withNominal(action: GrantedActionV1, nominal: boolean | undefined): GrantedActionV1 {
  const { nominal: _current, ...base } = action;
  void _current;
  return nominal === undefined ? base : { ...base, nominal };
}

/**
 * Nominal toggle for a template-granted action. Nominal actions record
 * activity and return display text without mechanical resolution. When a
 * nominal roll keeps a `{total}` output template the total never resolves,
 * so a hint is shown (Task 5 review suggestion).
 */function GrantedNominalToggle({
  action,
  onChange,
}: {
  action: GrantedActionV1;
  onChange: (nominal: boolean | undefined) => void;
}) {
  const nominal = action.nominal === true;
  const showTotalHint =
    nominal && action.kind === "roll" && action.outputTemplate.includes("{total}");
  return (
    <div>
      <Checkbox
        label="Nominal (display only, no roll resolution)"
        checked={nominal}
        onChange={(e) => onChange(e.target.checked ? true : undefined)}
        data-testid={`template-action-nominal-${action.id}`}
      />
      {showTotalHint ? (
        <p data-testid={`template-action-nominal-hint-${action.id}`}>
          Nominal actions do not resolve {"{total}"}; use static display text.
        </p>
      ) : null}
    </div>
  );
}

/**
 * Template field editing composed from the shared field editors (same
 * components `EntityList` routes through). Computed/image kinds are not
 * offered for templates, so no expression props are needed; unknown kinds
 * render the preserved notice instead of throwing.
 */
function TemplateFieldEditor({
  field,
  onChange,
}: {
  field: FieldV1;
  onChange: (next: FieldV1) => void;
}) {
  switch (field.kind) {
    case "text":
    case "integer":
    case "decimal":
      return <ScalarFieldEditor field={field} onChange={onChange} />;
    case "boolean":
      return <BooleanFieldEditor field={field} onChange={onChange} />;
    case "singleChoice":
    case "multiChoice":
      return <ChoiceFieldEditor field={field} onChange={onChange} />;
    case "resource":
      return <ResourceFieldEditor field={field} onChange={onChange} />;
    default:
      return (
        <div data-testid={`template-field-unsupported-${field.id}`}>
          <span>
            {t("editor.entity.unsupportedPreserved", {
              label: field.label,
              kind: t(`editor.fields.kind.${(field as { kind: string }).kind}`),
            })}
          </span>
        </div>
      );
  }
}

function SlotDetail({
  slot,
  onChange,
  onRemove,
}: {
  slot: SlotDefinitionV1;
  onChange: (patch: Partial<SlotDefinitionV1>) => void;
  onRemove: () => void;
}) {
  const toggleAccepts = (kind: TemplateKind) => {
    const accepts = slot.accepts.includes(kind)
      ? slot.accepts.filter((k) => k !== kind)
      : [...slot.accepts, kind];
    onChange({ accepts });
  };
  return (
    <div data-testid={`slot-row-${slot.id}`}>
      <div className={styles.tabHeader}>
        <FormField label={t("editor.fields.label")}>
          <input
            id={`slot-label-${slot.id}`}
            type="text"
            value={slot.label}
            maxLength={120}
            onChange={(e) => onChange({ label: e.target.value })}
            data-testid={`slot-label-${slot.id}`}
          />
        </FormField>
        <span data-testid={`slot-id-${slot.id}`}>
          {t("editor.entity.idLabel")} {slot.id}
        </span>
        <Button
          variant="secondary"
          className={styles.removeButton}
          onClick={onRemove}
          data-testid={`slot-remove-${slot.id}`}
        >
          {t("editor.sheet.removeConfirm.confirm")}
        </Button>
      </div>
      <fieldset>
        <legend>{STRINGS.accepts}</legend>
        {TEMPLATE_KINDS.map((kind) => (
          <Checkbox
            key={kind}
            label={kind}
            checked={slot.accepts.includes(kind)}
            onChange={() => toggleAccepts(kind)}
            data-testid={`slot-accepts-${slot.id}-${kind}`}
          />
        ))}
      </fieldset>
      <NumberInput
        label={STRINGS.maxEntries}
        testId={`slot-max-entries-${slot.id}`}
        {...(slot.maxEntries === undefined ? {} : { value: slot.maxEntries })}
        min={1}
        max={200}
        step={1}
        optional
        onChange={(value) => {
          if (value === null) {
            const { maxEntries: _dropped, ...rest } = slot;
            void _dropped;
            onChange(rest);
          } else {
            onChange({ maxEntries: value });
          }
        }}
      />
    </div>
  );
}

/**
 * Guided dice-kind for a template roll source. Mirrors `diceKindFor`
 * (DocumentEditor): canned kind, else custom (Advanced edit). Kept local to
 * avoid a TemplatesTab <-> DocumentEditor module cycle.
 */
function guidedDiceKindFor(source: string): string {
  const base = /^(d(?:4|6|8|10|12|20))(?:\s*\+\s*fields\.[a-z][a-z0-9_]{0,63})?(?:\s*\+\s*inputs\.[a-z][a-z0-9_]{0,63})*$/.exec(source)?.[1];
  return base !== undefined && (GUIDED_DICE_KINDS as ReadonlyArray<string>).includes(base)
    ? base
    : "custom";
}

function templateFieldTypeMap(
  template: ObjectTemplateV1,
): Record<string, "number" | "text" | "boolean"> {
  const out: Record<string, "number" | "text" | "boolean"> = {};
  for (const field of template.fields) {
    if (field.kind === "integer" || field.kind === "decimal" || field.kind === "resource") {
      out[field.id] = "number";
    } else if (field.kind === "boolean") {
      out[field.id] = "boolean";
    } else if (field.kind === "text" || field.kind === "singleChoice" || field.kind === "multiChoice") {
      out[field.id] = "text";
    }
  }
  return out;
}

function templateResourceFields(
  template: ObjectTemplateV1,
): Array<Extract<FieldV1, { kind: "resource" }>> {
  return template.fields.filter(
    (field): field is Extract<FieldV1, { kind: "resource" }> => field.kind === "resource",
  );
}
