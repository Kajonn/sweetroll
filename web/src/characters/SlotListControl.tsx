import { useEffect, useState } from "react";

import { t } from "../i18n/index.js";
import { Button } from "../ui/Button.js";
import { Dialog } from "../ui/Dialog.js";
import { EmptyState } from "../ui/EmptyState.js";
import { Panel } from "../ui/Panel.js";
import { Select } from "../ui/Select.js";
import styles from "./characters.module.css";

export type SlotGrantedActionInput = {
  id: string;
  label: string;
  valueType: "integer" | "decimal" | "boolean" | "text";
  required: boolean;
  default: unknown;
};

export type SlotGrantedAction = {
  id: string;
  label: string;
  actionKind: "roll" | "resourceBump";
  inputs: SlotGrantedActionInput[];
};

export type SlotTemplate = {
  source?: import("./types.js").EntrySource;
  defaultQuantity?: number;
  id: string;
  label: string;
  kind: string;
  fields?: SlotTemplateField[];
  grantedActions: SlotGrantedAction[];
};

export type SlotTemplateField = {
  id: string;
  label: string;
  kind: string;
  default?: unknown;
  required?: boolean;
  min?: number;
  max?: number;
  step?: number;
  minLength?: number;
  maxLength?: number;
  options?: Array<{ id: string; label: string }>;
};

export type SlotListEntry = {
  source?: import("./types.js").EntrySource;
  entryId: string;
  templateId: string | null;
  label: string;
  values: Record<string, unknown>;
  quantity?: number;
};

export type SlotListControlProps = {
  slotId: string;
  label: string;
  accepts: string[];
  entries: SlotListEntry[];
  templates: SlotTemplate[];
  disabled: boolean;
  /**
   * Granted-action buttons follow the entity-action availability (online,
   * owned, granted executor wired) rather than the edit gate, so offline
   * entry edits stay enabled while rolls stay disabled.
   */
  actionsDisabled?: boolean;
  onAddEntry(slotId: string, templateId: string | null, values: Record<string, unknown>, quantity?: number, source?: import("./types.js").EntrySource): void | Promise<void>;
  onRemoveEntry(entryId: string): void | Promise<void>;
  onUpdateEntry(entryId: string, values: Record<string, unknown>, quantity?: number, source?: import("./types.js").EntrySource): void | Promise<void>;
  onExecuteGranted(entryId: string, actionId: string, inputs: Record<string, unknown>): void | Promise<void>;
};

function describeCommandError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return t("character.command.failed", { message });
}

function scalarSummary(values: Record<string, unknown>, label: string): string | null {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (value === null || value === undefined) continue;
    if (key === "name" && value === label) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      parts.push(`${key}: ${String(value)}`);
    }
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

function invokeCommand(invoke: () => void | Promise<void>, onError: (message: string) => void): void {
  onError("");
  let result: void | Promise<void>;
  try {
    result = invoke();
  } catch (error) {
    onError(describeCommandError(error));
    return;
  }
  if (result !== undefined && result !== null && typeof (result as Promise<void>).then === "function") {
    (result as Promise<void>).then(undefined, (error: unknown) => onError(describeCommandError(error)));
  }
}

function GrantedActionForm({ entryId, action, disabled, onExecute }: {
  entryId: string;
  action: SlotGrantedAction;
  disabled: boolean;
  onExecute(entryId: string, actionId: string, inputs: Record<string, unknown>): void | Promise<void>;
}) {
  const [inputs, setInputs] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(action.inputs.map((input) => [input.id, input.default])));
  const [commandError, setCommandError] = useState("");
  return (
    <form
      className={styles.action}
      data-testid={`slot-granted-${entryId}-${action.id}`}
      onSubmit={(event) => {
        event.preventDefault();
        if (disabled) return;
        invokeCommand(() => onExecute(entryId, action.id, inputs), (message) => setCommandError(message));
      }}
    >
      {action.inputs.map((input) => (
        <label key={input.id}>
          {input.label}
          <input
            type={input.valueType === "integer" || input.valueType === "decimal" ? "number" : input.valueType === "boolean" ? "checkbox" : "text"}
            required={input.required}
            value={input.valueType === "boolean" ? undefined : String(inputs[input.id] ?? "")}
            checked={input.valueType === "boolean" ? inputs[input.id] === true : undefined}
            onChange={(event) => setInputs((current) => ({
              ...current,
              [input.id]: input.valueType === "boolean"
                ? event.target.checked
                : input.valueType === "integer" || input.valueType === "decimal"
                  ? Number(event.target.value)
                  : event.target.value,
            }))}
            disabled={disabled}
          />
        </label>
      ))}
      <Button type="submit" variant="secondary" disabled={disabled}>{action.label}</Button>
      {commandError !== "" ? <p role="alert" className={styles.commandError}>{commandError}</p> : null}
    </form>
  );
}

