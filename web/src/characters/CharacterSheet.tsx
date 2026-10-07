import { useState } from "react";

import { t } from "../i18n/index.js";
import { Button } from "../ui/Button.js";
import type { CharacterSnapshot } from "./session.js";
import { FieldControl, type ProjectedField } from "./FieldControl.js";
import { SlotListControl, type SlotTemplate } from "./SlotListControl.js";
import styles from "./characters.module.css";

export type CharacterSheetCallbacks = {
  onSetField(fieldId: string, value: unknown): void | Promise<void>;
  onBump(resourceId: string, direction: "up" | "down"): void | Promise<void>;
  /** Optional so standalone routes can bind fields/resources without owning action execution. */
  onExecuteAction?(actionId: string, inputs?: Record<string, unknown>): void | Promise<void>;
  /**
   * Task 7: entry intents. Optional like onExecuteAction; slot controls
   * disable while any entry callback is absent.
   */
  onAddEntry?(slotId: string, templateId: string | null, values: Record<string, unknown>, quantity?: number): void | Promise<void>;
  onRemoveEntry?(entryId: string): void | Promise<void>;
  onUpdateEntry?(entryId: string, values: Record<string, unknown>, quantity?: number): void | Promise<void>;
  onExecuteGranted?(entryId: string, actionId: string, inputs?: Record<string, unknown>): void | Promise<void>;
};

export type CharacterSheetProps = { snapshot: CharacterSnapshot } & CharacterSheetCallbacks & {
  /** Offline availability once determined; omitted while unknown. */
  offlineAvailable?: boolean | undefined;
  /** Template catalog for slot pickers and granted-action buttons; omitted while unknown. */
  templates?: SlotTemplate[] | undefined;
};
type Element = NonNullable<CharacterSnapshot["confirmed"]>["projection"]["sheets"][number]["sections"][number]["elements"][number];

function ValidationList({ validations }: { validations: Array<{ validationId: string; severity: "error" | "warning"; message: string }> }) {
  return validations.length > 0 ? <ul className={styles.validationList}>{validations.map(validation => <li key={validation.validationId} data-severity={validation.severity}>{validation.message}</li>)}</ul> : null;
}

function tentativeValue(snapshot: CharacterSnapshot, fieldId: string): unknown | null {
  return snapshot.tentative?.[fieldId] ?? null;
}

function resourceCurrent(snapshot: CharacterSnapshot, element: Extract<Element, { kind: "resource" }>): number {
  const estimate = tentativeValue(snapshot, element.resourceId);
  // Estimates are sequential bounded numbers produced by the session over
  // ordered intentions; clamp defensively and fall back to confirmed current.
  if (typeof estimate === "number") return Math.max(element.min, Math.min(element.max, estimate));
  return element.value.current;
}

function resourceEstimateActive(snapshot: CharacterSnapshot): boolean {
  if (snapshot.tentative === null || snapshot.confirmed === null) return false;
  const resourceIds = new Set<string>();
  for (const sheet of snapshot.confirmed.projection.sheets) {
    for (const section of sheet.sections) {
      for (const element of section.elements) {
        if (element.kind === "resource") resourceIds.add(element.resourceId);
      }
    }
  }
  return Object.entries(snapshot.tentative).some(([key, value]) => typeof value === "number" && resourceIds.has(key));
}

/** Truthful sync state: never report "Saved" while blocked, uncertain or purged. */
function syncStatusText(snapshot: CharacterSnapshot, pending: boolean): string {
  if (snapshot.phase === "loading") return t("character.sync.loading");
  if (snapshot.phase === "purged" || snapshot.error?.kind === "purged") return t("character.sync.purged");
  if (snapshot.error !== null) {
    switch (snapshot.error.kind) {
      case "conflict":
      case "expired-attempt":
      case "protocol":
      case "not-found":
        return t("character.sync.needsReview");
      case "invalid":
        return t("character.sync.invalid");
      case "reauthenticate":
        return t("character.sync.reauthenticate");
      case "storage-error":
        return t("character.sync.storageError");
      case "network-unavailable":
        break;
    }
  }
  switch (snapshot.phase) {
    case "uncertain":
      return t("character.sync.uncertain");
    case "sending":
      return t("character.sync.sending");
    default:
      return pending ? t("character.sync.pending") : t("character.sync.saved");
  }
}

