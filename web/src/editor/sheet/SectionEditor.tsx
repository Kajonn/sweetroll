import * as Dialog from "@radix-ui/react-dialog";

import { t } from "../../i18n/index.js";
import { useShortcut } from "../../shell/useShortcut.js";
import type { DefinitionId } from "../../state/documentFieldTypes.js";
import { DefinitionIdInput } from "../fields/DefinitionIdInput.js";
import { ElementEditor, makeElementOfKind } from "./ElementEditor.js";
import styles from "./SheetEditor.module.css";
import type {
  SheetElementKind,
  SheetElementV1,
  SheetSectionV1,
} from "./sheetTypes.js";

export type SectionEditorProps = {
  section: SheetSectionV1;
  position: number;
  total: number;
  isActive: boolean;
  activeElementIdx: number | null;
  onActivate: () => void;
  onActivateElement: (elementIdx: number) => void;
  onChange: (next: SheetSectionV1) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
};

export function SectionEditor({
  section,
  position,
  total,
  isActive,
  activeElementIdx,
  onActivate,
  onActivateElement,
  onChange,
  onRemove,
  onMoveUp,
  onMoveDown,
}: SectionEditorProps) {
  const replaceSection = (patch: Partial<SheetSectionV1>) => {
    onChange({ ...section, ...patch });
  };
  const replaceElement = (idx: number, element: SheetElementV1) => {
    const next = section.elements.map((el, i) => (i === idx ? element : el));
    replaceSection({ elements: next });
  };
  const removeElement = (idx: number) => {
    replaceSection({ elements: section.elements.filter((_, i) => i !== idx) });
    if (activeElementIdx === idx) onActivateElement(-1);
  };
  const moveElement = (idx: number, delta: number) => {
    const target = idx + delta;
    if (target < 0 || target >= section.elements.length) return;
    const next = [...section.elements];
    const [item] = next.splice(idx, 1);
    if (item === undefined) return;
    next.splice(target, 0, item);
    replaceSection({ elements: next });
    onActivateElement(target);
  };

  useShortcut("Alt+ArrowUp", () => {
    if (!isActive) return;
    if (activeElementIdx === null) {
      onMoveUp();
      return;
    }
    moveElement(activeElementIdx, -1);
  });
  useShortcut("Alt+ArrowDown", () => {
    if (!isActive) return;
    if (activeElementIdx === null) {
      onMoveDown();
      return;
    }
    moveElement(activeElementIdx, 1);
  });

  const addElement = (kind: SheetElementKind) => {
    const id = nextElementId(section.elements);
    const element = makeElementOfKind(kind, id);
    replaceSection({ elements: [...section.elements, element] });
    onActivateElement(section.elements.length);
  };

  const atFirst = position === 1;
  const atLast = position === total;
  const sectionRowId = `section-row-${section.id}`;

  return (
    <li
      className={styles.sectionCard}
      data-testid={sectionRowId}
      data-active={isActive}
    >
      <div className={styles.sectionHeader}>
        <button
          type="button"
          className={isActive ? styles.handleButtonActive : styles.handleButton}
          onClick={onActivate}
          aria-label={t("editor.sheet.positionAria", {
            position,
            total,
          })}
          data-testid={`${sectionRowId}-handle`}
        >
          <span
            className={styles.positionBadge}
            data-testid={`${sectionRowId}-position`}
          >
            {position}
          </span>
          {section.label || t("editor.section.label")}
        </button>
        <button
          type="button"
          className={styles.moveButton}
          onClick={onMoveUp}
          disabled={atFirst}
          aria-label={t("editor.sheet.moveUp")}
          title={t("editor.sheet.moveUp.shortcut")}
          data-testid={`${sectionRowId}-move-up`}
        >
          {t("editor.sheet.moveUp")}
        </button>
        <button
          type="button"
          className={styles.moveButton}
          onClick={onMoveDown}
          disabled={atLast}
          aria-label={t("editor.sheet.moveDown")}
          title={t("editor.sheet.moveDown.shortcut")}
          data-testid={`${sectionRowId}-move-down`}
        >
          {t("editor.sheet.moveDown")}
        </button>
        <div className={styles.sectionMeta}>
          <span className={styles.monoLabel}>id: {section.id}</span>
          <RemoveSectionButton section={section} onRemove={onRemove} />
        </div>
      </div>
      <div className={styles.elementRow2}>
        <label
          className={styles.sectionLabel}
          htmlFor={`section-label-${section.id}`}
        >
          {t("editor.section.label")}
          <input
            id={`section-label-${section.id}`}
            type="text"
            value={section.label}
            maxLength={120}
            onChange={(e) => replaceSection({ label: e.target.value })}
            data-testid={`section-label-${section.id}`}
          />
        </label>
        <div className={styles.elementField}>
          <DefinitionIdInput
            value={section.id}
            onChange={(id) => replaceSection({ id })}
          />
        </div>
      </div>
      <div className={styles.elementsHeader}>
        <h4 className={styles.elementsTitle}>{t("editor.section.elements")}</h4>
      </div>
      {section.elements.length === 0 ? (
        <p
          className={styles.empty}
          data-testid={`${sectionRowId}-elements-empty`}
        >
          {t("editor.section.empty")}
        </p>
      ) : (
        <ul className={styles.elementsList}>
          {section.elements.map((element, idx) => {
            const isElementActive =
              isActive && activeElementIdx === idx;
            const atFirstElement = idx === 0;
            const atLastElement = idx === section.elements.length - 1;
            const elementRowId = `element-row-${section.id}-${idx}`;
            return (
              <li
                key={element.id}
                className={styles.elementCard}
                data-testid={elementRowId}
                data-active={isElementActive}
              >
                <div className={styles.elementRow}>
                  <button
                    type="button"
                    className={
                      isElementActive
                        ? styles.handleButtonActive
                        : styles.handleButton
                    }
                    onClick={() => onActivateElement(idx)}
                    aria-label={t("editor.sheet.positionAria", {
                      position: idx + 1,
                      total: section.elements.length,
                    })}
                    data-testid={`${elementRowId}-handle`}
                  >
                    <span
                      className={styles.positionBadge}
                      data-testid={`${elementRowId}-position`}
                    >
                      {idx + 1}
                    </span>
                    <span className={styles.kindBadge}>
                      {t(`editor.element.kind.${element.kind}`)}
                    </span>
                  </button>
                  <button
                    type="button"
                    className={styles.moveButton}
                    onClick={() => moveElement(idx, -1)}
                    disabled={atFirstElement}
                    aria-label={t("editor.sheet.moveUp")}
                    title={t("editor.sheet.moveUp.shortcut")}
                    data-testid={`${elementRowId}-move-up`}
                  >
                    {t("editor.sheet.moveUp")}
                  </button>
                  <button
                    type="button"
                    className={styles.moveButton}
                    onClick={() => moveElement(idx, 1)}
                    disabled={atLastElement}
                    aria-label={t("editor.sheet.moveDown")}
                    title={t("editor.sheet.moveDown.shortcut")}
                    data-testid={`${elementRowId}-move-down`}
                  >
                    {t("editor.sheet.moveDown")}
                  </button>
                  <div className={styles.elementMeta}>
                    <span className={styles.monoLabel}>id: {element.id}</span>
                    <RemoveElementButton
                      element={element}
                      sectionId={section.id}
                      idx={idx}
                      onRemove={() => removeElement(idx)}
                    />
                  </div>
                </div>
                <ElementEditor
                  element={element}
                  onChange={(next) => replaceElement(idx, next)}
                />
              </li>
            );
          })}
        </ul>
      )}
      <div className={styles.elementsHeader}>
        <h4 className={styles.elementsTitle}>
          {t("editor.section.addElement")}
        </h4>
      </div>
      <div className={styles.addElementPicker} data-testid={`${sectionRowId}-add-element`}>
        <AddElementButton
          sectionId={section.id}
          kind="heading"
          onClick={() => addElement("heading")}
        />
        <AddElementButton
          sectionId={section.id}
          kind="field"
          onClick={() => addElement("field")}
        />
        <AddElementButton
          sectionId={section.id}
          kind="resource"
          onClick={() => addElement("resource")}
        />
        <AddElementButton
          sectionId={section.id}
          kind="action"
          onClick={() => addElement("action")}
        />
      </div>
    </li>
  );
}

