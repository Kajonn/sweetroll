import * as Dialog from "@radix-ui/react-dialog";

import { t } from "../i18n/index.js";
import type { FieldV1 } from "../state/documentFieldTypes.js";

import { BooleanFieldEditor } from "./fields/BooleanFieldEditor.js";
import { ChoiceFieldEditor } from "./fields/ChoiceFieldEditor.js";
import { ImageFieldEditor } from "./fields/ImageFieldEditor.js";
import { ResourceFieldEditor } from "./fields/ResourceFieldEditor.js";
import { ScalarFieldEditor } from "./fields/ScalarFieldEditor.js";
import styles from "./EntityList.module.css";

export type EntityListEntity = {
  id: string;
  label: string;
  fields: FieldV1[];
};

export type EntityListProps = {
  entities: EntityListEntity[];
  onChange: (next: EntityListEntity[]) => void;
  selectedEntityId: string | null;
  onSelectEntity: (id: string | null) => void;
};

function nextEntityId(existing: EntityListEntity[]): string {
  for (let i = 1; i < 10_000; i++) {
    const candidate = `entity_${i}`;
    if (!existing.some((e) => e.id === candidate)) return candidate;
  }
  return `entity_${Date.now()}`;
}

function defaultLabel(existing: EntityListEntity[]): string {
  const base = t("editor.entity.defaultLabel");
  if (!existing.some((e) => e.label === base)) return base;
  for (let i = 2; i < 10_000; i++) {
    const candidate = `${base} ${i}`;
    if (!existing.some((e) => e.label === candidate)) return candidate;
  }
  return `${base} ${Date.now()}`;
}

export function defaultField(kind: FieldV1["kind"]): FieldV1 {
  switch (kind) {
    case "text":
      return {
        kind: "text",
        id: "name",
        label: t("editor.entity.fieldKind.text"),
        default: "",
        required: false,
        minLength: 0,
        maxLength: 120,
      };
    case "integer":
      return {
        kind: "integer",
        id: "level",
        label: t("editor.entity.fieldKind.integer"),
        default: 0,
        required: false,
        min: 0,
        max: 20,
        step: 1,
      };
    case "decimal":
      return {
        kind: "decimal",
        id: "weight",
        label: t("editor.entity.fieldKind.decimal"),
        default: 0,
        required: false,
        min: 0,
        max: 1000,
        step: 0.1,
      };
    case "boolean":
      return {
        kind: "boolean",
        id: "active",
        label: t("editor.entity.fieldKind.boolean"),
        default: false,
        required: false,
      };
    case "singleChoice":
      return {
        kind: "singleChoice",
        id: "category",
        label: t("editor.entity.fieldKind.singleChoice"),
        required: false,
        default: null,
        options: [],
      };
    case "multiChoice":
      return {
        kind: "multiChoice",
        id: "tags",
        label: t("editor.entity.fieldKind.multiChoice"),
        required: false,
        default: [],
        options: [],
      };
    case "image":
      return {
        kind: "image",
        id: "portrait",
        label: t("editor.entity.fieldKind.image"),
        required: false,
      };
    case "resource":
      return {
        kind: "resource",
        id: "resource",
        label: t("editor.entity.fieldKind.resource"),
        default: { current: 0, max: 10 },
        min: 0,
        max: 10,
        step: 1,
        resetTo: "max",
      };
    case "computed":
      return {
        kind: "computed",
        id: "computed",
        label: t("editor.entity.fieldKind.computed"),
        valueType: "number",
        expressionId: "",
      };
  }
}

function FieldEditorRouter({
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
    case "image":
      return <ImageFieldEditor field={field} onChange={onChange} />;
    case "resource":
      return <ResourceFieldEditor field={field} onChange={onChange} />;
    case "computed":
      return (
        <div className={styles.unsupported} data-testid={`field-unsupported-${field.id}`}>
          <span data-testid={`field-unsupported-summary-${field.id}`}>
            {field.label} ({t(`editor.fields.kind.${field.kind}`)})
          </span>{" "}
          <span>
            {t("editor.entity.unsupportedPreserved", {
              label: field.label,
              kind: t(`editor.fields.kind.${field.kind}`),
            })}
          </span>
        </div>
      );
  }
}