function describeCommandError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return t("character.command.failed", { message });
}

function ActionControl({ element, disabled, disabledReason, onExecuteAction }: { element: Extract<Element, { kind: "action" }>; disabled: boolean; disabledReason: string | null; onExecuteAction: NonNullable<CharacterSheetCallbacks["onExecuteAction"]> }) {
  const [inputs, setInputs] = useState<Record<string, unknown>>(() => Object.fromEntries(element.inputs.map(input => [input.id, input.default])));
  const [commandError, setCommandError] = useState<string | null>(null);
  return <form className={styles.action} onSubmit={(event) => {
    event.preventDefault();
    if (disabled) return;
    // Catch rejected UI command promises locally: surface them persistently
    // and keep the entered inputs instead of dropping them or rejecting
    // without handling.
    setCommandError(null);
    let result: void | Promise<void>;
    try {
      result = onExecuteAction(element.actionId, inputs);
    } catch (error) {
      setCommandError(describeCommandError(error));
      return;
    }
    if (result !== undefined && result !== null && typeof (result as Promise<void>).then === "function") {
      (result as Promise<void>).then(undefined, (error: unknown) => setCommandError(describeCommandError(error)));
    }
  }}>
    {element.inputs.map(input => <label key={input.id}>{input.label}<input type={input.valueType === "integer" || input.valueType === "decimal" ? "number" : input.valueType === "boolean" ? "checkbox" : "text"} required={input.required} value={input.valueType === "boolean" ? undefined : String(inputs[input.id] ?? "")} checked={input.valueType === "boolean" ? inputs[input.id] === true : undefined} onChange={(event) => setInputs(current => ({ ...current, [input.id]: input.valueType === "boolean" ? event.target.checked : input.valueType === "integer" || input.valueType === "decimal" ? Number(event.target.value) : event.target.value }))} disabled={disabled} aria-describedby={disabledReason === null ? undefined : "character-action-unavailable"} /></label>)}
    <Button type="submit" variant="primary" disabled={disabled} aria-describedby={disabledReason === null ? undefined : "character-action-unavailable"}>{element.label}</Button>
    {commandError !== null ? <p role="alert" className={styles.commandError}>{commandError}</p> : null}
    <ValidationList validations={element.validations} />
  </form>;
}

function audienceLabel(audience: NonNullable<CharacterSnapshot["lastRoll"]>["audience"]): string {
  return t(`character.rollResult.audience.${audience}`);
}

function RollResult({ roll, fieldLabels }: { roll: NonNullable<CharacterSnapshot["lastRoll"]>; fieldLabels: ReadonlyMap<string, string> }) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const expression = roll.expression.replace(/\bfields\.([A-Za-z_][A-Za-z0-9_]*)\b/g, (reference, fieldId: string) => fieldLabels.get(fieldId) ?? reference);
  return <section className={styles.rollResult} aria-labelledby="character-roll-result"><h2 id="character-roll-result">{t("character.rollResult.title")}</h2><dl><dt>{t("character.rollResult.expression")}</dt><dd>{expression}</dd><dt>{t("character.rollResult.total")}</dt><dd>{roll.total}</dd><dt>{t("character.rollResult.output")}</dt><dd>{roll.output}</dd><dt>{t("character.rollResult.audience")}</dt><dd>{audienceLabel(roll.audience)}</dd></dl><Button variant="secondary" onClick={() => setDetailsOpen(open => !open)} aria-expanded={detailsOpen}>{t(detailsOpen ? "character.rollResult.hideDetails" : "character.rollResult.showDetails")}</Button>{detailsOpen ? <div className={styles.rollDetails}><ul>{roll.dice.map((die, index) => <li key={`${die.sides}-${index}`}>d{die.sides}={die.value}</li>)}</ul><ul>{roll.bindings.map(binding => <li key={`${binding.scope}-${binding.definitionId}`}>{binding.scope === "fields" ? fieldLabels.get(binding.definitionId) ?? `${binding.scope}.${binding.definitionId}` : `${binding.scope}.${binding.definitionId}`}: {String(binding.value)}</li>)}</ul></div> : null}</section>;
}