function nextElementId(elements: SheetElementV1[]): DefinitionId {
  for (let i = 1; i < 10_000; i++) {
    const candidate = `element_${i}`;
    if (!elements.some((e) => e.id === candidate)) return candidate;
  }
  return `element_${Date.now()}`;
}

function AddElementButton({
  sectionId,
  kind,
  onClick,
}: {
  sectionId: DefinitionId;
  kind: SheetElementKind;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={styles.kindPick}
      onClick={onClick}
      data-testid={`section-add-element-${kind}-${sectionId}`}
    >
      {t(`editor.element.kind.${kind}`)}
    </button>
  );
}

function RemoveSectionButton({
  section,
  onRemove,
}: {
  section: SheetSectionV1;
  onRemove: () => void;
}) {
  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>
        <button
          type="button"
          className={styles.removeButton}
          aria-label={t("editor.sheet.removeConfirm.title")}
          data-testid={`section-row-${section.id}-remove`}
        >
          {t("editor.sheet.removeConfirm.confirm")}
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.dialogOverlay} />
        <Dialog.Content
          className={styles.dialogContent}
          aria-describedby={undefined}
          onOpenAutoFocus={(e) => e.preventDefault()}
          data-testid="section-remove-confirm"
        >
          <Dialog.Title className={styles.dialogTitle}>
            {t("editor.section.removeConfirm.title")}
          </Dialog.Title>
          <p className={styles.dialogBody}>
            {t("editor.section.removeConfirm.message", { label: section.label })}
          </p>
          <div className={styles.dialogActions}>
            <Dialog.Close asChild>
              <button
                type="button"
                className={styles.dialogCancel}
                data-testid="section-remove-confirm-cancel"
              >
                {t("editor.section.removeConfirm.cancel")}
              </button>
            </Dialog.Close>
            <Dialog.Close asChild>
              <button
                type="button"
                className={styles.dialogDestructive}
                onClick={onRemove}
                data-testid="section-remove-confirm-submit"
              >
                {t("editor.section.removeConfirm.confirm")}
              </button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function RemoveElementButton({
  element,
  sectionId,
  idx,
  onRemove,
}: {
  element: SheetElementV1;
  sectionId: DefinitionId;
  idx: number;
  onRemove: () => void;
}) {
  const testId = `element-row-${sectionId}-${idx}-remove`;
  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>
        <button
          type="button"
          className={styles.removeButton}
          aria-label={t("editor.element.removeConfirm.title")}
          data-testid={testId}
        >
          {t("editor.element.removeConfirm.confirm")}
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.dialogOverlay} />
        <Dialog.Content
          className={styles.dialogContent}
          aria-describedby={undefined}
          onOpenAutoFocus={(e) => e.preventDefault()}
          data-testid="element-remove-confirm"
        >
          <Dialog.Title className={styles.dialogTitle}>
            {t("editor.element.removeConfirm.title")}
          </Dialog.Title>
          <p className={styles.dialogBody}>
            {t("editor.element.removeConfirm.message", {
              kind: t(`editor.element.kind.${element.kind}`),
            })}
          </p>
          <div className={styles.dialogActions}>
            <Dialog.Close asChild>
              <button
                type="button"
                className={styles.dialogCancel}
                data-testid="element-remove-confirm-cancel"
              >
                {t("editor.element.removeConfirm.cancel")}
              </button>
            </Dialog.Close>
            <Dialog.Close asChild>
              <button
                type="button"
                className={styles.dialogDestructive}
                onClick={onRemove}
                data-testid="element-remove-confirm-submit"
              >
                {t("editor.element.removeConfirm.confirm")}
              </button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