export function EntityList({
  entities,
  onChange,
  selectedEntityId,
  onSelectEntity,
}: EntityListProps) {
  const selected = entities.find((e) => e.id === selectedEntityId) ?? null;
  const replaceEntity = (id: string, patch: Partial<EntityListEntity>) => {
    const next = entities.map((e) => (e.id === id ? { ...e, ...patch } : e));
    onChange(next);
  };
  const replaceField = (entityId: string, field: FieldV1) => {
    const next = entities.map((e) => {
      if (e.id !== entityId) return e;
      const fields = e.fields.map((f) => (f.id === field.id ? field : f));
      return { ...e, fields };
    });
    onChange(next);
  };
  const addEntity = () => {
    const id = nextEntityId(entities);
    const entity: EntityListEntity = { id, label: defaultLabel(entities), fields: [] };
    onChange([...entities, entity]);
    onSelectEntity(id);
  };
  const removeEntity = (id: string) => {
    onChange(entities.filter((e) => e.id !== id));
    if (selectedEntityId === id) onSelectEntity(null);
  };
  const addField = (entityId: string) => {
    const entity = entities.find((e) => e.id === entityId);
    if (entity === undefined) return;
    const baseId = "field";
    let id = baseId;
    for (let i = 1; entity.fields.some((f) => f.id === id); i++) id = `${baseId}_${i}`;
    const field = defaultField("text");
    field.id = id;
    field.label = t("editor.entity.newFieldLabel");
    replaceEntity(entityId, { fields: [...entity.fields, field] });
  };

  return (
    <div className={styles.layout}>
      <aside className={styles.sidebar} aria-label={t("editor.entities.title")} data-testid="entity-list-sidebar">
        <header className={styles.sidebarHeader}>
          <h2 className={styles.sidebarTitle}>{t("editor.entities.title")}</h2>
          <button
            type="button"
            className={styles.addButton}
            onClick={addEntity}
            data-testid="entity-list-add"
          >
            {t("editor.entities.add")}
          </button>
        </header>
        {entities.length === 0 ? (
          <p className={styles.empty} data-testid="entity-list-empty">
            {t("editor.entities.empty")}
          </p>
        ) : (
          <ul className={styles.entityList}>
            {entities.map((entity) => {
              const isSelected = entity.id === selectedEntityId;
              const countLabel =
                entity.fields.length === 1
                  ? t("editor.entity.field")
                  : t("editor.entity.fields");
              return (
                <li
                  key={entity.id}
                  className={isSelected ? styles.entityRowActive : styles.entityRow}
                  data-testid={`entity-row-${entity.id}`}
                  data-selected={isSelected}
                >
                  <button
                    type="button"
                    className={styles.entitySelect}
                    onClick={() => onSelectEntity(entity.id)}
                    aria-current={isSelected ? "true" : undefined}
                    data-testid={`entity-row-${entity.id}-select`}
                  >
                    <span className={styles.entityLabel}>{entity.label}</span>
                    <span className={styles.entityMeta}>
                      {entity.fields.length} {countLabel}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </aside>
      <section className={styles.detail} data-testid="entity-list-detail">
        {selected === null ? (
          <p className={styles.placeholder} data-testid="entity-list-no-selection">
            {t("editor.entities.empty")}
          </p>
        ) : (
          <EntityDetail
            entity={selected}
            onChange={(patch) => replaceEntity(selected.id, patch)}
            onFieldChange={(field) => replaceField(selected.id, field)}
            onAddField={() => addField(selected.id)}
            onRemove={(id) => removeEntity(id)}
          />
        )}
      </section>
    </div>
  );
}

function EntityDetail({
  entity,
  onChange,
  onFieldChange,
  onAddField,
  onRemove,
}: {
  entity: EntityListEntity;
  onChange: (patch: Partial<EntityListEntity>) => void;
  onFieldChange: (field: FieldV1) => void;
  onAddField: () => void;
  onRemove: (id: string) => void;
}) {
  return (
    <div className={styles.detailInner}>
      <header className={styles.detailHeader}>
        <label className={styles.labelField} htmlFor={`entity-label-${entity.id}`}>
          {t("editor.fields.label")}
          <input
            id={`entity-label-${entity.id}`}
            type="text"
            value={entity.label}
            maxLength={120}
            onChange={(e) => onChange({ label: e.target.value })}
            data-testid={`entity-label-input-${entity.id}`}
          />
        </label>
        <div className={styles.detailMeta}>
          <span className={styles.monoLabel}>{t("editor.entity.idLabel")} {entity.id}</span>
          <RemoveEntityButton entity={entity} onRemove={onRemove} />
        </div>
      </header>
      <div className={styles.fieldsHeader}>
        <h3 className={styles.fieldsTitle}>{t("editor.entities.fields")}</h3>
        <button
          type="button"
          className={styles.addButton}
          onClick={onAddField}
          data-testid={`entity-add-field-${entity.id}`}
        >
          {t("editor.entities.addField")}
        </button>
      </div>
      {entity.fields.length === 0 ? (
        <p className={styles.placeholder} data-testid={`entity-fields-empty-${entity.id}`}>
          {t("editor.entities.noFields")}
        </p>
      ) : (
        <div className={styles.fieldsList}>
          {entity.fields.map((field) => (
            <div key={field.id} className={styles.fieldItem}>
              <div className={styles.fieldHeader}>
                <span className={styles.fieldKind}>{t(`editor.fields.kind.${field.kind}`)}</span>
              </div>
              <FieldEditorRouter field={field} onChange={onFieldChange} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RemoveEntityButton({
  entity,
  onRemove,
}: {
  entity: EntityListEntity;
  onRemove: (id: string) => void;
}) {
  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>
        <button
          type="button"
          className={styles.removeButton}
          aria-label={t("editor.entity.removeAria", { label: entity.label })}
          data-testid={`entity-row-${entity.id}-remove`}
        >
          {t("editor.entities.removeConfirm.confirm")}
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.dialogOverlay} />
        <Dialog.Content
          className={styles.dialogContent}
          aria-describedby={undefined}
          data-testid="entity-remove-confirm"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <Dialog.Title className={styles.dialogTitle}>
            {t("editor.entities.removeConfirm.title")}
          </Dialog.Title>
          <p className={styles.dialogBody}>
            {t("editor.entities.removeConfirm.message", { label: entity.label })}
          </p>
          <div className={styles.dialogActions}>
            <Dialog.Close asChild>
              <button
                type="button"
                className={styles.dialogCancel}
                data-testid="entity-remove-confirm-cancel"
              >
                {t("editor.entities.removeConfirm.cancel")}
              </button>
            </Dialog.Close>
            <Dialog.Close asChild>
              <button
                type="button"
                className={styles.dialogDestructive}
                onClick={() => onRemove(entity.id)}
                data-testid="entity-remove-confirm-submit"
              >
                {t("editor.entities.removeConfirm.confirm")}
              </button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
