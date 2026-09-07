import { useState } from "react";

import { t } from "../i18n/index.js";
import type { CharacterSnapshot } from "./session.js";
import { FieldControl, type ProjectedField } from "./FieldControl.js";
import styles from "./characters.module.css";

export type CharacterSheetCallbacks = {
  onSetField(fieldId: string, value: unknown): void | Promise<void>;
  onBump(resourceId: string, direction: "up" | "down"): void | Promise<void>;
  /** Optional so standalone routes can bind fields/resources without owning action execution. */
  onExecuteAction?(actionId: string, inputs?: Record<string, unknown>): void | Promise<void>;
};

export type CharacterSheetProps = { snapshot: CharacterSnapshot } & CharacterSheetCallbacks;
type Element = NonNullable<CharacterSnapshot["confirmed"]>["projection"]["sheets"][number]["sections"][number]["elements"][number];

function ValidationList({ validations }: { validations: Array<{ validationId: string; severity: "error" | "warning"; message: string }> }) {
  return validations.length > 0 ? <ul className={styles.validationList}>{validations.map(validation => <li key={validation.validationId} data-severity={validation.severity}>{validation.message}</li>)}</ul> : null;
}

function tentativeValue(snapshot: CharacterSnapshot, fieldId: string): unknown | null {
  return snapshot.tentative?.[fieldId] ?? null;
}

function resourceCurrent(snapshot: CharacterSnapshot, element: Extract<Element, { kind: "resource" }>): number {
  const estimate = tentativeValue(snapshot, element.resourceId);
  if (typeof estimate !== "object" || estimate === null || Array.isArray(estimate)) return element.value.current;
  const { up = 0, down = 0 } = estimate as { up?: number; down?: number };
  return Math.max(element.min, Math.min(element.max, element.value.current + (up - down) * element.step));
}

function ActionControl({ element, disabled, disabledReason, onExecuteAction }: { element: Extract<Element, { kind: "action" }>; disabled: boolean; disabledReason: string | null; onExecuteAction: NonNullable<CharacterSheetCallbacks["onExecuteAction"]> }) {
  const [inputs, setInputs] = useState<Record<string, unknown>>(() => Object.fromEntries(element.inputs.map(input => [input.id, input.default])));
  return <form className={styles.action} onSubmit={(event) => { event.preventDefault(); if (!disabled) onExecuteAction(element.actionId, inputs); }}>
    {element.inputs.map(input => <label key={input.id}>{input.label}<input type={input.valueType === "integer" || input.valueType === "decimal" ? "number" : input.valueType === "boolean" ? "checkbox" : "text"} required={input.required} value={input.valueType === "boolean" ? undefined : String(inputs[input.id] ?? "")} checked={input.valueType === "boolean" ? inputs[input.id] === true : undefined} onChange={(event) => setInputs(current => ({ ...current, [input.id]: input.valueType === "boolean" ? event.target.checked : input.valueType === "integer" || input.valueType === "decimal" ? Number(event.target.value) : event.target.value }))} disabled={disabled} aria-describedby={disabledReason === null ? undefined : "character-action-unavailable"} /></label>)}
    <button type="submit" className={styles.actionButton} disabled={disabled} aria-describedby={disabledReason === null ? undefined : "character-action-unavailable"}>{element.label}</button>
    <ValidationList validations={element.validations} />
  </form>;
}

function audienceLabel(audience: NonNullable<CharacterSnapshot["lastRoll"]>["audience"]): string {
  return t(`character.rollResult.audience.${audience}`);
}