function RemoveEntryButton({ entry, slotLabel, disabled, onRemove }: {
  entry: SlotListEntry;
  slotLabel: string;
  disabled: boolean;
  onRemove(entryId: string): void | Promise<void>;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [commandError, setCommandError] = useState("");
  return (
    <>
      <Button
        type="button"
        variant="secondary"
        className={styles.slotRemoveButton}
        disabled={disabled}
        data-testid={`slot-entry-remove-${entry.entryId}`}
        onClick={() => {
          setCommandError("");
          setConfirmOpen(true);
        }}
      >
        {t("character.slot.remove", { label: entry.label })}
      </Button>
      {commandError !== "" ? <p role="alert" className={styles.commandError}>{commandError}</p> : null}
      <Dialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t("character.slot.removeTitle", { label: entry.label })}
        description={t("character.slot.removeDescription", { label: entry.label, slot: slotLabel })}
        closeLabel={t("character.slot.cancel")}
        actions={(
          <Button
            type="button"
            variant="danger"
            data-testid={`slot-entry-remove-confirm-${entry.entryId}`}
            onClick={() => invokeCommand(() => onRemove(entry.entryId), (message) => {
              if (message === "") {
                setConfirmOpen(false);
              } else {
                setCommandError(message);
              }
            })}
          >
            {t("character.slot.confirmRemove")}
          </Button>
        )}
      >
        <p className={styles.meta}>{entry.label}</p>
      </Dialog>
    </>
  );
}

function PersonalFields({ values, onChange, quantity, onQuantity, disabled, nameTestId, showQuantity = true }: {
  values: Record<string, unknown>;
  onChange(values: Record<string, unknown>): void;
  quantity: number;
  onQuantity(value: number): void;
  nameTestId?: string;
  showQuantity?: boolean;
  disabled: boolean;
}) {
  return <>
    <label className={styles.field}>{t("character.slot.customName")}
      <input className={styles.dialogField} data-testid={nameTestId} required maxLength={200}
        value={String(values.name ?? "")} disabled={disabled}
        onChange={(event) => onChange({ ...values, name: event.target.value })} />
    </label>
    {(["description", "notes"] as const).map((key) => <label className={styles.field} key={key}>
      {t(key === "description" ? "character.slot.description" : "character.slot.notes")}
      <textarea className={styles.dialogField} maxLength={2000} rows={3}
        value={String(values[key] ?? "")} disabled={disabled}
        onChange={(event) => onChange({ ...values, [key]: event.target.value })} />
    </label>)}
    {showQuantity ? <label className={styles.field}>{t("character.slot.quantity")}
      <input className={styles.dialogField} type="number" min={1} step={1} required
        value={quantity} disabled={disabled}
        onChange={(event) => onQuantity(event.target.value === "" ? 0 : Number(event.target.value))} />
    </label> : null}
  </>;
}

