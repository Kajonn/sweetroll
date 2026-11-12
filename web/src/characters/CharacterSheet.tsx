import { hasRollSelection, RollContextFields } from "../rolls/RollContextFields.js";
import type { CampaignRollSelection, CharacterDeck } from "./types.js";
import { ItemArtwork } from "../ui/ItemArtwork.js";
import type { CharactersApi } from "./api.js";
import { SystemPresentationScope } from "../theme/SystemPresentation.js";
import {PushPanel,type PushApi} from "../rolls/PushPanel.js";
import {RollBreakdown} from "../rolls/RollBreakdown.js";
import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { t } from "../i18n/index.js";
import { Button } from "../ui/Button.js";
import { resourceMaxKey, type CharacterSnapshot } from "./session.js";
import { FieldControl, type ProjectedField } from "./FieldControl.js";
import { SlotListControl, type SlotTemplate } from "./SlotListControl.js";
import styles from "./characters.module.css";

export type CharacterSheetCallbacks = {
  onSetField(fieldId: string, value: unknown): void | Promise<void>;
  onBump(resourceId: string, direction: "up" | "down"): void | Promise<void>;
  /** Design 6.3: apply an amount in one command. The amount controls are hidden when absent. */
  onAdjustResource?(resourceId: string, delta: number): void | Promise<void>;
  /** Design 6.3: direct input of current value and maximum. The editor is hidden when absent. */
  onSetResource?(resourceId: string, values: { current?: number; max?: number }): void | Promise<void>;
  /** Optional so standalone routes can bind fields/resources without owning action execution. */
  onExecuteAction?(actionId: string, inputs?: Record<string, unknown>, campaignRoll?: CampaignRollSelection): void | Promise<void>;
  /**
   * Task 7: entry intents. Optional like onExecuteAction; slot controls
   * disable while any entry callback is absent.
   */
  onAddEntry?(slotId: string, templateId: string | null, values: Record<string, unknown>, quantity?: number, source?: import("./types.js").EntrySource): void | Promise<void>;
  onRemoveEntry?(entryId: string): void | Promise<void>;
  onUpdateEntry?(entryId: string, values: Record<string, unknown>, quantity?: number, source?: import("./types.js").EntrySource): void | Promise<void>;
  onExecuteGranted?(entryId: string, actionId: string, inputs?: Record<string, unknown>, campaignRoll?: CampaignRollSelection): void | Promise<void>;
};