function RollResult({ roll }: { roll: NonNullable<CharacterSnapshot["lastRoll"]> }) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  return <section className={styles.rollResult} aria-labelledby="character-roll-result"><h2 id="character-roll-result">{t("character.rollResult.title")}</h2><dl><dt>{t("character.rollResult.expression")}</dt><dd>{roll.expression}</dd><dt>{t("character.rollResult.total")}</dt><dd>{roll.total}</dd><dt>{t("character.rollResult.output")}</dt><dd>{roll.output}</dd><dt>{t("character.rollResult.audience")}</dt><dd>{audienceLabel(roll.audience)}</dd></dl><button type="button" className={styles.detailButton} onClick={() => setDetailsOpen(open => !open)} aria-expanded={detailsOpen}>{t(detailsOpen ? "character.rollResult.hideDetails" : "character.rollResult.showDetails")}</button>{detailsOpen ? <div className={styles.rollDetails}><ul>{roll.dice.map((die, index) => <li key={`${die.sides}-${index}`}>d{die.sides}={die.value}</li>)}</ul><ul>{roll.bindings.map(binding => <li key={`${binding.scope}-${binding.definitionId}`}>{binding.scope}.{binding.definitionId}: {String(binding.value)}</li>)}</ul></div> : null}</section>;
}

export function CharacterSheet({ snapshot, onSetField, onBump, onExecuteAction }: CharacterSheetProps) {
  const character = snapshot.confirmed;
  if (character === null) return <section className={styles.sheet}><p>{t("character.loading")}</p></section>;
  const { projection } = character;
  const pending = snapshot.entries.length > 0;
  const editable = snapshot.editing.owned && character.lifecycle === "active";
  const executeAction = onExecuteAction ?? (() => {});
  const actionsAvailable = editable && snapshot.phase === "ready" && onExecuteAction !== undefined;
  const actionUnavailableReason = snapshot.phase === "offline"
    ? t("character.action.offline")
    : character.lifecycle === "archived"
      ? t("character.action.archived")
      : !snapshot.editing.owned
        ? t("character.action.readOnly")
        : snapshot.phase !== "ready"
          ? t("character.action.unavailable")
          : null;
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
        return <div key={element.id} className={styles.resourceGroup}><div className={styles.resource}><span className={styles.resourceLabel}>{element.label}</span><span className={styles.resourceValue}>{current} / {element.value.max}</span><button type="button" disabled={!editable || current <= element.min} onClick={() => onBump(element.resourceId, "down")}>{t("character.resource.decrease", { label: element.label })}</button><button type="button" disabled={!editable || current >= element.max} onClick={() => onBump(element.resourceId, "up")}>{t("character.resource.increase", { label: element.label })}</button></div><ValidationList validations={element.validations} /></div>;
      }
      case "action": return <ActionControl key={element.id} element={element} disabled={!actionsAvailable} disabledReason={actionUnavailableReason} onExecuteAction={executeAction} />;
    }
  };

  return <main className={styles.sheet} aria-busy={pending}>
    <header className={styles.header}><h1>{character.name}</h1><span>{projection.entityLabel}</span><output role="status" aria-live="polite">{pending ? t("character.sync.pending") : t("character.sync.saved")}</output></header>
    {stale ? <p className={styles.stale}>{t("character.validation.stale")}</p> : null}
    {actionUnavailableReason !== null ? <p id="character-action-unavailable" className={styles.actionUnavailable}>{actionUnavailableReason}</p> : null}
    {projection.sheets.map(sheet => <section key={sheet.id} className={styles.sheetSection} aria-labelledby={`sheet-${sheet.id}`}><h2 id={`sheet-${sheet.id}`}>{sheet.label}</h2>{sheet.sections.map(section => <section key={section.id} className={styles.section} aria-labelledby={`section-${section.id}`}><h3 id={`section-${section.id}`}>{section.label}</h3>{section.elements.map(renderElement)}</section>)}</section>)}
    {projection.completionFields === undefined ? <p className={styles.completionUnavailable}>{t("character.completion.unavailable")}</p> : projection.completionFields.length > 0 ? <section className={styles.completion} aria-labelledby="character-completion"><h2 id="character-completion" tabIndex={-1}>{t("character.completion.title")}</h2>{projection.completionFields.map(field => <FieldControl key={field.id} field={field} tentativeValue={tentativeValue(snapshot, field.fieldId)} disabled={!editable} pending={pending} onCommit={onSetField} />)}</section> : null}
    {snapshot.lastRoll !== null ? <RollResult roll={snapshot.lastRoll} /> : null}
  </main>;
}