export function CharacterSheet({ snapshot, onSetField, onBump, onExecuteAction, onAddEntry, onRemoveEntry, onUpdateEntry, onExecuteGranted, offlineAvailable, templates }: CharacterSheetProps) {
  const character = snapshot.confirmed;
  const [commandError, setCommandError] = useState<string | null>(null);
  // A purged snapshot carries no private content: the session nulls
  // confirmed/tentative/entries on purge, so report availability only.
  if (character === null) {
    if (snapshot.phase === "purged" || snapshot.error?.kind === "purged") {
      return <section className={styles.sheet}><p role="status">{t("character.sync.purged")}</p></section>;
    }
    return <section className={styles.sheet}><p>{t("character.loading")}</p></section>;
  }
  const { projection } = character;
  const fieldLabels = new Map<string, string>();
  for (const field of projection.completionFields ?? []) fieldLabels.set(field.fieldId, field.label);
  for (const sheet of projection.sheets) {
    for (const section of sheet.sections) {
      for (const element of section.elements) {
        if (element.kind === "field") fieldLabels.set(element.fieldId, element.label);
      }
    }
  }
  const pending = snapshot.entries.length > 0;
  // Blocked edits stay disabled: a conflict/invalid/reauthenticate/
  // storage-error/purged pause must never look editable. A bare
  // network-unavailable (e.g. a failed refresh) still allows durable
  // offline field sets and resource bumps.
  const blocked = snapshot.error !== null && snapshot.error.kind !== "network-unavailable";
  const editable = snapshot.editing.owned && character.lifecycle === "active" && !blocked;
  const invokeCommand = (invoke: () => void | Promise<void>) => {
    setCommandError(null);
    let result: void | Promise<void>;
    try {
      result = invoke();
    } catch (error) {
      setCommandError(describeCommandError(error));
      return;
    }
    if (result !== undefined && result !== null && typeof (result as Promise<void>).then === "function") {
      (result as Promise<void>).then(undefined, (error: unknown) => setCommandError(describeCommandError(error)));
    }
  };
  const executeAction = onExecuteAction ?? (() => {});
  const actionsAvailable = editable && snapshot.phase === "ready" && onExecuteAction !== undefined;
  const actionUnavailableReason = onExecuteAction === undefined
    ? t("character.action.unavailable")
    : snapshot.phase === "offline"
      ? t("character.action.offline")
    : character.lifecycle === "archived"
      ? t("character.action.archived")
      : !snapshot.editing.owned
        ? t("character.action.readOnly")
        : snapshot.phase !== "ready"
          ? t("character.action.unavailable")
          : null;
  const stale = snapshot.tentative !== null;
  const nominal = snapshot.lastNominal;
  const nominalLabel = nominal === null
    ? null
    : templates?.flatMap((template) => template.grantedActions).find((action) => action.id === nominal.actionId)?.label ?? null;
  const showEstimateNote = resourceEstimateActive(snapshot);
  // Last-confirmed diagnostics: derived values, validations and bounds stay
  // exactly as the server projected them; only field/resource inputs carry
  // tentative estimates.
  const seenDiagnostics = new Set<string>();
  const diagnostics = [...character.validations, ...projection.validations].filter(validation =>
    seenDiagnostics.has(validation.validationId) ? false : (seenDiagnostics.add(validation.validationId), true));
  const renderElement = (element: Element) => {
    switch (element.kind) {
      case "heading": {
        const Heading = element.level === 2 ? "h3" : "h4";
        return <Heading key={element.id} className={element.level === 2 ? styles.heading2 : styles.heading3}>{element.text}</Heading>;
      }
      case "field": return <FieldControl key={element.id} field={element as ProjectedField} tentativeValue={tentativeValue(snapshot, element.fieldId)} disabled={!editable} pending={pending} onCommit={onSetField} />;
      case "resource": {
        const current = resourceCurrent(snapshot, element);
        return <div key={element.id} className={styles.resourceGroup}><div className={styles.resource}><span className={styles.resourceLabel}>{element.label}</span><span className={styles.resourceValue}>{current} / {element.value.max}</span><Button variant="primary" disabled={!editable || current <= element.min} onClick={() => invokeCommand(() => onBump(element.resourceId, "down"))}>{t("character.resource.decrease", { label: element.label })}</Button><Button variant="primary" disabled={!editable || current >= element.max} onClick={() => invokeCommand(() => onBump(element.resourceId, "up"))}>{t("character.resource.increase", { label: element.label })}</Button></div><ValidationList validations={element.validations} /></div>;
      }
      case "slot": {
        // Synthetic granted-action elements (action with entryId) are owned
        // by the slot control below, which resolves them against the
        // template catalog; the action branch skips them.
        const entriesEditable = editable
          && onAddEntry !== undefined
          && onRemoveEntry !== undefined
          && onUpdateEntry !== undefined;
        return <SlotListControl
          key={element.id}
          slotId={element.slotId}
          label={element.label}
          accepts={[...element.accepts]}
          entries={element.entries.map((entry) => ({ ...entry, values: { ...entry.values } }))}
          templates={templates ?? []}
          disabled={!entriesEditable}
          actionsDisabled={!(editable && snapshot.phase === "ready" && onExecuteGranted !== undefined)}
          onAddEntry={onAddEntry ?? (async () => {})}
          onRemoveEntry={onRemoveEntry ?? (async () => {})}
          onUpdateEntry={onUpdateEntry ?? (async () => {})}
          onExecuteGranted={async (entryId, actionId, inputs) => invokeCommand(() => (onExecuteGranted ?? (async () => {}))(entryId, actionId, inputs))}
        />;
      }
      case "action": {
        if (element.entryId !== undefined) return null;
        return <ActionControl key={element.id} element={element} disabled={!actionsAvailable} disabledReason={actionUnavailableReason} onExecuteAction={executeAction} />;
      }
    }
  };

  return <main className={styles.sheet} aria-busy={pending}>
    <header className={styles.header}><h1>{character.name}</h1><span>{projection.entityLabel}</span><p className={styles.meta}>{t("character.header.version", { version: character.systemVersionId })} · {t(character.lifecycle === "archived" ? "character.lifecycle.archived" : "character.lifecycle.active")}</p><output role="status" aria-live="polite">{syncStatusText(snapshot, pending)}</output>{commandError !== null ? <p role="alert" className={styles.commandError}>{commandError}</p> : null}{offlineAvailable === undefined ? null : <p role="status">{t(offlineAvailable ? "character.offline.available" : "character.offline.unavailable")}</p>}</header>
    {stale ? <p className={styles.stale}>{t("character.validation.stale")}</p> : null}
    {showEstimateNote ? <p className={styles.estimateNote}>{t("character.estimate.note")}</p> : null}
    {actionUnavailableReason !== null ? <p id="character-action-unavailable" className={styles.actionUnavailable}>{actionUnavailableReason}</p> : null}
    {diagnostics.length > 0 ? <section className={styles.diagnostics} aria-labelledby="character-diagnostics"><h2 id="character-diagnostics">{t("character.diagnostics.title")}</h2><ValidationList validations={diagnostics} /></section> : null}
    {projection.sheets.map(sheet => <section key={sheet.id} className={styles.sheetSection} aria-labelledby={`sheet-${sheet.id}`}><h2 id={`sheet-${sheet.id}`}>{sheet.label}</h2>{sheet.sections.map(section => <section key={section.id} className={styles.section} aria-labelledby={`section-${section.id}`}><h3 id={`section-${section.id}`}>{section.label}</h3>{section.elements.filter((element, index) => !(index === 0 && element.kind === "heading" && element.text.trim() === section.label.trim())).map(renderElement)}</section>)}</section>)}
    {projection.completionFields === undefined ? <p className={styles.completionUnavailable}>{t("character.completion.unavailable")}</p> : projection.completionFields.length > 0 ? <section className={styles.completion} aria-labelledby="character-completion"><h2 id="character-completion" tabIndex={-1}>{t("character.completion.title")}</h2>{projection.completionFields.map(field => <FieldControl key={field.id} field={field} tentativeValue={tentativeValue(snapshot, field.fieldId)} disabled={!editable} pending={pending} onCommit={onSetField} />)}</section> : null}
    {nominal !== null ? <section className={styles.nominalResult} role="status" aria-live="polite"><strong>{nominalLabel === null ? t("character.nominal.recorded") : t("character.nominal.recordedNamed", { label: nominalLabel })}</strong>{nominal.output.includes("{total}") || nominal.output === nominalLabel ? null : <p>{nominal.output}</p>}</section> : null}
    {snapshot.lastRoll !== null ? <RollResult roll={snapshot.lastRoll} fieldLabels={fieldLabels} /> : null}
  </main>;
}