function PersonalEntryForm({ entry, disabled, onUpdate }: {
  entry: SlotListEntry;
  disabled: boolean;
  onUpdate(entryId: string, values: Record<string, unknown>, quantity?: number, source?: import("./types.js").EntrySource): void | Promise<void>;
}) {
  const hasQuantity = entry.source?.kind !== "campaign" || entry.quantity !== undefined;
  const [draft, setDraft] = useState(entry.values);
  const [quantity, setQuantity] = useState(entry.quantity ?? 1);
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState(false);
  const [commandError, setCommandError] = useState("");
  useEffect(() => { setDraft(entry.values); setQuantity(entry.quantity ?? 1); }, [entry.values, entry.quantity]);
  if (!editing) return <Button type="button" variant="secondary" className={styles.slotEditButton}
    disabled={disabled} onClick={() => setEditing(true)}>{t("character.slot.editEntry")}</Button>;
  const valid = typeof draft.name === "string" && draft.name.trim() !== ""
    && Number.isSafeInteger(quantity) && quantity >= 1;
  const changed = JSON.stringify(draft) !== JSON.stringify(entry.values) || quantity !== (entry.quantity ?? 1);
  return <form className={styles.field} data-testid={`slot-entry-personal-${entry.entryId}`}
    onSubmit={(event) => {
      event.preventDefault();
      if (disabled || pending || !valid || !changed) return;
      setCommandError(""); setPending(true);
      void Promise.resolve().then(() => onUpdate(entry.entryId, { ...draft, name: String(draft.name).trim() }, hasQuantity ? quantity : undefined)).then(
        () => setEditing(false), (error: unknown) => setCommandError(describeCommandError(error)),
      ).finally(() => setPending(false));
    }}>
    <PersonalFields values={draft} onChange={setDraft} quantity={quantity} onQuantity={setQuantity} disabled={disabled || pending} showQuantity={hasQuantity} />
    <div className={styles.slotEditActions}>
      <Button type="submit" variant="secondary" disabled={disabled || !valid || !changed} pending={pending}>{t("character.slot.saveEntry")}</Button>
      <Button type="button" variant="secondary" disabled={pending} onClick={() => {
        setDraft(entry.values); setQuantity(entry.quantity ?? 1); setCommandError(""); setEditing(false);
      }}>{t("character.slot.cancel")}</Button>
    </div>
    {commandError !== "" ? <p role="alert" className={styles.commandError}>{commandError}</p> : null}
  </form>;
}