export type CharacterSheetProps = { snapshot: CharacterSnapshot;pushApi?:PushApi|undefined;onPushRoll?:((id:string)=>Promise<void>)|undefined;onRefreshRoll?:(()=>Promise<void>)|undefined;onDeniedRoll?:((id:string)=>Promise<void>)|undefined } & CharacterSheetCallbacks & {
  loadRollOptions?: CharactersApi["rollOptions"];
  /** Design 6.4: reads the cards left in the sheet's decks; counts are hidden when absent. */
  loadDecks?: CharactersApi["decks"];
  /** Offline availability once determined; omitted while unknown. */
  offlineAvailable?: boolean | undefined;
  /** Template catalog for slot pickers and granted-action buttons; omitted while unknown. */
  templates?: SlotTemplate[] | undefined;
  portrait?: ReactNode;
  entryImages?: CharactersApi["entryImages"];
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

function resourceMaximum(snapshot: CharacterSnapshot, element: Extract<Element, { kind: "resource" }>): number {
  const estimate = tentativeValue(snapshot, resourceMaxKey(element.resourceId));
  return typeof estimate === "number" ? estimate : element.value.max;
}

function parseAmount(text: string): number | null {
  if (text.trim() === "") return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/** Amount and direct-input controls for one resource (design 6.3). */
function ResourceEditor({ element, current, max, disabled, invoke, onAdjustResource, onSetResource }: {
  element: Extract<Element, { kind: "resource" }>;
  current: number;
  max: number;
  disabled: boolean;
  invoke(command: () => void | Promise<void>): void;
  onAdjustResource: CharacterSheetCallbacks["onAdjustResource"];
  onSetResource: CharacterSheetCallbacks["onSetResource"];
}) {
  const [amount, setAmount] = useState("");
  const [draft, setDraft] = useState<{ current: string; max: string } | null>(null);
  const parsedAmount = parseAmount(amount);
  const amountValid = parsedAmount !== null && parsedAmount > 0;
  const apply = (sign: 1 | -1) => {
    if (!amountValid || onAdjustResource === undefined) return;
    invoke(() => onAdjustResource(element.resourceId, sign * parsedAmount));
    setAmount("");
  };
  const draftCurrent = draft === null ? null : parseAmount(draft.current);
  const draftMax = draft === null ? null : element.computedMaximum ? max : parseAmount(draft.max);
  const draftValid = draftCurrent !== null && draftMax !== null
    && draftMax >= element.min && draftMax <= element.max && draftCurrent >= element.min && draftCurrent <= draftMax;
  const label = element.label;
  return <>
    {onAdjustResource ? <form className={styles.resource} onSubmit={(event) => { event.preventDefault(); apply(-1); }}>
      <label className={styles.resourceLabel} htmlFor={`${element.id}-amount`}>{t("character.resource.amount", { label })}</label>
      <input id={`${element.id}-amount`} className={styles.resourceInput} type="number" inputMode="decimal" min={element.step} step={element.step} value={amount} disabled={disabled} onChange={(event) => setAmount(event.target.value)} />
      <Button type="submit" disabled={disabled || !amountValid || current <= element.min}>{t("character.resource.subtract", { label })}</Button>
      <Button disabled={disabled || !amountValid || current >= max} onClick={() => apply(1)}>{t("character.resource.add", { label })}</Button>
    </form> : null}
    {onSetResource && draft === null ? <div className={styles.resource}>
      <Button disabled={disabled} onClick={() => setDraft({ current: String(current), max: String(max) })}>{t("character.resource.edit", { label })}</Button>
    </div> : null}
    {onSetResource && draft !== null ? <form className={styles.resource} onSubmit={(event) => {
      event.preventDefault();
      if (!draftValid || disabled) return;
      const values = {
        ...(draftCurrent === current ? {} : { current: draftCurrent }),
        ...(draftMax === max ? {} : { max: draftMax }),
      };
      if (Object.keys(values).length > 0) invoke(() => onSetResource(element.resourceId, values));
      setDraft(null);
    }}>
      <label className={styles.resourceLabel} htmlFor={`${element.id}-current`}>{t("character.resource.current", { label })}</label>
      <input id={`${element.id}-current`} className={styles.resourceInput} type="number" inputMode="decimal" min={element.min} max={draftMax ?? element.max} step={element.step} value={draft.current} disabled={disabled} onChange={(event) => setDraft({ ...draft, current: event.target.value })} />
      {element.computedMaximum ? null : <>
      <label className={styles.resourceLabel} htmlFor={`${element.id}-max`}>{t("character.resource.maximum", { label })}</label>
      <input id={`${element.id}-max`} className={styles.resourceInput} type="number" inputMode="decimal" min={element.min} max={element.max} step={element.step} value={draft.max} disabled={disabled} onChange={(event) => setDraft({ ...draft, max: event.target.value })} />
      </>}
      <Button type="submit" variant="primary" disabled={disabled || !draftValid}>{t("character.resource.save", { label })}</Button>
      <Button onClick={() => setDraft(null)}>{t("character.resource.cancel")}</Button>
      {draftValid ? null : <p className={styles.stale} role="alert">{t("character.resource.range", { min: element.min, max: element.max })}</p>}
    </form> : null}
  </>;
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

function ActionControl({ element, disabled, disabledReason, onExecuteAction, characterId, loadRollOptions, deck, onDeckChanged }: {
  element: Extract<Element, { kind: "action" }>;
  /** Card counts of the deck a draw or shuffle action uses, once known. */
  deck?: CharacterDeck | undefined;
  onDeckChanged?: (() => void) | undefined;
  disabled: boolean;
  disabledReason: string | null;
  onExecuteAction: NonNullable<CharacterSheetCallbacks["onExecuteAction"]>;
  characterId?: string | undefined;
  loadRollOptions?: CharactersApi["rollOptions"];
}) {
  const [selection, setSelection] = useState<CampaignRollSelection>({});
  const contextual = Boolean(element.target || element.respondsTo);
  const deckEmpty = element.actionKind === "draw" && deck?.remaining === 0;
  const blocked = disabled || deckEmpty || (contextual && (!characterId || !hasRollSelection(element, selection)));
  const [inputs, setInputs] = useState<Record<string, unknown>>(() => Object.fromEntries(element.inputs.map(input => [input.id, input.default])));
  const [commandError, setCommandError] = useState<string | null>(null);
  return <form className={styles.action} onSubmit={(event) => {
    event.preventDefault();
    if (blocked) return;
    // Catch rejected UI command promises locally: surface them persistently
    // and keep the entered inputs instead of dropping them or rejecting
    // without handling.
    setCommandError(null);
    let result: void | Promise<void>;
    try {
      result = contextual ? onExecuteAction(element.actionId, inputs, selection) : onExecuteAction(element.actionId, inputs);
    } catch (error) {
      setCommandError(describeCommandError(error));
      return;
    }
    if (result !== undefined && result !== null && typeof (result as Promise<void>).then === "function") {
      (result as Promise<void>).then(undefined, (error: unknown) => setCommandError(describeCommandError(error)))
        .then(() => { if (element.deck) onDeckChanged?.(); });
    } else if (element.deck) {
      onDeckChanged?.();
    }
  }}>
    {element.deck && deck ? <p role="status" data-testid={`deck-count-${element.id}`}>
      {t(deckEmpty ? "character.deck.empty" : "character.deck.remaining", { deck: deck.label, remaining: String(deck.remaining), total: String(deck.total) })}
    </p> : null}
    {element.inputs.map(input => <label key={input.id}>{input.label}<input type={input.valueType === "integer" || input.valueType === "decimal" ? "number" : input.valueType === "boolean" ? "checkbox" : "text"} required={input.required} value={input.valueType === "boolean" ? undefined : String(inputs[input.id] ?? "")} checked={input.valueType === "boolean" ? inputs[input.id] === true : undefined} onChange={(event) => setInputs(current => ({ ...current, [input.id]: input.valueType === "boolean" ? event.target.checked : input.valueType === "integer" || input.valueType === "decimal" ? Number(event.target.value) : event.target.value }))} disabled={disabled} aria-describedby={disabledReason === null ? undefined : "character-action-unavailable"} /></label>)}
    <RollContextFields requirements={element} selection={selection} onChange={setSelection} disabled={disabled}
      characterId={characterId} actionId={element.actionId} loadOptions={loadRollOptions} />
    <Button type="submit" variant="primary" disabled={blocked} aria-describedby={disabledReason === null ? undefined : "character-action-unavailable"}>{element.label}</Button>
    {commandError !== null ? <p role="alert" className={styles.commandError}>{commandError}</p> : null}
    <ValidationList validations={element.validations} />
  </form>;
}

function audienceLabel(audience: NonNullable<CharacterSnapshot["lastRoll"]>["audience"]): string {
  return t(`character.rollResult.audience.${audience}`);
}

function nominalActionLabel(
  nominal: NonNullable<CharacterSnapshot["lastNominal"]>,
  sheets: NonNullable<CharacterSnapshot["confirmed"]>["projection"]["sheets"],
  templates: SlotTemplate[],
): string | null {
  for (const sheet of sheets) {
    for (const section of sheet.sections) {
      const action = section.elements.find(element => element.kind === "action"
        && element.entryId === nominal.entryId && element.actionId === nominal.actionId);
      if (action?.kind === "action") return action.label;
    }
  }
  const matches = templates.flatMap(template => template.grantedActions.filter(action => action.id === nominal.actionId));
  return matches.length === 1 ? matches[0]!.label : null;
}

function RollResult({ roll, fieldLabels }: { roll: NonNullable<CharacterSnapshot["lastRoll"]>; fieldLabels: ReadonlyMap<string, string> }) {
  const expression = roll.expression.replace(/\bfields\.([A-Za-z_][A-Za-z0-9_]*)\b/g, (reference, fieldId: string) => fieldLabels.get(fieldId) ?? reference);
  const bindings = <ul>{roll.bindings.filter(binding => binding.scope !== "target" && binding.scope !== "opposed").map(binding => <li key={`${binding.scope}-${binding.definitionId}`}>
    {binding.scope === "fields" ? fieldLabels.get(binding.definitionId) ?? `${binding.scope}.${binding.definitionId}` : `${binding.scope}.${binding.definitionId}`}: {String(binding.value)}
  </li>)}</ul>;
  return <section className={styles.rollResult} aria-labelledby="character-roll-result">
    <h2 id="character-roll-result">{t("character.rollResult.title")}</h2>
    <dl>
      <dt>{t("character.rollResult.expression")}</dt><dd>{expression}</dd>
      <dt>{t("character.rollResult.total")}</dt><dd>{roll.total}</dd>
      {roll.outcome ? <><dt>{t("character.rollResult.outcome")}</dt><dd data-testid="roll-outcome">{roll.outcome.label}</dd></> : null}
      {roll.details?.map(detail => <Fragment key={detail.id}><dt>{detail.label}</dt><dd>{detail.value}</dd></Fragment>)}
      <dt>{t("character.rollResult.output")}</dt><dd>{roll.output}</dd>
      <dt>{t("character.rollResult.audience")}</dt><dd>{audienceLabel(roll.audience)}</dd>
    </dl>
    <RollBreakdown roll={roll}>{bindings}</RollBreakdown>
  </section>;
}

export function CharacterSheet({ snapshot, loadDecks, onSetField, onBump, onAdjustResource, onSetResource, onExecuteAction, onAddEntry, onRemoveEntry, onUpdateEntry, onExecuteGranted, offlineAvailable, templates, portrait, entryImages, loadRollOptions, pushApi, onPushRoll, onRefreshRoll, onDeniedRoll }: CharacterSheetProps) {
  const characterIdForImages = snapshot.confirmed?.characterId;
  const imageFactory = useMemo(() => entryImages && characterIdForImages ? (id: string) => entryImages(characterIdForImages, id) : undefined, [entryImages, characterIdForImages]);
  const character = snapshot.confirmed;
  const [commandError, setCommandError] = useState<string | null>(null);
  // Design 6.4: deck counts are read from the server on load and after each
  // draw or shuffle. Other players' draws show up on the next read.
  const [decks, setDecks] = useState<CharacterDeck[]>([]);
  const [deckRead, setDeckRead] = useState(0);
  const refreshDecks = useCallback(() => setDeckRead(count => count + 1), []);
  const deckCharacterId = character?.projection.sheets.some(sheet => sheet.sections.some(section =>
    section.elements.some(element => element.kind === "action" && element.deck !== undefined))) ? character.characterId : undefined;
  const lastDrawRemaining = snapshot.lastRoll?.breakdown?.cards?.remaining;
  const connected = snapshot.connected;
  useEffect(() => {
    if (deckCharacterId === undefined || loadDecks === undefined || !connected) return;
    let current = true;
    loadDecks(deckCharacterId).then(
      (response) => { if (current) setDecks(response.decks); },
      () => { if (current) setDecks([]); },
    );
    return () => { current = false; };
  }, [deckCharacterId, loadDecks, connected, deckRead, lastDrawRemaining, character?.campaignId]);
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
  const nominalLabel = nominal === null ? null : nominalActionLabel(nominal, projection.sheets, templates ?? []);
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
        const max = resourceMaximum(snapshot, element);
        return <div key={element.id} data-system-resource className={styles.resourceGroup}>
          <div className={styles.resource}>
            <span className={styles.resourceLabel}>{element.label}</span>
            <span className={styles.resourceValue}>{current} / {max}</span>
            <Button variant="primary" disabled={!editable || current <= element.min} onClick={() => invokeCommand(() => onBump(element.resourceId, "down"))}>{t("character.resource.decrease", { label: element.label })}</Button>
            <Button variant="primary" disabled={!editable || current >= max} onClick={() => invokeCommand(() => onBump(element.resourceId, "up"))}>{t("character.resource.increase", { label: element.label })}</Button>
          </div>
          <ResourceEditor element={element} current={current} max={max} disabled={!editable} invoke={invokeCommand} onAdjustResource={onAdjustResource} onSetResource={onSetResource} />
          <ValidationList validations={element.validations} />
        </div>;
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
          key={`${character.placementGeneration}:${element.id}`}
          slotId={element.slotId}
          label={element.label}
          accepts={[...element.accepts]}
          entries={element.entries.map((entry) => ({ ...entry, values: { ...entry.values } }))}
          templates={templates ?? []}
          renderEntryImage={imageFactory ? entry => <ItemArtwork key={entry.entryId} resourceId={entry.entryId} createApi={imageFactory} online={snapshot.connected} canEdit={snapshot.editing.owned && character.lifecycle === "active" && snapshot.entries.length === 0 && !snapshot.error} parentRevision={character.revision} /> : undefined}
          disabled={!entriesEditable}
          characterId={character.campaignId ? character.characterId : undefined}
          loadRollOptions={loadRollOptions}
          actionsDisabled={!(editable && snapshot.phase === "ready" && onExecuteGranted !== undefined)}
          onAddEntry={onAddEntry ?? (async () => {})}
          onRemoveEntry={onRemoveEntry ?? (async () => {})}
          onUpdateEntry={onUpdateEntry ?? (async () => {})}
          onExecuteGranted={(entryId, actionId, inputs, selection) => invokeCommand(() => selection ? onExecuteGranted?.(entryId, actionId, inputs, selection) : onExecuteGranted?.(entryId, actionId, inputs))}
        />;
      }
      case "action": {
        if (element.entryId !== undefined) return null;
        return <ActionControl key={`${character.characterId}:${character.placementGeneration}:${element.id}`} element={element}
          deck={decks.find(deck => deck.deckId === element.deck?.deckId)} onDeckChanged={refreshDecks}
          characterId={character.campaignId ? character.characterId : undefined} loadRollOptions={loadRollOptions} disabled={!actionsAvailable} disabledReason={actionUnavailableReason} onExecuteAction={executeAction} />;
      }
    }
  };

  return <SystemPresentationScope as="section" aria-label={character.name} presentation={character.projection.presentation} className={styles.sheet} aria-busy={pending}>
    <header className={styles.header}><h1>{character.name}</h1><span>{projection.entityLabel}</span><p className={styles.meta}>{t("character.header.version", { version: character.systemVersionId })} · {t(character.lifecycle === "archived" ? "character.lifecycle.archived" : "character.lifecycle.active")}</p><output role="status" aria-live="polite">{syncStatusText(snapshot, pending)}</output>{commandError !== null ? <p role="alert" className={styles.commandError}>{commandError}</p> : null}{offlineAvailable === undefined ? null : <p role="status">{t(offlineAvailable ? "character.offline.available" : "character.offline.unavailable")}</p>}</header>
    {portrait}
    {stale ? <p className={styles.stale}>{t("character.validation.stale")}</p> : null}
    {showEstimateNote ? <p className={styles.estimateNote}>{t("character.estimate.note")}</p> : null}
    {actionUnavailableReason !== null ? <p id="character-action-unavailable" className={styles.actionUnavailable}>{actionUnavailableReason}</p> : null}
    {diagnostics.length > 0 ? <section className={styles.diagnostics} aria-labelledby="character-diagnostics"><h2 id="character-diagnostics">{t("character.diagnostics.title")}</h2><ValidationList validations={diagnostics} /></section> : null}
    {projection.sheets.map(sheet => <section key={sheet.id} data-system-panel className={styles.sheetSection} aria-labelledby={`sheet-${sheet.id}`}><h2 id={`sheet-${sheet.id}`}>{sheet.label}</h2>{sheet.sections.map(section => <section key={section.id} className={styles.section} aria-labelledby={`section-${section.id}`}><h3 id={`section-${section.id}`}>{section.label}</h3>{section.elements.filter((element, index) => !(index === 0 && element.kind === "heading" && element.text.trim() === section.label.trim())).map(renderElement)}</section>)}</section>)}
    {projection.completionFields === undefined ? <p className={styles.completionUnavailable}>{t("character.completion.unavailable")}</p> : projection.completionFields.length > 0 ? <section className={styles.completion} aria-labelledby="character-completion"><h2 id="character-completion" tabIndex={-1}>{t("character.completion.title")}</h2>{projection.completionFields.map(field => <FieldControl key={field.id} field={field} tentativeValue={tentativeValue(snapshot, field.fieldId)} disabled={!editable} pending={pending} onCommit={onSetField} />)}</section> : null}
    {nominal !== null ? <section className={styles.nominalResult} role="status" aria-live="polite"><strong>{nominalLabel === null ? t("character.nominal.recorded") : t("character.nominal.recordedNamed", { label: nominalLabel })}</strong>{nominal.output.includes("{total}") || nominal.output === nominalLabel ? null : <p>{nominal.output}</p>}</section> : null}
    {snapshot.lastRoll !== null ? snapshot.lastRoll.push&&pushApi?<PushPanel roll={snapshot.lastRoll} characterId={character.characterId} api={pushApi} online={snapshot.connected} revision={character.revision} disabled={!editable||snapshot.phase!=="ready"||pending||snapshot.pendingOnlineAttempts.length>0} onPush={onPushRoll} onRefresh={onRefreshRoll} onDenied={onDeniedRoll}/>:<RollResult roll={snapshot.lastRoll} fieldLabels={fieldLabels} /> : null}
  </SystemPresentationScope>;
}
