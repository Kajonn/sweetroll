import { t } from "../../i18n/index.js";
import type { DefinitionId } from "../../state/documentFieldTypes.js";
import { FormField, Select } from "../../ui/index.js";
import { DefinitionReferenceSelect, type ReferenceOption } from "./DefinitionReferenceSelect.js";
import styles from "./SheetEditor.module.css";
import type {
  ActionSheetElementV1,
  FieldSheetElementV1,
  HeadingSheetElementV1,
  ResourceSheetElementV1,
  SheetElementKind,
  SheetElementV1,
  SlotSheetElementV1,
} from "./sheetTypes.js";

export type ElementEditorProps = {
  element: SheetElementV1;
  onChange: (next: SheetElementV1) => void;
  definitions?: ReadonlyArray<{kind: "field" | "resource" | "action" | "slot"; id: string; label: string}>;
};

export function ElementEditor({ element, onChange, definitions = [] }: ElementEditorProps) {
  const update = (patch: Partial<SheetElementV1>) => {
    onChange({ ...element, ...patch } as SheetElementV1);
  };
  return (
    <div className={styles.elementBody}>
      <div className={styles.elementRow2}>
        <Select
          label={t("editor.element.kind")}
          id={`element-kind-${element.id}`}
          value={element.kind}
          onChange={(e) => {
            const nextKind = e.target.value as SheetElementKind;
            if (nextKind === element.kind) return;
            onChange(makeElementOfKind(nextKind, element.id));
          }}
          data-testid={`element-kind-${element.id}`}
          options={[
            { value: "heading", label: t("editor.element.kind.heading") },
            { value: "field", label: t("editor.element.kind.field") },
            { value: "resource", label: t("editor.element.kind.resource") },
            { value: "action", label: t("editor.element.kind.action") },
            { value: "slot", label: t("editor.element.kind.slot") },
          ]}
        />
      </div>
      <ElementBodyRouter element={element} onChange={update} definitions={definitions} />
    </div>
  );
}

function ElementBodyRouter({
  element,
  onChange,
  definitions,
}: {
  element: SheetElementV1;
  onChange: (patch: Partial<SheetElementV1>) => void;
  definitions: ReadonlyArray<ReferenceOption>;
}) {
  switch (element.kind) {
    case "heading":
      return <HeadingEditor element={element} onChange={onChange} />;
    case "field":
      return <FieldEditor element={element} onChange={onChange} options={definitions.filter((entry) => entry.kind === "field")} />;
    case "resource":
      return <ResourceEditor element={element} onChange={onChange} options={definitions.filter((entry) => entry.kind === "resource")} />;
    case "action":
      return <ActionEditor element={element} onChange={onChange} options={definitions.filter((entry) => entry.kind === "action")} />;
    case "slot":
      return <SlotEditor element={element} onChange={onChange} options={definitions.filter((entry) => entry.kind === "slot")} />;
    default: {
      const exhaustive: never = element;
      void exhaustive;
      return (
        <p className={styles.unsupported} data-testid="element-unsupported">
          {t("editor.element.unsupported", {
            kind: (element as { kind: string }).kind,
          })}
        </p>
      );
    }
  }
}

function HeadingEditor({
  element,
  onChange,
}: {
  element: HeadingSheetElementV1;
  onChange: (patch: Partial<HeadingSheetElementV1>) => void;
}) {
  return (
    <div className={styles.elementRow2}>
      <div className={styles.elementField}>
        <FormField label={t("editor.element.heading.text")}>
          <input
            id={`element-heading-text-${element.id}`}
            type="text"
            value={element.text}
            maxLength={200}
            onChange={(e) => onChange({ text: e.target.value })}
            placeholder={t("editor.element.heading.text.placeholder")}
            data-testid={`element-heading-text-${element.id}`}
          />
        </FormField>
      </div>
      <div className={styles.elementField}>
        <Select
          label={t("editor.element.heading.level")}
          id={`element-heading-level-${element.id}`}
          value={String(element.level)}
          onChange={(e) =>
            onChange({ level: Number(e.target.value) === 3 ? 3 : 2 })
          }
          data-testid={`element-heading-level-${element.id}`}
          options={[
            { value: "2", label: t("editor.element.heading.level.h2") },
            { value: "3", label: t("editor.element.heading.level.h3") },
          ]}
        />
      </div>
    </div>
  );
}

function FieldEditor({
  element,
  onChange,
  options,
}: {
  element: FieldSheetElementV1;
  options: ReadonlyArray<ReferenceOption>;
  onChange: (patch: Partial<FieldSheetElementV1>) => void;
}) {
  return (
    <div className={styles.elementRow2}>
      <div className={styles.elementField} data-testid={`element-binding-${element.id}`}>
        {t("editor.element.field.target")}
        <DefinitionReferenceSelect value={element.fieldId} options={options} onChange={(fieldId) => onChange({ fieldId })} label={t("editor.element.field.target")} />
      </div>
    </div>
  );
}

function ResourceEditor({
  element,
  onChange,
  options,
}: {
  element: ResourceSheetElementV1;
  options: ReadonlyArray<ReferenceOption>;
  onChange: (patch: Partial<ResourceSheetElementV1>) => void;
}) {
  return (
    <div className={styles.elementRow2}>
      <div className={styles.elementField} data-testid={`element-binding-${element.id}`}>
        {t("editor.element.resource.target")}
        <DefinitionReferenceSelect value={element.resourceId} options={options} onChange={(resourceId) => onChange({ resourceId })} label={t("editor.element.resource.target")} />
      </div>
    </div>
  );
}

function ActionEditor({
  element,
  onChange,
  options,
}: {
  element: ActionSheetElementV1;
  options: ReadonlyArray<ReferenceOption>;
  onChange: (patch: Partial<ActionSheetElementV1>) => void;
}) {
  return (
    <div className={styles.elementRow2}>
      <div className={styles.elementField} data-testid={`element-binding-${element.id}`}>
        {t("editor.element.action.target")}
        <DefinitionReferenceSelect value={element.actionId} options={options} onChange={(actionId) => onChange({ actionId })} label={t("editor.element.action.target")} />
      </div>
    </div>
  );
}

function SlotEditor({
  element,
  onChange,
  options,
}: {
  element: SlotSheetElementV1;
  options: ReadonlyArray<ReferenceOption>;
  onChange: (patch: Partial<SlotSheetElementV1>) => void;
}) {
  return (
    <div className={styles.elementRow2}>
      <div className={styles.elementField} data-testid={`element-binding-${element.id}`}>
        {t("editor.element.kind.slot")}
        <DefinitionReferenceSelect value={element.slotId} options={options} onChange={(slotId) => onChange({ slotId })} label={t("editor.element.kind.slot")} />
      </div>
    </div>
  );
}

export function makeElementOfKind(
  kind: SheetElementKind,
  id: DefinitionId,
): SheetElementV1 {
  switch (kind) {
    case "heading":
      return { kind, id, text: "", level: 2 };
    case "field":
      return { kind, id, fieldId: "" };
    case "resource":
      return { kind, id, resourceId: "" };
    case "action":
      return { kind, id, actionId: "" };
    case "slot":
      return { kind, id, slotId: "" };
  }
}
