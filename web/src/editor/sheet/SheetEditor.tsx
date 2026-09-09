import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";

import { t } from "../../i18n/index.js";
import { useShortcut } from "../../shell/useShortcut.js";
import type { DefinitionId } from "../../state/documentFieldTypes.js";
import { Button, EmptyState, FormField } from "../../ui/index.js";
import { DefinitionIdInput } from "../fields/DefinitionIdInput.js";
import { SectionEditor } from "./SectionEditor.js";
import styles from "./SheetEditor.module.css";
import type { SheetEditorV1, SheetSectionV1 } from "./sheetTypes.js";

export type SheetEditorProps = {
  sheet: SheetEditorV1;
  onChange: (next: SheetEditorV1) => void;
  /**
   * Document-wide section/element-id allocators (see SectionEditor's
   * allocateElementId). Fall back to sheet-local allocation when absent.
   */
  allocateSectionId?: (() => DefinitionId) | undefined;
  allocateElementId?: (() => DefinitionId) | undefined;
};

type Focus =
  | { kind: "section"; sectionIdx: number; elementIdx: number | null }
  | null;

export function SheetEditor({ sheet, onChange, allocateSectionId, allocateElementId }: SheetEditorProps) {
  const [focus, setFocus] = useState<Focus>(null);

  const replaceSheet = (patch: Partial<SheetEditorV1>) => {
    onChange({ ...sheet, ...patch });
  };
  const replaceSection = (idx: number, section: SheetSectionV1) => {
    const next = sheet.sections.map((s, i) => (i === idx ? section : s));
    replaceSheet({ sections: next });
  };
  const removeSection = (idx: number) => {
    replaceSheet({ sections: sheet.sections.filter((_, i) => i !== idx) });
    if (focus?.kind === "section" && focus.sectionIdx === idx) setFocus(null);
  };
  const moveSection = (idx: number, delta: number) => {
    const target = idx + delta;
    if (target < 0 || target >= sheet.sections.length) return;
    const next = [...sheet.sections];
    const [item] = next.splice(idx, 1);
    if (item === undefined) return;
    next.splice(target, 0, item);
    replaceSheet({ sections: next });
    setFocus({ kind: "section", sectionIdx: target, elementIdx: null });
  };

  useShortcut("Alt+ArrowUp", () => {
    if (focus === null) return;
    if (focus.elementIdx === null) {
      moveSection(focus.sectionIdx, -1);
      return;
    }
    const section = sheet.sections[focus.sectionIdx];
    if (section === undefined) return;
    const target = focus.elementIdx - 1;
    if (target < 0) return;
    const next = [...section.elements];
    const [item] = next.splice(focus.elementIdx, 1);
    if (item === undefined) return;
    next.splice(target, 0, item);
    replaceSection(focus.sectionIdx, { ...section, elements: next });
    setFocus({
      kind: "section",
      sectionIdx: focus.sectionIdx,
      elementIdx: target,
    });
  });
  useShortcut("Alt+ArrowDown", () => {
    if (focus === null) return;
    if (focus.elementIdx === null) {
      moveSection(focus.sectionIdx, 1);
      return;
    }
    const section = sheet.sections[focus.sectionIdx];
    if (section === undefined) return;
    const target = focus.elementIdx + 1;
    if (target >= section.elements.length) return;
    const next = [...section.elements];
    const [item] = next.splice(focus.elementIdx, 1);
    if (item === undefined) return;
    next.splice(target, 0, item);
    replaceSection(focus.sectionIdx, { ...section, elements: next });
    setFocus({
      kind: "section",
      sectionIdx: focus.sectionIdx,
      elementIdx: target,
    });
  });

  const addSection = () => {
    const id = allocateSectionId?.() ?? nextSectionId(sheet.sections);
    const section: SheetSectionV1 = {
      id,
      label: defaultSectionLabel(sheet.sections),
      elements: [],
    };
    replaceSheet({ sections: [...sheet.sections, section] });
    setFocus({
      kind: "section",
      sectionIdx: sheet.sections.length,
      elementIdx: null,
    });
  };

  const sheetTotal = sheet.sections.length;
  const isSectionActive = (idx: number) =>
    focus?.kind === "section" && focus.sectionIdx === idx;
  const activeElementIdx = (idx: number) =>
    isSectionActive(idx) ? focus?.elementIdx ?? null : null;

  return (
    <section className={styles.layout} data-testid="sheet-editor">
      <header className={styles.header}>
        <div className={styles.headerRow}>
          <div className={styles.headerLabel}>
            <FormField label={t("editor.sheet.label")}>
              <input
                id={`sheet-label-${sheet.id}`}
                type="text"
                value={sheet.label}
                maxLength={120}
                onChange={(e) => replaceSheet({ label: e.target.value })}
                data-testid={`sheet-label-${sheet.id}`}
              />
            </FormField>
          </div>
          <div className={styles.elementField}>
            {t("editor.sheet.targetEntity")}
            <DefinitionIdInput
              value={sheet.targetEntityId}
              onChange={(targetEntityId) => replaceSheet({ targetEntityId })}
            />
          </div>
          <div className={styles.elementField}>
            <DefinitionIdInput
              value={sheet.id}
              onChange={(id) => replaceSheet({ id })}
            />
          </div>
          <div className={styles.headerMeta}>
            <RemoveSheetButton sheet={sheet} onRemove={() => undefined} />
          </div>
        </div>
      </header>
      <div className={styles.sectionsHeader}>
        <h3 className={styles.sectionsTitle}>{t("editor.sheet.sections")}</h3>
        <Button
          variant="secondary"
          onClick={addSection}
          data-testid="sheet-add-section"
        >
          {t("editor.sheet.addSection")}
        </Button>
      </div>
      {sheet.sections.length === 0 ? (
        <div data-testid="sheet-empty">
          <EmptyState title={t("editor.section.empty")} />
        </div>
      ) : (
        <ul className={styles.sectionsList}>
          {sheet.sections.map((section, idx) => (
            <SectionEditor
              key={section.id}
              section={section}
              position={idx + 1}
              total={sheetTotal}
              isActive={isSectionActive(idx)}
              activeElementIdx={activeElementIdx(idx)}
              onActivate={() =>
                setFocus({ kind: "section", sectionIdx: idx, elementIdx: null })
              }
              onActivateElement={(elementIdx) =>
                setFocus({
                  kind: "section",
                  sectionIdx: idx,
                  elementIdx: elementIdx === -1 ? null : elementIdx,
                })
              }
              onChange={(next) => replaceSection(idx, next)}
              onRemove={() => removeSection(idx)}
              onMoveUp={() => moveSection(idx, -1)}
              onMoveDown={() => moveSection(idx, 1)}
              allocateElementId={allocateElementId}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function RemoveSheetButton({
  sheet,
  onRemove,
}: {
  sheet: SheetEditorV1;
  onRemove: () => void;
}) {
  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>
        <Button
          variant="secondary"
          aria-label={t("editor.sheet.removeConfirm.title")}
          data-testid={`sheet-remove-${sheet.id}`}
        >
          {t("editor.sheet.removeConfirm.confirm")}
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.dialogOverlay} />
        <Dialog.Content
          className={styles.dialogContent}
          aria-describedby={undefined}
          onOpenAutoFocus={(e) => e.preventDefault()}
          data-testid="sheet-remove-confirm"
        >
          <Dialog.Title className={styles.dialogTitle}>
            {t("editor.sheet.removeConfirm.title")}
          </Dialog.Title>
          <p className={styles.dialogBody}>
            {t("editor.sheet.removeConfirm.message", { label: sheet.label })}
          </p>
          <div className={styles.dialogActions}>
            <Dialog.Close asChild>
              <Button
                variant="secondary"
                data-testid="sheet-remove-confirm-cancel"
              >
                {t("editor.sheet.removeConfirm.cancel")}
              </Button>
            </Dialog.Close>
            <Dialog.Close asChild>
              <Button
                variant="danger"
                onClick={onRemove}
                data-testid="sheet-remove-confirm-submit"
              >
                {t("editor.sheet.removeConfirm.confirm")}
              </Button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function nextSectionId(sections: SheetSectionV1[]): DefinitionId {
  for (let i = 1; i < 10_000; i++) {
    const candidate = `section_${i}`;
    if (!sections.some((s) => s.id === candidate)) return candidate;
  }
  return `section_${Date.now()}`;
}

function defaultSectionLabel(sections: SheetSectionV1[]): string {
  const base = t("editor.section.label");
  if (!sections.some((s) => s.label === base)) return base;
  for (let i = 2; i < 10_000; i++) {
    const candidate = `${base} ${i}`;
    if (!sections.some((s) => s.label === candidate)) return candidate;
  }
  return `${base} ${Date.now()}`;
}
