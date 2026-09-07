import { useState } from "react";

import { t } from "../i18n/index.js";
import type { CharacterSnapshot } from "./session.js";
import { FieldControl, type ProjectedField } from "./FieldControl.js";
import styles from "./characters.module.css";

export type CharacterSheetCallbacks = {
  onSetField(fieldId: string, value: unknown): void | Promise<void>;
  onBump(resourceId: string, direction: "up" | "down"): void | Promise<void>;
  onExecuteAction(actionId: string, inputs?: Record<string, unknown>): void | Promise<void>;
};

export type CharacterSheetProps = { snapshot: CharacterSnapshot } & CharacterSheetCallbacks;
type Element = NonNullable<CharacterSnapshot["confirmed"]>["projection"]["sheets"][number]["sections"][number]["elements"][number];

function tentativeValue(snapshot: CharacterSnapshot, fieldId: string): unknown | null {
  return snapshot.tentative?.[fieldId] ?? null;
}

function resourceCurrent(snapshot: CharacterSnapshot, element: Extract<Element, { kind: "resource" }>): number {
  const estimate = tentativeValue(snapshot, element.resourceId);
  if (typeof estimate !== "object" || estimate === null || Array.isArray(estimate)) return element.value.current;
  const { up = 0, down = 0 } = estimate as { up?: number; down?: number };
  return Math.max(element.min, Math.min(element.max, element.value.current + (up - down) * element.step));
}

function ActionControl({ element, disabled, onExecuteAction }: { element: Extract<Element, { kind: "action" }>; disabled: boolean; onExecuteAction: CharacterSheetCallbacks["onExecuteAction"] }) {
  const [inputs, setInputs] = useState<Record<string, unknown>>(() => Object.fromEntries(element.inputs.map(input => [input.id, input.default])));
  return <form className={styles.action} onSubmit={(event) => { event.preventDefault(); if (!disabled) onExecuteAction(element.actionId, inputs); }}>
    {element.inputs.map(input => <label key={input.id}>{input.label}<input type={input.valueType === "integer" || input.valueType === "decimal" ? "number" : input.valueType === "boolean" ? "checkbox" : "text"} required={input.required} value={input.valueType === "boolean" ? undefined : String(inputs[input.id] ?? "")} checked={input.valueType === "boolean" ? inputs[input.id] === true : undefined} onChange={(event) => setInputs(current => ({ ...current, [input.id]: input.valueType === "boolean" ? event.target.checked : input.valueType === "integer" || input.valueType === "decimal" ? Number(event.target.value) : event.target.value }))} disabled={disabled} /></label>)}
    <button type="submit" className={styles.actionButton} disabled={disabled} title={disabled ? t("character.action.offline") : undefined}>{element.label}</button>
  </form>;
}

export function CharacterSheet({ snapshot, onSetField, onBump, onExecuteAction }: CharacterSheetProps) {
  const character = snapshot.confirmed;
  if (character === null) return <section className={styles.sheet}><p>{t("character.loading")}</p></section>;
  const { projection } = character;
  const pending = snapshot.entries.length > 0;
  const editable = snapshot.editing.owned && character.lifecycle === "active";
  const actionsAvailable = editable && snapshot.phase === "ready";
  const stale = snapshot.tentative !== null;
  const renderElement = (element: Element) => {
    switch (element.kind) {
      case "heading": {
        const Heading = element.level === 2 ? "h3" : "h4";
        return <Heading key={element.id} className={element.level === 2 ? styles.heading2 : styles.heading3}>{element.text}</Heading>;
      }
      case "field": return <FieldControl key={element.id} field={element as ProjectedField} tentativeValue={tentativeValue(snapshot, element.fieldId)} disabled={!editable} pending={pending} onCommit={onSetField} />;
      case "resource": {
        const current = resourceCurrent(snapshot, element);
        return <div key={element.id} className={styles.resource}><span className={styles.resourceLabel}>{element.label}</span><span className={styles.resourceValue}>{current} / {element.value.max}</span><button type="button" disabled={!editable || current <= element.min} onClick={() => onBump(element.resourceId, "down")}>{t("character.resource.decrease", { label: element.label })}</button><button type="button" disabled={!editable || current >= element.max} onClick={() => onBump(element.resourceId, "up")}>{t("character.resource.increase", { label: element.label })}</button></div>;
      }
      case "action": return <ActionControl key={element.id} element={element} disabled={!actionsAvailable} onExecuteAction={onExecuteAction} />;
    }
  };

  return <main className={styles.sheet} aria-busy={pending}>
    <header className={styles.header}><h1>{character.name}</h1><span>{projection.entityLabel}</span><output role="status" aria-live="polite">{pending ? t("character.sync.pending") : t("character.sync.saved")}</output></header>
    {stale ? <p className={styles.stale}>{t("character.validation.stale")}</p> : null}
    {projection.sheets.map(sheet => <section key={sheet.id} className={styles.sheetSection} aria-labelledby={`sheet-${sheet.id}`}><h2 id={`sheet-${sheet.id}`}>{sheet.label}</h2>{sheet.sections.map(section => <section key={section.id} className={styles.section} aria-labelledby={`section-${section.id}`}><h3 id={`section-${section.id}`}>{section.label}</h3>{section.elements.map(renderElement)}</section>)}</section>)}
    {projection.completionFields !== undefined && projection.completionFields.length > 0 ? <section className={styles.completion} aria-labelledby="character-completion"><h2 id="character-completion">{t("character.completion.title")}</h2>{projection.completionFields.map(field => <FieldControl key={field.id} field={field} tentativeValue={tentativeValue(snapshot, field.fieldId)} disabled={!editable} pending={pending} onCommit={onSetField} />)}</section> : null}
    {snapshot.lastRoll !== null ? <section className={styles.rollResult} aria-labelledby="character-roll-result"><h2 id="character-roll-result">{t("character.rollResult.title")}</h2><dl><dt>{t("character.rollResult.expression")}</dt><dd>{snapshot.lastRoll.expression}</dd><dt>{t("character.rollResult.total")}</dt><dd>{snapshot.lastRoll.total}</dd><dt>{t("character.rollResult.output")}</dt><dd>{snapshot.lastRoll.output}</dd></dl></section> : null}
  </main>;
}