function TemplateEntryForm({ entry, template, disabled, onUpdate }: {
  entry: SlotListEntry;
  template: SlotTemplate;
  disabled: boolean;
  onUpdate(entryId: string, values: Record<string, unknown>, quantity?: number, source?: import("./types.js").EntrySource): void | Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState(false);
  const [draft, setDraft] = useState<Record<string, unknown>>(entry.values);
  const [quantity, setQuantity] = useState(entry.quantity ?? 1);
  const [commandError, setCommandError] = useState("");
  useEffect(() => {
    setDraft(entry.values);
    setQuantity(entry.quantity ?? 1);
  }, [entry.values, entry.quantity]);
  const fields = (template.fields ?? []).filter((field) =>
    field.kind !== "computed" && field.kind !== "image");
  if (fields.length === 0 && template.kind !== "item") return null;
  const setValue = (id: string, value: unknown) => setDraft((current) => ({ ...current, [id]: value }));
  if (!editing) {
    return <Button type="button" variant="secondary" className={styles.slotEditButton}
      disabled={disabled} data-testid={`slot-entry-edit-${entry.entryId}`}
      onClick={() => setEditing(true)}>{t("character.slot.editValues")}</Button>;
  }
  const validQuantity = Number.isInteger(quantity) && quantity >= 1;
  const changed = JSON.stringify(draft) !== JSON.stringify(entry.values)
    || (template.kind === "item" && quantity !== (entry.quantity ?? 1));
  return <form className={styles.field} data-testid={`slot-entry-values-${entry.entryId}`}
    onSubmit={(event) => {
      event.preventDefault();
      if (disabled || pending || !changed || !validQuantity) return;
      setCommandError("");
      setPending(true);
      void Promise.resolve().then(() => onUpdate(entry.entryId, draft,
        template.kind === "item" ? quantity : undefined)).then(
        () => setEditing(false),
        (error: unknown) => setCommandError(describeCommandError(error)),
      ).finally(() => setPending(false));
    }}>
    {fields.map((field) => {
      const value = draft[field.id] ?? field.default;
      if (field.kind === "boolean") return <label key={field.id}>
        <input type="checkbox" checked={value === true} disabled={disabled || pending}
          onChange={(event) => setValue(field.id, event.target.checked)} /> {field.label}
      </label>;
      if (field.kind === "singleChoice") return <Select key={field.id} label={field.label}
        value={typeof value === "string" ? value : ""} disabled={disabled || pending}
        onChange={(event) => setValue(field.id, event.target.value || null)}
        options={[{ value: "", label: "—" }, ...(field.options ?? []).map((o) => ({ value: o.id, label: o.label }))]} />;
      if (field.kind === "multiChoice") return <fieldset key={field.id}>
        <legend>{field.label}</legend>
        {(field.options ?? []).map((option) => <label key={option.id}>
          <input type="checkbox" checked={Array.isArray(value) && value.includes(option.id)}
            disabled={disabled || pending} onChange={(event) => {
              const selected = Array.isArray(value) ? value as string[] : [];
              setValue(field.id, event.target.checked
                ? [...selected, option.id] : selected.filter((id) => id !== option.id));
            }} /> {option.label}
        </label>)}
      </fieldset>;
      if (field.kind === "resource") return <fieldset key={field.id}>
        <legend>{field.label}</legend>
        {(["current", "max"] as const).map((part) => {
          const resource = value && typeof value === "object" ? value as Record<string, unknown> : {};
          return <label key={part}>{part}
            <input type="number" min={field.min} max={field.max} step={field.step ?? 1}
              value={typeof resource[part] === "number" ? resource[part] as number : ""}
              disabled={disabled || pending} required
              onChange={(event) => setValue(field.id, { ...resource,
                [part]: event.target.value === "" ? null : Number(event.target.value) })} />
          </label>;
        })}
      </fieldset>;
      return <label key={field.id}>{field.label}
        <input type={field.kind === "integer" || field.kind === "decimal" ? "number" : "text"}
          min={field.min} max={field.max} step={field.kind === "integer" ? field.step ?? 1 : field.step ?? "any"}
          minLength={field.minLength} maxLength={field.maxLength} required={field.required}
          value={typeof value === "string" || typeof value === "number" ? value : ""}
          disabled={disabled || pending} data-testid={`slot-entry-field-${entry.entryId}-${field.id}`}
          onChange={(event) => setValue(field.id,
            field.kind === "integer" || field.kind === "decimal"
              ? event.target.value === "" ? null : Number(event.target.value)
              : event.target.value)} />
      </label>;
    })}
    {template.kind === "item" ? <label>{t("character.slot.quantity")}
      <input type="number" min={1} step={1} required value={quantity} disabled={disabled || pending}
        data-testid={`slot-entry-quantity-${entry.entryId}`}
        onChange={(event) => setQuantity(event.target.value === "" ? 0 : Number(event.target.value))} />
    </label> : null}
    <div className={styles.slotEditActions}>
      <Button type="submit" variant="secondary" disabled={disabled || pending || !changed || !validQuantity}
        pending={pending}>{t("character.slot.saveValues")}</Button>
      <Button type="button" variant="secondary" disabled={pending} onClick={() => {
        setDraft(entry.values); setQuantity(entry.quantity ?? 1); setCommandError(""); setEditing(false);
      }}>{t("character.slot.cancel")}</Button>
    </div>
    {commandError !== "" ? <p role="alert" className={styles.commandError}>{commandError}</p> : null}
  </form>;
}

function AddEntryDialog({ slotId, label, accepts, templates, disabled, onAdd }: {
  slotId: string;
  label: string;
  accepts: string[];
  templates: SlotTemplate[];
  disabled: boolean;
  onAdd(slotId: string, templateId: string | null, values: Record<string, unknown>, quantity?: number, source?: import("./types.js").EntrySource): void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const offered = templates.filter((template) => accepts.includes(template.kind));
  const [selected, setSelected] = useState<string>(offered[0]?.id ?? "");
  const [customValues, setCustomValues] = useState<Record<string, unknown>>({ name: "" });
  const [quantity, setQuantity] = useState(1);
  const [pending, setPending] = useState(false);
  const [commandError, setCommandError] = useState("");
  const isCustom = selected === "";
  return (
    <>
      <Button
        type="button"
        variant="secondary"
        disabled={disabled}
        data-testid={`slot-add-${slotId}`}
        onClick={() => {
          setCommandError("");
          setSelected(offered[0]?.id ?? "");
          setCustomValues({ name: "" });
          setQuantity(1);
          setOpen(true);
        }}
      >
        {t("character.slot.add", { label })}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => { if (!pending) setOpen(next); }}
        title={t("character.slot.addTitle", { label })}
        description={t("character.slot.addDescription")}
        closeLabel={t("character.slot.cancel")}
        actions={(
          <Button
            type="button"
            variant="primary"
            disabled={disabled || pending || (isCustom && (String(customValues.name ?? "").trim() === "" || !Number.isSafeInteger(quantity) || quantity < 1))}
            pending={pending}
            data-testid={`slot-add-confirm-${slotId}`}
            onClick={() => {
              setCommandError(""); setPending(true);
              void Promise.resolve().then(() => isCustom
                ? onAdd(slotId, null, { ...customValues, name: String(customValues.name).trim() }, quantity)
                : offered.find(t=>t.id === selected)?.source?.kind === "campaign" ? onAdd(slotId, null, {}, undefined, offered.find(t=>t.id === selected)?.source) : onAdd(slotId, selected, {})).then(
                () => setOpen(false), (error: unknown) => setCommandError(describeCommandError(error)),
              ).finally(() => setPending(false));
            }}
          >
            {t("character.slot.confirmAdd")}
          </Button>
        )}
      >
        <Select
          label={t("character.slot.template")}
          data-testid={`slot-template-picker-${slotId}`}
          value={selected}
          disabled={disabled || pending}
          onChange={(event) => setSelected(event.target.value)}
          options={[
            ...offered.map((template) => ({ value: template.id, label: template.source?.kind === "campaign" ? `${template.label} · ${t("character.slot.campaign")}` : template.label })),
            { value: "", label: t("character.slot.customEntry") },
          ]}
        />
        {isCustom ? <div>
          <PersonalFields values={customValues} onChange={setCustomValues} quantity={quantity}
            onQuantity={setQuantity} disabled={disabled || pending} nameTestId={`slot-custom-name-${slotId}`} />
        </div> : null}
        {commandError !== "" ? <p role="alert" className={styles.commandError}>{commandError}</p> : null}
      </Dialog>
    </>
  );
}

/**
 * Task 7 sheet control for one typed slot: entry list, template-picker add
 * flow with a labeled custom-entry fallback, destructive-confirm removal,
 * and inline template-granted action buttons. Synthetic granted-action
 * projection elements are owned here (CharacterSheet skips them), resolved
 * against the template catalog passed down from the route.
 */
export function SlotListControl({ slotId, label, accepts, entries, templates, disabled, actionsDisabled, onAddEntry, onRemoveEntry, onUpdateEntry, onExecuteGranted }: SlotListControlProps) {
  const byId = new Map(templates.map((template) => [template.id, template]));
  const grantedDisabled = actionsDisabled ?? disabled;
  return (
    <div data-testid={`slot-list-${slotId}`}>
      <Panel
        title={label}
        actions={(
          <AddEntryDialog
            slotId={slotId}
            label={label}
            accepts={accepts}
            templates={templates}
            disabled={disabled}
            onAdd={onAddEntry}
          />
        )}
      >
        {entries.length === 0 ? (
          <div data-testid={`slot-empty-${slotId}`}>
            <EmptyState title={t("character.slot.empty")} />
          </div>
        ) : (
          <ul className={styles.slotList}>
            {entries.map((entry) => {
              const template = entry.templateId === null ? undefined : byId.get(entry.templateId);
              const summary = entry.templateId === null ? null : scalarSummary(entry.values, entry.label);
              return (
                <li key={entry.entryId} data-testid={`slot-entry-${entry.entryId}`} className={styles.slotEntry}>
                  <span className={styles.slotEntryLabel}>{entry.label}</span>
                  {(entry.templateId === null || template?.kind === "item") && (entry.quantity ?? 1) > 1
                    ? <span className={styles.meta}>×{entry.quantity}</span> : null}
                  {entry.templateId === null ? <>
                    <span className={styles.meta}>{t(entry.source?.kind === "campaign" ? "character.slot.campaign" : "character.slot.personal")}</span>
                    {(["description", "notes"] as const).map((key) => typeof entry.values[key] === "string" && entry.values[key] !== ""
                      ? <p className={styles.personalText} key={key}><strong>{t(key === "description" ? "character.slot.description" : "character.slot.notes")}: </strong>{String(entry.values[key])}</p> : null)}
                  </> : null}
                  {summary !== null ? <span className={styles.meta}>{summary}</span> : null}
                  {template?.grantedActions.map((action) => (
                    <GrantedActionForm
                      key={action.id}
                      entryId={entry.entryId}
                      action={action}
                      disabled={grantedDisabled}
                      onExecute={onExecuteGranted}
                    />
                  ))}
                  {entry.templateId === null ? (
                    <PersonalEntryForm entry={entry} disabled={disabled} onUpdate={onUpdateEntry} />
                  ) : template ? <TemplateEntryForm entry={entry} template={template}
                    disabled={disabled} onUpdate={onUpdateEntry} /> : null}
                  <RemoveEntryButton entry={entry} slotLabel={label} disabled={disabled} onRemove={onRemoveEntry} />
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </div>
  );
}
