import { t } from "../../i18n/index.js";
import type { DefinitionId } from "../../state/documentFieldTypes.js";
import { FormField, Select } from "../../ui/index.js";
import { DefinitionIdInput } from "../fields/DefinitionIdInput.js";
import styles from "./SheetEditor.module.css";
import type {
  ActionSheetElementV1,
  FieldSheetElementV1,
  HeadingSheetElementV1,
  ResourceSheetElementV1,
  SheetElementKind,
  SheetElementV1,
} from "./sheetTypes.js";

export type ElementEditorProps = {
  element: SheetElementV1;
  onChange: (next: SheetElementV1) => void;
};

export function ElementEditor({ element, onChange }: ElementEditorProps) {
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
          ]}
        />
      </div>
      <ElementBodyRouter element={element} onChange={update} />
    </div>
  );
}

function ElementBodyRouter({
  element,
  onChange,
}: {
  element: SheetElementV1;
  onChange: (patch: Partial<SheetElementV1>) => void;
}) {
  switch (element.kind) {
    case "heading":
      return <HeadingEditor element={element} onChange={onChange} />;
    case "field":
      return <FieldEditor element={element} onChange={onChange} />;
    case "resource":
      return <ResourceEditor element={element} onChange={onChange} />;
    case "action":
      return <ActionEditor element={element} onChange={onChange} />;
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
}: {
  element: FieldSheetElementV1;
  onChange: (patch: Partial<FieldSheetElementV1>) => void;
}) {
  return (
    <div className={styles.elementRow2}>
      <div className={styles.elementField} data-testid={`element-binding-${element.id}`}>
        {t("editor.element.field.target")}
        <DefinitionIdInput
          value={element.fieldId}
          onChange={(fieldId) => onChange({ fieldId })}
        />
      </div>
    </div>
  );
}

function ResourceEditor({
  element,
  onChange,
}: {
  element: ResourceSheetElementV1;
  onChange: (patch: Partial<ResourceSheetElementV1>) => void;
}) {
  return (
    <div className={styles.elementRow2}>
      <div className={styles.elementField} data-testid={`element-binding-${element.id}`}>
        {t("editor.element.resource.target")}
        <DefinitionIdInput
          value={element.resourceId}
          onChange={(resourceId) => onChange({ resourceId })}
        />
      </div>
    </div>
  );
}

function ActionEditor({
  element,
  onChange,
}: {
  element: ActionSheetElementV1;
  onChange: (patch: Partial<ActionSheetElementV1>) => void;
}) {
  return (
    <div className={styles.elementRow2}>
      <div className={styles.elementField} data-testid={`element-binding-${element.id}`}>
        {t("editor.element.action.target")}
        <DefinitionIdInput
          value={element.actionId}
          onChange={(actionId) => onChange({ actionId })}
        />
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
  }
}
